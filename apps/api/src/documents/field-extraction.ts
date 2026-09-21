import { FIELD_NAMES } from "@cargolens/shared";
import type { AttachmentReadResult, LabelValueCandidate } from "./index.js";

export type FieldName = (typeof FIELD_NAMES)[number];
export type DocumentRole = "si" | "bl";
export type ExtractionMethod = "deterministic" | "llm_fallback" | "vision_recovery";

export interface ExtractedDocumentField {
  value: string;
  candidateId: string;
  confidence: number;
  method: ExtractionMethod;
}

export interface FormatAssessment {
  matchesExpectedFormat: boolean;
  reasons: string[];
  detectedRole: DocumentRole | "other" | "ambiguous" | "unknown";
}

export interface FallbackSelection {
  detectedRole: DocumentRole | "other";
  fields: Partial<Record<FieldName, { candidateId?: string; value?: string; confidence: number | null }>>;
}

export interface FallbackRequest {
  expectedRole: DocumentRole;
  text: string;
  candidates: LabelValueCandidate[];
  /** Fields that do not already have one trustworthy native candidate. */
  requestedFields: FieldName[];
}

export interface DocumentFieldExtraction {
  status: "complete" | "wrong_document_type" | "unresolved" | "unreadable";
  method: ExtractionMethod | null;
  assessment: FormatAssessment;
  /** Structured model output before source-candidate and confidence validation. */
  fallbackSelection?: FallbackSelection;
  fallbackError?: string;
  fields: Partial<Record<FieldName, ExtractedDocumentField>>;
  unresolvedFields: FieldName[];
}

export type FallbackExtractor = (request: FallbackRequest) => Promise<FallbackSelection>;

const LABEL_ALIASES: Record<FieldName, readonly string[]> = {
  shipper: ["shipper", "shipper exporter", "shipper principal or seller"],
  consignee: ["consignee", "consignee non negotiable", "to the order of"],
  notify_party: ["notify", "notify party", "notify party intermediate consignee"],
  port_of_loading: ["port of loading", "port of loading pol", "pol", "load port"],
  port_of_discharge: ["port of discharge", "port of discharge pod", "discharge port", "pod"],
  container_count: ["no of containers", "no of containers or packages", "container count", "total containers"],
  gross_weight_kg: ["gross weight", "gross weight kg", "gross weight kgs", "gross wt kgs", "gross weight 毛重 kgs", "total gross weight", "total gross weight kg", "total gross weight kgs", "total gross weight nn", "total gross wt kgs"],
};

const aliasIndex = new Map<string, FieldName>(Object.entries(LABEL_ALIASES).flatMap(([field, aliases]) =>
  aliases.map(alias => [alias, field as FieldName] as const)));

export function normalizedLabel(value: string): string {
  const words = value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\p{Script=Han}+/gu, " ").replace(/[./_-]+/gu, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/gu);
  return words.filter((word, index) => word !== words[index - 1]).join(" ");
}

export function detectedRole(text: string): FormatAssessment["detectedRole"] {
  const header = text.split(/\r?\n/gu).filter(line => line.trim()).slice(0, 3).join("\n").slice(0, 500);
  const instruction = /\bshipping\s+instructions?\b|\b(?:bl|bill\s+of\s+lading)\s+instruction\b/iu.test(header);
  const si = instruction;
  const bl = header.split("\n").some(line => /\bbill\s+of\s+lading\b|\bdraft\s+b\s*\/\s*l\b/iu.test(line)
    && !/\b(?:bl|bill\s+of\s+lading)\s+instruction\b/iu.test(line));
  const other = /\bpacking\s+list\b|\bcommercial\s+invoice\b|\bcertificate\s+of\s+origin\b/iu.test(header);
  if (other && !si && !bl) return "other";
  if ((si && bl) || (other && (si || bl))) return "ambiguous";
  if (si) return "si";
  if (bl) return "bl";
  return "unknown";
}

function plausibleValue(field: FieldName, value: string): boolean {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return false;
  if (/^(?:\?+|_+|[-–—]+|TBA|TBD|N\s*\/\s*A|PENDING|NOT\s+AVAILABLE)(?:\s*(?:KG|KGS|MT|MTS))?$/iu.test(compact)) return false;
  if (field === "container_count") return /\d/u.test(compact);
  if (field === "gross_weight_kg") return /\d/u.test(compact);
  return /[\p{L}\p{N}]/u.test(compact);
}

export function candidatesByField(candidates: LabelValueCandidate[]): Record<FieldName, LabelValueCandidate[]> {
  const result = {} as Record<FieldName, LabelValueCandidate[]>;
  for (const field of FIELD_NAMES) result[field] = [];
  for (const candidate of candidates) {
    const field = aliasIndex.get(normalizedLabel(candidate.label));
    if (field) result[field].push(candidate);
  }
  return result;
}

export function assessExpectedFormat(reading: AttachmentReadResult, expectedRole: DocumentRole): FormatAssessment {
  const reasons: string[] = [];
  const role = detectedRole(reading.text);
  if (role !== expectedRole) reasons.push(role === "ambiguous" ? "conflicting_document_role_markers" : role === "unknown" ? "missing_document_role_marker" : "unexpected_document_role");
  const grouped = candidatesByField(reading.candidates ?? []);
  for (const field of FIELD_NAMES) {
    if (grouped[field].length === 0) reasons.push(`missing_expected_label:${field}`);
    else if (grouped[field].length > 1) reasons.push(`ambiguous_expected_label:${field}`);
    else if (!plausibleValue(field, grouped[field][0].value)) reasons.push(`implausible_value:${field}`);
  }
  return { matchesExpectedFormat: reasons.length === 0, reasons, detectedRole: role };
}

