import { createHash } from "node:crypto";
import { FieldNameSchema } from "@cargolens/shared";
import type { z } from "zod";

type FieldName = z.infer<typeof FieldNameSchema>;

export interface VisionRecoveryRequest {
  /**
   * Only pages that remained unresolved after native parsing + OCR.
   */
  unresolvedPages: number[];

  /**
   * Only CargoLens fields that remain unresolved.
   */
  unresolvedFields: FieldName[];

  /**
   * Evidence images for unresolved pages only.
   * Never include the opposite-side document or expected target values.
   */
  pageImages: Array<{
    page: number;
    mimeType: "image/png" | "image/jpeg";
    base64: string;
  }>;
}

export interface VisionProviderOptions {
  apiKey: string;

  /**
   * Primary vision-capable OpenRouter model.
   */
  model?: string;

  /**
   * Optional secondary vision-capable model used only when the primary
   * model is unavailable or fails with a transient provider error.
   */
  fallbackModel?: string;

  timeoutMs?: number;

  /**
   * Number of retries after the first attempt.
   * 0 = one attempt total.
   */
  maxRetries?: number;

  maxPages?: number;
  maxOutputTokens?: number;
  fetch?: typeof fetch;
}

export interface VisionProvider {
  recover(
    request: VisionRecoveryRequest,
  ): Promise<VisionRecoveryResult>;
}

export interface VisionRecoveryUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface VisionRecoveredCandidate {
  field: FieldName;
  value: string;
  page: number;
  confidence: number | null;
}

export interface VisionRecoverySuccess {
  ok: true;
  model: string;
  profile: "vision_recovered" | "vision_partial";
  latencyMs: number;
  attempts: number;
  usedFallback: boolean;
  usage: VisionRecoveryUsage;
  candidates: VisionRecoveredCandidate[];
  unresolvedFields: FieldName[];
  sourceImageHashes: Array<{ page: number; sha256: string }>;
}

export interface VisionRecoveryFailure {
  ok: false;
  model: string | null;
  profile: "vision_blocked";
  latencyMs: number;
  attempts: number;
  usedFallback: boolean;
  usage: VisionRecoveryUsage;
  error: {
    code: string;
    message: string;
  };
}

export type VisionRecoveryResult =
  | VisionRecoverySuccess
  | VisionRecoveryFailure;

interface OpenRouterVisionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

interface VisionModelPayload {
  candidates?: unknown;
  unresolvedFields?: unknown;
}

interface ModelAttemptSuccess {
  ok: true;
  response: Response;
}

interface ModelAttemptFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
}

type ModelAttemptResult =
  | ModelAttemptSuccess
  | ModelAttemptFailure;

const OPENROUTER_CHAT_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash-lite";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

function validateProviderOptions(
  options: VisionProviderOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxOutputTokens =
    options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("timeoutMs must be between 1 and 120000 ms.");
  }

  if (
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > 3
  ) {
    throw new Error(
      "maxRetries must be an integer between 0 and 3.",
    );
  }

  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages <= 0 ||
    maxPages > 10
  ) {
    throw new Error(
      "maxPages must be an integer between 1 and 10.",
    );
  }

  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 || maxOutputTokens > 4096
  ) {
    throw new Error(
      "maxOutputTokens must be an integer between 1 and 4096.",
    );
  }

  if (options.model !== undefined && !options.model.trim()) {
    throw new Error("model must not be empty.");
  }

  if (
    options.fallbackModel !== undefined &&
    !options.fallbackModel.trim()
  ) {
    throw new Error("fallbackModel must not be empty.");
  }
}

