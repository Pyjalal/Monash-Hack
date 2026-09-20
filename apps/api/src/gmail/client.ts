import type { GmailMessage, GmailPart, ReplyInput } from './message.js';
import { buildReplyRaw, decodeGmailMessage, header, isTextBodyPart, mailboxAddress, replyMessageId } from './message.js';
import { GmailAuthorizationError } from './oauth.js';

export interface GmailClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string | (() => string);
  onAuthorizationRevoked?: () => void;
  mailboxAddress: string;
  aliases?: string[];
  authorizedAdditionalRecipients?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export interface GmailThread { id: string; messages: GmailMessage[] }
export interface MessagePage { messages: { id: string; threadId: string }[]; nextPageToken?: string }
export class GmailApiError extends Error {
  constructor(public readonly status: number) { super(`Gmail request failed (${status})`); }
}
export class GmailPreflightError extends Error {
  constructor(public readonly code: string) { super(`Gmail reply preflight failed: ${code}`); }
}
export class GmailClient {
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  constructor(readonly config: GmailClientConfig) {
    if (![config.clientId, config.clientSecret, config.mailboxAddress].every(value => value.trim()) || (typeof config.refreshToken === 'string' && !config.refreshToken.trim())) throw new Error('Gmail credentials are not configured');
    mailboxAddress(config.mailboxAddress);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    const refreshToken = typeof this.config.refreshToken === 'function' ? this.config.refreshToken() : this.config.refreshToken;
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        if (failure.error === 'invalid_grant') { this.token = null; this.config.onAuthorizationRevoked?.(); throw new GmailAuthorizationError('GMAIL_REAUTHORIZATION_REQUIRED'); }
        throw new GmailApiError(response.status);
      }
      const data = await response.json() as { access_token?: string; expires_in?: number };
      if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Malformed Gmail token response');
      this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
      return data.access_token;
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }

  private async request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const accessToken = await this.accessToken();
    const response = await this.fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      ...init, signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 401) {
        this.token = null;
        if (!retried && (!init.method || init.method === 'GET')) return this.request<T>(path, init, true);
        this.config.onAuthorizationRevoked?.();
        throw new GmailAuthorizationError('GMAIL_REAUTHORIZATION_REQUIRED');
      }
      throw new GmailApiError(response.status);
    }
    return await response.json() as T;
  }

  async listMessages(options: { query?: string; pageToken?: string; maxResults?: number } = {}): Promise<MessagePage> {
    const params = new URLSearchParams({ q: options.query ?? 'in:inbox', maxResults: String(Math.max(1, Math.min(options.maxResults ?? 100, 100))) });
    if (options.pageToken) params.set('pageToken', options.pageToken);
    const data = await this.request<Partial<MessagePage>>(`messages?${params}`);
    if (!data || typeof data !== 'object' || (data.messages !== undefined && (!Array.isArray(data.messages) || data.messages.some(item => !item || typeof item.id !== 'string' || typeof item.threadId !== 'string')))) throw new Error('Malformed Gmail message list');
    return { messages: data.messages ?? [], ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const result = await this.request<GmailMessage>(`messages/${encodeURIComponent(id)}?format=full`);
    if (result.id !== id || !result.threadId) throw new Error('Unexpected Gmail message identity');
    return this.hydrateTextBody(result);
  }

  async getThread(id: string): Promise<GmailThread> {
    const result = await this.request<GmailThread>(`threads/${encodeURIComponent(id)}?format=full`);
    if (result.id !== id || !Array.isArray(result.messages) || result.messages.some(message => message.threadId !== id)) throw new Error('Unexpected Gmail thread identity');
    return { ...result, messages: await Promise.all(result.messages.map(message => this.hydrateTextBody(message))) };
  }

  private async hydrateTextBody(message: GmailMessage): Promise<GmailMessage> {
    const hydrate = async (part: GmailPart): Promise<GmailPart> => {
      const result = { ...part, ...(part.body ? { body: { ...part.body } } : {}) };
      if (isTextBodyPart(part) && part.body?.attachmentId && part.body.data === undefined) {
        const bytes = await this.getAttachment(message.id, part.body.attachmentId);
        if (bytes.length > 1_000_000) throw new Error('Gmail text body exceeds hydration limit');
        result.body = { ...part.body, data: bytes.toString('base64url') };
      }
      if (part.parts) result.parts = await Promise.all(part.parts.map(hydrate));
      return result;
    };
    return message.payload ? { ...message, payload: await hydrate(message.payload) } : message;
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const result = await this.request<{ data?: string }>(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    if (typeof result.data !== 'string') throw new Error('Missing Gmail attachment data');
    return Buffer.from(result.data, 'base64url');
  }

  async sendReply(reply: ReplyInput): Promise<{ id: string; threadId: string }> {
    let raw: string;
    try {
      raw = buildReplyRaw(reply, this.config.mailboxAddress);
      const thread = await this.getThread(reply.threadId);
      const source = thread.messages.find(message => header(message, 'Message-ID') === reply.inReplyTo);
      if (!source) throw new GmailPreflightError('SOURCE_NOT_IN_THREAD');
      const decoded = decodeGmailMessage(source, this.config);
      if (!decoded.eligible) throw new GmailPreflightError('SOURCE_EXCLUDED');
      const latest = thread.messages.map((message, index) => ({ message, index }))
        .filter(value => decodeGmailMessage(value.message, this.config).eligible)
        .sort((a, b) => (Number(a.message.internalDate) || 0) - (Number(b.message.internalDate) || 0) || a.index - b.index).at(-1)?.message;
      if (latest?.id !== source.id) throw new GmailPreflightError('STALE_SOURCE');
      const allowed = [mailboxAddress(decoded.email.from), ...(this.config.authorizedAdditionalRecipients ?? []).map(mailboxAddress)];
      if (!allowed.includes(mailboxAddress(reply.to))) throw new GmailPreflightError('RECIPIENT_NOT_AUTHORIZED');
      const normalizeSubject = (value: string) => value.replace(/^(?:re:\s*)+/i, '').trim();
      if (normalizeSubject(reply.subject) !== normalizeSubject(decoded.email.subject)) throw new GmailPreflightError('THREAD_SUBJECT_MISMATCH');
      const knownReferences = new Set(thread.messages.flatMap(message => [header(message, 'Message-ID'), ...(header(message, 'References').match(/<[^<>\s]+>/g) ?? [])]));
      if (reply.references.some(reference => !knownReferences.has(reference))) throw new GmailPreflightError('UNKNOWN_SOURCE_REFERENCE');
    } catch (error) {
      if (error instanceof GmailPreflightError) throw error;
      throw new GmailPreflightError(error instanceof GmailApiError ? `READ_${error.status}` : 'SOURCE_VALIDATION_FAILED');
    }
    const sent = await this.request<{ id: string; threadId: string }>('messages/send', { method: 'POST', body: JSON.stringify({ threadId: reply.threadId, raw }) });
    if (!sent.id || !sent.threadId) throw new Error('Gmail send response did not establish delivery identity');
    return sent;
  }

  async findSentReply(idempotencyKey: string): Promise<{ id: string; threadId: string } | null> {
    const rfcId = replyMessageId(idempotencyKey, this.config.mailboxAddress);
    const page = await this.listMessages({ query: `in:sent rfc822msgid:${rfcId}`, maxResults: 10 });
    for (const candidate of page.messages) {
      const message = await this.getMessage(candidate.id);
      const ownAddresses = [this.config.mailboxAddress, ...(this.config.aliases ?? [])].map(mailboxAddress);
      let sender = '';
      try { sender = mailboxAddress(header(message, 'From')); } catch { sender = ''; }
      if (message.labelIds?.includes('SENT') && header(message, 'Message-ID') === rfcId && ownAddresses.includes(sender)) return { id: message.id, threadId: message.threadId };
    }
    return null;
  }
}
