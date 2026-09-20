import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { ClassificationService } from './pipeline.js';
import { TextRecovery } from './ai/text-recovery.js';
import { createApp } from './app.js';

it('recovers server-read regions only and rejects stale or already resolved fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-recovery-')); const store = new Store(':memory:');
  try {
    await writeFile(join(root, 'si.txt'), 'Shipper: Acme Trading\nConsignee: Private receiver');
    const record = store.upsertEmail({ id: 'case', subject: 'Verify documents', from: 'ops@example.test', contentScope: 'full_message', attachments: [{ id: 'si', relativePath: 'si.txt', mimeType: 'text/plain' }] });
    store.saveDecision('case', { category: 'BL_COMPARISON', sourceVersion: record.sourceVersion, decisionVersion: 1, requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW',
      verificationState: 'BLOCKED', workflowState: 'BLOCKED', blockers: ['MISSING_VALUE'], knownMismatches: [], fieldResults: [], pairValidated: false, nextAction: 'RECOVER_FIELDS' });
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/models') ? Response.json({ data: [{ id: 'google/gemini-2.5-flash-lite', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['response_format'] }] }) :
      Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidates: [{ field: 'shipper', locator: 'line:1', value: 'Acme Trading' }] }) } }] }));
    const app = createApp({ store, datasetRoot: root, dashboardToken: 'token', service: new ClassificationService({ store, classifier: async () => { throw new Error('not used'); }, configurationKey: 'fixture' }), textRecovery: new TextRecovery({ store, apiKey: 'secret', fetch: fetcher }) });
    const body = { sourceVersion: record.sourceVersion, decisionVersion: 1, attachmentId: 'si', fields: ['shipper'], locators: ['line:1'] };
    const request = (payload: unknown, auth = true) => app.request('/cases/case/recover', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer token' } : {}) }, body: JSON.stringify(payload) });
    expect((await request(body, false)).status).toBe(401);
    expect((await request({ ...body, regions: [{ text: 'Invented evidence' }] })).status).toBe(400);
    expect((await request({ ...body, decisionVersion: 3 })).status).toBe(409);
    expect((await request({ ...body, locators: ['line:9'] })).status).toBe(422);
    const before = store.getCase('case')!.decision;
    const result = await request(body); expect(result.status).toBe(200);
    expect((await result.json()).recovery.requiresSemanticValidation).toBe(true);
    expect(String(fetcher.mock.calls[1][1]!.body)).not.toContain('Private receiver');
    expect(store.getCase('case')!.decision).toEqual(before);
    store.saveDecision('case', { ...before!, decisionVersion: 2, fieldResults: [{ field: 'shipper', outcome: 'MATCH' }] });
    expect((await request({ ...body, decisionVersion: 2 })).status).toBe(422);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
