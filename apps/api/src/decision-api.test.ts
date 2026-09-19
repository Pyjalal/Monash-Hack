import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { FIELD_NAMES, type Classification, type Email, type OperationalDecision } from '@cargolens/shared';
import { Store } from './store.js';
import { ClassificationService } from './pipeline.js';
import { createApp } from './app.js';

test('validates source claims before persisting any verified product state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-proof-'));
  const store = new Store(':memory:');
  try {
    const text = FIELD_NAMES.map(field => `value-${field}`).join('\n');
    const siText = `SHIPPING INSTRUCTIONS\n${text}`; const blText = `DRAFT BILL OF LADING\n${text}`;
    const digest = createHash('sha256').update(siText).digest('hex'); const blDigest = createHash('sha256').update(blText).digest('hex');
    await writeFile(join(root, 'si.txt'), siText); await writeFile(join(root, 'bl.txt'), blText);
    const email: Email = { id: 'proof', subject: 'Verify BL', from: 'docs@example.test', body: 'Compare the SI and BL', contentScope: 'full_message', attachments: [
      { id: 'si', mimeType: 'text/plain', relativePath: 'si.txt', sha256: digest }, { id: 'bl', mimeType: 'text/plain', relativePath: 'bl.txt', sha256: blDigest },
    ] };
    const initial = store.upsertEmail(email);
    const classified: Classification = { id: email.id, category: 'BL_COMPARISON', confidence: 1, probabilities: { BL_COMPARISON: 1 }, urgency: null, expectation: 'VERIFY_NOW', expectationConfidence: 1, model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 }, elapsedMs: 0, questionVersion: 'fixture', cached: false };
    store.saveClassification(email.id, initial.sourceVersion, classified);
    const valid: OperationalDecision = { category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW', verificationState: 'COMPLETE', workflowState: 'VERIFIED', nextAction: 'NONE', knownMismatches: [], blockers: [], pairValidated: true, sourceVersion: initial.sourceVersion, decisionVersion: 2,
      fieldResults: FIELD_NAMES.map((field, index) => ({ field, outcome: 'MATCH', si: { attachmentId: 'si', sha256: digest, locator: `line:${index + 2}`, text: `value-${field}` }, bl: { attachmentId: 'bl', sha256: blDigest, locator: `line:${index + 2}`, text: `value-${field}` } })),
    };
    const service = new ClassificationService({ store, classifier: async () => classified, configurationKey: 'fixture' });
    const app = createApp({ store, service, dashboardToken: 'test-token', datasetRoot: root });
    const send = (decision: OperationalDecision) => app.request('/cases/proof/decision', { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(decision) });
    const forged = structuredClone(valid); forged.fieldResults[0].si!.text = 'not present in the source';
    expect((await send(forged)).status).toBe(422);
    expect(store.getCase('proof')?.decision?.workflowState).toBe('AWAITING_DOCUMENTS');
    expect((await send(valid)).status).toBe(200);
    expect(store.getCase('proof')?.decision?.workflowState).toBe('VERIFIED');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
