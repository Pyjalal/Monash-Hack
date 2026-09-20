import { OperationalDecisionSchema, type Submission, type SubmissionRow } from '@cargolens/shared';
import type { CaseRecord } from '../../../apps/api/src/store.js';

/** References are used only after inference, for measurement and triage. */
export function evaluationDiagnostics(records: CaseRecord[], truth: Record<string, SubmissionRow>, submission: Submission) {
  const exactSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const defects = Object.entries(truth).filter(([, row]) => row.category === 'BL_COMPARISON' && row.has_defect);
  const caughtDefects = defects.filter(([id, row]) => submission[id]?.category === 'BL_COMPARISON' && submission[id]?.has_defect && exactSet(row.defect_fields, submission[id].defect_fields));
  const review = Object.entries(truth).filter(([, row]) => row.status === 'NEEDS_REVIEW');
  const caughtReview = review.filter(([id]) => submission[id]?.status === 'NEEDS_REVIEW');
  const falseClears = records.filter(record => {
    const decision = record.decision;
    if (decision?.workflowState !== 'VERIFIED' && decision?.nextAction !== 'CONFIRM_MATCH') return false;
    return !OperationalDecisionSchema.safeParse(decision).success || decision.verificationState !== 'COMPLETE' || truth[record.email.id]?.status !== 'OK';
  }).map(record => record.email.id);
  return {
    endToEndDefects: { caught: caughtDefects.length, total: defects.length, rate: defects.length ? caughtDefects.length / defects.length : null, targetRate: 0.80 },
    reviewRecall: { caught: caughtReview.length, total: review.length, rate: review.length ? caughtReview.length / review.length : null, target: '15/20' },
    operationalFalseClearIdsAgainstReference: falseClears,
    benchmarkFalseClearIds: Object.entries(truth).filter(([id, row]) => row.status !== 'OK' && submission[id]?.category === 'BL_COMPARISON' && submission[id]?.status === 'OK').map(([id]) => id),
    rows: records.map(record => {
      const id = record.email.id; const expected = truth[id]; const predicted = submission[id];
      return { id, categoryCorrect: record.classification?.category === expected.category, exported: !!predicted,
        statusCorrect: !!predicted && predicted.status === expected.status,
        reasonCorrect: !!predicted && predicted.review_reason === expected.review_reason,
        exactDefectSet: !!predicted && exactSet(predicted.defect_fields, expected.defect_fields),
        expected, predicted: predicted ?? null, operationalState: record.decision?.workflowState ?? null, blockers: record.decision?.blockers ?? [],
        disposition: record.status === 'failed' ? 'INFERENCE_FAILED' : !predicted ? 'EXPORT_FAILED' : JSON.stringify(predicted) === JSON.stringify(expected) ? 'AGREES' : 'REQUIRES_SOURCE_REVIEW' };
    }),
  };
}
