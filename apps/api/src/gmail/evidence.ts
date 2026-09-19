import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { GmailThread, MessagePage } from './client.js';
import type { DecodedGmailMessage } from './message.js';
import { decodeGmailMessage, mailboxAddress } from './message.js';

export type DocumentRole = 'SI' | 'BL';
export interface EvidenceDocument { role: DocumentRole | 'OTHER' | 'UNKNOWN'; attachmentId: string; messageId: string; threadId: string; sourceHash: string; authoritative: boolean; shipmentReference?: string }
export interface MissingEvidenceInput { requestedAction: string; requester: string; documentationContact?: string; missingRoles: DocumentRole[]; retrievalComplete: boolean }
interface EvidenceReader {
  getThread(id: string): Promise<GmailThread>;
  listMessages(options: { query: string; maxResults: number }): Promise<MessagePage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}
export function shipmentSearchQuery(reference: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{3,63}$/.test(reference)) throw new Error('Invalid explicit shipment reference');
  return `has:attachment -in:trash -in:spam "${reference}"`;
}

export function planMissingEvidence(input: MissingEvidenceInput): { kind: 'FETCH_EVIDENCE' | 'REQUEST_DOCUMENTATION' | 'REQUEST_CLARIFICATION' | 'REQUEST_MISSING_SOURCES' | 'WAIT'; recipient: string | null; replyType: 'REQUEST_DOCUMENTS' | 'REQUEST_CLARIFICATION' | null; text: string } {
  if (!input.retrievalComplete) return { kind: 'FETCH_EVIDENCE', recipient: null, replyType: null, text: '' };
  const requester = mailboxAddress(input.requester);
  if (input.requestedAction === 'REQUEST_DRAFT') {
    const contact = input.documentationContact ? mailboxAddress(input.documentationContact) : null;
    if (contact && contact !== requester) return { kind: 'REQUEST_DOCUMENTATION', recipient: contact, replyType: 'REQUEST_DOCUMENTS', text: 'The customer is requesting a draft BL from our team. Please provide the authorized draft and its supporting shipping instructions, or confirm who is responsible for preparing it. No document verification has been completed.' };
    return { kind: 'REQUEST_CLARIFICATION', recipient: requester, replyType: 'REQUEST_CLARIFICATION', text: 'We understand that you are requesting a draft BL from our team. Please clarify the responsible documentation contact so we can locate or arrange the authorized draft. No document verification has been completed.' };
  }
  if (input.requestedAction === 'VERIFY_DOCUMENTS' || input.requestedAction === 'AMEND_DOCUMENTS') {
    if (!input.missingRoles.length) return { kind: 'WAIT', recipient: null, replyType: null, text: '' };
    const names = [...new Set(input.missingRoles)].map(role => role === 'SI' ? 'authoritative shipping instructions (SI)' : 'current draft bill of lading (BL)');
    return { kind: 'REQUEST_MISSING_SOURCES', recipient: requester, replyType: 'REQUEST_DOCUMENTS', text: `Please provide the ${names.join(' and ')} for this shipment. We could not establish this evidence from the available messages and have not completed document verification.` };
  }
  return { kind: 'REQUEST_CLARIFICATION', recipient: requester, replyType: 'REQUEST_CLARIFICATION', text: 'Please clarify whether you need us to provide a draft BL or verify existing documents, and identify the shipment reference. We have not completed document verification.' };
}

export function selectEvidencePair(documents: EvidenceDocument[], context: { threadId: string; shipmentReference?: string }): { status: 'READY' | 'MISSING' | 'AMBIGUOUS'; si?: EvidenceDocument; bl?: EvidenceDocument; missingRoles: DocumentRole[] } {
  const matching = documents.filter(doc => doc.authoritative && doc.sourceHash && (
    doc.threadId === context.threadId
      ? !(context.shipmentReference && doc.shipmentReference && context.shipmentReference !== doc.shipmentReference)
      : Boolean(context.shipmentReference && doc.shipmentReference === context.shipmentReference)
  ));
  const unique = (role: DocumentRole) => [...new Map(matching.filter(doc => doc.role === role).map(doc => [doc.sourceHash, doc])).values()];
  const si = unique('SI'); const bl = unique('BL');
  const missingRoles: DocumentRole[] = [];
  if (!si.length) missingRoles.push('SI');
  if (!bl.length) missingRoles.push('BL');
  if (si.length > 1 || bl.length > 1) return { status: 'AMBIGUOUS', missingRoles };
  if (missingRoles.length) return { status: 'MISSING', missingRoles, si: si[0], bl: bl[0] };
  if (si[0].sourceHash === bl[0].sourceHash || (si[0].shipmentReference && bl[0].shipmentReference && si[0].shipmentReference !== bl[0].shipmentReference)) return { status: 'AMBIGUOUS', missingRoles };
  return { status: 'READY', si: si[0], bl: bl[0], missingRoles };
}

