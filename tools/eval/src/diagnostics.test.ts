import { expect, it } from 'vitest';
import type { CaseRecord } from '../../../apps/api/src/store.js';
import type { SubmissionRow } from '@cargolens/shared';
import { evaluationDiagnostics } from './diagnostics.js';

it('counts exact defect sets and missing exports against targets, separately from false clears', () => {
  const clean: SubmissionRow = { category: 'BL_COMPARISON', status: 'OK', review_reason: null, defect_fields: [], has_defect: false };
  const defect: SubmissionRow = { ...clean, status: 'MISMATCH', defect_fields: ['shipper'], has_defect: true };
  const review: SubmissionRow = { ...clean, status: 'NEEDS_REVIEW', review_reason: 'unreadable' };
  const record = (id: string): CaseRecord => ({ email: { id, from: 'ops@example.test', subject: 'Test', contentScope: 'full_message', attachments: [] },
    classification: null, sourceVersion: id, status: 'classified', updatedAt: new Date().toISOString(), decision: null });
  const unsafe = record('false-clear');
  unsafe.decision = { category: 'BL_COMPARISON', workflowState: 'VERIFIED', nextAction: 'CONFIRM_MATCH', verificationState: 'COMPLETE',
    pairValidated: false, knownMismatches: [], fieldResults: [], blockers: [], sourceVersion: unsafe.sourceVersion, decisionVersion: 1,
    requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW' };
  const result = evaluationDiagnostics([record('caught'), record('missed'), record('review'), unsafe],
    { caught: defect, missed: defect, review, 'false-clear': defect }, { caught: defect, review, 'false-clear': clean });
  expect(result.endToEndDefects).toMatchObject({ caught: 1, total: 3, rate: 1 / 3 });
  expect(result.reviewRecall).toMatchObject({ caught: 1, total: 1 });
  expect(result.operationalFalseClearIdsAgainstReference).toEqual(['false-clear']);
  expect(result.benchmarkFalseClearIds).toEqual(['false-clear']);
  expect(result.rows.find(row => row.id === 'missed')?.exported).toBe(false);
});
