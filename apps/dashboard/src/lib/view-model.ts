import type { InboxRow } from "./api";
import type { Case } from "@cargolens/shared";

export function filterRows(
  rows: InboxRow[],
  query: string,
  category: string,
  workflow: string,
  status = "",
) {
  const text = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (!text ||
        `${row.subject} ${row.from} ${row.id}`.toLowerCase().includes(text)) &&
      (!category || row.classification?.category === category) &&
      (!workflow || row.workflowState === workflow) &&
      (!status || row.status === status),
  );
}
export function counts(rows: InboxRow[]) {
  return {
    total: rows.length,
    classified: rows.filter((r) => r.status === "classified").length,
    failed: rows.filter((r) => r.status === "failed").length,
    pending: rows.filter((r) => r.status === "queued").length,
  };
}
export function canCompare(record: Case) {
  const d = record.decision;
  return (
    !!d &&
    d.category === "BL_COMPARISON" &&
    d.requestedAction === "VERIFY_DOCUMENTS" &&
    d.documentExpectation === "EXPECTED_NOW" &&
    !d.blockers.some((code) =>
      [
        "THREAD_CONTEXT_REQUIRED",
        "UNCERTAIN_INTENT",
        "LOW_CATEGORY_CONFIDENCE",
        "CATEGORY_EXPECTATION_CONFLICT",
      ].includes(code),
    )
  );
}
/**
 * Whether the seven-field SI/BL grid can say anything truthful about this case.
 *
 * Only BL_COMPARISON cases that expect documents now ever produce field
 * results. Rendering the grid for anything else reports a correct
 * classification as seven pending verifications that will never resolve.
 */
export type ComparisonStatus =
  | "UNCLASSIFIED"
  | "NOT_APPLICABLE"
  | "DEFERRED"
  | "NOT_RUN"
  | "RUN";
export function comparisonView(record: Case): {
  status: ComparisonStatus;
  applies: boolean;
  matched: number;
  resolved: number;
} {
  const d = record.decision;
  const results = d?.fieldResults ?? [];
  const matched = results.filter((row) => row.outcome === "MATCH").length;
  const resolved = results.length;
  const status: ComparisonStatus = !d
    ? "UNCLASSIFIED"
    : d.category !== "BL_COMPARISON"
      ? "NOT_APPLICABLE"
      : d.requestedAction === "REQUEST_DRAFT" ||
          d.documentExpectation === "DEFERRED"
        ? "DEFERRED"
        : resolved
          ? "RUN"
          : "NOT_RUN";
  return {
    status,
    applies: status === "RUN" || status === "NOT_RUN",
    matched,
    resolved,
  };
}
export function canDraft(record: Case) {
  return (
    !!record.decision &&
    !record.decision.blockers.includes("THREAD_CONTEXT_REQUIRED") &&
    [
      "CONFIRM_MATCH",
      "REQUEST_AMENDMENT",
      "REQUEST_DOCUMENTS",
      "REQUEST_CLARIFICATION",
    ].includes(record.decision.nextAction)
  );
}
export const human = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (first) => first.toUpperCase());
export const duration = (ms: number | null | undefined) =>
  ms == null
    ? "Not measured"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(2)} s`;
