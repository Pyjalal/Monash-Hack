import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OperationalDecisionSchema, type Email, type OperationalDecision } from '@cargolens/shared';
import type { Store, CaseRecord } from '../store.js';
import type { ClassificationService } from '../pipeline.js';
import type { GmailClient } from './client.js';
import { GmailOutbox, type OutboxItem } from './outbox.js';
import { decodeGmailMessage, mailboxAddress, type DecodedGmailMessage } from './message.js';
import { collectGmailEvidence, GmailResumeStore, planMissingEvidence, type CollectedEvidence } from './evidence.js';
import { verifyOperationalEvidence } from './evidence-validation.js';
import { GmailAuthorizationError } from './oauth.js';
import { composeDraft } from '../drafts.js';

export interface GmailAutomationOptions { store: Store; service: ClassificationService; client: GmailClient; attachmentRoot: string; enabled: boolean; documentationContact?: string }
export interface GmailSyncResult { processed: number; skipped: number; errors: { threadId: string; code: string }[]; nextPageToken?: string }
interface Snapshot { sourceVersion: string; latest: DecodedGmailMessage; retrievalComplete: boolean }
interface RetainedGoal { requestedAction: OperationalDecision['requestedAction']; documentExpectation: OperationalDecision['documentExpectation']; active?: boolean }

