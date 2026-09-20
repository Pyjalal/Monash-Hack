import "dotenv/config";

type ChatResponse = {
  id?: unknown;
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  error?: { message?: unknown; code?: unknown; metadata?: { raw?: unknown; provider_name?: unknown; provider_error_code?: unknown } };
};

type SmokeOptions = { apiKey: string; model: string; message: string; endpoint: string; timeoutMs: number };

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function config(): SmokeOptions {
  const args = process.argv.slice(2);
  const model = option(args, "--model") ?? process.env.OPENROUTER_SMOKE_MODEL ?? process.env.OPENROUTER_EXTRACTION_MODEL ?? "nex-agi/nex-n2.5-pro:free";
  const message = option(args, "--message") ?? "Hi";
  const endpoint = option(args, "--endpoint") ?? process.env.OPENROUTER_CHAT_URL ?? "https://openrouter.ai/api/v1/chat/completions";
  const timeoutMs = positiveInteger(option(args, "--timeout-ms") ?? process.env.OPENROUTER_SMOKE_TIMEOUT_MS, "--timeout-ms", 30_000);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required (set it in .env or pass DOTENV_CONFIG_PATH)");
  return { apiKey, model, message, endpoint, timeoutMs };
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function smoke(options: SmokeOptions): Promise<void> {
  const response = await fetch(options.endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "CargoLens OpenRouter Smoke Test",
    },
    body: JSON.stringify({ model: options.model, messages: [{ role: "user", content: options.message }], temperature: 0, max_tokens: 64 }),
  });
  const raw = await response.text();
  let body: ChatResponse;
  try { body = raw ? JSON.parse(raw) as ChatResponse : {}; }
  catch { throw new Error(`HTTP ${response.status}: OpenRouter returned non-JSON output: ${raw.slice(0, 300)}`); }
  if (!response.ok) {
    const error = body.error;
    const detail = error?.metadata?.raw ?? error?.message ?? `HTTP ${response.status}`;
    const provider = error?.metadata?.provider_name ? ` [provider: ${safeText(error.metadata.provider_name)}]` : "";
    throw new Error(`${safeText(detail)}${provider}`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned 200 but no assistant message content");
  console.log(JSON.stringify({
    ok: true,
    endpoint: options.endpoint,
    requestedModel: options.model,
    responseModel: typeof body.model === "string" ? body.model : null,
    responseId: typeof body.id === "string" ? body.id : null,
    message: options.message,
    reply: safeText(content),
    usage: body.usage ?? null,
  }, null, 2));
}

try {
  await smoke(config());
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
