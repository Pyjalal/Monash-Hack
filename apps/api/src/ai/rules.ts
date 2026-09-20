import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import type { Email, Usage } from "@cargolens/shared";
import { buildClassificationState } from "@cargolens/shared/questions";
import { buildRuleQuestions, RULE_QUESTION_VERSION, type RuleDefinition, type RuleEvaluation } from "@cargolens/shared/rules";
import { InvalidJevResponseError } from "./classify.js";
import type { JevProviderOptions } from "./jev.js";
import { hash, type Store } from "../store.js";

export type RuleProbabilities = Record<string, number>;
export interface RuleBatchResult { probabilities: Map<string, RuleProbabilities>; usage: Usage; model: string; elapsedMs: number }
export type RuleEvaluator = (emails: Email[], rules: RuleDefinition[]) => Promise<RuleBatchResult>;

const MAX_EMAILS_PER_REQUEST = 8;

/** Packs up to eight emails and every requested rule into one Jev request of independent Noul questions. */
export function createJevRuleEvaluator(options: Pick<JevProviderOptions, "apiKey" | "model" | "timeoutMs" | "totalTimeoutMs" | "maxRetries" | "fetch">): RuleEvaluator {
  const totalTimeoutMs = options.totalTimeoutMs ?? 20_000;
  const client = new TypeSafeClient({ apiKey: options.apiKey, defaultModel: options.model ?? "jev-1.13.0",
    timeout: options.timeoutMs ?? 10_000, retry: { maxRetries: options.maxRetries ?? 2 }, logLevel: "off", fetch: options.fetch });
  return async (emails, rules) => {
    if (emails.length < 1 || emails.length > MAX_EMAILS_PER_REQUEST || rules.length < 1) throw new RangeError("A rule batch needs 1 to 8 emails and at least one rule");
    const questions: Questions = {};
    emails.forEach((_email, index) => Object.assign(questions, buildRuleQuestions(rules, `emails[${index}]`, `e${index}_`)));
    const state = { emails: emails.map(email => buildClassificationState(email).email) };
    const started = performance.now();
    const response = await client.systemOne({ state, questions }, { signal: AbortSignal.timeout(totalTimeoutMs) });
    const elapsedMs = performance.now() - started;
    const answers = response?.answers as Record<string, { type?: string; noul?: unknown }> | undefined;
    if (!answers || typeof answers !== "object") throw new InvalidJevResponseError("rules.answers");
    const usage = response.usage as Usage | undefined;
    if (!usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) throw new InvalidJevResponseError("rules.usage");
    const probabilities = new Map<string, RuleProbabilities>();
    emails.forEach((email, index) => {
      const forEmail: RuleProbabilities = {};
      for (const rule of rules) {
        const answer = answers[`e${index}_${rule.id}`];
        if (!answer || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
          throw new InvalidJevResponseError(`rules.e${index}_${rule.id}`);
        forEmail[rule.id] = answer.noul;
      }
      probabilities.set(email.id, forEmail);
    });
    return { probabilities, usage, model: String(response.model ?? ""), elapsedMs };
  };
}

export interface RuleServiceOptions { store: Store; evaluator: RuleEvaluator; model: string }

/** Caches each (email, rule) probability so changing a client-side action or threshold never re-runs inference. */
export class RuleService {
  constructor(private readonly options: RuleServiceOptions) {}

  get rulesVersion(): string { return `${this.options.model}:${RULE_QUESTION_VERSION}`; }

  private key(email: Email, rule: RuleDefinition): string {
    return hash({ version: this.rulesVersion, state: buildClassificationState(email), condition: rule.condition });
  }

  async evaluate(emails: Email[], rules: RuleDefinition[]): Promise<RuleEvaluation[]> {
    const results = new Map<string, RuleProbabilities>();
    const cachedFlags = new Map<string, boolean>();
    const missing = new Map<string, RuleDefinition[]>();
    for (const email of emails) {
      const found: RuleProbabilities = {};
      const misses: RuleDefinition[] = [];
      for (const rule of rules) {
        const cached = this.options.store.getCachedRule(this.key(email, rule));
        if (cached === null) misses.push(rule); else found[rule.id] = cached;
      }
      results.set(email.id, found);
      cachedFlags.set(email.id, misses.length === 0);
      if (misses.length) missing.set(email.id, misses);
    }
    const failures = new Set<string>();
    const pending = emails.filter(email => missing.has(email.id));
    const chunks: Email[][] = [];
    for (let index = 0; index < pending.length; index += MAX_EMAILS_PER_REQUEST) chunks.push(pending.slice(index, index + MAX_EMAILS_PER_REQUEST));
    await Promise.all(chunks.map(async chunk => {
      const wanted = [...new Map(chunk.flatMap(email => missing.get(email.id) ?? []).map(rule => [rule.id, rule])).values()];
      try {
        const batch = await this.options.evaluator(chunk, wanted);
        for (const email of chunk) {
          const answers = batch.probabilities.get(email.id) ?? {};
          const target = results.get(email.id)!;
          for (const rule of missing.get(email.id) ?? []) {
            if (typeof answers[rule.id] !== "number") { failures.add(email.id); continue; }
            target[rule.id] = answers[rule.id];
            this.options.store.cacheRule(this.key(email, rule), answers[rule.id]);
          }
        }
      } catch { for (const email of chunk) failures.add(email.id); }
    }));
    return emails.map(email => failures.has(email.id)
      ? { id: email.id, status: "error", error: { code: "RULES_UNAVAILABLE", message: "Smart filters are unavailable; retry this row." } }
      : { id: email.id, status: "evaluated", rules: results.get(email.id)!, cached: cachedFlags.get(email.id)! });
  }
}