export class GmailAutomation {
  private readonly queue: GmailOutbox;
  private readonly resume: GmailResumeStore;
  private serial: Promise<unknown> = Promise.resolve();
  private operations = 0;
  constructor(readonly options: GmailAutomationOptions) {
    this.queue = new GmailOutbox(options.store.db);
    this.queue.recoverInterrupted();
    this.resume = new GmailResumeStore(options.store.db, options.client.config.mailboxAddress);
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS gmail_automation_snapshots (
      case_id TEXT PRIMARY KEY, source_version TEXT NOT NULL, decoded_json TEXT NOT NULL,
      retrieval_complete INTEGER NOT NULL, evidence_json TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS gmail_automation_goals (
      case_id TEXT PRIMARY KEY, goal_json TEXT NOT NULL
    )`);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.operations++;
    const result = this.serial.then(work).finally(() => { this.operations--; });
    this.serial = result.catch(() => undefined);
    return result;
  }

  sync(options: { query?: string; pageToken?: string; maxMessages?: number } = {}): Promise<GmailSyncResult> {
    return this.exclusive(async () => {
      const limit = Math.max(1, Math.min(Math.floor(options.maxMessages ?? 50), 100));
      if (!Number.isFinite(limit)) throw new Error('Gmail sync limit must be finite');
      const result: GmailSyncResult = { processed: 0, skipped: 0, errors: [] };
      const seen = new Set<string>(); let pageToken = options.pageToken; let scanned = 0;
      do {
        const page = await this.options.client.listMessages({ query: options.query ?? 'in:inbox -in:spam -in:trash', pageToken, maxResults: limit - scanned });
        for (const message of page.messages) {
          scanned++;
          if (seen.has(message.threadId)) continue;
          seen.add(message.threadId);
          try {
            if (await this.ingestThread(message.threadId)) result.processed++;
            else result.skipped++;
          } catch (error) {
            if (error instanceof GmailAuthorizationError) throw error;
            result.errors.push({ threadId: message.threadId, code: 'THREAD_PROCESSING_FAILED' });
            this.options.store.emit('gmail.thread.failed', null, { threadId: message.threadId, code: 'THREAD_PROCESSING_FAILED' });
          }
        }
        pageToken = page.nextPageToken;
        if (!page.messages.length) break;
      } while (pageToken && scanned < limit);
      if (pageToken) result.nextPageToken = pageToken;
      if (this.options.enabled) await this.dispatchInternal();
      return result;
    });
  }

  private async ingestThread(threadId: string): Promise<boolean> {
    const { client, store, service } = this.options;
    const thread = await client.getThread(threadId);
    const latest = thread.messages.map((raw, index) => ({ raw, index, decoded: decodeGmailMessage(raw, client.config) }))
      .filter(value => value.decoded.eligible)
      .sort((a, b) => (Number(a.raw.internalDate) || 0) - (Number(b.raw.internalDate) || 0) || a.index - b.index).at(-1);
    if (!latest) return false;
    const mailboxKey = createHash('sha256').update(mailboxAddress(client.config.mailboxAddress)).digest('hex').slice(0, 16);
    const caseId = `gmail:${mailboxKey}:${threadId}`;
    const references = [...latest.decoded.email.bodyCurrent.matchAll(/\b(?:booking(?:\s+(?:ref(?:erence)?|number|no\.?))?|shipment(?:\s+(?:ref(?:erence)?|number|no\.?))?|reference)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9_./-]{3,63})/gi)].map(match => match[1]);
    const uniqueReferences = [...new Set(references)];
    const evidence = await collectGmailEvidence(client, { threadId, mailboxAddress: client.config.mailboxAddress, ...(uniqueReferences.length === 1 ? { shipmentReference: uniqueReferences[0] } : {}) });
    const attachments = await this.persistAttachments(evidence);
    const email: Email = { ...latest.decoded.email, id: caseId, sourceMessageId: latest.raw.id, attachments };
    const previous = store.getCase(caseId);
    if (previous?.decision?.category === 'BL_COMPARISON' && ['VERIFIED', 'NOT_APPLICABLE'].includes(previous.decision.workflowState)) {
      store.db.prepare('DELETE FROM gmail_automation_goals WHERE case_id=?').run(caseId);
    }
    const record = store.upsertEmail(email);
    this.resume.bindCase(caseId, threadId);
    this.resume.acceptReply(caseId, latest.decoded);
    this.queue.cancelStale(caseId, record.sourceVersion);
    store.db.prepare(`INSERT INTO gmail_automation_snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET
      source_version=excluded.source_version,decoded_json=excluded.decoded_json,retrieval_complete=excluded.retrieval_complete,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
      .run(caseId, record.sourceVersion, JSON.stringify(latest.decoded), evidence.truncated ? 0 : 1,
        JSON.stringify(evidence.attachments.map(({ bytes: _bytes, ...source }) => source)), new Date().toISOString());
    if (record.status !== 'classified' || !record.classification || !record.decision) await service.processCase(email);
    let current = store.getCase(caseId)!;
    if (!current.classification || !current.decision) throw new Error('Gmail classification failed');
    const storedGoal = store.db.prepare('SELECT goal_json FROM gmail_automation_goals WHERE case_id=?').get(caseId) as { goal_json: string } | undefined;
    const goal = storedGoal ? JSON.parse(storedGoal.goal_json) as RetainedGoal : undefined;
    if (current.classification.category === 'BL_COMPARISON') {
      store.db.prepare('INSERT OR REPLACE INTO gmail_automation_goals(case_id,goal_json) VALUES(?,?)').run(caseId, JSON.stringify({
        requestedAction: current.decision.requestedAction, documentExpectation: current.decision.documentExpectation,
        sourceVersion: current.sourceVersion, sourceMessageId: latest.raw.id, requestExcerpt: latest.decoded.email.bodyCurrent,
        active: !['VERIFIED', 'NOT_APPLICABLE'].includes(current.decision.workflowState),
      }));
    } else if (goal && goal.active !== false && ['GENERAL', 'UNCERTAIN'].includes(current.classification.category)
      && !current.decision.blockers.includes('THREAD_CONTEXT_REQUIRED')) {
      store.saveDecision(caseId, { ...current.decision, category: 'BL_COMPARISON', requestedAction: goal.requestedAction, documentExpectation: goal.documentExpectation,
        decisionVersion: current.decision.decisionVersion + 1, verificationState: 'BLOCKED', workflowState: 'BLOCKED', blockers: ['THREAD_CONTEXT_REQUIRED'],
        nextAction: attachments.length ? 'RECOVER_FIELDS' : 'WAIT' });
      store.emit(attachments.length ? 'evidence.ready' : 'case.continuation.required', caseId, { sourceVersion: current.sourceVersion, attachments: attachments.length,
        validatedPair: false, continuationRequired: true, messageCategory: current.classification.category });
      current = store.getCase(caseId)!;
    }
    if (current.decision?.category !== 'BL_COMPARISON') return true;
    if (current.decision.nextAction === 'FETCH_THREAD') {
      if (attachments.length) {
        store.saveDecision(caseId, { ...current.decision, decisionVersion: current.decision.decisionVersion + 1, verificationState: 'IN_PROGRESS', workflowState: 'PROCESSING', nextAction: 'RECOVER_FIELDS' });
        store.emit('evidence.ready', caseId, { sourceVersion: current.sourceVersion, attachments: attachments.length, validatedPair: false, truncated: evidence.truncated });
      } else if (!evidence.truncated) {
        const plan = planMissingEvidence({ requestedAction: current.decision.requestedAction, requester: current.email.from, documentationContact: this.options.documentationContact, missingRoles: ['SI', 'BL'], retrievalComplete: true });
        if (plan.replyType) {
          const expectedNow = current.decision.documentExpectation === 'EXPECTED_NOW';
          store.saveDecision(caseId, { ...current.decision, decisionVersion: current.decision.decisionVersion + 1, nextAction: plan.replyType,
            verificationState: expectedNow ? 'BLOCKED' : current.decision.verificationState,
            workflowState: expectedNow ? 'BLOCKED' : current.decision.workflowState,
            blockers: expectedNow ? [...new Set([...current.decision.blockers, 'MISSING_SI', 'MISSING_BL'])] : current.decision.blockers });
        }
      }
    }
    if (previous?.sourceVersion !== record.sourceVersion) store.emit('gmail.case.resumed', caseId, { sourceVersion: record.sourceVersion, sourceMessageId: latest.raw.id });
    await this.prepareDecision(caseId);
    return true;
  }

  private async persistAttachments(evidence: CollectedEvidence): Promise<Email['attachments']> {
    const root = resolve(this.options.attachmentRoot);
    await mkdir(root, { recursive: true });
    const extensions: Record<string, string> = { 'text/plain': 'txt', 'text/csv': 'csv', 'text/tab-separated-values': 'tsv', 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };
    const attachments: Email['attachments'] = [];
    for (const source of evidence.attachments) {
      const metadata = evidence.messages.find(message => message.email.id === source.messageId)?.email.attachments.find(item => item.id === source.attachmentId);
      if (!metadata) throw new Error('Attachment source metadata is missing');
      const mimeType = metadata.mimeType.split(';', 1)[0].toLowerCase();
      const relativePath = `${source.sourceHash}.${extensions[mimeType] ?? 'bin'}`;
      const path = resolve(root, relativePath);
      try { await writeFile(path, source.bytes, { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (createHash('sha256').update(await readFile(path)).digest('hex') !== source.sourceHash) throw new Error('Attachment source cache hash mismatch');
      }
      attachments.push({ id: 'gmail-att:' + createHash('sha256').update(`${source.messageId}:${source.attachmentId}`).digest('hex'), messageId: source.messageId, name: metadata.name, mimeType, sha256: source.sourceHash, relativePath });
    }
    return attachments.sort((a, b) => a.id.localeCompare(b.id));
  }

  private snapshot(caseId: string): Snapshot {
    const row = this.options.store.db.prepare('SELECT source_version,decoded_json,retrieval_complete FROM gmail_automation_snapshots WHERE case_id=?').get(caseId) as { source_version: string; decoded_json: string; retrieval_complete: number } | undefined;
    if (!row) throw new Error('Gmail source snapshot is missing');
    return { sourceVersion: row.source_version, latest: JSON.parse(row.decoded_json) as DecodedGmailMessage, retrievalComplete: Boolean(row.retrieval_complete) };
  }

  processDecision(caseId: string): Promise<OutboxItem | null> {
    return this.exclusive(async () => {
      const item = await this.prepareDecision(caseId);
      if (this.options.enabled) await this.dispatchInternal();
      return item ? this.queue.get(item.id) : null;
    });
  }

  validateDecision(caseId: string, candidate: OperationalDecision): Promise<void> {
    return this.exclusive(async () => {
      const decision = OperationalDecisionSchema.parse(candidate);
      const record = this.options.store.getCase(caseId);
      if (!record || record.sourceVersion !== decision.sourceVersion) throw new Error('Gmail decision source version is stale');
      const snapshot = this.snapshot(caseId);
      if (snapshot.sourceVersion !== record.sourceVersion || !snapshot.latest.eligible || !snapshot.retrievalComplete) throw new Error('Current complete Gmail source snapshot is required');
      if (record.decision?.blockers.includes('THREAD_CONTEXT_REQUIRED') && !decision.blockers.includes('THREAD_CONTEXT_REQUIRED')) {
        throw new Error('Thread continuation context must be resolved explicitly before clearing its blocker');
      }
      await this.verifyEvidence(record, decision);
    });
  }

  private async prepareDecision(caseId: string): Promise<OutboxItem | null> {
    const record = this.options.store.getCase(caseId);
    if (!record?.decision || record.decision.category !== 'BL_COMPARISON') return null;
    const decision = OperationalDecisionSchema.parse(record.decision);
    if (decision.blockers.includes('THREAD_CONTEXT_REQUIRED')) return null;
    if (!['REQUEST_DOCUMENTS', 'REQUEST_CLARIFICATION', 'REQUEST_AMENDMENT', 'CONFIRM_MATCH'].includes(decision.nextAction)) return null;
    const snapshot = this.snapshot(caseId);
    if (snapshot.sourceVersion !== record.sourceVersion || !snapshot.latest.eligible || !snapshot.retrievalComplete) throw new Error('Current complete Gmail source snapshot is required');
    if (decision.nextAction === 'CONFIRM_MATCH' || decision.nextAction === 'REQUEST_AMENDMENT') await this.verifyEvidence(record, decision);
    const { action, to: recipient, text } = composeDraft(record, this.options.documentationContact);
    const idempotencyKey = createHash('sha256').update(`${caseId}:${record.sourceVersion}:${action}:${recipient}`).digest('hex');
    const existing = this.queue.list().some(item => item.reply.idempotencyKey === idempotencyKey);
    const item = this.queue.enqueue({ caseId, sourceVersion: record.sourceVersion, action, decision, reply: { threadId: snapshot.latest.email.threadId!, to: recipient, subject: snapshot.latest.email.subject, text, inReplyTo: snapshot.latest.rfcMessageId, references: snapshot.latest.references, idempotencyKey, sourceVersion: record.sourceVersion } });
    if (!existing) this.options.store.emit('outbound.queued', caseId, { id: item.id, action, status: item.status, sourceVersion: record.sourceVersion });
    return item;
  }

  private async verifyEvidence(record: CaseRecord, decision: OperationalDecision): Promise<void> {
    await verifyOperationalEvidence(record, decision, this.options.attachmentRoot);
  }

  dispatchPending(): Promise<OutboxItem[]> { return this.exclusive(() => this.dispatchInternal()); }

  private async dispatchInternal(): Promise<OutboxItem[]> {
    if (!this.options.enabled) return this.queue.list();
    for (const item of this.queue.list('UNKNOWN')) {
      try { await this.queue.reconcile(item.id, this.options.client); }
      catch { this.options.store.emit('outbound.reconciliation.failed', item.caseId, { id: item.id }); }
    }
    for (const item of this.queue.list('PENDING')) {
      const record = this.options.store.getCase(item.caseId);
      if (!record) continue;
      if (record.decision?.decisionVersion !== item.decision?.decisionVersion) {
        this.options.store.db.prepare("UPDATE gmail_outbox SET status='CANCELLED',error='STALE_DECISION',updated_at=? WHERE id=? AND status='PENDING'").run(new Date().toISOString(), item.id);
        continue;
      }
      if (item.action === 'CONFIRM_MATCH' || item.action === 'REQUEST_AMENDMENT') {
        try { await this.verifyEvidence(record, record.decision!); }
        catch {
          this.options.store.db.prepare("UPDATE gmail_outbox SET status='FAILED',error='SOURCE_EVIDENCE_CHANGED',updated_at=? WHERE id=? AND status='PENDING'").run(new Date().toISOString(), item.id);
          continue;
        }
      }
      const result = await this.queue.dispatch(item.id, record.sourceVersion, this.options.client);
      this.options.store.emit('outbound.delivery', item.caseId, { id: item.id, status: result.status, sentMessageId: result.sentMessageId });
    }
    return this.queue.list();
  }

  status(): { enabled: boolean; busy: boolean; pending: number; unknown: number } {
    return { enabled: this.options.enabled, busy: this.operations > 0, pending: this.queue.list('PENDING').length, unknown: this.queue.list('UNKNOWN').length };
  }

  outbox(): OutboxItem[] { return this.queue.list(); }
}
