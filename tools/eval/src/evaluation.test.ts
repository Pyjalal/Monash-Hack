import { describe, expect, it } from 'vitest';
import { type SubmissionRow } from '@cargolens/shared';
import { Store } from '../../../apps/api/src/store.js';
import { exportCases } from './export.js';
import { adjudicate, targetMetrics, type DisputeLedger } from './disputes.js';
import { groupedSplit } from './metrics.js';

describe('honest evaluation projection', () => {
  it('accounts for failures explicitly, never invents OK, and preserves future draft state', () => {
    const store = new Store(':memory:');
    try {
      const first = store.upsertEmail({ id: 'future', subject: 'Prepare BL', from: 'customer@example.test', contentScope: 'full_message', attachments: [] });
      store.upsertEmail({ ...first.email, id: 'failed' });
      store.saveClassification('future', first.sourceVersion, { id: 'future', category: 'BL_COMPARISON', confidence: 1, probabilities: { BL_COMPARISON: 1 }, urgency: null, expectation: 'FUTURE_DRAFT', expectationConfidence: 1, model: 'fixture', questionVersion: 'fixture', cached: false, elapsedMs: 0, usage: null });
      const before = store.listCases(); const output = exportCases(before);
      expect(output.submission.future.status).toBe('OK'); expect(output.provenance.future.lossy).toBe(true);
      expect(output.failures).toEqual([{ id: 'failed', code: 'CASE_NOT_CLASSIFIED' }]); expect(output.complete).toBe(false);
      expect(store.listCases()).toEqual(before); expect(store.getCase('future')!.decision!.workflowState).toBe('AWAITING_DOCUMENTS');
      const immediate = structuredClone(store.getCase('future')!); immediate.decision!.requestedAction = 'VERIFY_DOCUMENTS'; immediate.decision!.documentExpectation = 'EXPECTED_NOW';
      expect(exportCases([immediate]).failures[0].code).toBe('UNSUPPORTED_UNRESOLVED_STATE');
      immediate.decision!.blockers = ['shipper:MISSING'];
      immediate.decision!.verificationState = 'BLOCKED';
      immediate.decision!.fieldResults = [{ field: 'shipper', outcome: 'MISSING' }];
      expect(exportCases([immediate]).submission.future.review_reason).toBe('missing_value');
      immediate.decision!.blockers.push('DOCUMENT_ROLES_UNVERIFIED');
      expect(exportCases([immediate]).failures[0].code).toBe('UNSUPPORTED_UNRESOLVED_STATE');
    } finally { store.close(); }
  });
  it('keeps template siblings together even across format strata and input permutations', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: String(index), group: `group-${index % 10}`, category: 'GENERAL', format: index % 2 ? 'pdf' : 'txt' }));
    const split = groupedSplit(rows);
    expect(split.dev.some(row => split.holdout.some(other => other.group === row.group))).toBe(false);
    expect(groupedSplit([...rows].reverse()).holdout.map(row => row.id).sort()).toEqual(split.holdout.map(row => row.id).sort());
  });
});
describe('source-backed reference overlays', () => {
  const truth: Record<string, SubmissionRow> = { email: { category: 'GENERAL', status: 'OK', review_reason: null, defect_fields: [], has_defect: false } };
  const entry: DisputeLedger['entries'][number] = { id: 'd1', emailId: 'email', target: 'category', kind: 'SOURCE_LABEL_CONTRADICTION', status: 'PROPOSED', rationale: 'Current request asks for instructions', evidence: [{ path: 'inbox/email.json', sha256: 'a'.repeat(64), start: 0, end: 7, text: 'Send SI' }] };
  const ledger = (entries: DisputeLedger['entries']) => ({ version: 1, datasetSha256: 'a'.repeat(64), entries });
  it('excludes only unresolved targets, keeping other targets usable', () => {
    const result = adjudicate(truth, ledger([entry]));
    expect(result.overlay).toEqual(truth); expect(result.excluded).toEqual({ email: ['category'] });
    const metrics = targetMetrics(truth, truth, result.excluded);
    expect(metrics.category.excluded).toBe(1); expect(metrics.status.correct).toBe(1);
  });
  it('requires reviewed accepted corrections and never changes official labels', () => {
    expect(() => adjudicate(truth, ledger([{ ...entry, status: 'ACCEPTED', corrected: 'SI_REQUEST' }]))).toThrow('human review');
    const result = adjudicate(truth, ledger([{ ...entry, status: 'ACCEPTED', corrected: 'SI_REQUEST', reviewer: 'human-reviewer', reviewedAt: '2026-09-20T00:00:00.000Z' }]));
    expect(result.overlay.email.category).toBe('SI_REQUEST'); expect(truth.email.category).toBe('GENERAL');
    expect(() => adjudicate(truth, ledger([{ ...entry, status: 'ACCEPTED', corrected: 'MADE_UP', reviewer: 'reviewer', reviewedAt: '2026-09-20T00:00:00.000Z' }]))).toThrow();
  });
  it('rejects conflicting active targets and duplicate ledger IDs', () => {
    expect(() => adjudicate(truth, ledger([entry, { ...entry, id: 'd2' }]))).toThrow('Conflicting');
    expect(() => adjudicate(truth, ledger([entry, entry]))).toThrow('duplicate');
  });
});
