import type { OperationalDecision } from '@cargolens/shared';
import { validateFlow, type Flow, type FlowNode } from '@cargolens/shared/flows';
import type { Store, CaseRecord } from '../store.js';
import { compareDocuments } from '../documents/comparison.js';
import { draftCase, DraftError } from '../drafts.js';
import { verifyOperationalEvidence } from '../gmail/evidence-validation.js';

export type FlowNodeState = 'RAN' | 'SKIPPED' | 'FAILED';
export interface FlowNodeReport { id: string; type: FlowNode['type']; state: FlowNodeState; detail?: string }
export type FlowOutcome =
  | { kind: 'DRAFT'; action: string; draftId: string }
  | { kind: 'ESCALATE'; reason: string };

export interface FlowRun {
  flowId: string;
  flowVersion: string;
  caseId: string;
  sourceVersion: string;
  /** INVALID and SKIPPED never touch the case; BLOCKED and FAILED never claim a verified result. */
  status: 'COMPLETED' | 'SKIPPED' | 'BLOCKED' | 'FAILED' | 'INVALID';
  nodes: FlowNodeReport[];
  outcome: FlowOutcome | null;
  errors: string[];
}

export interface RunFlowOptions {
  flow: Flow;
  store: Store;
  caseId: string;
  attachmentRoot?: string;
  documentationContact?: string;
}

/**
 * Executes a validated fixed-node graph using the same comparison and drafting
 * functions as the default pipeline, so a saved flow and the direct pipeline
 * cannot disagree about the same case.
 *
 * The graph is validated before any node runs: a cycle, an unknown node or an
 * unreachable outcome stops the run at INVALID rather than half-executing.
 * Outbound work goes through `draftCase`, whose content-hash id and
 * INSERT OR IGNORE make a replay produce the same draft without re-emitting it.
 */
