import { describe, expect, it } from "vitest";
import type { Email } from "@cargolens/shared";
import { buildQuestions } from "@cargolens/shared/questions";
import { getClassificationRecoverySignals, InvalidJevResponseError, parseClassification } from "./classify.js";

const email: Email = { id: "record-1", subject: "Please check BL", from: "a@example.test", body: "Check the BL.", contentScope: "full_message", attachments: [] };
const questions = buildQuestions("concise", "full");
const metadata = { questions, mode: "full" as const, elapsedMs: 123, questionVersion: "test-v1" };
const valid = () => ({
  model: "jev-1.13.0", usage: { input_tokens: 101, output_tokens: 30 },
  answers: {
    intent: { type: "choice", choice: "BL_COMPARISON", confidence: 0.9,
      probabilities: { BL_COMPARISON: 0.95, SI_REQUEST: 0.01, INVOICE_QUERY: 0.01, GENERAL: 0.01, SPAM: 0.01, UNCERTAIN: 0.01 } },
    urgency: { type: "score", score: 2.8, confidence: 0.8,
      legend: Object.fromEntries(questions.urgency.criteria.map((level: unknown, index: number) => [String(index), level])),
      probabilities: { "0": 0, "1": 0, "2": 0.2, "3": 0.8 } },
    expectation: { type: "choice", choice: "VERIFY_NOW", confidence: 1,
      probabilities: { FUTURE_DRAFT: 0, VERIFY_NOW: 1, REPORTS_MISSING: 0, UNCLEAR: 0 } },
  },
});

describe("Jev response validation", () => {
  it("returns typed classification with provider usage and original correlation ID", () => {
    const result = parseClassification(valid(), email, metadata);
    expect(result).toMatchObject({ id: "record-1", category: "BL_COMPARISON", urgency: { level: "blocking", score: 2.8 },
      expectation: "VERIFY_NOW", model: "jev-1.13.0", usage: { input_tokens: 101, output_tokens: 30 }, elapsedMs: 123, cached: false });
  });

  it.each([
    ["missing answer", (r: ReturnType<typeof valid>) => { delete (r.answers as Partial<typeof r.answers>).urgency; }],
    ["unexpected answer", (r: ReturnType<typeof valid>) => { Object.assign(r.answers, { extra: {} }); }],
    ["unknown category", (r: ReturnType<typeof valid>) => { r.answers.intent.choice = "CLEARED"; }],
    ["invalid probability", (r: ReturnType<typeof valid>) => { r.answers.intent.probabilities.GENERAL = Number.NaN; }],
    ["invalid sum", (r: ReturnType<typeof valid>) => { r.answers.intent.probabilities.GENERAL = 0.5; }],
    ["wrong probability keys", (r: ReturnType<typeof valid>) => { Object.assign(r.answers.intent.probabilities, { OTHER: 0 }); }],
    ["choice not maximum", (r: ReturnType<typeof valid>) => { r.answers.intent.choice = "GENERAL"; }],
    ["invalid confidence", (r: ReturnType<typeof valid>) => { r.answers.intent.confidence = 2; }],
    ["invalid weighted score", (r: ReturnType<typeof valid>) => { r.answers.urgency.score = 0; }],
    ["wrong score legend", (r: ReturnType<typeof valid>) => { r.answers.urgency.legend["0"] = "Made up"; }],
    ["invalid usage", (r: ReturnType<typeof valid>) => { r.usage.input_tokens = -1; }],
  ])("rejects %s without silently substituting GENERAL", (_name, mutate) => {
    const response = valid(); mutate(response);
    expect(() => parseClassification(response, email, metadata)).toThrow(InvalidJevResponseError);
  });

  it("accepts category-only output with explicitly absent speculative dimensions", () => {
    const response = valid();
    const result = parseClassification({ ...response, answers: { intent: response.answers.intent } }, email,
      { ...metadata, mode: "intent-only", questions: buildQuestions("concise", "intent-only") });
    expect(result.urgency).toBeNull();
    expect(result.expectation).toBeNull();
    expect(result.expectationConfidence).toBeNull();
  });

  it("accepts provider probabilities rounded independently to two decimal places", () => {
    const response = valid();
    response.answers.intent.probabilities.BL_COMPARISON = 0.94;
    expect(parseClassification(response, email, metadata).category).toBe("BL_COMPARISON");
  });

  it("accepts a provider score computed before displayed probabilities were rounded", () => {
    const response = valid();
    response.answers.urgency.probabilities = { "0": 0.97, "1": 0, "2": 0, "3": 0.03 };
    response.answers.urgency.score = 0.11;
    expect(parseClassification(response, email, metadata).urgency?.score).toBe(0.11);
  });
});

describe("classification recovery signals", () => {
  it("flags low confidence without changing the category", () => {
    const result = { ...parseClassification(valid(), email, metadata), confidence: 0.79 };
    expect(getClassificationRecoverySignals(result)).toEqual(["LOW_CATEGORY_CONFIDENCE"]);
    expect(result.category).toBe("BL_COMPARISON");
  });

  it("flags disagreement between intent and an independently supported verification request", () => {
    const result = { ...parseClassification(valid(), email, metadata), category: "SI_REQUEST" as const, expectationConfidence: 0.6 };
    expect(getClassificationRecoverySignals(result)).toEqual(["CATEGORY_EXPECTATION_CONFLICT"]);
    expect(result.category).toBe("SI_REQUEST");
  });

  it("does not invent conflict from weak or absent expectation evidence", () => {
    const result = { ...parseClassification(valid(), email, metadata), category: "SI_REQUEST" as const, confidence: 0.8 };
    expect(getClassificationRecoverySignals({ ...result, expectationConfidence: 0.49 })).toEqual([]);
    expect(getClassificationRecoverySignals({ ...result, expectation: null, expectationConfidence: null })).toEqual([]);
  });
});
