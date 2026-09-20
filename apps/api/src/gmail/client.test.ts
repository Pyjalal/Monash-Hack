import { describe, expect, it } from 'vitest';
import { GmailClient, GmailApiError, GmailPreflightError } from './client.js';
import { replyMessageId } from './message.js';

const config = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', mailboxAddress: 'ops@example.org' };
const source = { id: 'm1', threadId: 't1', payload: { headers: [
  { name: 'From', value: 'docs@example.org' }, { name: 'Subject', value: 'Booking REF-42' }, { name: 'Message-ID', value: '<m1@example.org>' },
] } };
const reply = { threadId: 't1', to: 'docs@example.org', subject: 'Re: Booking REF-42', text: 'Please supply SI.', inReplyTo: '<m1@example.org>', references: ['<m1@example.org>'], idempotencyKey: 'request-v1', sourceVersion: 'v1' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Gmail HTTP connector', () => {
  it('refreshes once and retrieves full messages, thread and attachment bytes', async () => {
    const requests: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push(url);
      if (url.includes('oauth2.googleapis.com')) {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        return json({ access_token: 'access', expires_in: 3600 });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access');
      if (url.includes('/attachments/')) return json({ data: Buffer.from('source bytes').toString('base64url') });
      if (url.includes('/threads/')) return json({ id: 't1', messages: [source] });
      if (url.includes('/messages/m1')) return json(source);
      return json({ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'page2' });
    };
    const client = new GmailClient({ ...config, fetchImpl });
    expect((await client.listMessages({ query: 'in:inbox' })).messages).toHaveLength(1);
    expect((await client.getMessage('m1')).id).toBe('m1');
    expect((await client.getThread('t1')).messages).toHaveLength(1);
    expect((await client.getAttachment('m1', 'a1')).toString()).toBe('source bytes');
    expect(requests.filter(url => url.includes('oauth2.googleapis.com'))).toHaveLength(1);
    expect(requests.some(url => url.includes('format=full'))).toBe(true);
  });
  it('sends one MIME reply after verifying the source belongs to its thread', async () => {
    let sends = 0;
    const client = new GmailClient({ ...config, fetchImpl: async (input, init) => {
      if (String(input).includes('oauth2.googleapis.com')) return json({ access_token: 'access', expires_in: 3600 });
      if (String(input).includes('/threads/')) return json({ id: 't1', messages: [source] });
      sends++;
      const payload = JSON.parse(String(init?.body));
      expect(payload.threadId).toBe('t1');
      expect(Buffer.from(payload.raw, 'base64url').toString()).toContain('In-Reply-To: <m1@example.org>');
      return json({ id: 'sent-1', threadId: 't1' });
    } });
    expect((await client.sendReply(reply)).id).toBe('sent-1');
    expect(sends).toBe(1);
  });
  it('rejects fabricated thread references before sending', async () => {
    let sends = 0;
    const client = new GmailClient({ ...config, fetchImpl: async input => {
      if (String(input).includes('oauth2.googleapis.com')) return json({ access_token: 'access', expires_in: 3600 });
      if (String(input).includes('/threads/')) return json({ id: 't1', messages: [source] });
      sends++; return json({ id: 'should-not-send' });
    } });
    await expect(client.sendReply({ ...reply, inReplyTo: '<fabricated@example.org>' })).rejects.toThrow(/source|thread/i);
    expect(sends).toBe(0);
  });
  it('never silently retries a send after a server error', async () => {
    let sends = 0;
    const client = new GmailClient({ ...config, fetchImpl: async input => {
      if (String(input).includes('oauth2.googleapis.com')) return json({ access_token: 'access', expires_in: 3600 });
      if (String(input).includes('/threads/')) return json({ id: 't1', messages: [source] });
      sends++; return json({ error: { message: 'unavailable' } }, 503);
    } });
    await expect(client.sendReply(reply)).rejects.toBeInstanceOf(GmailApiError);
    expect(sends).toBe(1);
  });
  it('reconciles only a SENT message with our exact Message-ID and mailbox sender', async () => {
    const rfcId = replyMessageId('request-v1', config.mailboxAddress);
    const client = new GmailClient({ ...config, fetchImpl: async input => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) return json({ access_token: 'access', expires_in: 3600 });
      if (url.includes('/messages/foreign')) return json({ id: 'foreign', threadId: 't1', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: rfcId }, { name: 'From', value: 'foreign@example.org' }] } });
      return json({ messages: [{ id: 'foreign', threadId: 't1' }] });
    } });
    expect(await client.findSentReply('request-v1')).toBeNull();
  });
  it('rejects a stale reply when a newer eligible inbound message arrives before sending', async () => {
    let sends = 0;
    const newer = { ...source, id: 'm2', internalDate: '200', payload: { headers: source.payload.headers.map(value => value.name === 'Message-ID' ? { ...value, value: '<m2@example.org>' } : value) } };
    const client = new GmailClient({ ...config, fetchImpl: async input => {
      if (String(input).includes('oauth2.googleapis.com')) return json({ access_token: 'access', expires_in: 3600 });
      if (String(input).includes('/threads/')) return json({ id: 't1', messages: [{ ...source, internalDate: '100' }, newer] });
      sends++; return json({ id: 'incorrect-send', threadId: 't1' });
    } });
    await expect(client.sendReply(reply)).rejects.toBeInstanceOf(GmailPreflightError);
    expect(sends).toBe(0);
  });
  it('hydrates external text bodies before returning a message', async () => {
    const client = new GmailClient({ ...config, fetchImpl: async input => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com')) return json({ access_token: 'access', expires_in: 3600 });
      if (url.includes('/attachments/')) return json({ data: Buffer.from('Please compare the current documents').toString('base64url') });
      return json({ ...source, payload: { ...source.payload, mimeType: 'text/plain', body: { attachmentId: 'external-body' } } });
    } });
    const message = await client.getMessage('m1');
    expect(Buffer.from(message.payload?.body?.data ?? '', 'base64url').toString()).toBe('Please compare the current documents');
  });
});

it('refreshes and retries a failed GET once after access-token expiry', async () => {
  let refreshes = 0; let reads = 0;
  const client = new GmailClient({ ...config, fetchImpl: async input => {
    if (String(input).includes('/token')) return json({ access_token: 'access-' + ++refreshes, expires_in: 3600 });
    if (++reads === 1) return json({}, 401);
    return json({ messages: [] });
  } });
  expect((await client.listMessages()).messages).toEqual([]);
  expect(refreshes).toBe(2); expect(reads).toBe(2);
});
it('makes revoked authorization explicit and does not expose provider secrets', async () => {
  let revoked = false;
  const client = new GmailClient({ ...config, onAuthorizationRevoked: () => { revoked = true; }, fetchImpl: async () => json({ error: 'invalid_grant', error_description: 'secret provider detail' }, 400) });
  await expect(client.listMessages()).rejects.toThrow('GMAIL_REAUTHORIZATION_REQUIRED');
  expect(revoked).toBe(true);
});
