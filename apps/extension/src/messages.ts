import type { PreviewEmail } from "./fingerprints.js";
import type { MailSource } from "./adapters.js";

export interface QueueItem {
  source: MailSource;
  rowKey: string;
  fingerprint: string;
  email: PreviewEmail;
}

export interface ClassificationPreview {
  id: string;
  category: string;
  confidence: number;
  urgency: { level: string; score: number; confidence: number } | null;
  expectation: string | null;
  expectationConfidence: number | null;
  cached: boolean;
}

export type RowClassifyResult =
  | { id: string; status: "classified"; classification: ClassificationPreview }
  | { id: string; status: "error"; error: { code: string; message: string } };

export interface RowResultMessage {
  rowKey: string;
  fingerprint: string;
  result: RowClassifyResult;
}

export type ExtensionMessage =
  | { type: "CLASSIFY_ROWS"; items: QueueItem[] }
  | { type: "RETRY_ROW"; item: QueueItem }
  | { type: "CLASSIFY_RESULTS"; items: RowResultMessage[] }
  | { type: "TOGGLE_ENABLED" }
  | { type: "GET_SETTINGS" }
  | { type: "SET_ENABLED"; enabled: boolean };

export function isClassifyResult(value: unknown): value is RowClassifyResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (typeof result.id !== "string" || (result.status !== "classified" && result.status !== "error")) return false;
  if (result.status === "classified") {
    if (!result.classification || typeof result.classification !== "object") return false;
    const classification = result.classification as Record<string, unknown>;
    const confidence = classification.confidence;
    if (typeof classification.category !== "string" || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false;
    if (classification.urgency !== null && classification.urgency !== undefined) {
      if (typeof classification.urgency !== "object") return false;
      const urgency = classification.urgency as Record<string, unknown>;
      if (typeof urgency.level !== "string" || typeof urgency.score !== "number" || !Number.isFinite(urgency.score)) return false;
    }
    return true;
  }
  if (!result.error || typeof result.error !== "object") return false;
  const error = result.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}
