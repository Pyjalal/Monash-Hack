import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Classification, Email } from '@cargolens/shared';
import { SEED_SI_BL_FLOW, parseFlow } from '@cargolens/shared/flows';
import { Store } from '../store.js';
import { ClassificationService } from '../pipeline.js';
import { runFlow } from './interpreter.js';

const FIELDS = 'Shipment reference: TEST-4321\nShipper: Cedar Export\nConsignee: Willow Import\nNotify party: Willow Agent\nPort of loading: North Harbour\nPort of discharge: South Harbour\nContainer count: 3\nGross weight kg: 14000';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-flow-'));
  const store = new Store(':memory:');
  await writeFile(join(root, 'si.txt'), `SHIPPING INSTRUCTIONS\n${FIELDS}`);
  await writeFile(join(root, 'bl.txt'), `DRAFT BILL OF LADING\n${FIELDS}`);
  await writeFile(join(root, 'bl-off.txt'), `DRAFT BILL OF LADING\n${FIELDS.replace('14000', '14500')}`);
  const classifier = vi.fn(async (email: Email): Promise<Classification> => ({
    id: email.id, category: email.body === 'si' ? 'SI_REQUEST' : 'BL_COMPARISON', confidence: 1,
    probabilities: { BL_COMPARISON: 1 }, urgency: null, expectation: 'VERIFY_NOW', expectationConfidence: 1,
    documentIssue: 'NONE', documentIssueConfidence: 1, bodyDocument: 'NO_SI_BL_CONTENT', bodyDocumentConfidence: 1,
    model: 'fixture', questionVersion: 'v1', cached: false, elapsedMs: 1, usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const service = new ClassificationService({ store, classifier, configurationKey: 'fixture:v1:packed-v1' });
  const email = (id: string, bl: string, body = 'compare'): Email => ({
    id, from: 'ops@example.test', subject: 'Compare', body, contentScope: 'full_message',
    attachments: [{ id: 'si', relativePath: 'si.txt', mimeType: 'text/plain' }, { id: 'bl', relativePath: bl, mimeType: 'text/plain' }],
  });
  return { root, store, service, email, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('saved flow execution', () => {
  it('runs the seeded flow on a real comparison case and agrees with the direct pipeline', async () => {
    const w = await workspace();
    try {
      // Classify only: the flow, not the pipeline, performs the comparison.
      await w.service.processCase(w.email('match', 'bl.txt'));
      const run = await runFlow({ flow: SEED_SI_BL_FLOW, store: w.store, caseId: 'match', attachmentRoot: w.root });

      expect(run.status).toBe('COMPLETED');
      expect(run.outcome).toMatchObject({ kind: 'DRAFT', action: 'CONFIRM_MATCH' });
      expect(run.flowVersion).toBe(SEED_SI_BL_FLOW.version);
      expect(run.nodes.filter((node) => node.state === 'RAN').map((node) => node.id))
        .toEqual(['trigger', 'expectation', 'compare', 'verified', 'clean', 'confirm']);

      // Case-visible result, identical to running the pipeline directly.
      const viaFlow = w.store.getCase('match')!;
      expect(viaFlow.decision?.workflowState).toBe('VERIFIED');
      expect(w.store.getDocumentComparison('match')).not.toBeNull();

      await w.service.processCase(w.email('direct', 'bl.txt'), w.root);
      const direct = w.store.getCase('direct')!;
      expect(viaFlow.decision?.verificationState).toBe(direct.decision?.verificationState);
      expect(viaFlow.decision?.knownMismatches).toEqual(direct.decision?.knownMismatches);
      expect(viaFlow.decision?.nextAction).toBe(direct.decision?.nextAction);
    } finally { await w.close(); }
  });

  it('takes the amendment branch on a real mismatch', async () => {
    const w = await workspace();
    try {
      await w.service.processCase(w.email('off', 'bl-off.txt'));
      const run = await runFlow({ flow: SEED_SI_BL_FLOW, store: w.store, caseId: 'off', attachmentRoot: w.root });
      expect(run.status).toBe('COMPLETED');
      expect(run.outcome).toMatchObject({ kind: 'DRAFT', action: 'REQUEST_AMENDMENT' });
      expect(w.store.getCase('off')?.decision?.knownMismatches).toEqual(['gross_weight_kg']);
    } finally { await w.close(); }
  });

  it('escalates instead of pretending to compare when the evidence is absent', async () => {
    const w = await workspace();
    try {
      await w.service.processCase({ ...w.email('bare', 'bl.txt'), attachments: [] });
      const run = await runFlow({ flow: SEED_SI_BL_FLOW, store: w.store, caseId: 'bare', attachmentRoot: w.root });
      expect(run.status).toBe('BLOCKED');
      expect(run.outcome).toMatchObject({ kind: 'ESCALATE' });
      // The comparison node runs and reports honestly that nothing was
      // established; the condition then routes to escalation rather than
      // letting an unverified case reach a draft.
      expect(run.nodes.find((node) => node.id === 'compare')?.detail).not.toContain('COMPLETE');
      expect(run.nodes.find((node) => node.id === 'confirm')?.state).toBe('SKIPPED');
      expect(w.store.getCase('bare')?.decision?.verificationState).not.toBe('COMPLETE');
    } finally { await w.close(); }
  });

  it('does not run on a case the trigger does not select', async () => {
    const w = await workspace();
    try {
      await w.service.processCase(w.email('si-case', 'bl.txt', 'si'));
      const run = await runFlow({ flow: SEED_SI_BL_FLOW, store: w.store, caseId: 'si-case', attachmentRoot: w.root });
      expect(run.status).toBe('SKIPPED');
      expect(run.outcome).toBeNull();
      expect(run.nodes.every((node) => node.state !== 'RAN' || node.type === 'trigger')).toBe(true);
      expect(w.store.getDocumentComparison('si-case')).toBeNull();
    } finally { await w.close(); }
  });

  it('refuses an unsupported graph rather than half-executing it', async () => {
    const w = await workspace();
    try {
      await w.service.processCase(w.email('cyclic', 'bl.txt'));
      const cyclic = parseFlow({
        ...SEED_SI_BL_FLOW, id: 'cyclic', nodes: SEED_SI_BL_FLOW.nodes,
        edges: [...SEED_SI_BL_FLOW.edges, { id: 'loop', from: 'confirm', to: 'compare', branch: null }],
      });
      const run = await runFlow({ flow: cyclic, store: w.store, caseId: 'cyclic', attachmentRoot: w.root });
      expect(run.status).toBe('INVALID');
      expect(run.errors.length).toBeGreaterThan(0);
      expect(run.nodes).toEqual([]);
      expect(w.store.getDocumentComparison('cyclic')).toBeNull();
    } finally { await w.close(); }
  });

  it('replays without producing a second outbound action', async () => {
    const w = await workspace();
    try {
      await w.service.processCase(w.email('replay', 'bl.txt'));
      const first = await runFlow({ flow: SEED_SI_BL_FLOW, store: w.store, caseId: 'replay', attachmentRoot: w.root });
      const drafted = () => w.store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE case_id=? AND type=?')
        .get('replay', 'case.drafted') as { n: number };
      expect(drafted().n).toBe(1);

      const second = await runFlow({ flow: SEED_SI_BL_FLOW, store: w.store, caseId: 'replay', attachmentRoot: w.root });
      expect(second.status).toBe('COMPLETED');
      expect(second.outcome).toEqual(first.outcome);
      expect(drafted().n).toBe(1);
    } finally { await w.close(); }
  });
});
