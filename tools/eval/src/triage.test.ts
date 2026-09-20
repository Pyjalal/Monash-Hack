import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { adjudicate, validateDisputeEvidence, type DisputeLedger } from './disputes.js';
import { triageRows } from './triage.js';
import type { Email, SubmissionRow } from '@cargolens/shared';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const expected: SubmissionRow = { category: 'BL_COMPARISON', status: 'NEEDS_REVIEW', review_reason: 'unreadable', defect_fields: [], has_defect: false };

describe('offline miss triage', () => {
  it('separates reader, semantic and export stages without inventing label disputes', () => {
    const row = { id: 'email', categoryCorrect: true, exported: false, statusCorrect: false, reasonCorrect: false,
      exactDefectSet: false, expected, predicted: null, operationalState: 'BLOCKED' as const,
      blockers: ['ocr_failed', 'DOCUMENT_ROLES_UNVERIFIED'], disposition: 'EXPORT_FAILED' };
    const [result] = triageRows([row], { rows: {}, failures: [{ id: 'email', code: 'UNSUPPORTED_UNRESOLVED_STATE' }] }, { version: 1, datasetSha256: 'a'.repeat(64), entries: [] });
    expect(result.stages).toEqual(['READER', 'SEMANTIC', 'EXPORT']);
    expect(result.disputes).toEqual([]);
  });
  it('does not count failed inference as a semantic classification error', () => {
    const [result] = triageRows([{ id: 'email', categoryCorrect: false, exported: false, statusCorrect: false, reasonCorrect: false,
      exactDefectSet: false, expected, predicted: null, operationalState: null, blockers: [], disposition: 'INFERENCE_FAILED' }],
    { rows: {}, failures: [{ id: 'email', code: 'CASE_NOT_CLASSIFIED' }] }, { version: 1, datasetSha256: 'a'.repeat(64), entries: [] });
    expect(result.stages).toEqual(['INFERENCE', 'EXPORT']);
  });
  it('validates both observation and original source, and refuses observation-only corrections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dispute-test-'));
    try {
      await mkdir(join(root, 'attachments'));
      await writeFile(join(root, 'attachments', 'scan.pdf'), 'scan bytes');
      const observation = { source: 'data/attachments/scan.pdf', sha256: sha('scan bytes'), readerProfile: 'ocr_recovered', unresolvedPages: [], ocrError: null };
      const span = JSON.stringify(observation); const text = `{"observations":[${span}]}`;
      await writeFile(join(root, 'observations.json'), text);
      const email: Email = { id: 'email', from: 'a@example.test', subject: 'Check', contentScope: 'full_message', attachments: [{ id: 'scan', mimeType: 'application/pdf', relativePath: 'attachments/scan.pdf' }] };
      const ledger: DisputeLedger = { version: 1, datasetSha256: 'a'.repeat(64), entries: [{ id: 'd', emailId: 'email', target: 'review_reason', kind: 'CAPABILITY_ASSUMPTION', status: 'PROPOSED', rationale: 'Recovered scan',
        evidence: [{ path: 'attachments/scan.pdf', sha256: sha('scan bytes'), start: text.indexOf(span), end: text.indexOf(span) + span.length, text: span,
          observation: { path: 'observations.json', sha256: sha(text) } }] }] };
      await expect(validateDisputeEvidence(ledger, root, [email], root)).resolves.toBeUndefined();
      expect(adjudicate({ email: expected }, ledger).excluded).toEqual({ email: ['review_reason'] });
      const accepted = structuredClone(ledger); Object.assign(accepted.entries[0], { status: 'ACCEPTED', reviewer: 'human', reviewedAt: '2026-09-21T00:00:00Z', corrected: null });
      expect(() => adjudicate({ email: expected }, accepted)).toThrow('cannot authorize');
      await expect(validateDisputeEvidence(accepted, root, [email], root)).rejects.toThrow('not corrections');
      await writeFile(join(root, 'observations.json'), text + ' ');
      await expect(validateDisputeEvidence(ledger, root, [email], root)).rejects.toThrow('observation hash');
      await writeFile(join(root, 'observations.json'), text);
      await writeFile(join(root, 'attachments', 'scan.pdf'), 'changed scan');
      await expect(validateDisputeEvidence(ledger, root, [email], root)).rejects.toThrow('source hash');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects label files, another email source, and invented spans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dispute-test-'));
    try {
      await mkdir(join(root, 'inbox')); await writeFile(join(root, 'inbox/email.json'), 'source');
      const email: Email = { id: 'email', from: 'a@example.test', subject: 'Check', contentScope: 'full_message', attachments: [] };
      const ledger: DisputeLedger = { version: 1, datasetSha256: 'a'.repeat(64), entries: [{ id: 'd', emailId: 'email', target: 'category', kind: 'SOURCE_LABEL_CONTRADICTION', status: 'PROPOSED', rationale: 'Source',
        evidence: [{ path: 'ground_truth.json', sha256: sha('source'), start: 0, end: 6, text: 'source' }] }] };
      await expect(validateDisputeEvidence(ledger, root, [email], root)).rejects.toThrow('not attached');
      ledger.entries[0].evidence[0].path = 'inbox/another.json';
      await expect(validateDisputeEvidence(ledger, root, [email], root)).rejects.toThrow('not attached');
      ledger.entries[0].evidence[0].path = 'inbox/email.json'; ledger.entries[0].evidence[0].text = 'model guess';
      await expect(validateDisputeEvidence(ledger, root, [email], root)).rejects.toThrow('exact source span');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
