import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { collectGmailEvidence, planMissingEvidence, selectEvidencePair, shipmentSearchQuery, GmailResumeStore } from './evidence.js';
import { decodeGmailMessage } from './message.js';

describe('responsibility and source retrieval', () => {
  it('routes an owed draft to the configured documentation contact', () => {
    const plan = planMissingEvidence({ requestedAction: 'REQUEST_DRAFT', requester: 'customer@example.org', documentationContact: 'docs@example.org', missingRoles: ['BL'], retrievalComplete: true });
    expect(plan.kind).toBe('REQUEST_DOCUMENTATION');
    expect(plan.recipient).toBe('docs@example.org');
    expect(plan.replyType).toBe('REQUEST_DOCUMENTS');
  });
  it('asks for responsibility clarification instead of demanding the BL from its requester', () => {
    const plan = planMissingEvidence({ requestedAction: 'REQUEST_DRAFT', requester: 'customer@example.org', missingRoles: ['BL'], retrievalComplete: true });
    expect(plan.kind).toBe('REQUEST_CLARIFICATION');
    expect(plan.text).not.toMatch(/send (?:us )?(?:the |a )?(?:draft )?BL/i);
  });
  it('retrieves evidence before sending a missing-document request', () => {
    expect(planMissingEvidence({ requestedAction: 'VERIFY_DOCUMENTS', requester: 'customer@example.org', missingRoles: ['SI'], retrievalComplete: false }).kind).toBe('FETCH_EVIDENCE');
  });
  it('rejects search operators in shipment references', () => {
    expect(shipmentSearchQuery('BOOK-0042')).toContain('"BOOK-0042"');
    expect(() => shipmentSearchQuery('REF" OR in:sent')).toThrow(/reference/i);
  });
  it('keeps conflicting same-role source documents ambiguous', () => {
    const docs = [
      { role: 'SI' as const, attachmentId: 's1', messageId: 'm1', threadId: 't1', sourceHash: 'a', authoritative: true },
      { role: 'SI' as const, attachmentId: 's2', messageId: 'm2', threadId: 't1', sourceHash: 'b', authoritative: true },
      { role: 'BL' as const, attachmentId: 'b1', messageId: 'm3', threadId: 't1', sourceHash: 'c', authoritative: true },
    ];
    expect(selectEvidencePair(docs, { threadId: 't1' }).status).toBe('AMBIGUOUS');
  });
  it('will not pair unrelated cross-thread documents', () => {
    const docs = [
      { role: 'SI' as const, attachmentId: 's1', messageId: 'm1', threadId: 't1', sourceHash: 'a', authoritative: true },
      { role: 'BL' as const, attachmentId: 'b1', messageId: 'm2', threadId: 't2', sourceHash: 'b', authoritative: true, shipmentReference: 'OTHER-42' },
    ];
    expect(selectEvidencePair(docs, { threadId: 't1', shipmentReference: 'BOOK-0042' }).status).toBe('MISSING');
  });
  it('collects actual earlier thread attachment bytes while exposing unvalidated candidates', async () => {
    const message = { id: 'old-message', threadId: 't1', payload: { headers: [{ name: 'From', value: 'source@example.org' }], parts: [{ filename: 'SI.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1' } }] } };
    const result = await collectGmailEvidence({ getThread: async () => ({ id: 't1', messages: [message] }), getAttachment: async () => Buffer.from('real source'), listMessages: async () => ({ messages: [] }) }, { threadId: 't1', mailboxAddress: 'ops@example.org' });
    expect(result.attachments[0].bytes.toString()).toBe('real source');
    expect(result.attachments[0].sourceHash).toHaveLength(64);
    expect(result.attachments[0].messageId).toBe('old-message');
    expect(result.validatedPair).toBe(false);
  });
});

describe('reply-driven resumption', () => {
  it('persists receipt deduplication and changes source version for an eligible reply', () => {
    const db = new Database(':memory:');
    const store = new GmailResumeStore(db, 'ops@example.org'); store.bindCase('case-1', 't1');
    const raw = { id: 'reply-1', threadId: 't1', payload: { headers: [{ name: 'From', value: 'docs@example.org' }], body: { data: Buffer.from('Here is the missing SI').toString('base64url') }, mimeType: 'text/plain' } };
    const message = decodeGmailMessage(raw, { mailboxAddress: 'ops@example.org' });
    expect(store.acceptReply('case-1', message).changed).toBe(true);
    expect(new GmailResumeStore(db, 'ops@example.org').acceptReply('case-1', message).changed).toBe(false);
    const other = decodeGmailMessage({ ...raw, id: 'reply-2', threadId: 'other' }, { mailboxAddress: 'ops@example.org' });
    expect(() => store.acceptReply('case-1', other)).toThrow(/thread/i);
    db.close();
  });
});
