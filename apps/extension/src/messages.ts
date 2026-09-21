import type { PreviewEmail } from "./fingerprints.js";
import type { MailSource } from "./adapters.js";

export interface QueueItem {
  source: MailSource;
  context?: string;
  bypassCache?: boolean;
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
  documentIssue?: string | null;
  documentIssueConfidence?: number | null;
  bodyDocument?: string | null;
  bodyDocumentConfidence?: number | null;
  cached: boolean;
  /** Smart-filter probabilities keyed by rule id; absent when no rules were active or evaluation failed. */
  rules?: Record<string, number>;
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
  | { type: "CLASSIFY_ROWS"; items: QueueItem[]; epoch: number }
  | { type: "RETRY_ROW"; item: QueueItem; epoch: number; bypassCache?: boolean }
  | { type: "CHECK_REVISION" }
  | { type: "CLASSIFY_RESULTS"; items: RowResultMessage[]; epoch: number; revision?: string }
  | { type: "TOGGLE_ENABLED" }
  | { type: "GET_SETTINGS" }
  | { type: "SET_ENABLED"; enabled: boolean }
  | { type: "SET_SETTINGS"; enabled: boolean; apiUrl: string; inbox?: unknown }
  | { type: "SETTINGS_UPDATED"; enabled: boolean; apiUrl: string; epoch: number; inbox?: unknown };

const categories = new Set(["BL_COMPARISON", "SI_REQUEST", "INVOICE_QUERY", "GENERAL", "SPAM", "UNCERTAIN"]);
const urgencyLevels = new Set(["routine", "week", "today", "blocking"]);
const expectations = new Set(["FUTURE_DRAFT", "VERIFY_NOW", "REPORTS_MISSING", "UNCLEAR"]);
const documentIssues = new Set(["NONE", "REPORTS_MISSING", "WRONG_DOCS", "UNCLEAR"]);
const bodyDocuments = new Set(["HAS_SI_BL_CONTENT", "NO_SI_BL_CONTENT", "UNCLEAR"]);

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteUrgencyScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3;
}

function probabilityRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => finiteProbability(entry));
}

export function isClassifyResult(value: unknown): value is RowClassifyResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (typeof result.id !== "string" || (result.status !== "classified" && result.status !== "error")) return false;
  if (result.status === "classified") {
    if (!result.classification || typeof result.classification !== "object") return false;
    const classification = result.classification as Record<string, unknown>;
    if (classification.id !== result.id || typeof classification.id !== "string" || !categories.has(classification.category as string) || !finiteProbability(classification.confidence)) return false;
    if (!probabilityRecord(classification.probabilities)) return false;
    if (classification.urgency !== null) {
      if (typeof classification.urgency !== "object") return false;
      const urgency = classification.urgency as Record<string, unknown>;
      if (!urgencyLevels.has(urgency.level as string) || !finiteUrgencyScore(urgency.score) || !finiteProbability(urgency.confidence) || !probabilityRecord(urgency.probabilities)) return false;
    }
    if (classification.expectation !== null && !expectations.has(classification.expectation as string)) return false;
    if (classification.expectationConfidence !== null && !finiteProbability(classification.expectationConfidence)) return false;
    if (classification.documentIssue !== undefined && classification.documentIssue !== null && !documentIssues.has(classification.documentIssue as string)) return false;
    if (classification.documentIssueConfidence !== undefined && classification.documentIssueConfidence !== null && !finiteProbability(classification.documentIssueConfidence)) return false;
    if (classification.bodyDocument !== undefined && classification.bodyDocument !== null && !bodyDocuments.has(classification.bodyDocument as string)) return false;
    if (classification.bodyDocumentConfidence !== undefined && classification.bodyDocumentConfidence !== null && !finiteProbability(classification.bodyDocumentConfidence)) return false;
    if (typeof classification.model !== "string" || classification.model.length === 0 || !finiteProbability(classification.confidence)) return false;
    if (classification.usage !== null) {
      if (typeof classification.usage !== "object") return false;
      const usage = classification.usage as Record<string, unknown>;
      if (!Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens) || (usage.input_tokens as number) < 0 || (usage.output_tokens as number) < 0) return false;
    }
    if (typeof classification.elapsedMs !== "number" || !Number.isFinite(classification.elapsedMs) || classification.elapsedMs < 0 || typeof classification.questionVersion !== "string" || classification.questionVersion.length === 0 || typeof classification.cached !== "boolean") return false;
    if (classification.usageRequestId !== undefined && typeof classification.usageRequestId !== "string") return false;
    if (classification.rules !== undefined && !probabilityRecord(classification.rules)) return false;
    return true;
  }
  if (!result.error || typeof result.error !== "object") return false;
  const error = result.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}
