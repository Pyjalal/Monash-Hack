import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Store } from '../store.js';
import { mailboxAddress } from './message.js';

export const gmailScopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
export class GmailAuthorizationError extends Error {
  constructor(readonly code: string) { super(code); }
}
interface OAuthOptions {
  store: Store; clientId: string; clientSecret: string; redirectUri: string; mailbox: string;
  refreshToken?: string; fetchImpl?: typeof fetch;
}

export class GmailAuthorization {
  readonly callbackPath: string;
  private readonly pending = new Map<string, { verifier: string; expires: number }>();
  private readonly key: Buffer;
  private readonly mailbox: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OAuthOptions) {
    const redirect = new URL(options.redirectUri);
    if (redirect.username || redirect.password || redirect.search || redirect.hash ||
      !((redirect.protocol === 'https:') || (redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) ||
      redirect.pathname !== '/gmail/oauth/callback') throw new Error('Invalid Gmail OAuth callback URI');
    this.callbackPath = redirect.pathname;
    this.mailbox = mailboxAddress(options.mailbox);
    this.key = createHash('sha256').update('CargoLens Gmail OAuth v1\0').update(options.clientSecret).update('\0' + this.mailbox).digest();
    this.fetchImpl = options.fetchImpl ?? fetch;
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS gmail_authorization (
      mailbox TEXT PRIMARY KEY, token TEXT, state TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    if (!this.row() && options.refreshToken) this.save(options.refreshToken);
  }
  private row(): { token: string | null; state: string } | undefined {
    return this.options.store.db.prepare('SELECT token,state FROM gmail_authorization WHERE mailbox=?').get(this.mailbox) as { token: string | null; state: string } | undefined;
  }
  private save(refreshToken: string): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(this.mailbox));
    const ciphertext = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
    this.options.store.db.prepare('INSERT OR REPLACE INTO gmail_authorization VALUES (?,?,?,?)').run(this.mailbox, encrypted, 'connected', new Date().toISOString());
  }
  refreshToken(): string {
    const row = this.row();
    if (!row?.token || row.state !== 'connected') throw new GmailAuthorizationError(row?.state === 'reauthorization_required' ? 'GMAIL_REAUTHORIZATION_REQUIRED' : 'GMAIL_DISCONNECTED');
    try {
      const encrypted = Buffer.from(row.token, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, 12));
      decipher.setAAD(Buffer.from(this.mailbox)); decipher.setAuthTag(encrypted.subarray(12, 28));
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8');
    } catch { this.markRevoked(); throw new GmailAuthorizationError('GMAIL_REAUTHORIZATION_REQUIRED'); }
  }
  status(): { authorization: string; mailbox: string; scopes: string[] } {
    let authorization = this.row()?.state ?? 'disconnected';
    if (authorization === 'connected') { try { this.refreshToken(); } catch { authorization = 'reauthorization_required'; } }
    return { authorization, mailbox: this.mailbox, scopes: gmailScopes };
  }
  markRevoked(): void {
    this.options.store.db.prepare('INSERT OR REPLACE INTO gmail_authorization VALUES (?,NULL,?,?)').run(this.mailbox, 'reauthorization_required', new Date().toISOString());
  }
  begin(): { url: string; expiresInSeconds: number } {
    for (const [key, value] of this.pending) if (value.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 10) throw new GmailAuthorizationError('OAUTH_ATTEMPTS_EXCEEDED');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { verifier, expires: Date.now() + 10 * 60_000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri,
      response_type: 'code', scope: gmailScopes.join(' '), access_type: 'offline', prompt: 'consent',
      login_hint: this.mailbox, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    return { url: url.toString(), expiresInSeconds: 600 };
  }
  async complete(query: { state?: string; code?: string; error?: string }): Promise<void> {
    const pending = this.pending.get(query.state ?? '');
    this.pending.delete(query.state ?? '');
    if (!pending || pending.expires < Date.now()) throw new GmailAuthorizationError('OAUTH_STATE_INVALID');
    if (query.error || !query.code) throw new GmailAuthorizationError('OAUTH_CONSENT_DENIED');
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret,
        redirect_uri: this.options.redirectUri, grant_type: 'authorization_code', code: query.code, code_verifier: pending.verifier }),
    });
    if (!response.ok) throw new GmailAuthorizationError('OAUTH_EXCHANGE_FAILED');
    const token = await response.json() as { access_token?: string; refresh_token?: string; scope?: string };
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token ||
      !gmailScopes.every(scope => token.scope?.split(' ').includes(scope))) throw new GmailAuthorizationError('OAUTH_REQUIRED_SCOPES_OR_REFRESH_TOKEN_MISSING');
    const profileResponse = await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!profileResponse.ok) throw new GmailAuthorizationError('OAUTH_MAILBOX_CHECK_FAILED');
    const profile = await profileResponse.json() as { emailAddress?: string };
    if (typeof profile.emailAddress !== 'string' || mailboxAddress(profile.emailAddress) !== this.mailbox) throw new GmailAuthorizationError('OAUTH_MAILBOX_MISMATCH');
    this.save(token.refresh_token);
    this.options.store.emit('gmail.authorization.connected', null, { state: 'connected' });
  }
  async disconnect(): Promise<void> {
    let token: string | undefined;
    try { token = this.refreshToken(); } catch { /* Local disconnection still succeeds when authorization has expired. */ }
    this.pending.clear();
    this.options.store.db.prepare('INSERT OR REPLACE INTO gmail_authorization VALUES (?,NULL,?,?)').run(this.mailbox, 'disconnected', new Date().toISOString());
    if (token) {
      const response = await this.fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
      if (!response.ok && response.status !== 400) throw new GmailAuthorizationError('OAUTH_REMOTE_REVOCATION_FAILED');
    }
  }
}
