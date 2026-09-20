import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIELD_NAMES, type Classification } from '@cargolens/shared';
import { Store } from '../store.js';
import { ClassificationService } from '../pipeline.js';
import { GmailClient } from './client.js';
import type { GmailMessage } from './message.js';
import { GmailAutomation } from './automation.js';

function message(id: string, text: string, attachments: string[] = []): GmailMessage {
  return { id, threadId: 'thread-1', internalDate: id === 'm1' ? '100' : '200', labelIds: ['INBOX'], payload: {
    mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'customer@example.org' }, { name: 'Subject', value: 'Shipment' }, { name: 'Message-ID', value: `<${id}@example.org>` }],
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } }, ...attachments.map(id => ({ mimeType: 'text/plain', filename: '../../../' + id + '.txt', body: { attachmentId: id } }))],
  } };
}

async function harness(enabled: boolean, initial: GmailMessage[] = [message('m1', 'Please send us the draft BL.')], attachmentBytes: Record<string, string | Buffer> = {}, automaticComparison = false) {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-gmail-'));
  const store = new Store(':memory:'); const messages = initial; const sent: string[] = [];
  const service = new ClassificationService({ store, configurationKey: 'fixture:v1', requestsPerMinute: 1200, classifier: async email => ({
    id: email.id, category: email.body?.startsWith('Here are') ? 'GENERAL' : 'BL_COMPARISON', confidence: 0.99, probabilities: { BL_COMPARISON: 0.99 }, urgency: null,
    expectation: email.body?.startsWith('Here are') ? null : email.body?.includes('send us') ? 'FUTURE_DRAFT' : 'VERIFY_NOW', expectationConfidence: 0.99,
    model: 'fixture', questionVersion: 'v1', usage: { input_tokens: 1, output_tokens: 1 }, elapsedMs: 1, cached: false,
  }) satisfies Classification });
  const client = new GmailClient({ mailboxAddress: 'ops@example.org', clientId: 'fixture', clientSecret: 'fixture', refreshToken: 'fixture', fetchImpl: async (input, init) => {
    const url = String(input); let data: unknown;
    if (url.includes('oauth2.googleapis.com')) data = { access_token: 'fixture', expires_in: 3600 };
    else if (url.endsWith('/messages/send')) { sent.push(Buffer.from(JSON.parse(String(init?.body)).raw, 'base64url').toString()); data = { id: 'sent-' + sent.length, threadId: 'thread-1' }; }
    else if (url.includes('/attachments/')) {
      const bytes = attachmentBytes[url.split('/').at(-1)!] ?? 'Shipper: ' + url.split('/').at(-1);
      data = { data: (typeof bytes === 'string' ? Buffer.from(bytes) : bytes).toString('base64url') };
    }
    else if (url.includes('/threads/')) data = { id: 'thread-1', messages };
    else data = { messages: messages.map(value => ({ id: value.id, threadId: value.threadId })) };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const automation = new GmailAutomation({ store, service, client, attachmentRoot: root, enabled, automaticComparison });
  return { automation, service, store, messages, sent, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('Gmail automation integration', () => {
  it('automatically compares real image-only thread evidence and sends one verified confirmation', async () => {
    const inbound = message('m1', 'Please verify these documents.', ['a1', 'a2']);
    for (const part of inbound.payload!.parts!.slice(1)) part.mimeType = 'image/png';
    const h = await harness(true, [inbound], {
      a1: await readFile('apps/api/src/documents/testfixtures/ocr-comparison/a.png'),
      a2: await readFile('apps/api/src/documents/testfixtures/ocr-comparison/b.png'),
    }, true);
    try {
      expect((await h.automation.sync()).errors).toEqual([]);
      const record = h.store.listCases()[0];
      expect(record.decision?.workflowState).toBe('VERIFIED');
      expect(h.store.getDocumentComparison(record.email.id)).not.toBeNull();
      expect(h.automation.outbox()[0]).toMatchObject({ action: 'CONFIRM_MATCH', status: 'SENT' });
      expect(h.sent).toHaveLength(1);
      await h.automation.sync(); expect(h.sent).toHaveLength(1);
    } finally { await h.cleanup(); }
  }, 120_000);
  it('queues responsibility clarification for a draft request without asking the customer for the BL', async () => {
    const h = await harness(false);
    try {
      expect((await h.automation.sync()).processed).toBe(1);
      const queued = h.automation.outbox();
      expect(queued).toHaveLength(1);
      expect(queued[0].action).toBe('REQUEST_CLARIFICATION');
      expect(queued[0].reply.text).not.toMatch(/send (?:us )?(?:the )?draft BL/i);
      expect(h.sent).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  it('sends a logical reply once across repeated syncs', async () => {
    const h = await harness(true);
    try {
      await h.automation.sync(); await h.automation.sync();
      expect(h.sent).toHaveLength(1);
      expect(h.automation.outbox()[0].status).toBe('SENT');
      expect(h.store.eventsAfter(0).filter(event => event.type === 'outbound.queued')).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it('dispatches the latest decision revision using the existing never-attempted logical reply', async () => {
    const h = await harness(false);
    try {
      await h.automation.sync();
      const original = h.automation.outbox()[0]; const record = h.store.listCases()[0];
      const revised = { ...record.decision!, decisionVersion: record.decision!.decisionVersion + 1 };
      await h.automation.validateDecision(record.email.id, revised);
      h.store.saveDecision(record.email.id, revised);
      const item = await h.automation.processDecision(record.email.id);
      expect(item?.id).toBe(original.id);
      expect(item?.decision?.decisionVersion).toBe(revised.decisionVersion);
      h.automation.options.enabled = true;
      await h.automation.dispatchPending();
      expect(h.automation.outbox()[0].status).toBe('SENT');
      expect(h.sent).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it('blocks immediate verification when required sources are absent after retrieval', async () => {
    const h = await harness(false, [message('m1', 'Please verify the shipment documents now.')]);
    try {
      await h.automation.sync();
      expect(h.store.listCases()[0].decision?.verificationState).toBe('BLOCKED');
      expect(h.automation.outbox()[0].action).toBe('REQUEST_DOCUMENTS');
    } finally { await h.cleanup(); }
  });
  it('invalidates an older queued reply when a new inbound source arrives', async () => {
    const h = await harness(false);
    try {
      await h.automation.sync();
      const old = h.automation.outbox()[0];
      h.messages.push(message('m2', 'Please verify the revised files.', ['a1', 'a2']));
      await h.automation.sync();
      expect(h.automation.outbox().find(value => value.id === old.id)?.status).toBe('CANCELLED');
      expect(h.store.listCases()[0].email.sourceMessageId).toBe('m2');
    } finally { await h.cleanup(); }
  });
  it('persists thread evidence but waits for content comparison before replying', async () => {
    const h = await harness(true, [message('m1', 'Please verify these documents.', ['a1', 'a2'])]);
    try {
      await h.automation.sync();
      const record = h.store.listCases()[0];
      expect(record.email.attachments).toHaveLength(2);
      expect(record.email.attachments[0].relativePath).toMatch(/^[a-f0-9]{64}\.txt$/);
      expect(record.decision?.nextAction).toBe('RECOVER_FIELDS');
      expect(record.decision?.verificationState).toBe('IN_PROGRESS');
      expect(h.store.eventsAfter(0).some(event => event.type === 'evidence.ready')).toBe(true);
      expect(h.sent).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  it('retains the pending comparison goal when a document reply classifies as GENERAL', async () => {
    const h = await harness(false, [message('m1', 'Please verify our shipment documents.')]);
    try {
      await h.automation.sync();
      h.messages.push(message('m2', 'Here are the documents.', ['a1', 'a2']));
      await h.automation.sync();
      const current = h.store.listCases()[0];
      expect(current.classification?.category).toBe('GENERAL');
      expect(current.decision?.category).toBe('BL_COMPARISON');
      expect(current.decision?.requestedAction).toBe('VERIFY_DOCUMENTS');
      expect(current.decision?.blockers).toContain('THREAD_CONTEXT_REQUIRED');
      expect(current.decision?.nextAction).toBe('RECOVER_FIELDS');
      expect(h.store.eventsAfter(0).some(event => event.type === 'evidence.ready')).toBe(true);
      expect(h.automation.outbox().filter(item => item.status === 'PENDING')).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  it('blocks a forged complete decision whose claimed excerpts are absent from real source bytes', async () => {
    const h = await harness(false, [message('m1', 'Please verify these documents.', ['a1', 'a2'])]);
    try {
      await h.automation.sync();
      const record = h.store.listCases()[0]; const [si, bl] = record.email.attachments;
      const span = (attachment: typeof si) => ({ attachmentId: attachment.id, sha256: attachment.sha256!, locator: 'line:1', text: 'FORGED SOURCE FACT' });
      h.store.saveDecision(record.email.id, { ...record.decision!, decisionVersion: record.decision!.decisionVersion + 1, verificationState: 'COMPLETE', workflowState: 'VERIFIED', nextAction: 'CONFIRM_MATCH', pairValidated: true, blockers: [], knownMismatches: [], fieldResults: FIELD_NAMES.map(field => ({ field, outcome: 'MATCH', si: span(si), bl: span(bl) })) });
      await expect(h.automation.processDecision(record.email.id)).rejects.toThrow(/source|evidence/i);
      expect(h.automation.outbox()).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  it('rejects a forged candidate before persisting a verified state even without an outbound action', async () => {
    const h = await harness(false, [message('m1', 'Please verify these documents.', ['a1', 'a2'])]);
    try {
      await h.automation.sync();
      const record = h.store.listCases()[0]; const [si, bl] = record.email.attachments;
      const span = (attachment: typeof si) => ({ attachmentId: attachment.id, sha256: attachment.sha256!, locator: 'line:1', text: 'FORGED SOURCE FACT' });
      await expect(h.automation.validateDecision(record.email.id, { ...record.decision!, decisionVersion: record.decision!.decisionVersion + 1,
        verificationState: 'COMPLETE', workflowState: 'VERIFIED', nextAction: 'NONE', pairValidated: true, blockers: [], knownMismatches: [],
        fieldResults: FIELD_NAMES.map(field => ({ field, outcome: 'MATCH', si: span(si), bl: span(bl) })) })).rejects.toThrow(/source|evidence/i);
      expect(h.store.getCase(record.email.id)?.decision).toEqual(record.decision);
      expect(h.automation.outbox()).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  it('rejects field evidence assembled from different SI and BL pairs', async () => {
    const lines = FIELD_NAMES.map((field, index) => `${field}: value-${index}`);
    const h = await harness(false, [message('m1', 'Please verify these documents.', ['a1', 'a2', 'a3'])],
      { a1: 'SI\n' + lines.join('\n'), a2: 'BL\n' + lines.join('\n'), a3: 'OTHER BL\n' + lines.join('\n') });
    try {
      await h.automation.sync();
      const record = h.store.listCases()[0]; const [si, bl, other] = record.email.attachments;
      const span = (attachment: typeof si, index: number) => ({ attachmentId: attachment.id, sha256: attachment.sha256!, locator: `line:${index + 2}`, text: lines[index] });
      await expect(h.automation.validateDecision(record.email.id, { ...record.decision!, decisionVersion: record.decision!.decisionVersion + 1,
        verificationState: 'COMPLETE', workflowState: 'VERIFIED', nextAction: 'NONE', pairValidated: true, blockers: [], knownMismatches: [],
        fieldResults: FIELD_NAMES.map((field, index) => ({ field, outcome: 'MATCH', si: span(si, index), bl: span(index ? bl : other, index) })) })).rejects.toThrow(/pair/i);
      expect(h.store.getCase(record.email.id)?.decision).toEqual(record.decision);
    } finally { await h.cleanup(); }
  });
  it('preserves the active BL goal across a failed classification and restarted continuation', async () => {
    const h = await harness(false, [message('m1', 'Please verify our shipment documents.')]);
    try {
      await h.automation.sync();
      h.messages.push(message('m2', 'Here are the documents.', ['a1', 'a2']));
      vi.spyOn(h.service, 'processCase').mockImplementationOnce(async email => {
        const record = h.store.getCase(email.id)!;
        h.store.markFailed(email.id, record.sourceVersion, 'CLASSIFICATION_FAILED');
      });
      expect((await h.automation.sync()).errors).toHaveLength(1);
      const restarted = new GmailAutomation(h.automation.options);
      expect((await restarted.sync()).errors).toHaveLength(0);
      const current = h.store.listCases()[0];
      expect(current.classification?.category).toBe('GENERAL');
      expect(current.decision?.category).toBe('BL_COMPARISON');
      expect(current.decision?.blockers).toContain('THREAD_CONTEXT_REQUIRED');
      expect(current.decision?.nextAction).toBe('RECOVER_FIELDS');
      const version = current.decision!.decisionVersion;
      await restarted.sync();
      expect(h.store.listCases()[0].decision?.decisionVersion).toBe(version);
      await expect(restarted.validateDecision(current.email.id, { ...current.decision!, decisionVersion: version + 1,
        blockers: [], workflowState: 'PROCESSING', verificationState: 'IN_PROGRESS' })).rejects.toThrow(/continuation|context/i);
      expect(h.sent).toHaveLength(0);
    } finally { await h.cleanup(); }
  });
  it('restores an active BL goal after the standalone classification retry finishes first', async () => {
    const h = await harness(false, [message('m1', 'Please verify our shipment documents.')]);
    try {
      await h.automation.sync();
      h.messages.push(message('m2', 'Here are the documents.', ['a1', 'a2']));
      vi.spyOn(h.service, 'processCase').mockImplementationOnce(async () => undefined);
      expect((await h.automation.sync()).errors).toHaveLength(1);
      await h.service.processCase(h.store.listCases()[0].email);
      expect(h.store.listCases()[0].decision?.workflowState).toBe('NOT_APPLICABLE');
      await h.automation.sync();
      expect(h.store.listCases()[0].decision?.category).toBe('BL_COMPARISON');
      expect(h.store.listCases()[0].decision?.blockers).toContain('THREAD_CONTEXT_REQUIRED');
    } finally { await h.cleanup(); }
  });
  it('sends a confirmation when all seven asserted source excerpts are verified', async () => {
    const lines = FIELD_NAMES.map((field, index) => `${field}: value-${index}`);
    const h = await harness(true, [message('m1', 'Please verify these documents.', ['a1', 'a2'])], { a1: 'SI\n' + lines.join('\n'), a2: 'BL\n' + lines.join('\n') });
    try {
      await h.automation.sync();
      const record = h.store.listCases()[0]; const [si, bl] = record.email.attachments;
      const span = (attachment: typeof si, index: number) => ({ attachmentId: attachment.id, sha256: attachment.sha256!, locator: `line:${index + 2}`, text: lines[index] });
      h.store.saveDecision(record.email.id, { ...record.decision!, decisionVersion: record.decision!.decisionVersion + 1, verificationState: 'COMPLETE', workflowState: 'VERIFIED', nextAction: 'CONFIRM_MATCH', pairValidated: true, blockers: [], knownMismatches: [], fieldResults: FIELD_NAMES.map((field, index) => ({ field, outcome: 'MATCH', si: span(si, index), bl: span(bl, index) })) });
      expect((await h.automation.processDecision(record.email.id))?.status).toBe('SENT');
      expect(h.sent).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
  it('drafts an amendment from a proven difference without claiming other fields are cleared', async () => {
    const h = await harness(false, [message('m1', 'Please verify these documents.', ['a1', 'a2'])]);
    try {
      await h.automation.sync();
      const record = h.store.listCases()[0]; const [si, bl] = record.email.attachments;
      const span = (attachment: typeof si) => ({ attachmentId: attachment.id, sha256: attachment.sha256!, locator: 'line:1', text: 'Shipper: ' + (attachment.name!.includes('a1') ? 'a1' : 'a2') });
      h.store.saveDecision(record.email.id, { ...record.decision!, decisionVersion: record.decision!.decisionVersion + 1, nextAction: 'REQUEST_AMENDMENT', knownMismatches: ['shipper'], fieldResults: [{ field: 'shipper', outcome: 'MISMATCH', si: span(si), bl: span(bl) }] });
      const item = await h.automation.processDecision(record.email.id);
      expect(item?.action).toBe('REQUEST_AMENDMENT');
      expect(item?.reply.text).toContain('Shipper: a1');
      expect(item?.reply.text).toContain('Shipper: a2');
      expect(item?.reply.text).not.toContain('No mismatch');
    } finally { await h.cleanup(); }
  });
});

it('preserves validated decision revisions during unchanged Gmail polling', async () => {
  const h = await harness(false);
  try {
    await h.automation.sync();
    const record = h.store.listCases()[0];
    const decision = { ...record.decision!, decisionVersion: record.decision!.decisionVersion + 1 };
    await h.automation.validateDecision(record.email.id, decision);
    h.store.saveDecision(record.email.id, decision);
    const classify = vi.spyOn(h.service, 'processCase');
    await h.automation.sync();
    expect(h.store.getCase(record.email.id)!.decision).toEqual(decision);
    expect(classify).not.toHaveBeenCalled();
    h.messages.push(message('m2', 'Please verify updated shipment documents.'));
    await h.automation.sync();
    expect(classify).toHaveBeenCalledOnce();
    expect(h.store.getCase(record.email.id)!.sourceVersion).not.toBe(record.sourceVersion);
  } finally { await h.cleanup(); }
});
