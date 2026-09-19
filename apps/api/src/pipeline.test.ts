import { describe, expect, it, vi } from 'vitest';
import type { Classification, Email } from '@cargolens/shared';
import { Store } from './store.js';
import { ClassificationService } from './pipeline.js';
import { createApp } from './app.js';

const email: Email = { id: 'a', subject: 'Draft BL', body: 'Please send the draft for checking', from: 'ops@example.test', attachments: [], contentScope: 'full_message' };
const result = (source: Email): Classification => ({ id: source.id, category: 'BL_COMPARISON', confidence: 0.98, probabilities: { BL_COMPARISON: 0.98, GENERAL: 0.02 }, urgency: null, expectation: 'FUTURE_DRAFT', expectationConfidence: 0.98, model: 'test', usage: { input_tokens: 10, output_tokens: 5 }, elapsedMs: 1, questionVersion: 'test', cached: false });

describe('classification pipeline', () => {
  it('shares concurrent work and invalidates cache when source changes', async () => {
    const store = new Store(':memory:');
    const classifier = vi.fn(async (source: Email) => result(source));
    const service = new ClassificationService({ store, classifier, configurationKey: 'v1', concurrency: 2, requestsPerMinute: 1200 });
    const rows = await Promise.all([service.classify(email), service.classify(email)]);
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(rows[0].category).toBe('BL_COMPARISON');
    expect((await service.classify(email)).cached).toBe(true);
    await service.classify({ ...email, body: 'Invoice dispute' });
    expect(classifier).toHaveBeenCalledTimes(2);
    store.close();
  });
  it('does not cache service failures as GENERAL', async () => {
    const store = new Store(':memory:');
    const classifier = vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockImplementation(async (source: Email) => result(source));
    const service = new ClassificationService({ store, classifier, configurationKey: 'v1' });
    await expect(service.classify(email)).rejects.toThrow('provider unavailable');
    expect((await service.classify(email)).category).toBe('BL_COMPARISON');
    expect(classifier).toHaveBeenCalledTimes(2);
    store.close();
  });
  it('preserves awaiting-documents state and prevents stale writes', async () => {
    const store = new Store(':memory:');
    const first = store.upsertEmail(email);
    const second = store.upsertEmail({ ...email, body: 'New evidence arrived' });
    expect(first.sourceVersion).not.toBe(second.sourceVersion);
    expect(store.saveClassification(email.id, first.sourceVersion, result(email))).toBe(false);
    expect(store.saveClassification(email.id, second.sourceVersion, result(email))).toBe(true);
    expect(store.getCase(email.id)?.decision?.workflowState).toBe('AWAITING_DOCUMENTS');
    expect(store.getCase(email.id)?.decision?.nextAction).toBe('FETCH_THREAD');
    expect(store.eventsAfter(0).map(event => event.type)).toContain('case.classified');
    store.close();
  });
});

describe('API boundaries', () => {
  it('publishes a stable cache revision that changes with classifier configuration', async () => {
    const store = new Store(':memory:');
    const health = async (configurationKey: string) => {
      const service = new ClassificationService({ store, classifier: async source => result(source), configurationKey });
      const app = createApp({ store, service, dashboardToken: 'private-dashboard-token' });
      return (await app.request('/health')).json() as Promise<{ classifierRevision: string }>;
    };
    const first = await health('model-a:questions-v1');
    expect(first.classifierRevision).toMatch(/^[a-f0-9]{64}$/);
    expect((await health('model-a:questions-v1')).classifierRevision).toBe(first.classifierRevision);
    expect((await health('model-b:questions-v1')).classifierRevision).not.toBe(first.classifierRevision);
    expect((await health('model-a:questions-v2')).classifierRevision).not.toBe(first.classifierRevision);
    expect(JSON.stringify(first)).not.toContain('private-dashboard-token');
    store.close();
  });
  it('exposes Gmail only through privileged routes and validates sync limits', async () => {
    const store = new Store(':memory:');
    const service = new ClassificationService({ store, classifier: async source => result(source), configurationKey: 'v1' });
    const gmail = { sync: vi.fn(async () => ({ processed: 0, skipped: 0, errors: [] })), status: () => ({ enabled: false, busy: false, pending: 0, unknown: 0 }), outbox: () => [], validateDecision: async () => {}, processDecision: async () => null, dispatchPending: async () => [] };
    const app = createApp({ store, service, dashboardToken: 'local-test-token', gmail });
    expect((await app.request('/gmail/status')).status).toBe(401);
    const headers = { Authorization: 'Bearer local-test-token', 'Content-Type': 'application/json' };
    expect((await app.request('/gmail/sync', { method: 'POST', headers, body: JSON.stringify({ maxMessages: 1000 }) })).status).toBe(400);
    expect((await app.request('/gmail/sync', { method: 'POST', headers, body: JSON.stringify({ maxMessages: 10 }) })).status).toBe(202);
    expect(gmail.sync).toHaveBeenCalledWith({ maxMessages: 10 });
    await new Promise(resolve => setTimeout(resolve, 0)); store.close();
  });
  it('protects case data, limits preview batches, and preserves per-item failures', async () => {
    const store = new Store(':memory:'); store.upsertEmail(email);
    const service = new ClassificationService({ store, classifier: async source => { if (source.id === 'bad') throw new Error('secret upstream detail'); return result(source); }, configurationKey: 'v1' });
    const app = createApp({ store, service, dashboardToken: 'local-test-token' });
    expect((await app.request('/emails')).status).toBe(401);
    expect((await app.request('/emails', { headers: { Authorization: 'Bearer local-test-token' } })).status).toBe(200);
    const payload = { emails: [{ id: 'a', subject: 'BL', from: 'x', snippet: 'Please send draft', contentScope: 'inbox_snippet' }, { id: 'bad', subject: 'Invoice', from: 'x', snippet: 'x', contentScope: 'inbox_snippet' }] };
    const response = await app.request('/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    const body = await response.json() as { results: {status: string}[] };
    expect(body.results.map(item => item.status)).toEqual(['classified', 'error']);
    expect(JSON.stringify(body)).not.toContain('secret upstream detail');
    const invalid = await app.request('/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(invalid.status).toBe(400);
    expect(store.getCase('a')?.email.body).toBe(email.body);
    store.close();
  });
});
