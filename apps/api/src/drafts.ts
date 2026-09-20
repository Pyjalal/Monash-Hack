import { createHash } from 'node:crypto';
import { OperationalDecisionSchema, type OperationalDecision } from '@cargolens/shared';
import type { CaseRecord, Store } from './store.js';
import { mailboxAddress } from './gmail/message.js';
import { planMissingEvidence, type DocumentRole } from './gmail/evidence.js';
import type { OutboundAction } from './gmail/outbox.js';

export class DraftError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface Draft {
  id: string; caseId: string; sourceVersion: string; decisionVersion: number;
  action: OutboundAction; to: string; subject: string; text: string;
  evidence: OperationalDecision['fieldResults']; templateVersion: 'operational-v1';
}

/** Called only after the service has validated the current source claims. */
export function composeDraft(record: CaseRecord, documentationContact?: string): Draft {
  if (!record.decision) throw new DraftError('DECISION_REQUIRED');
  const decision = OperationalDecisionSchema.parse(record.decision);
  if (decision.sourceVersion !== record.sourceVersion) throw new DraftError('STALE_DECISION');
  if (decision.blockers.includes('THREAD_CONTEXT_REQUIRED')) throw new DraftError('THREAD_CONTEXT_REQUIRED');
  let to = mailboxAddress(record.email.from);
  let action: OutboundAction;
  let text: string;
  let evidence: OperationalDecision['fieldResults'] = [];
  if (decision.nextAction === 'CONFIRM_MATCH') {
    if (decision.workflowState !== 'VERIFIED' || decision.category !== 'BL_COMPARISON' || decision.documentExpectation !== 'EXPECTED_NOW' || decision.requestedAction === 'REQUEST_DRAFT') throw new DraftError('BLOCKED_OR_UNVERIFIED_CASE');
    action = 'CONFIRM_MATCH'; evidence = decision.fieldResults;
    text = 'No mismatch was detected across the seven verified SI and BL fields in the supplied source documents.';
  } else if (decision.nextAction === 'REQUEST_AMENDMENT') {
    if (!decision.knownMismatches.length) throw new DraftError('ESTABLISHED_MISMATCH_REQUIRED');
    action = 'REQUEST_AMENDMENT';
    evidence = decision.fieldResults.filter(field => decision.knownMismatches.includes(field.field));
    if (evidence.some(field => !field.si || !field.bl)) throw new DraftError('SOURCE_EVIDENCE_REQUIRED');
    text = 'Please amend the draft BL for these established differences:\n' + evidence.map(field =>
      `- ${field.field}: SI ${JSON.stringify(field.si!.text)}; BL ${JSON.stringify(field.bl!.text)}.`).join('\n');
    if (decision.blockers.length || decision.verificationState !== 'COMPLETE') text += '\nOther fields remain unresolved; document verification is not complete.';
  } else if (['REQUEST_DOCUMENTS', 'REQUEST_CLARIFICATION'].includes(decision.nextAction)) {
    const missingRoles: DocumentRole[] = record.email.attachments.length === 0 ? ['SI', 'BL'] :
      decision.blockers.flatMap(blocker => blocker === 'MISSING_SI' ? ['SI' as const] : blocker === 'MISSING_BL' ? ['BL' as const] : []);
    if (decision.nextAction === 'REQUEST_CLARIFICATION' && decision.requestedAction !== 'REQUEST_DRAFT') {
      action = 'REQUEST_CLARIFICATION';
      const unresolved = decision.fieldResults.filter(field => !['MATCH', 'MISMATCH'].includes(field.outcome)).map(field => field.field);
      text = 'Please clarify the request or provide clearer source evidence' + (unresolved.length ? ` for: ${unresolved.join(', ')}` : ' for the unresolved fields') + '. Document verification has not been completed.';
    } else {
      const plan = planMissingEvidence({ requestedAction: decision.requestedAction, requester: record.email.from, documentationContact, missingRoles, retrievalComplete: true });
      if (!plan.replyType || !plan.recipient) throw new DraftError('NO_DRAFT_ACTION');
      action = plan.replyType; to = plan.recipient; text = plan.text;
    }
  } else throw new DraftError('NO_DRAFT_ACTION');
  const draft = { caseId: record.email.id, sourceVersion: record.sourceVersion, decisionVersion: decision.decisionVersion,
    action, to, subject: record.email.subject, text, evidence, templateVersion: 'operational-v1' as const };
  return { id: createHash('sha256').update(JSON.stringify(draft)).digest('hex'), ...draft };
}

export async function draftCase(store: Store, id: string, expected: { sourceVersion: string; decisionVersion: number },
  validate: (record: CaseRecord, decision: OperationalDecision) => Promise<void>, documentationContact?: string): Promise<Draft> {
  const record = store.getCase(id);
  if (!record) throw new DraftError('NOT_FOUND');
  if (record.sourceVersion !== expected.sourceVersion || record.decision?.decisionVersion !== expected.decisionVersion) throw new DraftError('STALE_DECISION');
  const decision = OperationalDecisionSchema.parse(record.decision);
  if (['CONFIRM_MATCH', 'REQUEST_AMENDMENT'].includes(decision.nextAction) || id.startsWith('gmail:')) await validate(record, decision);
  const draft = composeDraft(record, documentationContact);
  const current = store.getCase(id);
  if (current?.sourceVersion !== draft.sourceVersion || current.decision?.decisionVersion !== draft.decisionVersion) throw new DraftError('STALE_DECISION');
  store.db.exec('CREATE TABLE IF NOT EXISTS case_drafts (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, draft_json TEXT NOT NULL)');
  store.db.transaction(() => {
    const inserted = store.db.prepare('INSERT OR IGNORE INTO case_drafts VALUES(?,?,?)').run(draft.id, id, JSON.stringify(draft));
    if (inserted.changes) store.emit('case.drafted', id, { id: draft.id, sourceVersion: draft.sourceVersion, decisionVersion: draft.decisionVersion, action: draft.action });
  })();
  return draft;
}