function validateVisionRequest(
  request: VisionRecoveryRequest,
  maxPages: number,
): void {
  if (request.unresolvedPages.length === 0) {
    throw new Error(
      "Vision recovery requires at least one unresolved page.",
    );
  }

  if (request.unresolvedPages.length > maxPages) {
    throw new Error(
      `Vision recovery exceeds the ${maxPages}-page limit.`,
    );
  }

  if (request.pageImages.length === 0) {
    throw new Error(
      "Vision recovery requires unresolved page evidence.",
    );
  }

  if (request.pageImages.length > maxPages) {
    throw new Error(
      `Vision recovery exceeds the ${maxPages}-image limit.`,
    );
  }

  if (request.unresolvedFields.length === 0) {
    throw new Error(
      "Vision recovery requires at least one unresolved field.",
    );
  }

  if (request.unresolvedPages.some((page) => !Number.isSafeInteger(page) || page < 1) ||
      new Set(request.unresolvedPages).size !== request.unresolvedPages.length ||
      request.unresolvedFields.some((field) => !FieldNameSchema.safeParse(field).success) ||
      new Set(request.unresolvedFields).size !== request.unresolvedFields.length) {
    throw new Error("Pages and fields must be valid and unique.");
  }
  let totalImageBytes = 0;
  const unresolvedPageSet = new Set(request.unresolvedPages);
  if (request.pageImages.length !== request.unresolvedPages.length) {
    throw new Error("Supply every declared unresolved page; scope the request to the pages being processed.");
  }
  const suppliedPages = new Set<number>();

  for (const image of request.pageImages) {
    if (!unresolvedPageSet.has(image.page)) {
      throw new Error(
        `Page ${image.page} was not marked unresolved by OCR.`,
      );
    }

    if (suppliedPages.has(image.page)) {
      throw new Error(
        `Page ${image.page} was supplied more than once.`,
      );
    }

    suppliedPages.add(image.page);

    if (!["image/png", "image/jpeg"].includes(image.mimeType) ||
        image.base64.length > 8 * 1024 * 1024 ||
        (image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64))) {
      throw new Error("Image evidence must be bounded base64 PNG or JPEG.");
    }
    const bytes = Buffer.from(image.base64, "base64");
    const validMagic = image.mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    totalImageBytes += bytes.length;
    if (!validMagic || totalImageBytes > 12 * 1024 * 1024) {
      throw new Error("Invalid image signature or total image budget exceeded.");
    }
    if (!image.base64.trim()) {
      throw new Error(
        `Page ${image.page} does not contain image evidence.`,
      );
    }
  }
}

function emptyUsage(): VisionRecoveryUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    estimatedCostUsd: null,
  };
}

