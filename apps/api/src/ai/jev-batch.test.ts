import { describe, expect, it } from "vitest";
import type { Email } from "@cargolens/shared";
import { createJevBatchProvider } from "./jev-batch.js";
import { InvalidJevResponseError } from "./classify.js";

const emails: Email[] = [
  { id: "first-secret", subject: "Send draft", body: "Please send the draft BL.", from: "a@example.test", contentScope: "full_message", attachments: [] },
  { id: "second-secret", subject: "Invoice", body: "Please explain this invoice charge.", from: "b@example.test", contentScope: "full_message", attachments: [] },
];

describe("packed Jev transport", () => {
  it("scopes every question to its indexed email, maps answers correctly and bills usage once", async () => {
    const provider = createJevBatchProvider({ apiKey: "test", mode: "intent-only", fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state.emails).toHaveLength(2);
      expect(JSON.stringify(body.state)).not.toContain("first-secret");
      expect(body.questions.e0_intent.instructions).toContain("emails[0].body_current");
      expect(body.questions.e1_intent.instructions).toContain("emails[1].body_current");
      const answers = Object.fromEntries(Object.keys(body.questions).map((key, index) => {
        const choice = index === 0 ? "BL_COMPARISON" : "INVOICE_QUERY";
        return [key, { type: "choice", choice, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(body.questions[key].criteria).map(label => [label, label === choice ? 1 : 0])) }];
      }));
      return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 400, output_tokens: 50 }, answers });
    } });
    const result = await provider.classifyBatch(emails);
    expect(result.classifications.map(row => [row.id, row.category])).toEqual([["first-secret", "BL_COMPARISON"], ["second-secret", "INVOICE_QUERY"]]);
    expect(result.usage).toEqual({ input_tokens: 400, output_tokens: 50 });
    expect(result.classifications.every(row => !("usage" in row))).toBe(true);
  });

  it("rejects a missing indexed answer rather than mapping the neighboring email", async () => {
    const provider = createJevBatchProvider({ apiKey: "test", mode: "intent-only", fetch: async () => Response.json({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 }, answers: {} }) });
    await expect(provider.classifyBatch(emails)).rejects.toBeInstanceOf(InvalidJevResponseError);
  });

  it("rejects empty or duplicate-ID batches before calling the model", async () => {
    let calls = 0;
    const provider = createJevBatchProvider({ apiKey: "test", fetch: async () => { calls++; return Response.json({}); } });
    await expect(provider.classifyBatch([])).rejects.toThrow(RangeError);
    await expect(provider.classifyBatch([emails[0], emails[0]])).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });

  it("rejects an oversized packed state before sending it", async () => {
    let calls = 0;
    const provider = createJevBatchProvider({ apiKey: "test", fetch: async () => { calls++; return Response.json({}); } });
    const large = Array.from({ length: 8 }, (_, index) => ({ ...emails[0], id: `large-${index}`, body: "shipment ".repeat(2000) }));
    await expect(provider.classifyBatch(large)).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });
});
