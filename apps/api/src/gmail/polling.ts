import { createHash } from 'node:crypto';
import type { Store } from '../store.js';
import type { GmailAutomation } from './automation.js';
import { GmailApiError } from './client.js';
import { GmailAuthorizationError } from './oauth.js';

export class GmailPoller {
  private running = false;
  private lastError: string | null = null;
  private readonly key: string;
  constructor(private readonly store: Store, private readonly gmail: Pick<GmailAutomation, 'sync' | 'status'>,
    mailbox: string, private readonly query = 'in:inbox -in:spam -in:trash') {
    this.key = createHash('sha256').update(mailbox.toLowerCase() + '\0' + query).digest('hex');
    store.db.exec('CREATE TABLE IF NOT EXISTS gmail_poll_cursor (scope TEXT PRIMARY KEY, token TEXT, completed_at TEXT)');
  }
  status(): { polling: boolean; lastSyncError: string | null; lastCompletedAt: string | null; hasNextPage: boolean } {
    const row = this.store.db.prepare('SELECT token,completed_at FROM gmail_poll_cursor WHERE scope=?').get(this.key) as { token: string | null; completed_at: string | null } | undefined;
    return { polling: this.running, lastSyncError: this.lastError, lastCompletedAt: row?.completed_at ?? null, hasNextPage: !!row?.token };
  }
  async tick(): Promise<void> {
    if (this.running || this.gmail.status().busy) return;
    this.running = true;
    const row = this.store.db.prepare('SELECT token FROM gmail_poll_cursor WHERE scope=?').get(this.key) as { token: string | null } | undefined;
    try {
      const result = await this.gmail.sync({ query: this.query, pageToken: row?.token ?? undefined });
      if (result.errors.length) { this.lastError = 'THREAD_PROCESSING_FAILED'; return; }
      this.store.db.prepare('INSERT OR REPLACE INTO gmail_poll_cursor VALUES (?,?,?)').run(this.key, result.nextPageToken ?? null, new Date().toISOString());
      this.lastError = null;
      this.store.emit('gmail.sync.completed', null, result);
    } catch (error) {
      this.lastError = error instanceof GmailAuthorizationError ? error.code : 'GMAIL_SYNC_FAILED';
      if (row?.token && error instanceof GmailApiError && error.status === 400) {
        this.store.db.prepare('UPDATE gmail_poll_cursor SET token=NULL WHERE scope=?').run(this.key);
        this.lastError = 'GMAIL_CURSOR_RESET';
      }
      this.store.emit('gmail.sync.failed', null, { code: this.lastError });
    } finally { this.running = false; }
  }
}
