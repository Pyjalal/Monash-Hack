import { createHash } from 'node:crypto';
import type { Email } from '@cargolens/shared';

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  payload?: GmailPart;
}

export interface ReplyInput {
  threadId: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo: string;
  references: string[];
  idempotencyKey: string;
  sourceVersion: string;
  attachments?: VerifiedReplyAttachment[];
}

export interface VerifiedReplyAttachment {
  name: string;
  mimeType: string;
  contentBase64: string;
  sha256: string;
  sourceVersion: string;
  verified: true;
  authorizedForSharing: true;
}

export interface DecodedGmailMessage {
  email: Email & { bodyCurrent: string; quoted: string };
  rfcMessageId: string;
  references: string[];
  sourceVersion: string;
  eligible: boolean;
  skipReason: string | null;
  inlineAttachmentData: Record<string, string>;
  bodyIncomplete: boolean;
}

export function isTextBodyPart(part: GmailPart): boolean {
  const disposition = part.headers?.find(value => value.name.toLowerCase() === 'content-disposition')?.value ?? '';
  return !part.filename && !/^attachment/i.test(disposition) && ['text/plain', 'text/html'].includes(part.mimeType ?? '');
}

export function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function mailboxAddress(value: string): string {
  if (/[\r\n]/.test(value) || value.includes('\0')) throw new Error('Invalid address header');
  const address = (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(address)) throw new Error('Invalid mailbox address');
  return address;
}

export function decodeGmailMessage(raw: GmailMessage, config: { mailboxAddress: string; aliases?: string[] }): DecodedGmailMessage {
  const from = header(raw, 'From');
  const subject = header(raw, 'Subject');
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: Email['attachments'] = [];
  const inlineAttachmentData: Record<string, string> = {};
  let bodyIncomplete = false;
  const visit = (part: GmailPart) => {
    if (isTextBodyPart(part)) {
      if (part.body?.attachmentId && part.body.data === undefined) bodyIncomplete = true;
      if (part.body?.data !== undefined) {
        const text = Buffer.from(part.body.data, 'base64url').toString('utf8');
        if (part.mimeType === 'text/plain') plain.push(text);
        else html.push(text);
      }
    } else if (part.filename || part.body?.attachmentId) {
      const id = part.body?.attachmentId ?? `inline-${attachments.length}`;
      attachments.push({ id, name: part.filename ?? 'attachment', mimeType: part.mimeType ?? 'application/octet-stream', messageId: raw.id });
      if (part.body?.data) inlineAttachmentData[id] = part.body.data;
    }
    part.parts?.forEach(visit);
  };
  if (raw.payload) visit(raw.payload);
  const body = plain.length ? plain.join('\n') : html.join('\n')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br\s*\/?|\/p|\/div)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const quoteAt = body.search(/^(?:On .{1,300}wrote:|_{5,}|-{2,}\s*Original Message|>)/mi);
  const bodyCurrent = (quoteAt >= 0 ? body.slice(0, quoteAt) : body).trim();
  const quoted = quoteAt >= 0 ? body.slice(quoteAt).trim() : '';
  let sender = '';
  try { sender = mailboxAddress(from); } catch { sender = ''; }
  const ownAddresses = [config.mailboxAddress, ...(config.aliases ?? [])].map(value => mailboxAddress(value));
  let skipReason: string | null = null;
  if (raw.labelIds?.some(label => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label))) skipReason = 'OUTGOING_OR_EXCLUDED_LABEL';
  else if (!sender) skipReason = 'INVALID_SENDER';
  else if (ownAddresses.includes(sender)) skipReason = 'SELF_MESSAGE';
  else if (/^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster)@/i.test(sender)) skipReason = 'NON_REPLYABLE_SENDER';
  else if (header(raw, 'Auto-Submitted') && header(raw, 'Auto-Submitted').toLowerCase() !== 'no') skipReason = 'AUTOMATED_MESSAGE';
  else if (header(raw, 'List-Id') || /^(?:bulk|list|junk)$/i.test(header(raw, 'Precedence')) || header(raw, 'X-Auto-Response-Suppress')) skipReason = 'LIST_OR_SUPPRESSED_REPLY';
  else if (bodyIncomplete) skipReason = 'BODY_NOT_HYDRATED';
  const email = { id: raw.id, threadId: raw.threadId, subject, from, snippet: raw.snippet ?? '', body, bodyCurrent, quoted, attachments, contentScope: 'full_message' as const };
  const sourceVersion = createHash('sha256').update(JSON.stringify({ id: raw.id, threadId: raw.threadId, subject, from, body, attachments, inlineAttachmentData })).digest('hex');
  return { email, sourceVersion, eligible: skipReason === null, skipReason, rfcMessageId: header(raw, 'Message-ID'), references: header(raw, 'References').match(/<[^<>\s]+>/g) ?? [], inlineAttachmentData, bodyIncomplete };
}

export function replyMessageId(key: string, mailbox: string): string {
  if (!key) throw new Error('An idempotency key is required');
  const domain = mailboxAddress(mailbox).split('@')[1];
  return `<cargolens.${createHash('sha256').update(key).digest('hex')}@${domain}>`;
}

function safeHeader(value: string): string {
  if (/[\r\n]/.test(value) || value.includes('\0')) throw new Error('Invalid email header');
  return value;
}

export function buildReplyRaw(reply: ReplyInput, mailbox: string): string {
  const from = mailboxAddress(mailbox);
  const to = mailboxAddress(reply.to);
  const subject = safeHeader(reply.subject);
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(reply.inReplyTo)) throw new Error('Valid source Message-ID is required');
  const references = [...new Set([...reply.references, reply.inReplyTo])];
  if (references.some(value => !/^<[^<>\s]+@[^<>\s]+>$/.test(value))) throw new Error('Invalid References header');
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const wrapBase64 = (text: string) => text.match(/.{1,76}/g)?.join('\r\n') ?? '';
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(reply.text).toString('base64')), ''];
  const headers = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodedSubject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${replyMessageId(reply.idempotencyKey, from)}`,
    `In-Reply-To: ${reply.inReplyTo}`, `References: ${references.join(' ')}`, 'Auto-Submitted: auto-replied',
    'X-Auto-Response-Suppress: All', 'MIME-Version: 1.0',
  ];
  const attachments = reply.attachments ?? [];
  if (attachments.length > 10) throw new Error('Too many outbound source attachments');
  const boundary = 'cargolens-' + createHash('sha256').update(reply.idempotencyKey).digest('hex');
  const lines = attachments.length ? [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...textPart] : [...headers, ...textPart];
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (!attachment.verified || !attachment.authorizedForSharing || attachment.sourceVersion !== reply.sourceVersion) throw new Error('Attachment source version and sharing verification are required');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.contentBase64)) throw new Error('Invalid attachment source encoding');
    const bytes = Buffer.from(attachment.contentBase64, 'base64');
    if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw new Error('Attachment source hash mismatch');
    totalBytes += bytes.length;
    if (totalBytes > 20_000_000) throw new Error('Outbound source attachment size exceeds limit');
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.mimeType)) throw new Error('Invalid attachment MIME header');
    safeHeader(attachment.name);
    const filename = encodeURIComponent(attachment.name).replace(/'/g, '%27');
    lines.push(`--${boundary}`, `Content-Type: ${attachment.mimeType}`, `Content-Disposition: attachment; filename*=UTF-8''${filename}`, 'Content-Transfer-Encoding: base64', '', wrapBase64(bytes.toString('base64')), '');
  }
  if (attachments.length) lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}
