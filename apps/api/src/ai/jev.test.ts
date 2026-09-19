import { describe, expect, it } from "vitest";
import type { Email } from "@cargolens/shared";
import { APIUserAbortError, AuthenticationError } from "@typesafe-ai/sdk";
import { createJevProvider } from "./jev.js";

const email: Email = { id: "private-id", subject: "Send draft BL", from: "sender@example.test", body: "Please send us your draft BL.", contentScope: "full_message", attachments: [] };
const response = () => ({ model: "jev-1.13.0", usage: { input_tokens: 120, output_tokens: 20 }, answers: {
  intent: { type: "choice", choice: "BL_COMPARISON", confidence: 1,
    probabilities: { BL_COMPARISON: 1, SI_REQUEST: 0, INVOICE_QUERY: 0, GENERAL: 0, SPAM: 0, UNCERTAIN: 0 } },
} });

describe("Jev provider transport boundary", () => {
  it("retries a 429 through the SDK and keeps credentials out of semantic input", async () => {
    let attempts = 0;
    const provider = createJevProvider({ apiKey: "test-key-not-real", mode: "intent-only", maxRetries: 1,
      fetch: async (_url, init) => {
        attempts++;
        const body = JSON.parse(String(init?.body));
        expect(JSON.stringify(body.state)).not.toContain("private-id");
        expect(JSON.stringify(body)).not.toContain("test-key-not-real");
        expect(body.model).toBe("jev-1.13.0");
        return attempts === 1
          ? new Response("busy", { status: 429, headers: { "retry-after-ms": "0" } })
          : Response.json(response());
      },
    });
    expect((await provider.classify(email)).category).toBe("BL_COMPARISON");
    expect(attempts).toBe(2);
  });

  it("does not retry authentication errors or emit a fake classification", async () => {
    let attempts = 0;
    const provider = createJevProvider({ apiKey: "test", mode: "intent-only", fetch: async () => {
      attempts++; return new Response("unauthorized", { status: 401 });
    } });
    await expect(provider.classify(email)).rejects.toBeInstanceOf(AuthenticationError);
    expect(attempts).toBe(1);
  });

  it("bounds the full retry lifecycle with a caller deadline", async () => {
    const provider = createJevProvider({ apiKey: "test", mode: "intent-only", timeoutMs: 5000, totalTimeoutMs: 20,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    await expect(provider.classify(email)).rejects.toBeInstanceOf(APIUserAbortError);
  });
});