export async function runFlow(options: RunFlowOptions): Promise<FlowRun> {
  const { flow, store, caseId } = options;
  const base = { flowId: flow.id, flowVersion: flow.version, caseId };

  const validation = validateFlow(flow);
  if (!validation.ok) {
    return { ...base, sourceVersion: '', status: 'INVALID', nodes: [], outcome: null, errors: validation.errors };
  }

  const record = store.getCase(caseId);
  if (!record) {
    return { ...base, sourceVersion: '', status: 'FAILED', nodes: [], outcome: null, errors: [`Case "${caseId}" was not found.`] };
  }

  const sourceVersion = record.sourceVersion;
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const next = (from: string, branch: 'true' | 'false' | null) =>
    flow.edges.find((edge) => edge.from === from && edge.branch === branch)?.to ?? null;

  const reports: FlowNodeReport[] = [];
  const errors: string[] = [];
  let outcome: FlowOutcome | null = null;
  let status: FlowRun['status'] = 'COMPLETED';

  const current = (): CaseRecord => store.getCase(caseId) ?? record;
  const decisionOf = (row: CaseRecord): OperationalDecision | null => row.decision;

  let cursor: string | null = flow.nodes.find((node) => node.type === 'trigger')!.id;
  // The graph is acyclic and finite; the node budget is a belt-and-braces stop.
  for (let step = 0; cursor && step <= flow.nodes.length; step++) {
    const node: FlowNode | undefined = nodes.get(cursor);
    if (!node) { errors.push(`Node "${cursor}" disappeared during execution.`); status = 'FAILED'; break; }
    const row = current();
    const decision = decisionOf(row);

    if (node.type === 'trigger') {
      const matches = !!decision && decision.category === node.config.category
        && (!node.config.requestedAction || decision.requestedAction === node.config.requestedAction);
      reports.push({ id: node.id, type: node.type, state: matches ? 'RAN' : 'SKIPPED', detail: matches ? undefined : 'Case does not match the trigger.' });
      if (!matches) { status = 'SKIPPED'; break; }
      cursor = next(node.id, null);
      continue;
    }

    if (node.type === 'jev_question') {
      // Reuse the answer the classifier already produced for this bounded
      // question; a flow never re-asks and never invents a new prompt.
      const answers: Record<string, unknown> = {
        intent: row.classification?.category,
        expectation: row.classification?.expectation,
        document_issue: row.classification?.documentIssue,
        body_document: row.classification?.bodyDocument,
      };
      const value = answers[node.config.question];
      reports.push({ id: node.id, type: node.type, state: value == null ? 'FAILED' : 'RAN', detail: value == null ? `No ${node.config.question} answer on this case.` : String(value) });
      if (value == null) { status = 'BLOCKED'; errors.push(`Question "${node.config.question}" has no answer on this case.`); }
      cursor = next(node.id, null);
      continue;
    }

    if (node.type === 'compare_fields') {
      if (!options.attachmentRoot) {
        reports.push({ id: node.id, type: node.type, state: 'FAILED', detail: 'No evidence reader is configured.' });
        errors.push('EVIDENCE_READER_NOT_CONFIGURED'); status = 'BLOCKED';
        cursor = next(node.id, null); continue;
      }
      // A comparison already recorded against the current source version is
      // reused, exactly as the direct pipeline refuses to re-compare a case it
      // has already decided. Without this a replay would advance the decision
      // version and produce a second, differently-hashed draft.
      const recorded = store.getDocumentComparison(caseId);
      if (recorded) {
        reports.push({ id: node.id, type: node.type, state: 'RAN', detail: `reused decision ${recorded.decisionVersion}` });
        cursor = next(node.id, null);
        continue;
      }
      try {
        const comparison = await compareDocuments(row, options.attachmentRoot);
        if (!store.saveDocumentComparison(caseId, comparison.decision, comparison.evidence)) {
          throw new Error('STALE_DECISION');
        }
        const saved = decisionOf(current());
        reports.push({ id: node.id, type: node.type, state: 'RAN', detail: `verification=${saved?.verificationState ?? 'UNKNOWN'}` });
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'COMPARISON_FAILED';
        reports.push({ id: node.id, type: node.type, state: 'FAILED', detail });
        errors.push(detail);
        status = 'BLOCKED';
      }
      cursor = next(node.id, null);
      continue;
    }

    if (node.type === 'condition') {
      const observed = readCondition(node.config.source, decision);
      const held = evaluate(node.config.operator, observed, node.config.value);
      reports.push({ id: node.id, type: node.type, state: 'RAN', detail: `${node.config.source}=${String(observed)} → ${held}` });
      cursor = next(node.id, held ? 'true' : 'false');
      continue;
    }

    if (node.type === 'draft_email') {
      if (!decision) {
        reports.push({ id: node.id, type: node.type, state: 'FAILED', detail: 'No decision to draft from.' });
        errors.push('DECISION_REQUIRED'); status = 'BLOCKED'; break;
      }
      if (decision.nextAction !== node.config.replyType) {
        // The decision, not the canvas, decides what may be sent.
        reports.push({ id: node.id, type: node.type, state: 'FAILED', detail: `Decision asks for ${decision.nextAction}, not ${node.config.replyType}.` });
        errors.push('REPLY_TYPE_NOT_AUTHORIZED'); status = 'BLOCKED'; break;
      }
      try {
        const draft = await draftCase(store, caseId, { sourceVersion: decision.sourceVersion, decisionVersion: decision.decisionVersion },
          async (target, candidate) => {
            if (!options.attachmentRoot) throw new DraftError('EVIDENCE_READER_NOT_CONFIGURED');
            await verifyOperationalEvidence(target, candidate, options.attachmentRoot);
          }, options.documentationContact);
        outcome = { kind: 'DRAFT', action: draft.action, draftId: draft.id };
        reports.push({ id: node.id, type: node.type, state: 'RAN', detail: draft.action });
      } catch (error) {
        const detail = error instanceof DraftError ? error.code : 'DRAFT_FAILED';
        reports.push({ id: node.id, type: node.type, state: 'FAILED', detail });
        errors.push(detail); status = 'BLOCKED';
      }
      break;
    }

    // escalate
    outcome = { kind: 'ESCALATE', reason: node.config.reason };
    reports.push({ id: node.id, type: node.type, state: 'RAN', detail: node.config.reason });
    if (status === 'COMPLETED') status = 'BLOCKED';
    break;
  }

  for (const node of flow.nodes) {
    if (!reports.some((report) => report.id === node.id)) reports.push({ id: node.id, type: node.type, state: 'SKIPPED' });
  }

  store.emit('flow.run', caseId, { flowId: flow.id, flowVersion: flow.version, sourceVersion, status, outcome,
    nodes: reports.map(({ id, state }) => ({ id, state })) });

  return { ...base, sourceVersion, status, nodes: reports, outcome, errors };
}

function readCondition(source: string, decision: OperationalDecision | null): string | number {
  if (!decision) return source.endsWith('Count') ? 0 : 'UNKNOWN';
  switch (source) {
    case 'verificationState': return decision.verificationState;
    case 'workflowState': return decision.workflowState;
    case 'category': return decision.category;
    case 'requestedAction': return decision.requestedAction;
    case 'documentExpectation': return decision.documentExpectation;
    case 'matchedFieldCount': return decision.fieldResults.filter((row) => row.outcome === 'MATCH').length;
    case 'mismatchCount': return decision.knownMismatches.length;
    case 'blockerCount': return decision.blockers.length;
    default: return 'UNKNOWN';
  }
}

function evaluate(operator: 'equals' | 'not_equals' | 'at_least', observed: string | number, value: string | number): boolean {
  if (operator === 'at_least') return typeof observed === 'number' && typeof value === 'number' && observed >= value;
  const same = observed === value;
  return operator === 'equals' ? same : !same;
}