function visionFailure(
  code: string,
  message: string,
  startedAt: number,
  model: string | null,
  attempts = 0,
  usedFallback = false,
): VisionRecoveryFailure {
  return {
    ok: false,
    model,
    profile: "vision_blocked",
    latencyMs: performance.now() - startedAt,
    attempts,
    usedFallback,
    usage: emptyUsage(),
    error: {
      code,
      message,
    },
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function usageFromResponse(
  usage: OpenRouterVisionResponse["usage"],
): VisionRecoveryUsage {
  return {
    promptTokens: numberOrNull(usage?.prompt_tokens),
    completionTokens: numberOrNull(usage?.completion_tokens),
    totalTokens: numberOrNull(usage?.total_tokens),
    estimatedCostUsd: numberOrNull(usage?.cost),
  };
}

export function parseVisionCandidate(
  value: unknown,
  request: VisionRecoveryRequest,
): VisionRecoveredCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const fieldResult = FieldNameSchema.safeParse(candidate.field);

  if (!fieldResult.success) {
    return null;
  }

  if (!request.unresolvedFields.includes(fieldResult.data)) {
    return null;
  }

  if (
    typeof candidate.value !== "string" ||
    candidate.value.trim().length === 0
  ) {
    return null;
  }

  /*
   * Candidate provenance requires a page corresponding to
   * evidence that was actually supplied to the vision model.
   *
   * Merely appearing in unresolvedPages is not enough: a caller may
   * intentionally send only a subset of unresolved page regions.
   */
  const suppliedPageSet = new Set(
    request.pageImages.map((image) => image.page),
  );

  if (
    typeof candidate.page !== "number" ||
    !Number.isSafeInteger(candidate.page) ||
    !request.unresolvedPages.includes(candidate.page) ||
    !suppliedPageSet.has(candidate.page)
  ) {
    return null;
  }

  const confidence =
    typeof candidate.confidence === "number" &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1
      ? candidate.confidence
      : null;

  if (confidence === null || confidence < 0.8) return null;

  return {
    field: fieldResult.data,
    value: candidate.value.trim(),
    page: candidate.page,
    confidence,
  };
}

function parseModelPayload(
  content: string,
): VisionModelPayload | null {
  try {
    const parsed: unknown = JSON.parse(content);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const payload = parsed as VisionModelPayload;
    if (!Array.isArray(payload.candidates) || !Array.isArray(payload.unresolvedFields) ||
        payload.unresolvedFields.some((field) => !FieldNameSchema.safeParse(field).success)) return null;
    return payload;
  } catch {
    return null;
  }
}

function buildVisionPrompt(request: VisionRecoveryRequest): string {
  return [
    "Recover only the requested unresolved fields from the supplied source-document pages.",
    `Requested fields: ${request.unresolvedFields.join(", ")}.`,
    "Use only evidence visibly present in the supplied pages.",
    "Do not infer, guess, or invent missing values.",
    "Do not use any expected answer, target value, comparison-side document, or evaluation label.",
    "If the evidence is insufficient for a field, do not create a candidate for it.",
    "Return JSON only using this exact structure:",
    '{"candidates":[{"field":"shipper","value":"visible value","page":1,"confidence":0.95}],"unresolvedFields":[]}',
  ].join(" ");
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

function isModelUnavailableStatus(status: number): boolean {
  return status === 404 || status === 410 || status === 503;
}

/**
 * A fallback is appropriate only for failures where changing provider/model
 * may reasonably recover the request. Permanent client/authentication
 * failures must not trigger a second paid request.
 */
function shouldUseFallback(
  failure: ModelAttemptFailure,
): boolean {
  return (
    failure.code === "model_unavailable" ||
    failure.code === "timeout" ||
    failure.code === "request_failed" ||
    failure.retryable
  );
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  model: string,
  request: VisionRecoveryRequest,
  options: VisionProviderOptions,
): Promise<ModelAttemptResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens:
          options.maxOutputTokens ??
          DEFAULT_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildVisionPrompt(request),
              },
              ...request.pageImages.flatMap((image) => [{
                type: "text", text: `Source document page ${image.page}:`,
              }, {
                type: "image_url",
                image_url: {
                  url: `data:${image.mimeType};base64,${image.base64}`,
                },
              }]),
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (isModelUnavailableStatus(response.status)) {
        return {
          ok: false,
          code: "model_unavailable",
          message: `OpenRouter model ${model} is unavailable (HTTP ${response.status}).`,
          retryable: true,
        };
      }

      return {
        ok: false,
        code: "openrouter_error",
        message: `OpenRouter returned HTTP ${response.status} for model ${model}.`,
        retryable: isRetryableStatus(response.status),
      };
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { void reader?.cancel().catch(() => undefined); reject(new DOMException("Timed out", "AbortError")); };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (reader) {
        while (true) {
          const part = await Promise.race([reader.read(), aborted]);
          if (controller.signal.aborted) throw new DOMException("Timed out", "AbortError");
          if (part.done) break;
          length += part.value.length;
          if (length > 1024 * 1024) {
            void reader.cancel().catch(() => undefined);
            return { ok: false, code: "invalid_response", message: "Vision response exceeds 1 MiB.", retryable: false };
          }
          chunks.push(part.value);
        }
      }
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      reader?.releaseLock();
    }
    return { ok: true, response: new Response(Buffer.concat(chunks), { status: 200 }) };
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return {
        ok: false,
        code: "timeout",
        message: `OpenRouter vision request exceeded the ${timeoutMs} ms timeout.`,
        retryable: true,
      };
    }

    return {
      ok: false,
      code: "request_failed",
      message:
        error instanceof Error
          ? error.message
          : "OpenRouter vision request failed.",
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestModelWithRetries(
  fetchImpl: typeof fetch,
  model: string,
  request: VisionRecoveryRequest,
  options: VisionProviderOptions,
): Promise<{
  result: ModelAttemptResult;
  attempts: number;
}> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxAttempts = maxRetries + 1;

  let attempts = 0;
  let lastResult: ModelAttemptResult | null = null;

  while (attempts < maxAttempts) {
    attempts += 1;

    const result = await fetchWithTimeout(
      fetchImpl,
      model,
      request,
      options,
    );

    lastResult = result;

    if (result.ok || !result.retryable) {
      return {
        result,
        attempts,
      };
    }
  }

  return {
    result:
      lastResult ?? {
        ok: false,
        code: "request_failed",
        message: "OpenRouter vision request failed.",
        retryable: false,
      },
    attempts,
  };
}

