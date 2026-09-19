import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { OperationalDecisionSchema, type OperationalDecision } from '@cargolens/shared';
import type { ReplyInput } from './message.js';
import { mailboxAddress } from './message.js';
import { GmailApiError, GmailPreflightError } from './client.js';

export type OutboundAction = 'REQUEST_DOCUMENTS' | 'REQUEST_AMENDMENT' | 'CONFIRM_MATCH' | 'REQUEST_CLARIFICATION';
export type OutboxStatus = 'PENDING' | 'SENDING' | 'UNKNOWN' | 'SENT' | 'FAILED' | 'CANCELLED';
export interface EnqueueInput { caseId: string; sourceVersion: string; action: OutboundAction; reply: ReplyInput; decision?: OperationalDecision }
export interface OutboxItem extends EnqueueInput { id: string; status: OutboxStatus; attempts: number; sentMessageId: string | null; error: string | null }
interface Sender { sendReply(reply: ReplyInput): Promise<{ id: string; threadId: string }> }
interface Reconciler { findSentReply(key: string): Promise<{ id: string; threadId: string } | null> }
function deliveryHash(input: EnqueueInput): string {
  const reply = input.reply;
  return createHash('sha256').update(JSON.stringify([input.caseId, input.sourceVersion, input.action,
    mailboxAddress(reply.to), reply.threadId, reply.subject, reply.text, reply.inReplyTo, reply.references,
    reply.idempotencyKey, reply.sourceVersion, reply.attachments?.map(item => [item.name, item.mimeType,
      item.contentBase64, item.sha256, item.sourceVersion, item.verified, item.authorizedForSharing]) ?? [],
  ])).digest('hex');
}
export class GmailOutbox {
  constructor(readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS gmail_outbox (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, source_version TEXT NOT NULL,
      action TEXT NOT NULL, recipient TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0,
      sent_message_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(case_id, source_version, action, recipient)
    )`);
  }

  enqueue(input: EnqueueInput): OutboxItem {
    if (!input.caseId || !input.sourceVersion || input.reply.sourceVersion !== input.sourceVersion || !input.reply.idempotencyKey) throw new Error('Outbound source version and idempotency key are required');
    if (input.action === 'CONFIRM_MATCH') {
      const decision = OperationalDecisionSchema.safeParse(input.decision);
      if (!decision.success || decision.data.nextAction !== 'CONFIRM_MATCH' || decision.data.sourceVersion !== input.sourceVersion) throw new Error('Verified source-backed decision is required for confirmation');
    }
    const recipient = mailboxAddress(input.reply.to);
    const payload = JSON.stringify(input);
    const hash = createHash('sha256').update(payload).digest('hex');
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id, payload_hash FROM gmail_outbox WHERE idempotency_key = ? OR (case_id = ? AND source_version = ? AND action = ? AND recipient = ?)')
        .get(input.reply.idempotencyKey, input.caseId, input.sourceVersion, input.action, recipient) as { id: string; payload_hash: string } | undefined;
      if (existing) {
        const current = this.require(existing.id);
        if (existing.payload_hash === hash) return current;
        if (current.caseId !== input.caseId || current.sourceVersion !== input.sourceVersion || current.action !== input.action
          || mailboxAddress(current.reply.to) !== recipient || current.reply.idempotencyKey !== input.reply.idempotencyKey) {
          throw new Error('Idempotency conflict: key belongs to a different logical reply');
        }
        if (current.status === 'PENDING' && current.attempts === 0) {
          this.db.prepare("UPDATE gmail_outbox SET payload_json=?,payload_hash=?,updated_at=? WHERE id=? AND status='PENDING' AND attempts=0")
            .run(payload, hash, new Date().toISOString(), current.id);
          return this.require(current.id);
        }
        if (deliveryHash(current) !== deliveryHash(input)) throw new Error('Idempotency conflict: existing logical reply has different content');
        return current;
      }
      const id = randomUUID(); const at = new Date().toISOString();
      this.db.prepare('INSERT INTO gmail_outbox(id,case_id,source_version,action,recipient,idempotency_key,payload_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.caseId, input.sourceVersion, input.action, recipient, input.reply.idempotencyKey, payload, hash, 'PENDING', at, at);
      return this.require(id);
    })();
  }

  get(id: string): OutboxItem | null {
    const row = this.db.prepare('SELECT * FROM gmail_outbox WHERE id = ?').get(id) as { id: string; payload_json: string; status: OutboxStatus; attempts: number; sent_message_id: string | null; error: string | null } | undefined;
    if (!row) return null;
    return { ...JSON.parse(row.payload_json) as EnqueueInput, id: row.id, status: row.status, attempts: row.attempts, sentMessageId: row.sent_message_id, error: row.error };
  }

  private require(id: string): OutboxItem {
    const result = this.get(id);
    if (!result) throw new Error('Outbound item not found');
    return result;
  }

  list(status?: OutboxStatus): OutboxItem[] {
    const rows = (status ? this.db.prepare('SELECT id FROM gmail_outbox WHERE status = ? ORDER BY created_at').all(status) : this.db.prepare('SELECT id FROM gmail_outbox ORDER BY created_at').all()) as { id: string }[];
    return rows.map(row => this.require(row.id));
  }

  cancelStale(caseId: string, currentSourceVersion: string): number {
    return this.db.prepare("UPDATE gmail_outbox SET status='CANCELLED', error='STALE_SOURCE', updated_at=? WHERE case_id=? AND source_version<>? AND status='PENDING'")
      .run(new Date().toISOString(), caseId, currentSourceVersion).changes;
  }

  claim(id: string, currentSourceVersion: string): OutboxItem | null {
    return this.db.transaction(() => {
      const item = this.require(id);
      this.cancelStale(item.caseId, currentSourceVersion);
      const changed = this.db.prepare("UPDATE gmail_outbox SET status='SENDING', attempts=attempts+1, updated_at=? WHERE id=? AND source_version=? AND status='PENDING' AND not_before<=?")
        .run(new Date().toISOString(), id, currentSourceVersion, Date.now()).changes;
      return changed ? this.require(id) : null;
    })();
  }

  recoverInterrupted(): number {
    return this.db.prepare("UPDATE gmail_outbox SET status='UNKNOWN', error='INTERRUPTED_DURING_SEND', updated_at=? WHERE status='SENDING'")
      .run(new Date().toISOString()).changes;
  }

  markSent(id: string, messageId: string): void {
    if (!messageId) throw new Error('Sent-message identity is required');
    this.db.prepare("UPDATE gmail_outbox SET status='SENT', sent_message_id=?, error=NULL, updated_at=? WHERE id=? AND status IN ('SENDING','UNKNOWN')")
      .run(messageId, new Date().toISOString(), id);
  }

  markUnknown(id: string, reason = 'DELIVERY_UNCERTAIN'): void {
    this.db.prepare("UPDATE gmail_outbox SET status='UNKNOWN', error=?, updated_at=? WHERE id=? AND status='SENDING'")
      .run(reason, new Date().toISOString(), id);
  }

  async dispatch(id: string, currentSourceVersion: string, sender: Sender): Promise<OutboxItem> {
    const item = this.claim(id, currentSourceVersion);
    if (!item) return this.require(id);
    try {
      const sent = await sender.sendReply(item.reply);
      this.markSent(id, sent.id);
    } catch (error) {
      if (error instanceof GmailPreflightError) {
        this.db.prepare("UPDATE gmail_outbox SET status='FAILED', error=?, updated_at=? WHERE id=? AND status='SENDING'")
          .run(`PREFLIGHT_${error.code}`, new Date().toISOString(), id);
      } else if (error instanceof GmailApiError && [400, 401, 403, 404, 429].includes(error.status)) {
        const retry = error.status === 429 && item.attempts < 3;
        this.db.prepare("UPDATE gmail_outbox SET status=?, error=?, not_before=?, updated_at=? WHERE id=? AND status='SENDING'")
          .run(retry ? 'PENDING' : 'FAILED', `GMAIL_${error.status}`, Date.now() + 2 ** item.attempts * 1000, new Date().toISOString(), id);
      } else this.markUnknown(id);
    }
    return this.require(id);
  }

  async reconcile(id: string, reconciler: Reconciler): Promise<OutboxItem> {
    const item = this.require(id);
    if (item.status !== 'UNKNOWN') return item;
    const found = await reconciler.findSentReply(item.reply.idempotencyKey);
    if (found) this.markSent(id, found.id);
    return this.require(id);
  }
}
