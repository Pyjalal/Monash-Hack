import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { GmailOutbox } from './outbox.js';
import { GmailPreflightError } from './client.js';
import type { OperationalDecision } from '@cargolens/shared';

const input = { caseId: 'case-1', sourceVersion: 'v1', action: 'REQUEST_DOCUMENTS' as const, reply: { threadId: 't1', to: 'docs@example.org', subject: 'Booking', text: 'Please supply SI.', inReplyTo: '<m1@example.org>', references: ['<m1@example.org>'], idempotencyKey: 'case-1:v1:docs', sourceVersion: 'v1' } };
const decision = (decisionVersion: number): OperationalDecision => ({ category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW',
  verificationState: 'BLOCKED', workflowState: 'BLOCKED', knownMismatches: [], blockers: ['MISSING_SI'], fieldResults: [], nextAction: 'REQUEST_DOCUMENTS', sourceVersion: 'v1', decisionVersion, pairValidated: false });

describe('durable Gmail outbox', () => {
  it('deduplicates a logical reply and replaces a never-attempted pending revision', () => {
    const db = new Database(':memory:'); const outbox = new GmailOutbox(db);
    const first = outbox.enqueue(input);
    expect(first.status).toBe('PENDING');
    expect(outbox.enqueue(input).id).toBe(first.id);
    const revised = outbox.enqueue({ ...input, decision: decision(2), reply: { ...input.reply, text: 'Changed facts' } });
    expect(revised.id).toBe(first.id);
    expect(revised.reply.idempotencyKey).toBe(first.reply.idempotencyKey);
    expect(revised.reply.text).toBe('Changed facts');
    expect(revised.decision?.decisionVersion).toBe(2);
    db.close();
  });
  it('returns the existing sent reply for a metadata-only decision revision without resending', async () => {
    const db = new Database(':memory:'); const outbox = new GmailOutbox(db); let sends = 0;
    const first = outbox.enqueue({ ...input, decision: decision(1) });
    const sender = { sendReply: async () => { sends++; return { id: 'sent-1', threadId: 't1' }; } };
    await outbox.dispatch(first.id, 'v1', sender);
    expect(outbox.enqueue({ ...input, decision: decision(2) }).status).toBe('SENT');
    await outbox.dispatch(first.id, 'v1', sender);
    expect(sends).toBe(1);
    expect(() => outbox.enqueue({ ...input, decision: decision(2), reply: { ...input.reply, text: 'Changed facts' } })).toThrow(/conflict|different/i);
    db.close();
  });
  it('keeps ambiguous delivery immutable and never resends revised metadata or content', async () => {
    const db = new Database(':memory:'); const outbox = new GmailOutbox(db); let sends = 0;
    const first = outbox.enqueue({ ...input, decision: decision(1) });
    const sender = { sendReply: async () => { sends++; throw new Error('timeout'); } };
    await outbox.dispatch(first.id, 'v1', sender);
    expect(outbox.enqueue({ ...input, decision: decision(2) }).status).toBe('UNKNOWN');
    expect(() => outbox.enqueue({ ...input, decision: decision(2), reply: { ...input.reply, text: 'Changed facts' } })).toThrow(/conflict|different/i);
    await outbox.dispatch(first.id, 'v1', sender);
    expect(sends).toBe(1);
    db.close();
  });
  it('cancels a stale decision before a worker can claim it', () => {
    const db = new Database(':memory:'); const outbox = new GmailOutbox(db);
    const item = outbox.enqueue(input);
    expect(outbox.claim(item.id, 'v2')).toBeNull();
    expect(outbox.get(item.id)?.status).toBe('CANCELLED');
    db.close();
  });
  it('does not resend after an ambiguous timeout and reconciles later', async () => {
    const db = new Database(':memory:'); const outbox = new GmailOutbox(db);
    const item = outbox.enqueue(input); let sends = 0;
    const sender = { sendReply: async () => { sends++; throw new Error('timeout'); }, findSentReply: async () => null };
    expect((await outbox.dispatch(item.id, 'v1', sender)).status).toBe('UNKNOWN');
    expect((await outbox.dispatch(item.id, 'v1', sender)).status).toBe('UNKNOWN');
    expect((await outbox.reconcile(item.id, sender)).status).toBe('UNKNOWN');
    expect(sends).toBe(1);
    expect((await outbox.reconcile(item.id, { findSentReply: async () => ({ id: 'sent-1', threadId: 't1' }) })).status).toBe('SENT');
    expect(outbox.get(item.id)?.sentMessageId).toBe('sent-1');
    db.close();
  });
  it('recovers interrupted SENDING rows as UNKNOWN rather than PENDING', () => {
    const db = new Database(':memory:'); const first = new GmailOutbox(db);
    const item = first.enqueue(input);
    expect(first.claim(item.id, 'v1')?.status).toBe('SENDING');
    const restarted = new GmailOutbox(db);
    expect(restarted.recoverInterrupted()).toBe(1);
    expect(restarted.get(item.id)?.status).toBe('UNKNOWN');
    expect(restarted.claim(item.id, 'v1')).toBeNull();
    db.close();
  });
  it('requires a complete source-backed operational decision before confirming a match', () => {
    const db = new Database(':memory:'); const outbox = new GmailOutbox(db);
    expect(() => outbox.enqueue({ ...input, action: 'CONFIRM_MATCH' })).toThrow(/verified|decision/i);
    db.close();
  });
  it('records preflight rejection as failed because no send was attempted', async () => {
    const db = new Database(':memory:'); const outbox = new GmailOutbox(db);
    const item = outbox.enqueue(input);
    const result = await outbox.dispatch(item.id, 'v1', { sendReply: async () => { throw new GmailPreflightError('STALE_SOURCE'); } });
    expect(result.status).toBe('FAILED');
    expect(result.error).toBe('PREFLIGHT_STALE_SOURCE');
    db.close();
  });
});
