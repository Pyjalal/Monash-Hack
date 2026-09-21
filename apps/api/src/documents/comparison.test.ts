import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmailSchema } from '@cargolens/shared';
import { Store } from '../store.js';
import * as sidecar from './ocr.js';
import { compareDocuments } from './comparison.js';
import { verifyOperationalEvidence } from '../gmail/evidence-validation.js';
import { createApp } from '../app.js';
import { ClassificationService } from '../pipeline.js';
import { GmailAutomation } from '../gmail/automation.js';
import { GmailClient } from '../gmail/client.js';
import { GmailOutbox } from '../gmail/outbox.js';

const fields = ['Shipper: Orchard Exporters', 'Consignee: Cedar Imports', 'Notify party: Cedar Agent', 'Port of loading: North Harbour', 'Port of discharge: South Harbour', 'Container count: 3', 'Gross weight kg: 12500'];
let root: string;
let store: Store;
let confidence: number;
let reference: string;
let referenceLabel: string;
let mismatch: boolean;
let duplicate: boolean;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cargolens-comparison-')); store = new Store(':memory:');
  confidence = 98; reference = 'SHIP-1234'; referenceLabel = 'Shipment reference'; mismatch = false; duplicate = false;
  await writeFile(join(root, 'a.png'), 'synthetic source SI');
  await writeFile(join(root, 'b.png'), 'synthetic source BL');
  vi.spyOn(sidecar, 'runOcrSidecar').mockImplementation(async ({ inputPath }) => {
    const bytes = await readFile(inputPath); const bl = bytes.toString().endsWith('BL');
    const lines = [bl ? 'DRAFT BILL OF LADING' : 'SHIPPING INSTRUCTIONS', `${referenceLabel}: ${bl ? reference : 'SHIP-1234'}`, ...fields.map(line => bl && mismatch ? line.replace('12500', '12000') : line), ...(duplicate ? ['Shipper: Different Exporter'] : [])];
    const words = lines.flatMap((line, y) => line.split(' ').map((text, x) => ({ text, confidence, bbox: { x: x * 100, y: y * 40, width: 90, height: 30 } })));
    return { ok: true, input: { path: inputPath, type: 'png', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      engine: { name: 'tesseract', executable: 'fixture' }, summary: { pages_processed: 1, pages_with_text: 1, unresolved_pages: [] },
      pages: [{ page: 1, status: 'ok', text: words.map(word => word.text).join(' '), words, word_count: words.length, average_confidence: confidence, width: 2000, height: 1000 }] };
  });
});
afterEach(async () => { vi.restoreAllMocks(); store.close(); for (const name of await readdir(root)) await unlink(join(root, name)); await rmdir(root); });
function record() {
  return store.upsertEmail(EmailSchema.parse({ id: 'neutral-case', from: 'ops@example.test', subject: 'Verify documents', body: '', attachments: [
    { id: 'a', relativePath: 'a.png', mimeType: 'image/png' }, { id: 'b', relativePath: 'b.png', mimeType: 'image/png' },
  ] }));
}
it('compares seven recovered fields and revalidates OCR provenance before confirmation', async () => {
  const source = record(); const comparison = await compareDocuments(source, root);
  expect(comparison.decision.nextAction).toBe('CONFIRM_MATCH');
  expect(comparison.decision.fieldResults).toHaveLength(7);
  expect(comparison.decision.fieldResults[0].si?.locator).toMatch(/^ocr:page:1:words:/);
  await expect(verifyOperationalEvidence(source, comparison.decision, root)).resolves.toBeUndefined();
  const forged = structuredClone(comparison.decision); forged.fieldResults[0].si!.text = 'invented';
  await expect(verifyOperationalEvidence(source, forged, root)).rejects.toThrow();
  await writeFile(join(root, 'a.png'), 'changed source');
  await expect(verifyOperationalEvidence(source, comparison.decision, root)).rejects.toThrow();
});
it('accepts Booking No. as a verified shipment-pair reference', async () => {
  referenceLabel = 'Booking No.';
  const { decision } = await compareDocuments(record(), root);
  expect(decision.pairValidated).toBe(true);
  expect(decision.nextAction).toBe('CONFIRM_MATCH');
});
it('accepts Booking Ref as a verified shipment-pair reference', async () => {
  referenceLabel = 'Booking Ref';
  const { decision } = await compareDocuments(record(), root);
  expect(decision.pairValidated).toBe(true);
  expect(decision.nextAction).toBe('CONFIRM_MATCH');
});
it('produces an evidence-backed amendment for a recovered mismatch and rejects forged MATCH', async () => {
  mismatch = true; const source = record(); const { decision } = await compareDocuments(source, root);
  expect(decision.nextAction).toBe('REQUEST_AMENDMENT'); expect(decision.knownMismatches).toEqual(['gross_weight_kg']);
  await expect(verifyOperationalEvidence(source, decision, root)).resolves.toBeUndefined();
  decision.fieldResults.at(-1)!.outcome = 'MATCH'; decision.knownMismatches = []; decision.nextAction = 'CONFIRM_MATCH'; decision.workflowState = 'VERIFIED';
  await expect(verifyOperationalEvidence(source, decision, root)).rejects.toThrow();
});
it.each(['low confidence', 'wrong shipment', 'duplicate field', 'missing engine', 'provider timeout', 'partial pages'])('blocks %s without confirming', async cause => {
  if (cause === 'low confidence') confidence = 40;
  if (cause === 'wrong shipment') reference = 'OTHER-999';
  if (cause === 'duplicate field') duplicate = true;
  if (cause === 'missing engine') vi.mocked(sidecar.runOcrSidecar).mockResolvedValue(sidecar.ocrFailure('tesseract_missing', 'unavailable'));
  if (cause === 'provider timeout') vi.mocked(sidecar.runOcrSidecar).mockResolvedValue(sidecar.ocrFailure('ocr_timeout', 'unavailable'));
  if (cause === 'partial pages') {
    const run = vi.mocked(sidecar.runOcrSidecar).getMockImplementation()!;
    vi.mocked(sidecar.runOcrSidecar).mockImplementation(async options => {
      const recovered = await run(options);
      if (!recovered.ok) throw new Error('Expected fixture OCR');
      recovered.pages.push({ page: 2, status: 'unresolved', text: '', average_confidence: null, word_count: 0, words: [] });
      recovered.summary.pages_processed = 2; recovered.summary.unresolved_pages = [2]; return recovered;
    });
  }
  const { decision, evidence } = await compareDocuments(record(), root);
  expect(decision.nextAction).toBe('REQUEST_CLARIFICATION'); expect(decision.verificationState).toBe('BLOCKED');
  expect(decision.blockers.length).toBeGreaterThan(0); expect(evidence).toHaveLength(2);
  if (cause === 'missing engine') expect(decision.blockers.join(' ')).toContain('tesseract_missing');
});

