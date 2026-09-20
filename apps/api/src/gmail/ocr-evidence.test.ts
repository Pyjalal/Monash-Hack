import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EmailSchema, FIELD_NAMES, OperationalDecisionSchema } from '@cargolens/shared';
import { sources } from '../../../../tools/eval/src/ocr-verification.js';
import { readAttachment } from '../documents/index.js';
import { ClassificationService } from '../pipeline.js';
import { Store } from '../store.js';
import { GmailAutomation } from './automation.js';
import { GmailClient } from './client.js';
import { verifyOperationalEvidence } from './evidence-validation.js';
import { GmailOutbox } from './outbox.js';

const irrecoverable = sources.filter(source => [
  'email_511_BL', 'email_515_BL', 'independent_empty', 'independent_corrupt',
  'independent_blank_image', 'independent_garbled',
].includes(source.key));
const lines = FIELD_NAMES.map((field, index) => `${field}: independent-${index}`);

async function confirmationAttempt(bytes: Buffer, extension: string, side: 'si' | 'bl', shouldReject: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-confirmation-evidence-'));
  const store = new Store(':memory:');
  const names = [`source-a${extension}`, 'source-b.txt'];
  const mimeType = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.png': 'image/png' }[extension]!;
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('No network permitted in this regression'); });
  const client = new GmailClient({ mailboxAddress: 'ops@example.org', clientId: 'test', clientSecret: 'test', refreshToken: 'test', fetchImpl });
  const send = vi.spyOn(client, 'sendReply').mockResolvedValue({ id: 'test-sent', threadId: 'test-thread' });
  const classifier = vi.fn(async () => { throw new Error('Classification must not run'); });
  const service = new ClassificationService({ store, configurationKey: 'test', classifier });
  const automation = new GmailAutomation({ store, service, client, attachmentRoot: root, enabled: true });
  try {
    await writeFile(join(root, names[0]), bytes);
    await writeFile(join(root, names[1]), 'Independent counterpart\n' + lines.join('\n'));
    const suspect = await readAttachment({ root, relativePath: names[0], mimeType });
    const good = await readAttachment({ root, relativePath: names[1], mimeType: 'text/plain' });
    expect(good.status).toBe('READABLE');
    if (shouldReject) expect(suspect.status).not.toBe('READABLE');
    const record = store.upsertEmail(EmailSchema.parse({
      id: 'neutral-case', from: 'sender@example.org', subject: '', body: '',
      attachments: [
        { id: 'a', relativePath: names[0], mimeType, sha256: suspect.sha256 },
        { id: 'b', relativePath: names[1], mimeType: 'text/plain', sha256: good.sha256 },
      ],
    }));
    // Adversarial assertion: correct source hashes, distinct pair, seven MATCH
    // outcomes and valid schema are insufficient when source bytes are unreadable.
    // These fabricated claims are test attacks, never recovery input or evidence.
    const decision = OperationalDecisionSchema.parse({
      category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW',
      verificationState: 'COMPLETE', workflowState: 'VERIFIED', pairValidated: true,
      blockers: [], knownMismatches: [], nextAction: 'CONFIRM_MATCH',
      sourceVersion: record.sourceVersion, decisionVersion: 1,
      fieldResults: FIELD_NAMES.map((field, index) => {
        const a = { attachmentId: 'a', sha256: suspect.sha256, locator: `line:${index + 2}`, text: lines[index] };
        const b = { attachmentId: 'b', sha256: good.sha256, locator: `line:${index + 2}`, text: lines[index] };
        return { field, outcome: 'MATCH', si: side === 'si' ? a : b, bl: side === 'bl' ? a : b };
      }),
    });
    if (shouldReject) {
      await expect(verifyOperationalEvidence(record, decision, root)).rejects.toThrow('Source evidence excerpt or hash could not be verified');
    } else {
      await expect(verifyOperationalEvidence(record, decision, root)).resolves.toBeUndefined();
    }
    expect(store.saveDecision(record.email.id, decision)).toBe(true);
    // Bypass admission deliberately to test the final pre-send guard as well.
    // Even a structurally valid forged decision already in the outbox cannot send.
    const queue = new GmailOutbox(store.db);
    queue.enqueue({ caseId: record.email.id, sourceVersion: record.sourceVersion, action: 'CONFIRM_MATCH', decision,
      reply: { to: 'recipient@example.org', threadId: 'test-thread', subject: 'Test', text: 'Test confirmation',
        inReplyTo: '<test@example.org>', references: [], sourceVersion: record.sourceVersion, idempotencyKey: 'test-confirmation' } });
    const [item] = await automation.dispatchPending();
    if (shouldReject) {
      expect(item).toMatchObject({ status: 'FAILED', error: 'SOURCE_EVIDENCE_CHANGED', attempts: 0, sentMessageId: null });
      expect(send).not.toHaveBeenCalled();
    } else {
      expect(item.status).toBe('SENT');
      expect(send).toHaveBeenCalledTimes(1);
    }
    expect(classifier).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    store.close();
    for (const name of names) await unlink(join(root, name)).catch(() => undefined);
    await rmdir(root);
  }
}

describe('irrecoverable source confirmation rejection (#43)', () => {
  it.each(irrecoverable.flatMap(source => (['si', 'bl'] as const).map(side => ({ ...source, side }))))(
    '$key cannot authorize confirmation as $side evidence, including from a queued decision',
    async ({ path, side }) => confirmationAttempt(await readFile(path), extname(path), side, true),
  );
  it('allows independently readable sourced evidence through the same validator and mocked send path', async () => {
    await confirmationAttempt(Buffer.from('Independent source\n' + lines.join('\n')), '.txt', 'si', false);
  });
});
