import { FIELD_NAMES } from "@cargolens/shared";

export type ComparableField = (typeof FIELD_NAMES)[number];

export function normaliseFieldValue(field: ComparableField, value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/gu, " ").trim().toLocaleUpperCase("en-US");
  if (field === "container_count") return compact.match(/\d[\d,]*/u)?.[0]?.replaceAll(",", "") ?? compact;
  if (field === "gross_weight_kg") return [...compact.matchAll(/\d[\d,]*(?:\.\d+)?/gu)].at(-1)?.[0]?.replaceAll(",", "") ?? compact;
  return compact.replace(/\s*\([A-Z]{5}\)\s*$/u, "").replace(/[^A-Z0-9]+/gu, " ").trim();
}

/**
 * Hard acceptance boundary for an AI "format equivalent" verdict. Removing
 * separators may join words, but no letters or numbers may be added or lost.
 */
export function isFormattingOnlyDifference(field: ComparableField, si: string, bl: string): boolean {
  if (field === "container_count" || field === "gross_weight_kg") return false;
  const signature = (value: string) => value.normalize("NFKC").toLocaleUpperCase("en-US")
    .replace(/\s*\([A-Z]{5}\)\s*$/u, "").replace(/&/gu, "AND").replace(/[^A-Z0-9]+/gu, "");
  const left = signature(si);
  const right = signature(bl);
  return left.length > 0 && left === right;
}

/**
 * A party can be represented by its legal name alone in one document and by
 * that same name followed by postal/contact lines in the other. This is never
 * applied to ports or numeric fields, and requires the added suffix to look
 * like address detail rather than a second legal entity.
 */
export function isPartyWithOmittedAddress(field: ComparableField, si: string, bl: string): boolean {
  if (field !== "shipper" && field !== "consignee" && field !== "notify_party") return false;

  const normalized = (value: string) => normaliseFieldValue(field, value) ?? "";
  const left = normalized(si);
  const right = normalized(bl);
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];

  if (!shorter || !longer.startsWith(`${shorter} `)) return false;

  const suffix = longer.slice(shorter.length).trim();
  return /\d/u.test(suffix) || /\b(?:P\s*O\s*BOX|ROAD|RD|STREET|ST|AVENUE|AVE|BOULEVARD|BLVD|TOWER|LEVEL|BLOCK|SUITE|UNIT|BUILDING)\b/u.test(suffix);
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
    && verdict.confidence >= minimumConfidence;
}