it('preserves durable recovery evidence across database restart', async () => {
  store.close(); store = new Store(join(root, 'evidence.sqlite'));
  const source = record(); const comparison = await compareDocuments(source, root);
  expect(store.saveDocumentComparison(source.email.id, comparison.decision, comparison.evidence)).toBe(true);
  store.close(); store = new Store(join(root, 'evidence.sqlite'));
  expect(store.getDocumentComparison(source.email.id)?.evidence).toEqual(comparison.evidence);
  store.upsertEmail({ ...source.email, body: 'New source version' });
  expect(store.getDocumentComparison(source.email.id)).toBeNull();
  expect(store.saveDocumentComparison(source.email.id, comparison.decision, comparison.evidence)).toBe(false);
});

it('retains partial recovered field evidence while requiring clarification', async () => {
  const run = vi.mocked(sidecar.runOcrSidecar).getMockImplementation()!;
  vi.mocked(sidecar.runOcrSidecar).mockImplementation(async options => {
    const recovered = await run(options);
    if (!recovered.ok) throw new Error('Expected fixture OCR');
    recovered.pages[0].words.at(-1)!.confidence = 40;
    return recovered;
  });
  const source = record(); const { decision } = await compareDocuments(source, root);
  expect(decision.nextAction).toBe('REQUEST_CLARIFICATION');
  expect(decision.fieldResults.filter(field => field.outcome === 'MATCH')).toHaveLength(6);
  await expect(verifyOperationalEvidence(source, decision, root)).resolves.toBeUndefined();
});

