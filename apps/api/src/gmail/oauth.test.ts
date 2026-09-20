import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { GmailAuthorization, gmailScopes } from './oauth.js';
import { GmailClient } from './client.js';
import { createApp } from '../app.js';
import { ClassificationService } from '../pipeline.js';

const stores: Store[] = [];
afterEach(() => { stores.forEach(store => store.close()); stores.length = 0; vi.useRealTimers(); });
function setup(fetchImpl?: typeof fetch) {
  const store = new Store(':memory:'); stores.push(store);
  const options = { store, clientId: 'client', clientSecret: 'secret', mailbox: 'ops@example.org', redirectUri: 'http://127.0.0.1:3001/gmail/oauth/callback', fetchImpl: fetchImpl ?? vi.fn(async input => String(input).includes('/token')
    ? Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', scope: gmailScopes.join(' '), expires_in: 3600 })
    : Response.json({ emailAddress: 'ops@example.org' })) };
  return { store, options, auth: new GmailAuthorization(options) };
}
function state(auth: GmailAuthorization): string { return new URL(auth.begin().url).searchParams.get('state')!; }

describe('Gmail OAuth authorization', () => {
  it('uses expiring single-use state and PKCE, pins mailbox and encrypts the refresh token at rest', async () => {
    const { auth, options, store } = setup();
    const url = new URL(auth.begin().url);
    expect(url.searchParams.get('scope')).toBe(gmailScopes.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.toString()).not.toContain('client_secret');
    const query = { state: url.searchParams.get('state')!, code: 'one-use-code' };
    await auth.complete(query);
    expect(auth.status().authorization).toBe('connected');
    expect(auth.refreshToken()).toBe('refresh-secret');
    const rows = JSON.stringify(store.db.prepare('SELECT * FROM gmail_authorization').all());
    expect(rows).not.toContain('refresh-secret'); expect(rows).not.toContain('access-secret');
    expect(JSON.stringify(store.eventsAfter(0))).not.toMatch(/refresh-secret|access-secret|one-use-code/);
    expect(new GmailAuthorization(options).refreshToken()).toBe('refresh-secret');
    await expect(auth.complete(query)).rejects.toThrow('OAUTH_STATE_INVALID');
  });
  it('rejects expired state before any provider request', async () => {
    vi.useFakeTimers(); const { auth, options } = setup(); const nonce = state(auth);
    vi.advanceTimersByTime(600001);
    await expect(auth.complete({ state: nonce, code: 'code' })).rejects.toThrow('OAUTH_STATE_INVALID');
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects denied consent without exchanging a code', async () => {
    const { auth, options } = setup();
    await expect(auth.complete({ state: state(auth), error: 'access_denied' })).rejects.toThrow('OAUTH_CONSENT_DENIED');
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects a different authorized mailbox', async () => {
    const { auth } = setup(async input => String(input).includes('/token')
      ? Response.json({ access_token: 'access', refresh_token: 'refresh', scope: gmailScopes.join(' ') })
      : Response.json({ emailAddress: 'other@example.org' }));
    await expect(auth.complete({ state: state(auth), code: 'code' })).rejects.toThrow('OAUTH_MAILBOX_MISMATCH');
    expect(auth.status().authorization).toBe('disconnected');
  });
  it('rejects partial consent', async () => {
    const { auth } = setup(async () => Response.json({ access_token: 'access', refresh_token: 'refresh', scope: gmailScopes[0] }));
    await expect(auth.complete({ state: state(auth), code: 'code' })).rejects.toThrow('OAUTH_REQUIRED_SCOPES_OR_REFRESH_TOKEN_MISSING');
  });
  it('reports a changed encryption key as reauthorization required', async () => {
    const { auth, options } = setup(); await auth.complete({ state: state(auth), code: 'code' });
    expect(new GmailAuthorization({ ...options, clientSecret: 'changed' }).status().authorization).toBe('reauthorization_required');
  });
  it('disconnected credentials cannot use cached access tokens', async () => {
    const { auth } = setup(); await auth.complete({ state: state(auth), code: 'code' });
    const client = new GmailClient({ clientId: 'client', clientSecret: 'secret', mailboxAddress: 'ops@example.org', refreshToken: () => auth.refreshToken(), fetchImpl: async input => String(input).includes('/token') ? Response.json({ access_token: 'access', expires_in: 3600 }) : Response.json({ messages: [] }) });
    await client.listMessages(); await auth.disconnect();
    await expect(client.listMessages()).rejects.toThrow('GMAIL_DISCONNECTED');
  });
  it('requires dashboard authorization for starting OAuth and never returns tokens', async () => {
    const { auth, store } = setup();
    const service = new ClassificationService({ store, configurationKey: 'test', classifier: async () => { throw new Error('unused'); } });
    const app = createApp({ store, service, dashboardToken: 'dashboard', gmailAuthorization: auth });
    expect((await app.request('/gmail/oauth/start', { method: 'POST' })).status).toBe(401);
    const response = await app.request('/gmail/oauth/start', { method: 'POST', headers: { Authorization: 'Bearer dashboard' } });
    const start = await response.json(); expect(start.url).toContain('accounts.google.com');
    const callback = await app.request('/gmail/oauth/callback?state=' + new URL(start.url).searchParams.get('state') + '&code=code');
    expect(callback.status).toBe(303); expect(callback.headers.get('location')).toBe('/gmail/connection-result?status=connected');
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    const status = await app.request('/gmail/status', { headers: { Authorization: 'Bearer dashboard' } });
    const body = await status.text(); expect(body).toContain('connected'); expect(body).not.toMatch(/access-secret|refresh-secret/);
  });
});
