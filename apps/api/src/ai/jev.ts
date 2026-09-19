import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import { buildClassificationState, buildQuestions, questionVersion,
  type ClassificationMode, type PromptVariant } from "@cargolens/shared/questions";
import { parseClassification, type Classifier } from "./classify.js";

export interface JevProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetries?: number;
  variant?: PromptVariant;
  mode?: ClassificationMode;
  fetch?: Fetch;
}

export function createJevProvider(options: JevProviderOptions): { classify: Classifier } {
  const variant = options.variant ?? "concise";
  const mode = options.mode ?? "full";
  const totalTimeoutMs = options.totalTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) throw new RangeError("totalTimeoutMs must be a positive integer");
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    defaultModel: options.model ?? "jev-1.13.0",
    timeout: options.timeoutMs ?? 10_000,
    retry: { maxRetries: options.maxRetries ?? 2 },
    logLevel: "off",
    fetch: options.fetch,
  });
  const questions = buildQuestions(variant, mode);
  const version = questionVersion(variant, mode);
  return {
    classify: async (email) => {
      const started = performance.now();
      const raw = await client.systemOne(
        { state: buildClassificationState(email), questions },
        { signal: AbortSignal.timeout(totalTimeoutMs) },
      );
      return parseClassification(raw, email, {
        questions, mode, elapsedMs: performance.now() - started, questionVersion: version,
      });
    },
  };
}
