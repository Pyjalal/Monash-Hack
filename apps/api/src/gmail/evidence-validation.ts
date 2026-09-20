import { OperationalDecisionSchema, type OperationalDecision } from '@cargolens/shared';
import { compareDocuments } from '../documents/comparison.js';
import type { CaseRecord } from '../store.js';
import { readAttachment, type AttachmentReadResult } from '../documents/index.js';

export async function verifyOperationalEvidence(record: CaseRecord, candidate: OperationalDecision, attachmentRoot: string): Promise<void> {
  const decision = OperationalDecisionSchema.parse(candidate);
  if (decision.sourceVersion !== record.sourceVersion) throw new Error('Source evidence decision is stale');
  if (decision.fieldResults.some(field => [field.si, field.bl].some(span => span?.locator.startsWith('ocr:')))) {
    const reproduced = await compareDocuments(record, attachmentRoot);
    if (reproduced.decision.verificationState !== decision.verificationState
      || reproduced.decision.pairValidated !== decision.pairValidated
      || JSON.stringify(reproduced.decision.blockers) !== JSON.stringify(decision.blockers)
      || JSON.stringify(reproduced.decision.fieldResults) !== JSON.stringify(decision.fieldResults)
      || JSON.stringify(reproduced.decision.knownMismatches) !== JSON.stringify(decision.knownMismatches)) {
      throw new Error('Recovered source comparison could not be independently verified');
    }
    return;
  }
  if (decision.nextAction === 'REQUEST_AMENDMENT' && !decision.knownMismatches.length) throw new Error('Amendment requires established source mismatches');
  const fields = decision.verificationState === 'COMPLETE' || decision.nextAction === 'CONFIRM_MATCH'
    ? decision.fieldResults : decision.fieldResults.filter(field => decision.knownMismatches.includes(field.field));
  const readings = new Map<string, AttachmentReadResult>();
  let pair: string | undefined;
  for (const field of fields) {
    if (!field.si || !field.bl) throw new Error('Missing source evidence for operational decision');
    if (field.si.attachmentId === field.bl.attachmentId || field.si.sha256 === field.bl.sha256) throw new Error('Distinct SI and BL source pair is required');
    const fieldPair = JSON.stringify([field.si.attachmentId, field.si.sha256, field.bl.attachmentId, field.bl.sha256]);
    if (pair && pair !== fieldPair) throw new Error('All field evidence must use one consistent SI and BL pair');
    pair = fieldPair;
    for (const span of [field.si, field.bl]) {
      const attachment = record.email.attachments.find(value => value.id === span.attachmentId);
      if (!attachment?.relativePath || (attachment.sha256 && attachment.sha256 !== span.sha256)) throw new Error('Source evidence is not bound to this case');
      let reading = readings.get(attachment.id);
      if (!reading) {
        reading = await readAttachment({ root: attachmentRoot, relativePath: attachment.relativePath, mimeType: attachment.mimeType });
        readings.set(attachment.id, reading);
      }
      if (reading.status !== 'READABLE' || reading.sha256 !== span.sha256 || !reading.text.includes(span.text)) throw new Error('Source evidence excerpt or hash could not be verified');
      const located = reading.spans.some(source => {
        const locator = source.kind === 'line' ? `line:${source.line}` : source.kind === 'page' ? `page:${source.page}` : `cell:${source.sheet}!${source.cell}`;
        return locator === span.locator && source.text.includes(span.text);
      });
      const characterSpan = span.locator.match(/^chars:(\d+)-(\d+)$/);
      if (!located && !(characterSpan && reading.text.slice(Number(characterSpan[1]), Number(characterSpan[2])) === span.text)) throw new Error('Source evidence locator could not be verified');
    }
  }
}
