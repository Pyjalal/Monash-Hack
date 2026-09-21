import { FIELD_NAMES } from "@cargolens/shared";
import { canonicalPort, PORT_POLICY_VERSION } from "./port-codes.js";

export const COMPARISON_POLICY_VERSION = `source-normalization-v7:${PORT_POLICY_VERSION}`;
export const SEMANTIC_SAME_CONFIDENCE = 0.9;
export const SEMANTIC_DIFFERENT_CONFIDENCE = 0.85;

export interface SemanticVerdict { equivalent: boolean; confidence: number | null }

/** Converts the model's probability of sameness into a directional verdict. */
export function semanticVerdictFromSameProbability(probability: number): SemanticVerdict | undefined {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return undefined;
  return probability >= 0.5
    ? { equivalent: true, confidence: probability }
    : { equivalent: false, confidence: 1 - probability };
}

export function isConfidentSemanticDifference(verdict: SemanticVerdict | undefined): boolean {
  return verdict?.equivalent === false
    && verdict.confidence !== null
    && Number.isFinite(verdict.confidence)
    && verdict.confidence >= SEMANTIC_DIFFERENT_CONFIDENCE
    && verdict.confidence <= 1;
}

/** Supplies the kilograms unit implied by an explicit gross-weight source label. */
export function weightValueWithSourceUnit(value: string, label: string): string {
  if (!/^[\d,.]+$/u.test(value.trim())) return value;
  const units = label.toUpperCase().match(/\b(?:KG|KGS|KILOGRAMS?|MT|MTS|TONNES?)\b/gu) ?? [];
  return units.length === 1 ? `${value.trim()} ${units[0]}` : value;
}

export type ComparableField = (typeof FIELD_NAMES)[number];

export function normaliseFieldValue(field: ComparableField, value: string | null): string | null {
  if (!value) return null;
  const compact = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleUpperCase("en-US");
  if (field === "container_count") {
    const written = compact.match(/^([A-Z]+) \((\d+)\) CONTAINERS? - ((?:20|40|45)\s*['’]?\s*(?:HC|HQ|GP|DC|FCL))$/u);
    if (written) {
      const words = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE"];
      const count = Number(written[2]);
      return count > 0 && words[count] === written[1] ? String(count) : null;
    }
    const match = compact.match(/^(\d+)(?:\s*[X×]\s*(?:20|40|45)\s*['’]?\s*(?:HC|HQ|GP|DC|FCL))?$/u);
    const count = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(count) && count > 0 ? String(count) : null;
  }
  if (field === "gross_weight_kg") {
    const weight = compact.replace(/^\(\s*(KGS?)\s*\)\s*:\s*(.+)$/u, (_match, unit: string, amount: string) => /^[\d,.]+$/u.test(amount) ? `${amount} ${unit}` : amount);
    const match = weight.match(/^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(KG|KGS|KILOGRAMS?|MT|MTS|TONNES?|METRIC TONNES?)$/u);
    if (!match) return null;
    const unit = match[2] ?? "KG";
    const kg = Number(match[1].replaceAll(",", "")) * (/^(MT|MTS|TONNE|METRIC TONNE)/u.test(unit) ? 1000 : 1);
    return Number.isFinite(kg) && kg > 0 ? String(kg) : null;
  }
  const text = compact.replace(/&/gu, " AND ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return (field === "port_of_loading" || field === "port_of_discharge" ? canonicalPort(text) : text) || null;
}

/**
 * Hard acceptance boundary for an AI "format equivalent" verdict. Removing
 * separators may join words, but no letters or numbers may be added or lost.
 */
export function isFormattingOnlyDifference(field: ComparableField, si: string, bl: string): boolean {
  if (field === "container_count" || field === "gross_weight_kg") return false;
  const signature = (value: string) => value.normalize("NFKC").toLocaleUpperCase("en-US")
    .replace(/&/gu, "AND").replace(/[^\p{L}\p{N}]+/gu, "");
  const left = signature(si);
  const right = signature(bl);
  return left.length > 0 && left === right;
}

export function isPartyWithOmittedAddress(field: ComparableField, si: string, bl: string): boolean {
  if (field !== "shipper" && field !== "consignee" && field !== "notify_party") return false;

  void si; void bl;
  return false;
}

export function acceptFormattingVerdict(
  field: ComparableField,
  si: string,
  bl: string,
  verdict: SemanticVerdict | undefined,
  minimumConfidence = SEMANTIC_SAME_CONFIDENCE,
): boolean {
  return (isFormattingOnlyDifference(field, si, bl) || isPartyWithOmittedAddress(field, si, bl))
    && verdict?.equivalent === true
    && verdict.confidence !== null
    && Number.isFinite(verdict.confidence) && verdict.confidence <= 1
    && verdict.confidence >= minimumConfidence;
}
