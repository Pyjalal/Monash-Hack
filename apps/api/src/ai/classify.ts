import type { Questions } from "@typesafe-ai/sdk";
import type { Category, Classification, Email, Expectation, Urgency, Usage } from "@cargolens/shared";
import type { ClassificationMode } from "@cargolens/shared/questions";

export type Classifier = (email: Email) => Promise<Classification>;

export type ClassificationRecoverySignal = "LOW_CATEGORY_CONFIDENCE" | "CATEGORY_EXPECTATION_CONFLICT";
export function getClassificationRecoverySignals(classification: Classification): ClassificationRecoverySignal[] {
  const signals: ClassificationRecoverySignal[] = [];
  if (classification.confidence < 0.8) signals.push("LOW_CATEGORY_CONFIDENCE");
  if (classification.category !== "BL_COMPARISON" && classification.expectation === "VERIFY_NOW" &&
      (classification.expectationConfidence ?? 0) >= 0.5) signals.push("CATEGORY_EXPECTATION_CONFLICT");
  return signals;
}

export class InvalidJevResponseError extends Error {
  readonly code = "INVALID_JEV_RESPONSE";
  constructor(path: string) {
    super(`Invalid Jev response at ${path}`);
    this.name = "InvalidJevResponseError";
  }
}

interface ClassificationMetadata {
  questions: Questions;
  mode: ClassificationMode;
  elapsedMs: number;
  questionVersion: string;
}

export function parseClassification(raw: unknown, email: Email, meta: ClassificationMetadata): Classification & { usage: Usage } {
  const response = record(raw, "response");
  if (typeof response.model !== "string" || !response.model.trim()) fail("model");
  const usage = record(response.usage, "usage");
  for (const key of ["input_tokens", "output_tokens"])
    if (typeof usage[key] !== "number" || !Number.isSafeInteger(usage[key]) || usage[key] < 0) fail(`usage.${key}`);
  const answers = record(response.answers, "answers");
  sameKeys(answers, Object.keys(meta.questions), "answers");
  const intentQuestion = meta.questions.intent;
  if (!intentQuestion || intentQuestion.type !== "choice") fail("question.intent");
  const intent = parseChoice(answers.intent, Object.keys(intentQuestion.criteria), "intent");
  let urgency: Urgency | null = null;
  let expectation: Expectation | null = null;
  let expectationConfidence: number | null = null;
  if (meta.mode === "full") {
    const expectedUrgency = meta.questions.urgency;
    if (!expectedUrgency || expectedUrgency.type !== "score") fail("question.urgency");
    const answer = record(answers.urgency, "urgency");
    if (answer.type !== "score") fail("urgency.type");
    const keys = expectedUrgency.criteria.map((_criterion, index) => String(index));
    const probabilities = probabilityDistribution(answer.probabilities, keys, "urgency.probabilities");
    const confidence = probability(answer.confidence, "urgency.confidence");
    const legend = record(answer.legend, "urgency.legend");
    sameKeys(legend, keys, "urgency.legend");
    for (const key of keys)
      if (JSON.stringify(legend[key]) !== JSON.stringify(expectedUrgency.criteria[Number(key)])) fail(`urgency.legend.${key}`);
    const expectedScore = keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0);
    // Live Jev rounds each displayed probability and the score independently to two decimals.
    const scoreRoundingBudget = 0.005 * (keys.reduce((sum, key) => sum + Number(key), 0) + 1) + 1e-9;
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 ||
        answer.score > keys.length - 1 || Math.abs(answer.score - expectedScore) > scoreRoundingBudget) fail("urgency.score");
    const levels = ["routine", "week", "today", "blocking"] as const;
    urgency = { score: answer.score, confidence, probabilities, level: levels[Math.round(answer.score)] };
    const expectedExpectation = meta.questions.expectation;
    if (!expectedExpectation || expectedExpectation.type !== "choice") fail("question.expectation");
    const selected = parseChoice(answers.expectation, Object.keys(expectedExpectation.criteria), "expectation");
    expectation = selected.choice as Expectation;
    expectationConfidence = selected.confidence;
  }
  return {
    id: email.id,
    category: intent.choice as Category,
    confidence: intent.confidence,
    probabilities: intent.probabilities,
    urgency, expectation, expectationConfidence,
    model: response.model,
    usage: { input_tokens: usage.input_tokens as number, output_tokens: usage.output_tokens as number },
    elapsedMs: meta.elapsedMs,
    questionVersion: meta.questionVersion,
    cached: false,
    raw,
  };
}

function parseChoice(raw: unknown, allowed: string[], path: string) {
  const answer = record(raw, path);
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !allowed.includes(answer.choice)) fail(`${path}.choice`);
  const confidence = probability(answer.confidence, `${path}.confidence`);
  const probabilities = probabilityDistribution(answer.probabilities, allowed, `${path}.probabilities`);
  if (probabilities[answer.choice] + 0.000001 < Math.max(...Object.values(probabilities))) fail(`${path}.choice`);
  return { choice: answer.choice, confidence, probabilities };
}

function probabilityDistribution(raw: unknown, keys: string[], path: string) {
  const values = record(raw, path);
  sameKeys(values, keys, path);
  const checked: Record<string, number> = {};
  for (const key of keys) checked[key] = probability(values[key], `${path}.${key}`);
  const roundingBudget = keys.length * 0.005 + 1e-9;
  if (Math.abs(Object.values(checked).reduce((sum, value) => sum + value, 0) - 1) > roundingBudget) fail(`${path}.sum`);
  return checked;
}

function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(path);
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
  return value as Record<string, unknown>;
}

function sameKeys(value: Record<string, unknown>, keys: string[], path: string) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(path);
}

function fail(path: string): never {
  throw new InvalidJevResponseError(path);
}
