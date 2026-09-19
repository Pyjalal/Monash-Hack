import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeGmailMessage, buildReplyRaw, replyMessageId } from './message.js';

const encode = (value: string) => Buffer.from(value).toString('base64url');
const raw = {
  id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'Please compare',
  payload: { mimeType: 'multipart/mixed', headers: [
    { name: 'From', value: 'Docs <docs@example.org>' }, { name: 'Subject', value: 'Shipment ABC-42' },
    { name: 'Message-ID', value: '<source@example.org>' },
  ], parts: [
    { mimeType: 'text/plain', body: { data: encode('Please compare the attached drafts.\n\nOn Monday, Somebody wrote:\n> Old request') } },
    { mimeType: 'application/pdf', filename: 'scan.pdf', body: { attachmentId: 'a1', size: 12 } },
  ] },
};

describe('Gmail source decoding', () => {
  it('decodes current text and attachment references without inventing missing bytes', () => {
    const result = decodeGmailMessage(raw, { mailboxAddress: 'ops@example.org' });
    expect(result.email.bodyCurrent).toBe('Please compare the attached drafts.');
    expect(result.email.quoted).toContain('Old request');
    expect(result.email.attachments).toEqual([expect.objectContaining({ id: 'a1', name: 'scan.pdf', messageId: 'm1' })]);
    expect(result.eligible).toBe(true);
    expect(result.rfcMessageId).toBe('<source@example.org>');
  });
  it.each([
    { labelIds: ['SENT'] },
    { payload: { ...raw.payload, headers: [{ name: 'From', value: 'ops@example.org' }] } },
    { payload: { ...raw.payload, headers: [{ name: 'From', value: 'no-reply@example.org' }] } },
    { payload: { ...raw.payload, headers: [...raw.payload.headers, { name: 'Auto-Submitted', value: 'auto-replied' }] } },
    { payload: { ...raw.payload, headers: [...raw.payload.headers, { name: 'List-Id', value: '<updates.example.org>' }] } },
  ])('excludes outgoing or loop-prone mail %#', (patch) => {
    expect(decodeGmailMessage({ ...raw, ...patch }, { mailboxAddress: 'ops@example.org' }).eligible).toBe(false);
  });
  it('keeps source versions stable across read/unread label changes', () => {
    const first = decodeGmailMessage(raw, { mailboxAddress: 'ops@example.org' });
    const second = decodeGmailMessage({ ...raw, labelIds: ['INBOX', 'UNREAD'] }, { mailboxAddress: 'ops@example.org' });
    expect(first.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sourceVersion).toBe(second.sourceVersion);
  });
  it('does not treat an unhydrated text body as a document or an actionable blank message', () => {
    const result = decodeGmailMessage({ ...raw, payload: { ...raw.payload, parts: undefined, mimeType: 'text/plain', body: { attachmentId: 'body-1' } } }, { mailboxAddress: 'ops@example.org' });
    expect(result.email.attachments).toHaveLength(0);
    expect(result.eligible).toBe(false);
    expect(result.skipReason).toBe('BODY_NOT_HYDRATED');
  });
});

describe('outbound MIME', () => {
  const reply = { threadId: 't1', to: 'docs@example.org', subject: 'Shipment ABC-42', text: 'Please supply the SI.', inReplyTo: '<source@example.org>', references: ['<source@example.org>'], idempotencyKey: 'case-v1-request', sourceVersion: 'v1' };
  it('uses stable Message-ID and valid reply headers for reconciliation', () => {
    const decoded = Buffer.from(buildReplyRaw(reply, 'ops@example.org'), 'base64url').toString();
    expect(decoded).toContain('In-Reply-To: <source@example.org>');
    expect(decoded).toContain('Message-ID: ' + replyMessageId(reply.idempotencyKey, 'ops@example.org'));
    expect(decoded).toContain('Auto-Submitted: auto-replied');
  });
  it('rejects header injection', () => {
    expect(() => buildReplyRaw({ ...reply, to: 'docs@example.org\r\nBcc: attacker@example.org' }, 'ops@example.org')).toThrow(/header|address/i);
  });
  it('attaches only authorized verified bytes bound to the current source version', () => {
    const bytes = Buffer.from('actual validated BL');
    const attachment = { name: 'draft.pdf', mimeType: 'application/pdf', contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), sourceVersion: 'v1', verified: true as const, authorizedForSharing: true as const };
    const decoded = Buffer.from(buildReplyRaw({ ...reply, attachments: [attachment] }, 'ops@example.org'), 'base64url').toString();
    expect(decoded).toContain('multipart/mixed');
    expect(decoded).toContain(bytes.toString('base64'));
    expect(() => buildReplyRaw({ ...reply, attachments: [{ ...attachment, sha256: '0'.repeat(64) }] }, 'ops@example.org')).toThrow(/source|hash/i);
    expect(() => buildReplyRaw({ ...reply, attachments: [{ ...attachment, sourceVersion: 'stale' }] }, 'ops@example.org')).toThrow(/version|source/i);
  });
});
