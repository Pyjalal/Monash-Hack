import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SubmissionRow } from '@cargolens/shared';
import { Store } from '../../../apps/api/src/store.js';
import { compareDocuments } from '../../../apps/api/src/documents/comparison.js';
import { verifyOperationalEvidence } from '../../../apps/api/src/gmail/evidence-validation.js';
import { exportCases } from './export.js';
import { targetMetrics } from './disputes.js';

// Authored independently of organizer rows. Siblings stay in one shipment group.
// This is an implementation-informed component challenge, not a blind model test.
export const DOCUMENT_CASES = ['cedar', 'harbour'].flatMap((group, index) => {
  const fields = `Shipper: ${index ? 'Harbour Machinery' : 'Cedar Foods'}\nConsignee: Island Trading\nNotify party: Island Logistics\nPort of loading: Bay Terminal\nPort of discharge: River Terminal\nContainer count: 4\nGross weight kg: 8400`;
  const si = `SHIPPING INSTRUCTIONS\nShipment reference: ${group}-4821\n${fields}\n`;
  const bl = `DRAFT BILL OF LADING\nShipment reference: ${group}-4821\n${fields}\n`;
  return [
    { name: 'match', sources: [si, bl], status: 'OK', reason: null, defects: [], workflow: 'VERIFIED', blockers: [] },
    { name: 'weight', sources: [si, bl.replace('8400', '8450')], status: 'MISMATCH', reason: null, defects: ['gross_weight_kg'], workflow: 'MISMATCH', blockers: [] },
    { name: 'missing-value', sources: [si, bl.replace('Consignee: Island Trading', 'Consignee:')], status: 'NEEDS_REVIEW', reason: 'missing_value', defects: [], workflow: 'BLOCKED', blockers: ['consignee:MISSING'] },
    { name: 'missing-document', sources: [si], status: 'NEEDS_REVIEW', reason: 'missing_attachment', defects: [], workflow: 'BLOCKED', blockers: ['UNAMBIGUOUS_PAIR_REQUIRED', 'DOCUMENT_ROLES_UNVERIFIED'] },
    { name: 'wrong-document', sources: [si, bl.replace('DRAFT BILL OF LADING', 'COMMERCIAL INVOICE')], status: 'NEEDS_REVIEW', reason: 'wrong_doc_type', defects: [], workflow: 'BLOCKED', blockers: ['DOCUMENT_ROLES_UNVERIFIED'] },
    { name: 'wrong-shipment', sources: [si, bl.replace(`${group}-4821`, 'different-9842')], status: 'NEEDS_REVIEW', reason: 'wrong_doc_type', defects: [], workflow: 'BLOCKED', blockers: ['SHIPMENT_REFERENCE_UNVERIFIED'] },
  ].map(row => ({ id: `${group}-${row.name}`, group, sources: row.sources,
    expected: { category: 'BL_COMPARISON', status: row.status, review_reason: row.reason, defect_fields: row.defects, has_defect: row.defects.length > 0 } as SubmissionRow,
    workflow: row.workflow, blockers: row.blockers }));
});

export async function evaluateDocuments(root: string) {
  await mkdir(root, { recursive: false });
  const store = new Store(':memory:');
  const rows = [];
  const submission: Record<string, SubmissionRow> = {};
  try {
    for (const fixture of DOCUMENT_CASES) {
      const attachments = [];
      for (const [index, source] of fixture.sources.entries()) {
        const relativePath = `${fixture.id}-${index}.txt`;
        await writeFile(resolve(root, relativePath), source, { flag: 'wx' });
        attachments.push({ id: String(index), relativePath, mimeType: 'text/plain' });
      }
      const record = store.upsertEmail({ id: fixture.id, from: 'independent@example.test', subject: 'Compare the supplied documents', contentScope: 'full_message', attachments });
      // Intent is fixed at this component boundary; no classifier accuracy is claimed.
      store.saveClassification(fixture.id, record.sourceVersion, { id: fixture.id, category: 'BL_COMPARISON', confidence: 1, probabilities: { BL_COMPARISON: 1 }, urgency: null, expectation: 'VERIFY_NOW', expectationConfidence: 1, model: 'component-intent', questionVersion: 'component-intent', cached: false, elapsedMs: 0, usage: null });
      const { decision } = await compareDocuments(store.getCase(fixture.id)!, root);
      let proofError: string | null = null;
      try { await verifyOperationalEvidence(record, decision, root); } catch { proofError = 'SOURCE_EVIDENCE_VALIDATION_FAILED'; }
      store.saveDecision(fixture.id, decision);
      const exported = exportCases([store.getCase(fixture.id)!]);
      const predicted = proofError ? null : exported.submission[fixture.id] ?? null;
      if (predicted) submission[fixture.id] = predicted;
      const confirmed = decision.nextAction === 'CONFIRM_MATCH';
      rows.push({ id: fixture.id, group: fixture.group, expected: fixture.expected, predicted,
        workflow: decision.workflowState, blockers: decision.blockers, nextAction: decision.nextAction,
        operationalStatusReasonCorrect: decision.workflowState === fixture.workflow && isDeepStrictEqual([...decision.blockers].sort(), [...fixture.blockers].sort()),
        exportFailure: proofError ?? exported.failures[0]?.code ?? null,
        falseClear: confirmed && (fixture.expected.status !== 'OK' || proofError !== null),
        automated: !proofError && ['CONFIRM_MATCH', 'REQUEST_AMENDMENT'].includes(decision.nextAction) });
    }
    return { status: 'MEASURED_COMPONENT_CHALLENGE', scope: 'Native text document comparison, source proof and export; intent supplied. No classifier, OCR, or live delivery measured.',
      authorship: 'Agent-authored independently of organizer data, after implementation inspection; related variants grouped by shipment. Not blind or statistically representative.',
      count: rows.length, groupCount: new Set(rows.map(row => row.group)).size,
      exactTargets: targetMetrics(Object.fromEntries(DOCUMENT_CASES.map(row => [row.id, row.expected])), submission),
      operationalStatusReasonChecks: { correct: rows.filter(row => row.operationalStatusReasonCorrect).length, total: rows.length },
      falseClears: rows.filter(row => row.falseClear).length,
      automationCoverage: rows.filter(row => row.automated).length / rows.length,
      sentMessages: 0, rows };
  } finally { store.close(); }
}
