export type PairReferenceKind = "shipment" | "booking" | "bill_of_lading";
export interface PairReference { kind: PairReferenceKind; value: string }

const tokenPattern = "[A-Za-z0-9][A-Za-z0-9_./-]{3,63}";
const exactToken = new RegExp(`^${tokenPattern}$`, "u");

function normalizedLabel(label: string): string {
  return label.normalize("NFKC").replace(/\([^)]*\)/gu, " ").trim().toLowerCase().replace(/[._]/gu, " ").replace(/\s+/gu, " ").trim();
}

function add(result: PairReference[], kind: PairReferenceKind, value: string | undefined): void {
  const normalized = value?.trim().toUpperCase();
  if (normalized && exactToken.test(normalized) && !result.some(item => item.kind === kind && item.value === normalized)) result.push({ kind, value: normalized });
}

/** Extracts only explicit source-labelled shipment identifiers; it never infers an ID from arbitrary document text. */
export function pairReferences(label: string, value: string): PairReference[] {
  const normalized = normalizedLabel(label);
  const result: PairReference[] = [];
  if (/^shipment reference$/u.test(normalized)) add(result, "shipment", value);
  // Structured XLSX/DOCX templates use these labels for the same internal
  // shipment/order identifier. Keep the match source-labelled and take only
  // the first bounded token so trailing terms such as "FREIGHT PREPAID" do
  // not become part of the identifier.
  if (/^(?:bl instruction|bill of lading|order no)(?:\s*\([^)]*\))?$/u.test(normalized)) {
    add(result, "shipment", new RegExp(`^\\s*(${tokenPattern})(?=\\s|$)`, "u").exec(value)?.[1]);
  }
  if (/^booking (?:reference|number|no|ref)$/u.test(normalized)) add(result, "booking", value);
  if (/^(?:b\s*\/\s*l|bl|bill of lading) (?:number|no)$/u.test(normalized)) {
    add(result, "bill_of_lading", new RegExp(`^\\s*(${tokenPattern})(?=\\s|$)`, "u").exec(value)?.[1]);
    add(result, "booking", new RegExp(`\\bBOOKING\\s+(?:NO|NUMBER|REF(?:ERENCE)?)\\.?\\s*[:#-]?\\s*(${tokenPattern})`, "iu").exec(value)?.[1]);
  }
  return result;
}

export function referencesMatch(left: PairReference[], right: PairReference[]): boolean {
  if (!left.length || !right.length) return false;
  let shared = false;
  for (const kind of ['shipment', 'booking', 'bill_of_lading'] as const) {
    const a = new Set(left.filter(item => item.kind === kind).map(item => item.value));
    const b = new Set(right.filter(item => item.kind === kind).map(item => item.value));
    if (a.size > 1 || b.size > 1) return false;
    if (a.size && b.size) {
      if ([...a][0] !== [...b][0]) return false;
      shared = true;
    }
  }
  return shared;
}
