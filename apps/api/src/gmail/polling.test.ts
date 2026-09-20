import { expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { GmailPoller } from './polling.js';
import { GmailApiError } from './client.js';
import { GmailAuthorizationError } from './oauth.js';

it('resumes persisted polling pages and does not advance over failed threads', async () => {
  const store = new Store(':memory:');
  const sync = vi.fn().mockResolvedValueOnce({ processed: 1, skipped: 0, errors: [], nextPageToken: 'page2' })
    .mockResolvedValueOnce({ processed: 0, skipped: 0, errors: [{ threadId: 't2', code: 'failed' }] })
    .mockResolvedValueOnce({ processed: 1, skipped: 0, errors: [] });
  const gmail = { sync, status: () => ({ busy: false, enabled: false, pending: 0, unknown: 0 }) };
  try {
    await new GmailPoller(store, gmail, 'ops@example.org').tick();
    const restarted = new GmailPoller(store, gmail, 'ops@example.org'); await restarted.tick();
    expect(sync.mock.calls[1][0].pageToken).toBe('page2');
    expect(restarted.status()).toMatchObject({ hasNextPage: true, lastSyncError: 'THREAD_PROCESSING_FAILED' });
    await restarted.tick(); expect(sync.mock.calls[2][0].pageToken).toBe('page2');
    expect(restarted.status()).toMatchObject({ hasNextPage: false, lastSyncError: null });
  } finally { store.close(); }
});
it('invalid cursors restart explicitly; expired authorization is not an empty success', async () => {
  const store = new Store(':memory:');
  const sync = vi.fn().mockResolvedValueOnce({ processed: 0, skipped: 0, errors: [], nextPageToken: 'expired' })
    .mockRejectedValueOnce(new GmailApiError(400)).mockRejectedValueOnce(new GmailAuthorizationError('GMAIL_REAUTHORIZATION_REQUIRED'));
  const poller = new GmailPoller(store, { sync, status: () => ({ busy: false, enabled: false, pending: 0, unknown: 0 }) }, 'ops@example.org');
  try {
    await poller.tick(); await poller.tick(); expect(poller.status()).toMatchObject({ hasNextPage: false, lastSyncError: 'GMAIL_CURSOR_RESET' });
    await poller.tick(); expect(poller.status().lastSyncError).toBe('GMAIL_REAUTHORIZATION_REQUIRED');
  } finally { store.close(); }
});
