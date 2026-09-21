import type { Questions } from "@typesafe-ai/sdk";
import type { Email, Usage } from "@cargolens/shared";
import { buildClassificationState, buildQuestions, questionVersion, type ClassificationMode, type PromptVariant } from "@cargolens/shared/questions";
import { InvalidJevResponseError, parseClassification, type Classifier } from "./classify.js";
import { assertPackedBatch, assertPackedContextBudget, packBatchQuestions, packedAnswers, type BatchClassificationResult } from "./jev-batch.js";

const decisionsUrl = "https://openrouter.ai/api/alpha/decisions";

export interface OpenRouterJevOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetries?: number;
  variant?: PromptVariant;
  mode?: ClassificationMode;
  fetch?: typeof fetch;
}

type DecisionResponse = { model?: unknown; usage?: unknown; answers?: unknown };
type DecisionInput = { state: unknown; questions: Questions };

class OpenRouterHttpError extends Error {}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryable(status: number): boolean { return status === 408 || status === 409 || status === 429 || status >= 500; }

function normalized(response: DecisionResponse): unknown {
  const usage = response.usage && typeof response.usage === "object" ? response.usage as Record<string, unknown> : {};
  return { ...response, usage: {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens,
    output_tokens: usage.output_tokens ?? usage.completion_tokens,
  } };
}

export function createOpenRouterDecisionClient(options: OpenRouterJevOptions) {
  if (!options.apiKey.trim()) throw new Error("OPENROUTER_API_KEY is required");
  const model = options.model ?? "typesafe/jev-1.13";
  const fetchImplementation = options.fetch ?? fetch;
  const retries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) throw new RangeError("maxRetries must be an integer from 0 to 5");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError("timeoutMs must be an integer from 1 to 120000");
  return {
    async systemOne(input: DecisionInput, request: { signal?: AbortSignal } = {}): Promise<unknown> {
      for (let attempt = 0; ; attempt += 1) {
        request.signal?.throwIfAborted();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new DOMException("OpenRouter request timed out", "AbortError")), timeoutMs);
        const abort = () => controller.abort(request.signal?.reason);
        request.signal?.addEventListener("abort", abort, { once: true });
        try {
          const response = await fetchImplementation(decisionsUrl, { method: "POST", signal: controller.signal,
            headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "CargoLens" },
            body: JSON.stringify({ model, state: input.state, questions: input.questions }) });
          const text = await response.text();
          let body: DecisionResponse;
          try { body = text ? JSON.parse(text) as DecisionResponse : {}; }
          catch { throw new InvalidJevResponseError("openrouter.json"); }
          if (response.ok) return normalized(body);
          if (retryable(response.status) && attempt < retries) { await pause(250 * 2 ** attempt, request.signal); continue; }
          throw new OpenRouterHttpError(`OpenRouter Decisions request failed: HTTP ${response.status}`);
        } catch (error) {
          if (request.signal?.aborted || controller.signal.aborted || attempt >= retries || error instanceof InvalidJevResponseError || error instanceof OpenRouterHttpError) throw error;
          await pause(250 * 2 ** attempt, request.signal);
        } finally { clearTimeout(timeout); request.signal?.removeEventListener("abort", abort); }
      }
    },
  };
}

export function createOpenRouterJevProvider(options: OpenRouterJevOptions): { classify: Classifier } {
  const variant = options.variant ?? "concise"; const mode = options.mode ?? "full";
  const totalTimeoutMs = options.totalTimeoutMs ?? 15_000;
  const client = createOpenRouterDecisionClient(options); const questions = buildQuestions(variant, mode); const version = questionVersion(variant, mode);
  return { classify: async email => {
    const started = performance.now();
    const raw = await client.systemOne({ state: buildClassificationState(email), questions }, { signal: AbortSignal.timeout(totalTimeoutMs) });
    return parseClassification(raw, email, { questions, mode, elapsedMs: performance.now() - started, questionVersion: version });
  } };
}

export function createOpenRouterJevBatchProvider(options: OpenRouterJevOptions) {
  const variant = options.variant ?? "concise"; const mode = options.mode ?? "intent-only";
  const questions = buildQuestions(variant, mode); const version = `${questionVersion(variant, mode)}:packed-v1`;
  const totalTimeoutMs = options.totalTimeoutMs ?? 20_000; const client = createOpenRouterDecisionClient(options);
  return { async classifyBatch(emails: Email[]): Promise<BatchClassificationResult> {
    assertPackedBatch(emails);
    const packedQuestions = packBatchQuestions(questions, emails);
    const state = { emails: emails.map(email => buildClassificationState(email).email) };
    assertPackedContextBudget(state, packedQuestions);
    const started = performance.now(); const raw = await client.systemOne({ state, questions: packedQuestions }, { signal: AbortSignal.timeout(totalTimeoutMs) });
    const response = raw as { answers?: unknown; model?: unknown };
    const answers = packedAnswers(response.answers, packedQuestions);
    let usage: Usage | undefined;
    const classifications = emails.map((email, index) => {
      const selected = Object.fromEntries(Object.keys(questions).map(key => [key, answers[`e${index}_${key}`]]));
      const classification = parseClassification({ ...response, answers: selected }, email, { questions, mode, elapsedMs: performance.now() - started, questionVersion: version });
      usage = classification.usage; const { usage: ignored, raw: ignoredRaw, ...result } = classification; void ignored; void ignoredRaw; return result;
    });
    if (typeof response.model !== "string") throw new InvalidJevResponseError("model");
    return { classifications, usage: usage!, model: response.model, elapsedMs: performance.now() - started, questionVersion: version };
  } };
}
