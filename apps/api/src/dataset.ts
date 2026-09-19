import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { EmailSchema, type Email } from '@cargolens/shared';
import { z } from 'zod';

const SourceSchema = z.object({ email_id: z.string(), from: z.string(), subject: z.string(), body: z.string(), attachments: z.array(z.string()).default([]) });
const mime: Record<string, string> = { '.txt': 'text/plain', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export async function loadDataset(datasetRoot: string): Promise<Email[]> {
  const root = await realpath(datasetRoot); const inbox = resolve(root, 'inbox');
  const emails: Email[] = [];
  for (const name of (await readdir(inbox)).filter(name => name.endsWith('.json')).sort()) {
    const sourcePath = await realpath(resolve(inbox, name));
    const within = relative(root, sourcePath);
    if (within.startsWith('..') || isAbsolute(within)) throw new Error('Dataset source escapes configured root');
    const source = SourceSchema.parse(JSON.parse(await readFile(sourcePath, 'utf8')));
    const attachments = source.attachments.map((path, index) => {
      const normalized = path.replaceAll('\\', '/');
      const within = relative(root, resolve(root, normalized));
      if (within.startsWith('..') || isAbsolute(within)) throw new Error('Attachment escapes configured root');
      return { id: `${source.email_id}:attachment:${index}`, name: normalized.split('/').at(-1), relativePath: normalized, mimeType: mime[extname(normalized).toLowerCase()] ?? 'application/octet-stream' };
    });
    emails.push(EmailSchema.parse({ id: source.email_id, subject: source.subject, from: source.from, body: source.body, attachments, contentScope: 'full_message' }));
  }
  if (new Set(emails.map(email => email.id)).size !== emails.length) throw new Error('Duplicate dataset email ID');
  return emails;
}
