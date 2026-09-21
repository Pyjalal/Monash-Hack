import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import type { Classification, Email, Usage } from "@cargolens/shared";
import { buildClassificationState, buildQuestions, questionVersion } from "@cargolens/shared/questions";
import { InvalidJevResponseError, parseClassification } from "./classify.js";
import type { JevProviderOptions } from "./jev.js";

export type BatchClassification = Omit<Classification, "usage" | "raw">;
export interface BatchClassificationResult {
  classifications: BatchClassification[];
  usage: Usage;
  model: string;
  elapsedMs: number;
  questionVersion: string;
}

const MAX_LONGEST_QUESTION_BYTES = 28_000;
const MAX_PACKED_REQUEST_BYTES = 56_000;

export function assertPackedBatch(emails: readonly Email[]): void {
  if (emails.length < 1 || emails.length > 8 || new Set(emails.map(email => email.id)).size !== emails.length)
    throw new RangeError("A packed batch must contain 1 to 8 emails with unique IDs");
}

export function packBatchQuestions(questions: Questions, emails: readonly Email[]): Questions {
  const packedQuestions: Questions = {};
  emails.forEach((_email, index) => {
    for (const [key, question] of Object.entries(questions)) {
      const instructions = String(question.instructions).replaceAll("`email.", `\`emails[${index}].`);
      packedQuestions[`e${index}_${key}`] = { ...question,
        instructions: `Evaluate ONLY the message at \`emails[${index}]\`. Ignore every other message in this request. ${instructions}` };
    }
  });
  return packedQuestions;
}

export function assertPackedContextBudget(state: unknown, packedQuestions: Questions): void {
  const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  const longestQuestionBytes = Math.max(...Object.values(packedQuestions).map(question => Buffer.byteLength(JSON.stringify(question), "utf8")));
  if (stateBytes + longestQuestionBytes > MAX_LONGEST_QUESTION_BYTES || stateBytes + Buffer.byteLength(JSON.stringify(packedQuestions), "utf8") > MAX_PACKED_REQUEST_BYTES)
    throw new RangeError("Packed request exceeds conservative context budget; split into smaller batches");
}

export function packedAnswers(answers: unknown, packedQuestions: Questions): Record<string, unknown> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers) ||
      Object.keys(answers).length !== Object.keys(packedQuestions).length ||
      Object.keys(packedQuestions).some(key => !Object.hasOwn(answers, key)))
    throw new InvalidJevResponseError("packed.answers");
  return answers as Record<string, unknown>;
}

export function createJevBatchProvider(options: JevProviderOptions) {
  const variant = options.variant ?? "concise";
  const mode = options.mode ?? "intent-only";
  const questions = buildQuestions(variant, mode);
  const version = `${questionVersion(variant, mode)}:packed-v1`;
  const totalTimeoutMs = options.totalTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) throw new RangeError("totalTimeoutMs must be a positive integer");
  const client = new TypeSafeClient({ apiKey: options.apiKey, defaultModel: options.model ?? "jev-1.13.0",
    timeout: options.timeoutMs ?? 10_000, retry: { maxRetries: options.maxRetries ?? 2 }, logLevel: "off", fetch: options.fetch });

  return {
    async classifyBatch(emails: Email[]): Promise<BatchClassificationResult> {
      assertPackedBatch(emails);
      const packedQuestions = packBatchQuestions(questions, emails);
      const state = { emails: emails.map(email => buildClassificationState(email).email) };
      assertPackedContextBudget(state, packedQuestions);
      const started = performance.now();
      const response = await client.systemOne({ state, questions: packedQuestions },
        { signal: AbortSignal.timeout(totalTimeoutMs) });
      const elapsedMs = performance.now() - started;
      const answers = packedAnswers(response?.answers, packedQuestions);
      let usage: Usage | undefined;
      const classifications = emails.map((email, index) => {
        const selected = Object.fromEntries(Object.keys(questions).map(key => [key, answers[`e${index}_${key}`]]));
        const classification = parseClassification({ ...response, answers: selected }, email,
          { questions, mode, elapsedMs, questionVersion: version });
        usage = classification.usage;
        const { usage: _requestUsage, raw: _raw, ...result } = classification;
        void _requestUsage; void _raw;
        return result;
      });
      return { classifications, usage: usage!, model: response.model, elapsedMs, questionVersion: version };
    },
  };
}
