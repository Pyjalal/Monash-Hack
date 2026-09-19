import { expect, it } from "vitest";
import { isClassifyResult } from "./messages.js";

function classification(id: string) {
  return {
    id,
    category: "SI_REQUEST",
    confidence: 0.79,
    probabilities: { SI_REQUEST: 0.79, GENERAL: 0.21 },
    urgency: { level: "today", score: 2, confidence: 0.8, probabilities: { today: 1 } },
    expectation: "VERIFY_NOW",
    expectationConfidence: 0.8,
    model: "test-model",
    usage: null,
    elapsedMs: 12,
    questionVersion: "v1",
    cached: false,
  };
}

it("accepts the complete preview contract with nullable fields", () => {
  expect(isClassifyResult({ id: "email-1", status: "classified", classification: classification("email-1") })).toBe(true);
  expect(isClassifyResult({ id: "email-2", status: "classified", classification: { ...classification("email-2"), urgency: null, expectation: null, expectationConfidence: null } })).toBe(true);
});

it("rejects unknown categories, urgency ranges, and mismatched classification IDs", () => {
  expect(isClassifyResult({ id: "email-1", status: "classified", classification: { ...classification("email-1"), category: "MAYBE" } })).toBe(false);
  expect(isClassifyResult({ id: "email-1", status: "classified", classification: { ...classification("email-1"), urgency: { level: "soon", score: 4, confidence: 0.5, probabilities: {} } } })).toBe(false);
  expect(isClassifyResult({ id: "email-1", status: "classified", classification: classification("email-2") })).toBe(false);
});