export interface CollectedEvidence {
  messages: DecodedGmailMessage[];
  attachments: { bytes: Buffer; sourceHash: string; messageId: string; attachmentId: string; threadId: string }[];
  validatedPair: false;
  truncated: boolean;
}

export async function collectGmailEvidence(reader: EvidenceReader, options: { threadId: string; mailboxAddress: string; shipmentReference?: string; maxRelatedThreads?: number; maxAttachments?: number; maxBytes?: number }): Promise<CollectedEvidence> {
  const maxRelated = Math.max(0, Math.min(options.maxRelatedThreads ?? 3, 10));
  const threadIds = [options.threadId]; let truncated = false;
  if (options.shipmentReference && maxRelated > 0) {
    const found = await reader.listMessages({ query: shipmentSearchQuery(options.shipmentReference), maxResults: 20 });
    const related = [...new Set(found.messages.map(message => message.threadId))].filter(id => id !== options.threadId);
    threadIds.push(...related.slice(0, maxRelated));
    truncated = Boolean(found.nextPageToken) || related.length > maxRelated;
  }
  const messages: DecodedGmailMessage[] = [];
  const attachments: CollectedEvidence['attachments'] = [];
  const maxAttachments = Math.max(1, Math.min(options.maxAttachments ?? 20, 100));
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? 20_000_000, 50_000_000));
  let totalBytes = 0;
  for (const id of threadIds) {
    const thread = await reader.getThread(id);
    for (const raw of thread.messages) {
      if (raw.labelIds?.some(label => ['SPAM', 'TRASH', 'DRAFT'].includes(label))) continue;
      const message = decodeGmailMessage(raw, { mailboxAddress: options.mailboxAddress });
      messages.push(message);
      for (const attachment of message.email.attachments) {
        if (attachments.length >= maxAttachments) { truncated = true; continue; }
        const inline = message.inlineAttachmentData[attachment.id];
        const bytes = inline === undefined ? await reader.getAttachment(raw.id, attachment.id) : Buffer.from(inline, 'base64url');
        if (totalBytes + bytes.length > maxBytes) { truncated = true; continue; }
        totalBytes += bytes.length;
        attachments.push({ bytes, sourceHash: createHash('sha256').update(bytes).digest('hex'), messageId: raw.id, attachmentId: attachment.id, threadId: raw.threadId });
      }
    }
  }
  return { messages, attachments, validatedPair: false, truncated };
}

export class GmailResumeStore {
  readonly mailbox: string;
  constructor(readonly db: Database.Database, mailbox: string) {
    this.mailbox = mailboxAddress(mailbox);
    db.exec(`CREATE TABLE IF NOT EXISTS gmail_case_threads (
      mailbox TEXT NOT NULL, case_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY(mailbox, case_id)
    ); CREATE TABLE IF NOT EXISTS gmail_case_receipts (
      mailbox TEXT NOT NULL, case_id TEXT NOT NULL, message_id TEXT NOT NULL, source_version TEXT NOT NULL,
      received_at TEXT NOT NULL, PRIMARY KEY(mailbox, case_id, message_id)
    )`);
  }

  bindCase(caseId: string, threadId: string): void {
    if (!caseId || !threadId) throw new Error('Case and thread identity are required');
    const existing = this.db.prepare('SELECT thread_id FROM gmail_case_threads WHERE mailbox=? AND case_id=?').get(this.mailbox, caseId) as { thread_id: string } | undefined;
    if (existing && existing.thread_id !== threadId) throw new Error('Case is already bound to a different thread');
    this.db.prepare('INSERT OR IGNORE INTO gmail_case_threads(mailbox,case_id,thread_id) VALUES(?,?,?)').run(this.mailbox, caseId, threadId);
  }

  acceptReply(caseId: string, message: DecodedGmailMessage): { changed: boolean; sourceVersion: string } {
    return this.db.transaction(() => {
      const binding = this.db.prepare('SELECT thread_id FROM gmail_case_threads WHERE mailbox=? AND case_id=?').get(this.mailbox, caseId) as { thread_id: string } | undefined;
      if (!binding || binding.thread_id !== message.email.threadId) throw new Error('Reply does not belong to the bound case thread');
      const changed = message.eligible ? this.db.prepare('INSERT OR IGNORE INTO gmail_case_receipts(mailbox,case_id,message_id,source_version,received_at) VALUES(?,?,?,?,?)')
        .run(this.mailbox, caseId, message.email.id, message.sourceVersion, new Date().toISOString()).changes > 0 : false;
      const sources = this.db.prepare('SELECT message_id,source_version FROM gmail_case_receipts WHERE mailbox=? AND case_id=? ORDER BY message_id').all(this.mailbox, caseId);
      const sourceVersion = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
      return { changed, sourceVersion };
    })();
  }
}
