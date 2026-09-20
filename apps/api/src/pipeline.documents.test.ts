import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { type Classification, type Email } from '@cargolens/shared';
import { Store } from './store.js';
import { ClassificationService } from './pipeline.js';

it('classifies and compares source documents through one pipeline, preserving decisions on replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-pipeline-docs-')); const store = new Store(':memory:');
  try {
    const fields = 'Shipment reference: TEST-4321\nShipper: Cedar Export\nConsignee: Willow Import\nNotify party: Willow Agent\nPort of loading: North Harbour\nPort of discharge: South Harbour\nContainer count: 3\nGross weight kg: 14000';
    await writeFile(join(root, 'a.txt'), `SHIPPING INSTRUCTIONS\n${fields}`);
    await writeFile(join(root, 'b.txt'), `DRAFT BILL OF LADING\n${fields}`);
    await writeFile(join(root, 'c.txt'), `DRAFT BILL OF LADING\n${fields.replace('14000', '14500')}`);
    const classifier = vi.fn(async (email: Email): Promise<Classification> => ({ id: email.id, category: 'BL_COMPARISON', confidence: 1,
      probabilities: { BL_COMPARISON: 1 }, urgency: null, expectation: email.body === 'future' ? 'FUTURE_DRAFT' : 'VERIFY_NOW', expectationConfidence: 1,
      model: 'fixture', questionVersion: 'v1', cached: false, elapsedMs: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
    const service = new ClassificationService({ store, classifier, configurationKey: 'fixture:v1:packed-v1' });
    const email: Email = { id: 'match', from: 'ops@example.test', subject: 'Compare', body: 'match', contentScope: 'full_message', attachments: [
      { id: 'a', relativePath: 'a.txt', mimeType: 'text/plain' }, { id: 'b', relativePath: 'b.txt', mimeType: 'text/plain' } ] };
    await service.processCase(email, root);
    const verified = store.getCase('match')!;
    expect(verified.decision?.workflowState).toBe('VERIFIED'); expect(store.getDocumentComparison('match')).not.toBeNull();
    await service.processCase(email, root);
    expect(store.getCase('match')?.decision).toEqual(verified.decision); expect(classifier).toHaveBeenCalledOnce();
    await service.processCase({ ...email, id: 'mismatch', body: 'mismatch', attachments: [email.attachments[0], { ...email.attachments[1], relativePath: 'c.txt' }] }, root);
    expect(store.getCase('mismatch')?.decision?.knownMismatches).toEqual(['gross_weight_kg']);
    await service.processCase({ ...email, id: 'missing', body: 'missing', attachments: [] }, root);
    expect(store.getCase('missing')?.decision?.blockers).toEqual(['MISSING_ATTACHMENT']);
    await service.processCase({ ...email, id: 'future', body: 'future' }, root);
    expect(store.getCase('future')?.decision?.workflowState).toBe('AWAITING_DOCUMENTS');
    expect(store.getDocumentComparison('future')).toBeNull();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