function resolveCandidates(
  rawCandidates: unknown,
  request: VisionRecoveryRequest,
): {
  candidates: VisionRecoveredCandidate[];
  unresolvedFields: FieldName[];
} {
  if (!Array.isArray(rawCandidates)) {
    return {
      candidates: [],
      unresolvedFields: [...request.unresolvedFields],
    };
  }

  const parsedCandidates = rawCandidates
    .map((candidate) =>
      parseVisionCandidate(candidate, request),
    )
    .filter(
      (
        candidate,
      ): candidate is VisionRecoveredCandidate =>
        candidate !== null,
    );

  const acceptedCandidates: VisionRecoveredCandidate[] = [];
  const ambiguousFields = new Set<FieldName>();

  for (const field of request.unresolvedFields) {
    const fieldCandidates = parsedCandidates.filter(
      (candidate) => candidate.field === field,
    );

    if (fieldCandidates.length === 0) {
      continue;
    }

    const uniqueValues = new Set(
      fieldCandidates.map((candidate) => candidate.value),
    );

    /*
     * Conflicting model answers are not evidence.
     * Keep the field unresolved instead of choosing one.
     */
    if (uniqueValues.size !== 1) {
      ambiguousFields.add(field);
      continue;
    }

    acceptedCandidates.push(fieldCandidates[0]);
  }

  const recoveredFields = new Set(
    acceptedCandidates.map((candidate) => candidate.field),
  );

  const unresolvedFields = request.unresolvedFields.filter(
    (field) =>
      !recoveredFields.has(field) || ambiguousFields.has(field),
  );

  return {
    candidates: acceptedCandidates.filter(
      (candidate) =>
        !unresolvedFields.includes(candidate.field),
    ),
    unresolvedFields,
  };
}

