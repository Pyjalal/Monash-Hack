import { describe, expect, it } from 'vitest';
import type { Classification, Email } from '@cargolens/shared';
import { SEED_SI_BL_FLOW } from '@cargolens/shared/flows';
import { Store } from '../store.js';
import { ClassificationService } from '../pipeline.js';
import { createApp } from '../app.js';

const classified = (source: Email): Classification => ({
  id: source.id, category: 'BL_COMPARISON', confidence: 1, probabilities: { BL_COMPARISON: 1 },
  urgency: null, expectation: 'VERIFY_NOW', expectationConfidence: 1, documentIssue: 'NONE', documentIssueConfidence: 1,
  bodyDocument: 'NO_SI_BL_CONTENT', bodyDocumentConfidence: 1,
  model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, elapsedMs: 1, questionVersion: 'test', cached: false,
});

function harness() {
  const store = new Store(':memory:');
  const service = new ClassificationService({ store, classifier: async (source) => classified(source), configurationKey: 'v1' });
  const app = createApp({ store, service, dashboardToken: 'token', authRequired: false });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { store, app, post };
}

describe('flow routes', () => {
  it('saves a supported flow and reloads it without losing configuration', async () => {
    const { store, app, post } = harness();
    try {
      expect((await (await app.request('/flows')).json()).flows).toEqual([]);

      const saved = await post('/flows', SEED_SI_BL_FLOW);
      expect(saved.status).toBe(200);
      expect((await saved.json()).validation).toMatchObject({ ok: true });

      const loaded = await app.request(`/flows/${SEED_SI_BL_FLOW.id}`);
      expect(loaded.status).toBe(200);
      const body = await loaded.json() as { flow: typeof SEED_SI_BL_FLOW };
      expect(body.flow).toEqual(SEED_SI_BL_FLOW);
      expect(store.getFlow(SEED_SI_BL_FLOW.id)).toEqual(SEED_SI_BL_FLOW);
    } finally { store.close(); }
  });

  it('rejects an unknown node type and an unsupported graph with useful feedback', async () => {
    const { store, post } = harness();
    try {
      const unknownType = await post('/flows', {
        ...SEED_SI_BL_FLOW, id: 'bad-type',
        nodes: [{ id: 'x', type: 'run_script', config: { cmd: 'whoami' } }], edges: [],
      });
      expect(unknownType.status).toBe(400);
      expect((await unknownType.json()).error).toBe('INVALID_FLOW');

      const unsupported = await post('/flows', {
        ...SEED_SI_BL_FLOW, id: 'dangling',
        edges: [...SEED_SI_BL_FLOW.edges, { id: 'loop', from: 'confirm', to: 'compare', branch: null }],
      });
      expect(unsupported.status).toBe(422);
      const body = await unsupported.json() as { error: string; errors: string[] };
      expect(body.error).toBe('UNSUPPORTED_FLOW');
      expect(body.errors.join(' ').toLowerCase()).toContain('cycle');
      expect(store.getFlow('dangling')).toBeNull();
    } finally { store.close(); }
  });

  it('runs a saved flow against a real case and reports per-node state', async () => {
    const { store, post } = harness();
    try {
      await post('/flows', SEED_SI_BL_FLOW);
      const email: Email = { id: 'case-1', subject: 'Compare', body: 'check', from: 'ops@example.test', contentScope: 'full_message', attachments: [] };
      store.upsertEmail(email);
      store.saveClassification('case-1', store.getCase('case-1')!.sourceVersion, classified(email));

      const run = await post('/cases/case-1/flow-run', { flowId: SEED_SI_BL_FLOW.id });
      expect(run.status).toBe(200);
      const body = await run.json() as { run: { flowVersion: string; nodes: { id: string; state: string }[]; status: string } };
      expect(body.run.flowVersion).toBe(SEED_SI_BL_FLOW.version);
      expect(body.run.nodes.find((node) => node.id === 'trigger')?.state).toBe('RAN');
      // No evidence reader is configured here, so it must not claim a verified result.
      expect(body.run.status).not.toBe('COMPLETED');
      expect(store.getCase('case-1')?.decision?.verificationState).not.toBe('COMPLETE');
    } finally { store.close(); }
  });

  it('reports a missing flow or case rather than running something else', async () => {
    const { store, post } = harness();
    try {
      expect((await post('/cases/nope/flow-run', { flowId: 'absent' })).status).toBe(404);
      expect((await post('/cases/nope/flow-run', { bogus: 1 })).status).toBe(400);
    } finally { store.close(); }
  });
});