it('runs authenticated comparison, persists before/after evidence and rejects stale requests', async () => {
  const source = record();
  store.saveDecision(source.email.id, { category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW',
    verificationState: 'IN_PROGRESS', workflowState: 'PROCESSING', knownMismatches: [], blockers: [], fieldResults: [], nextAction: 'RECOVER_FIELDS', sourceVersion: source.sourceVersion, decisionVersion: 1, pairValidated: false });
  const service = new ClassificationService({ store, classifier: vi.fn(), configurationKey: 'test' });
  const app = createApp({ store, service, dashboardToken: 'test', datasetRoot: root });
  const request = (authorization = 'Bearer test') => app.request('/cases/neutral-case/compare', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceVersion: source.sourceVersion, decisionVersion: 1 }) });
  expect((await request('')).status).toBe(401);
  expect((await request()).status).toBe(200);
  expect(store.getCase(source.email.id)?.decision?.nextAction).toBe('CONFIRM_MATCH');
  const evidence = await app.request('/cases/neutral-case/comparison', { headers: { Authorization: 'Bearer test' } });
  const body = await evidence.json();
  expect(body.evidence[0].recovery.before.status).toBe('UNSUPPORTED');
  expect(body.evidence[0].recovery.ocr.ok).toBe(true);
  expect((await request()).status).toBe(409);
  const run = vi.mocked(sidecar.runOcrSidecar).getMockImplementation()!;
  vi.mocked(sidecar.runOcrSidecar).mockImplementationOnce(async options => {
    store.upsertEmail({ ...source.email, body: 'A newer inbound message arrived' });
    return run(options);
  });
  const raced = await app.request('/cases/neutral-case/compare', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceVersion: source.sourceVersion, decisionVersion: 2 }) });
  expect(raced.status).toBe(409);
  expect(store.getCase(source.email.id)?.decision).toBeNull();
  expect(store.getDocumentComparison(source.email.id)).toBeNull();
});

it.each([false, true])('rechecks recovered evidence at final outbox dispatch (changed=%s)', async changed => {
  const source = record(); const { decision } = await compareDocuments(source, root);
  store.saveDecision(source.email.id, decision);
  const send = vi.fn(async () => ({ id: 'sent', threadId: 'thread' }));
  const client = new GmailClient({ mailboxAddress: 'ops@example.test', clientId: 'test', clientSecret: 'test', refreshToken: 'test', fetchImpl: vi.fn() });
  client.sendReply = send;
  const automation = new GmailAutomation({ store, service: new ClassificationService({ store, classifier: vi.fn(), configurationKey: 'test' }), client, attachmentRoot: root, enabled: true });
  new GmailOutbox(store.db).enqueue({ caseId: source.email.id, sourceVersion: source.sourceVersion, action: 'CONFIRM_MATCH', decision,
    reply: { to: 'sender@example.test', threadId: 'thread', subject: 'Synthetic', text: 'Synthetic confirmation', inReplyTo: '<test@example.test>', references: [], sourceVersion: source.sourceVersion, idempotencyKey: 'ocr-test' } });
  if (changed) await writeFile(join(root, 'a.png'), 'changed');
  const [item] = await automation.dispatchPending();
  expect(item.status).toBe(changed ? 'FAILED' : 'SENT');
  expect(send).toHaveBeenCalledTimes(changed ? 0 : 1);
  await automation.dispatchPending(); expect(send).toHaveBeenCalledTimes(changed ? 0 : 1);
});

it('compares independently rendered image-only SI/BL using real Tesseract', async () => {
  vi.restoreAllMocks();
  for (const name of ['a', 'b']) await writeFile(join(root, `${name}.png`), await readFile(`apps/api/src/documents/testfixtures/ocr-comparison/${name}.png`));
  const source = record(); const comparison = await compareDocuments(source, root);
  expect(comparison.evidence.every(row => row.recovery.before.status === 'UNSUPPORTED')).toBe(true);
  expect(comparison.decision.blockers).toEqual([]);
  expect(comparison.decision.nextAction).toBe('CONFIRM_MATCH');
  await expect(verifyOperationalEvidence(source, comparison.decision, root)).resolves.toBeUndefined();
}, 120_000);