async function parseSuccessfulResponse(
  response: Response,
  request: VisionRecoveryRequest,
  model: string,
  startedAt: number,
  attempts: number,
  usedFallback: boolean,
): Promise<VisionRecoveryResult> {
  let data: OpenRouterVisionResponse;

  try {
    data =
      (await response.json()) as OpenRouterVisionResponse;
  } catch {
    return visionFailure(
      "invalid_response",
      "OpenRouter returned invalid JSON.",
      startedAt,
      model,
      attempts,
      usedFallback,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return visionFailure("invalid_response", "Invalid OpenRouter response object.", startedAt, model, attempts, usedFallback);
  }
  const content = data.choices?.[0]?.message?.content;

  if (
    typeof content !== "string" ||
    content.trim().length === 0
  ) {
    return { ...visionFailure("invalid_response", "OpenRouter response did not contain vision recovery content.", startedAt, model, attempts, usedFallback), usage: usageFromResponse(data.usage) };
  }

  const payload = parseModelPayload(content);

  if (!payload) {
    return { ...visionFailure("invalid_response", "Vision model returned malformed recovery JSON.", startedAt, model, attempts, usedFallback), usage: usageFromResponse(data.usage) };
  }

  const resolved = resolveCandidates(
    (payload.candidates as unknown[]).filter((item) => !((payload.unresolvedFields as unknown[]).includes((item as { field?: unknown } | null)?.field))),
    request,
  );

  return {
    ok: true,
    model,
    profile:
      resolved.unresolvedFields.length === 0
        ? "vision_recovered"
        : "vision_partial",
    latencyMs: performance.now() - startedAt,
    attempts,
    usedFallback,
    usage: usageFromResponse(data.usage),
    candidates: resolved.candidates,
    unresolvedFields: resolved.unresolvedFields,
    sourceImageHashes: request.pageImages.map((image) => ({
      page: image.page, sha256: createHash("sha256").update(Buffer.from(image.base64, "base64")).digest("hex"),
    })),
  };
}

export function createVisionProvider(
  options: VisionProviderOptions,
): VisionProvider {
  options = { ...options };
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const fallbackModel = options.fallbackModel?.trim() || null;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const fetchImpl = options.fetch ?? fetch;

  let providerConfigurationError: string | null = null;

  try {
    validateProviderOptions(options);
  } catch (error) {
    providerConfigurationError =
      error instanceof Error
        ? error.message
        : "Invalid vision provider configuration.";
  }

  const provider: VisionProvider = {
    recover: async (request) => {
      const startedAt = performance.now();

      if (providerConfigurationError) {
        return visionFailure(
          "invalid_configuration",
          providerConfigurationError,
          startedAt,
          model,
        );
      }

      if (!options.apiKey.trim()) {
        return visionFailure(
          "missing_credentials",
          "OpenRouter API key is not configured.",
          startedAt,
          model,
        );
      }

      try {
        validateVisionRequest(request, maxPages);
      } catch (error) {
        return visionFailure(
          "invalid_request",
          error instanceof Error
            ? error.message
            : "Invalid vision recovery request.",
          startedAt,
          model,
        );
      }

      const primary = await requestModelWithRetries(
        fetchImpl,
        model,
        request,
        options,
      );

      if (primary.result.ok) {
        return parseSuccessfulResponse(
          primary.result.response,
          request,
          model,
          startedAt,
          primary.attempts,
          false,
        );
      }

      /*
       * Only transient/provider-availability failures may use the
       * explicitly configured fallback. Permanent request/auth errors
       * return immediately instead of causing another paid request.
       */
      if (
        fallbackModel &&
        fallbackModel !== model &&
        shouldUseFallback(primary.result)
      ) {
        const fallback = await requestModelWithRetries(
          fetchImpl,
          fallbackModel,
          request,
          options,
        );

        const totalAttempts =
          primary.attempts + fallback.attempts;

        if (fallback.result.ok) {
          return parseSuccessfulResponse(
            fallback.result.response,
            request,
            fallbackModel,
            startedAt,
            totalAttempts,
            true,
          );
        }

        return visionFailure(
          fallback.result.code,
          `Primary model failed: ${primary.result.message} Fallback model failed: ${fallback.result.message}`,
          startedAt,
          fallbackModel,
          totalAttempts,
          true,
        );
      }

      return visionFailure(
        primary.result.code,
        primary.result.message,
        startedAt,
        model,
        primary.attempts,
        false,
      );
    },
  };
  return {
    recover: async (request) => {
      let snapshot: VisionRecoveryRequest;
      try { snapshot = structuredClone(request); }
      catch { return visionFailure("invalid_request", "Request must be cloneable evidence.", performance.now(), model); }
      const startedAt = performance.now();
      const first = await provider.recover(snapshot);
      if (!first.ok || first.candidates.length === 0) return first;
      const verification = await requestModelWithRetries(fetchImpl, first.model, snapshot, { ...options, maxRetries: 0 });
      const second = verification.result.ok
        ? await parseSuccessfulResponse(verification.result.response, snapshot, first.model, startedAt, verification.attempts, first.usedFallback)
        : visionFailure(verification.result.code, verification.result.message, startedAt, first.model, verification.attempts);
      const candidates = second.ok ? first.candidates.filter((candidate) => second.candidates.some((other) =>
        other.field === candidate.field && other.page === candidate.page && other.value === candidate.value)) : [];
      const usage = Object.fromEntries(Object.keys(first.usage).map((key) => {
        const field = key as keyof VisionRecoveryUsage;
        const a = first.usage[field], b = second.usage[field];
        return [field, a === null || b === null ? null : a + b];
      })) as unknown as VisionRecoveryUsage;
      const unresolvedFields = snapshot.unresolvedFields.filter((field) => !candidates.some((candidate) => candidate.field === field));
      return {
        ...first, candidates, unresolvedFields, usage,
        profile: unresolvedFields.length ? "vision_partial" : "vision_recovered",
        attempts: first.attempts + second.attempts,
        latencyMs: performance.now() - startedAt,
      };
    },
  };
}
