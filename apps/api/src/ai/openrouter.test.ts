import { describe, expect, it, vi } from "vitest";
import { createOpenRouterDecisionClient } from "./openrouter.js";

describe("OpenRouter Jev transport", () => {
  it("sends a Decisions request and normalizes OpenRouter usage fields", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "typesafe/jev-1.13", state: { email: "draft BL" } });
      return new Response(JSON.stringify({ model: "typesafe/jev-1.13", usage: { prompt_tokens: 12, completion_tokens: 0 }, answers: {} }), { status: 200 });
    });
    const client = createOpenRouterDecisionClient({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
    await expect(client.systemOne({ state: { email: "draft BL" }, questions: {} })).resolves.toMatchObject({
      model: "typesafe/jev-1.13", usage: { input_tokens: 12, output_tokens: 0 }, answers: {},
    });
  });
});