function deterministicFields(reading: AttachmentReadResult): Record<FieldName, ExtractedDocumentField> {
  const grouped = candidatesByField(reading.candidates ?? []);
  return Object.fromEntries(FIELD_NAMES.map(field => {
    const candidate = grouped[field][0];
    return [field, { value: candidate.value, candidateId: candidate.id, confidence: 1, method: "deterministic" }];
  })) as Record<FieldName, ExtractedDocumentField>;
}

export function supportedNativeFields(reading: AttachmentReadResult): Partial<Record<FieldName, ExtractedDocumentField>> {
  const grouped = candidatesByField(reading.candidates ?? []);
  const fields: Partial<Record<FieldName, ExtractedDocumentField>> = {};
  for (const field of FIELD_NAMES) {
    const candidates = grouped[field];
    if (candidates.length !== 1 || !plausibleValue(field, candidates[0].value)) continue;
    fields[field] = { value: candidates[0].value, candidateId: candidates[0].id, confidence: 1, method: "deterministic" };
  }
  return fields;
}

function boundedCandidates(candidates: LabelValueCandidate[], maximum: number): LabelValueCandidate[] {
  if (candidates.length <= maximum) return candidates;
  const leading = Math.ceil(maximum * 0.75);
  return [...candidates.slice(0, leading), ...candidates.slice(-(maximum - leading))];
}

export async function extractDocumentFields(
  reading: AttachmentReadResult,
  expectedRole: DocumentRole,
  fallback: FallbackExtractor,
  options: { minimumFallbackConfidence?: number; maximumFallbackCandidates?: number } = {},
): Promise<DocumentFieldExtraction> {
  const assessment = assessExpectedFormat(reading, expectedRole);
  if (reading.status !== "READABLE") return { status: "unreadable", method: null, assessment, fields: {}, unresolvedFields: [...FIELD_NAMES] };
  if (assessment.detectedRole === "ambiguous") return { status: "unresolved", method: null, assessment, fields: {}, unresolvedFields: [...FIELD_NAMES] };
  if (assessment.detectedRole === "other" || (assessment.detectedRole !== "unknown" && assessment.detectedRole !== expectedRole)) return {
    status: "wrong_document_type", method: "deterministic", assessment, fields: {}, unresolvedFields: [...FIELD_NAMES],
  };
  if (assessment.matchesExpectedFormat) return {
    status: "complete", method: "deterministic", assessment, fields: deterministicFields(reading), unresolvedFields: [],
  };

  const candidates = boundedCandidates(reading.candidates ?? [], options.maximumFallbackCandidates ?? 80);
  const nativeFields = supportedNativeFields(reading);
  const requestedFields = FIELD_NAMES.filter(field => !nativeFields[field]);
  let selection: FallbackSelection;
  try {
    selection = await fallback({ expectedRole, text: reading.text.slice(0, 16_000), candidates, requestedFields });
  } catch {
    return {
      status: "unresolved", method: "llm_fallback",
      assessment: { ...assessment, reasons: [...assessment.reasons, "fallback_failed"] },
      fallbackError: "Field recovery failed",
      fields: nativeFields, unresolvedFields: requestedFields,
    };
  }
  if (selection.detectedRole !== expectedRole) return {
    status: "unresolved", method: "llm_fallback", assessment: { ...assessment, reasons: [...assessment.reasons, "fallback_role_conflict"] }, fallbackSelection: selection,
    fields: nativeFields, unresolvedFields: requestedFields,
  };

  const minimumConfidence = options.minimumFallbackConfidence ?? 0.75;
  const available = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const fields: Partial<Record<FieldName, ExtractedDocumentField>> = { ...nativeFields };
  for (const field of requestedFields) {
    const selected = selection.fields[field];
    if (!selected || selected.confidence === null || !Number.isFinite(selected.confidence) || selected.confidence > 1 || selected.confidence < minimumConfidence) continue;

    let value: string | undefined;
    let candidateId: string | undefined;

    if (selected.candidateId && available.has(selected.candidateId)) {
      const candidate = available.get(selected.candidateId)!;
      value = candidate.value;
      candidateId = candidate.id;
    } else if (typeof selected.value === "string" && selected.value.trim()) {
      const trimmed = selected.value.trim();
      const compactDoc = reading.text.replace(/\s+/gu, " ");
      const compactVal = trimmed.replace(/\s+/gu, " ");
      if (compactDoc.includes(compactVal) || reading.text.includes(trimmed)) {
        value = trimmed;
        const matchingCandidate = candidates.find(c => c.value.trim() === trimmed || c.value.includes(trimmed));
        candidateId = matchingCandidate?.id ?? `candidate_llm_${field}`;
      }
    }

    if (!value || !candidateId || !plausibleValue(field, value)) continue;
    fields[field] = { value, candidateId, confidence: selected.confidence, method: "llm_fallback" };
  }
  const unresolvedFields = FIELD_NAMES.filter(field => !fields[field]);
  return {
    status: unresolvedFields.length ? "unresolved" : "complete",
    method: "llm_fallback",
    assessment,
    fallbackSelection: selection,
    fields,
    unresolvedFields,
  };
}
