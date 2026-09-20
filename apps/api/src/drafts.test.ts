import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_NAMES, type Classification } from '@cargolens/shared';
import { Store } from './store.js';
import { composeDraft, draftCase } from './drafts.js';
import { ClassificationService } from './pipeline.js';
import { createApp } from './app.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
function fixture() {
  const store = new Store(':memory:'); stores.push(store);
  const initial = store.upsertEmail({ id: 'draft', from: 'customer@example.test', subject: 'Verify draft BL', contentScope: 'full_message', attachments: [] });
  const classification: Classification = { id: 'draft', category: 'BL_COMPARISON', confidence: 1, probabilities: { BL_COMPARISON: 1 },
    urgency: null, expectation: 'VERIFY_NOW', expectationConfidence: 1, model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 }, elapsedMs: 0, questionVersion: 'fixture', cached: false };
  store.saveClassification('draft', initial.sourceVersion, classification);
  store.saveDecision('draft', { ...store.getCase('draft')!.decision!, decisionVersion: 2, nextAction: 'REQUEST_DOCUMENTS', blockers: ['MISSING_SI', 'MISSING_BL'] });
  const service = new ClassificationService({ store, classifier: async () => classification, configurationKey: 'fixture' });
  return { store, record: store.getCase('draft')!, app: createApp({ store, service, dashboardToken: 'secret' }) };
}
describe('versioned operational drafting', () => {
  it('authenticates, validates versions, and persists an idempotent draft without sending', async () => {
    const { app, store, record } = fixture();
    const body = { sourceVersion: record.sourceVersion, decisionVersion: 2 };
    const request = (auth: boolean, payload = body) => app.request('/cases/draft/draft', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer secret' } : {}) }, body: JSON.stringify(payload) });
    expect((await request(false)).status).toBe(401);
    expect((await request(true, { ...body, decisionVersion: 1 })).status).toBe(409);
    const first = await (await request(true)).json();
    expect(first.draft.action).toBe('REQUEST_DOCUMENTS'); expect(first.draft.text).toContain('shipping instructions');
    expect(await (await request(true)).json()).toEqual(first);
    expect(store.eventsAfter(0).filter(event => event.type === 'case.drafted')).toHaveLength(1);
    expect(store.getCase('draft')!.decision).toEqual(record.decision);
  });
  it('routes owed drafts to documentation or asks who is responsible', () => {
    const { record } = fixture(); record.decision!.requestedAction = 'REQUEST_DRAFT';
    expect(composeDraft(record).action).toBe('REQUEST_CLARIFICATION');
    const draft = composeDraft(record, 'docs@example.test');
    expect(draft.to).toBe('docs@example.test'); expect(draft.text).toContain('authorized draft');
    expect(draft.text).not.toContain('attached');
  });
  it('includes only established differences and explicitly retains partial-verification limits', () => {
    const { record } = fixture();
    Object.assign(record.decision!, { nextAction: 'REQUEST_AMENDMENT', knownMismatches: ['shipper'], fieldResults: [{ field: 'shipper', outcome: 'MISMATCH',
      si: { attachmentId: 'si', sha256: 'a'.repeat(64), locator: 'line:1', text: 'Source company' },
      bl: { attachmentId: 'bl', sha256: 'b'.repeat(64), locator: 'line:1', text: 'Wrong company' } }] });
    const draft = composeDraft(record);
    expect(draft.action).toBe('REQUEST_AMENDMENT'); expect(draft.text).toContain('Source company'); expect(draft.text).toContain('not complete');
  });
  it('rejects blocked confirmations and rechecks versions after asynchronous source validation', async () => {
    const { store, record } = fixture(); record.decision!.nextAction = 'CONFIRM_MATCH';
    expect(() => composeDraft(record)).toThrow();
    const current = store.getCase('draft')!;
    store.saveDecision('draft', { ...current.decision!, decisionVersion: 3, nextAction: 'CONFIRM_MATCH', blockers: [], pairValidated: true,
      verificationState: 'COMPLETE', workflowState: 'VERIFIED', fieldResults: FIELD_NAMES.map(field => ({ field, outcome: 'MATCH',
        si: { attachmentId: 'si', sha256: 'a'.repeat(64), locator: 'line:1', text: field }, bl: { attachmentId: 'bl', sha256: 'b'.repeat(64), locator: 'line:1', text: field } })) });
    const verified = store.getCase('draft')!;
    expect(composeDraft(verified).action).toBe('CONFIRM_MATCH');
    verified.decision!.workflowState = 'BLOCKED';
    expect(() => composeDraft(verified)).toThrow('BLOCKED_OR_UNVERIFIED_CASE');
    const validate = vi.fn(async () => { store.upsertEmail({ ...current.email, subject: 'Changed source' }); });
    await expect(draftCase(store, 'draft', { sourceVersion: current.sourceVersion, decisionVersion: 3 }, validate)).rejects.toThrow('STALE_DECISION');
    expect(validate).toHaveBeenCalledOnce();
  });
  it('propagates source-validation failure and cannot persist a confirmation', async () => {
    const { store, record } = fixture();
    store.saveDecision('draft', { ...record.decision!, decisionVersion: 3, nextAction: 'REQUEST_AMENDMENT', knownMismatches: ['shipper'], fieldResults: [{ field: 'shipper', outcome: 'MISMATCH' }] });
    await expect(draftCase(store, 'draft', { sourceVersion: record.sourceVersion, decisionVersion: 3 }, async () => { throw new Error('forged evidence'); })).rejects.toThrow('forged evidence');
    expect(store.eventsAfter(0).some(event => event.type === 'case.drafted')).toBe(false);
  });
});
