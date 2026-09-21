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
