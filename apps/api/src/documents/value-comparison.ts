import { FIELD_NAMES } from "@cargolens/shared";

export const COMPARISON_POLICY_VERSION = "source-normalization-v2";

export type ComparableField = (typeof FIELD_NAMES)[number];

export function normaliseFieldValue(field: ComparableField, value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/gu, " ").trim().toLocaleUpperCase("en-US");
  if (field === "container_count") {
    const match = compact.match(/^(\d+)(?:\s*[X×]\s*(?:20|40|45)\s*['’]?\s*(?:HC|HQ|GP|DC|FCL))?$/u);
    const count = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(count) && count > 0 ? String(count) : null;
  }
  if (field === "gross_weight_kg") {
    const match = compact.match(/^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(KG|KGS|KILOGRAMS?|MT|MTS|TONNES?)$/u);
    if (!match) return null;
    const kg = Number(match[1].replaceAll(",", "")) * (/^(MT|MTS|TONNE)/u.test(match[2]) ? 1000 : 1);
    return Number.isFinite(kg) && kg > 0 ? String(kg) : null;
  }
  return compact.normalize("NFKC").replace(/&/gu, " AND ").replace(/[^\p{L}\p{N}]+/gu, " ").trim() || null;
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
  verdict: { equivalent: boolean; confidence: number | null } | undefined,
  minimumConfidence = 0.8,
): boolean {
  return (isFormattingOnlyDifference(field, si, bl) || isPartyWithOmittedAddress(field, si, bl))
    && verdict?.equivalent === true
    && verdict.confidence !== null
    && Number.isFinite(verdict.confidence) && verdict.confidence <= 1
    && verdict.confidence >= minimumConfidence;
}
