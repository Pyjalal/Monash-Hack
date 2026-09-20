import { OperationalDecisionSchema, SubmissionRowSchema, type Submission, type SubmissionRow } from '@cargolens/shared';
import type { CaseRecord } from '../../../apps/api/src/store.js';

export const EXPORT_VERSION = 'conservative-projection-v2';
export function projectCase(record: CaseRecord): { row: SubmissionRow; rule: string; lossy: boolean } {
  if (record.status !== 'classified' || !record.classification || !record.decision) throw new Error('CASE_NOT_CLASSIFIED');
  const decision = OperationalDecisionSchema.parse(record.decision);
  if (decision.sourceVersion !== record.sourceVersion || decision.category !== record.classification.category || decision.category === 'UNCERTAIN') throw new Error('UNRESOLVED_CATEGORY_OR_STALE_DECISION');
  const base = { category: decision.category, status: 'OK' as const, review_reason: null, defect_fields: [], has_defect: false };
  if (decision.category !== 'BL_COMPARISON') {
    if (decision.workflowState !== 'NOT_APPLICABLE' || decision.blockers.length || decision.knownMismatches.length) throw new Error('UNRESOLVED_NON_COMPARISON');
    return { row: SubmissionRowSchema.parse(base), rule: 'NOT_APPLICABLE', lossy: false };
  }
  if (decision.requestedAction === 'REQUEST_DRAFT' && decision.documentExpectation === 'DEFERRED' && decision.verificationState === 'NOT_STARTED' &&
    decision.workflowState === 'AWAITING_DOCUMENTS' && !decision.blockers.length && !decision.fieldResults.length) {
    return { row: SubmissionRowSchema.parse(base), rule: 'DEFERRED_DRAFT_REQUEST', lossy: true };
  }
  if (decision.verificationState === 'COMPLETE') {
    return { row: SubmissionRowSchema.parse({ ...base, status: decision.knownMismatches.length ? 'MISMATCH' : 'OK', defect_fields: decision.knownMismatches, has_defect: !!decision.knownMismatches.length }), rule: 'COMPLETE_COMPARISON', lossy: false };
  }
  // A mismatch plus a blocker cannot be represented faithfully by the organizer row.
  if (decision.knownMismatches.length) throw new Error('MISMATCH_WITH_UNRESOLVED_EVIDENCE');
  const reasons: Record<string, SubmissionRow['review_reason']> = { MISSING_SI: 'missing_attachment', MISSING_BL: 'missing_attachment',
    MISSING_ATTACHMENT: 'missing_attachment', WRONG_DOC_TYPE: 'wrong_doc_type', UNREADABLE: 'unreadable', OCR_REQUIRED: 'unreadable', MISSING_VALUE: 'missing_value' };
  const mapped = [...new Set(decision.blockers.map(blocker => reasons[blocker] ??
    (/^(shipper|consignee|notify_party|port_of_loading|port_of_discharge|container_count|gross_weight_kg):MISSING$/.test(blocker) ? 'missing_value' : undefined)))];
  if (!mapped.length || mapped.some(reason => !reason) || mapped.length !== 1) throw new Error('UNSUPPORTED_UNRESOLVED_STATE');
  return { row: SubmissionRowSchema.parse({ ...base, status: 'NEEDS_REVIEW', review_reason: mapped[0] }), rule: 'EXPLICIT_REVIEW_BLOCKER', lossy: false };
}

export function exportCases(records: CaseRecord[]) {
  const submission: Submission = {}; const failures: { id: string; code: string }[] = [];
  const provenance: Record<string, { sourceVersion: string; decisionVersion: number; rule: string; lossy: boolean }> = {};
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.email.id)) throw new Error('Duplicate export ID'); seen.add(record.email.id);
    try {
      const projected = projectCase(record); submission[record.email.id] = projected.row;
      provenance[record.email.id] = { sourceVersion: record.sourceVersion, decisionVersion: record.decision!.decisionVersion, rule: projected.rule, lossy: projected.lossy };
    } catch (error) { failures.push({ id: record.email.id, code: error instanceof Error ? error.message : 'EXPORT_FAILED' }); }
  }
  return { version: EXPORT_VERSION, submission, provenance, failures, complete: failures.length === 0 };
}
