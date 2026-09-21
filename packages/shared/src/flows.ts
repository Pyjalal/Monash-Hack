import { z } from 'zod';
import { CategorySchema, FieldNameSchema } from './index.js';

export const FLOW_VERSION = 'flow-v1';

/**
 * Six fixed node types. Every configuration is a closed schema over enumerated
 * values: a saved flow can select from what the pipeline already does, but it
 * can never introduce new prompt text or executable behaviour. That is what
 * keeps an imported source document from turning into an instruction.
 */
export const FLOW_NODE_TYPES = ['trigger', 'jev_question', 'compare_fields', 'condition', 'draft_email', 'escalate'] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

/** Only the bounded questions the default pipeline already asks. */
export const FLOW_QUESTIONS = ['intent', 'expectation', 'document_issue', 'body_document'] as const;

export const CONDITION_SOURCES = ['verificationState', 'workflowState', 'category', 'requestedAction',
  'documentExpectation', 'matchedFieldCount', 'mismatchCount', 'blockerCount'] as const;
export type ConditionSource = (typeof CONDITION_SOURCES)[number];

/** Numeric sources compare with `at_least`; the rest compare by identity. */
export const NUMERIC_CONDITION_SOURCES: readonly ConditionSource[] = ['matchedFieldCount', 'mismatchCount', 'blockerCount'];

export const REQUESTED_ACTIONS = ['REQUEST_DRAFT', 'VERIFY_DOCUMENTS', 'AMEND_DOCUMENTS', 'OTHER', 'UNCERTAIN'] as const;
export const FLOW_REPLY_TYPES = ['REQUEST_DOCUMENTS', 'REQUEST_CLARIFICATION', 'REQUEST_AMENDMENT', 'CONFIRM_MATCH'] as const;

const identifier = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'must be an alphanumeric identifier');
const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

// `N` stays a single literal so the discriminated union narrows `config` by `type`.
const configured = <N extends FlowNodeType, T extends z.ZodTypeAny>(type: N, config: T) =>
  z.object({ id: identifier, type: z.literal(type), config, position: PositionSchema.optional() }).strict();

export const FlowNodeSchema = z.discriminatedUnion('type', [
  configured('trigger', z.object({
    category: CategorySchema,
    requestedAction: z.enum(REQUESTED_ACTIONS).optional(),
  }).strict()),
  configured('jev_question', z.object({ question: z.enum(FLOW_QUESTIONS) }).strict()),
  configured('compare_fields', z.object({ fields: z.array(FieldNameSchema).min(1).max(7) }).strict()),
  configured('condition', z.object({
    source: z.enum(CONDITION_SOURCES),
    operator: z.enum(['equals', 'not_equals', 'at_least']),
    value: z.union([z.string().min(1).max(64), z.number().int().min(0).max(7)]),
  }).strict()),
  configured('draft_email', z.object({ replyType: z.enum(FLOW_REPLY_TYPES) }).strict()),
  configured('escalate', z.object({ reason: z.string().min(3).max(120) }).strict()),
]);
export type FlowNode = z.infer<typeof FlowNodeSchema>;

export const FlowEdgeSchema = z.object({
  id: identifier, from: identifier, to: identifier,
  branch: z.enum(['true', 'false']).nullable().default(null),
}).strict();
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

export const FlowSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(80),
  version: z.literal(FLOW_VERSION),
  nodes: z.array(FlowNodeSchema).min(1).max(40),
  edges: z.array(FlowEdgeSchema).max(80),
}).strict();
export type Flow = z.infer<typeof FlowSchema>;

export function parseFlow(value: unknown): Flow {
  return FlowSchema.parse(value);
}

export type FlowValidation = { ok: true; order: string[] } | { ok: false; errors: string[] };

/**
 * Structural validation, reported in full so the canvas can mark every problem
 * at once rather than one per save. A flow that fails here is never executed.
 */
export function validateFlow(flow: Flow): FlowValidation {
  const errors: string[] = [];
  const byId = new Map<string, FlowNode>();
  for (const node of flow.nodes) {
    if (byId.has(node.id)) errors.push(`Duplicate node id "${node.id}".`);
    byId.set(node.id, node);
  }

  const edgeIds = new Set<string>();
  const outgoing = new Map<string, FlowEdge[]>();
  const inboundCount = new Map<string, number>();
  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) errors.push(`Duplicate edge id "${edge.id}".`);
    edgeIds.add(edge.id);
    if (!byId.has(edge.from)) errors.push(`Edge "${edge.id}" starts at unknown node "${edge.from}".`);
    if (!byId.has(edge.to)) errors.push(`Edge "${edge.id}" ends at unknown node "${edge.to}".`);
    if (edge.from === edge.to) errors.push(`Edge "${edge.id}" connects node "${edge.from}" to itself.`);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    inboundCount.set(edge.to, (inboundCount.get(edge.to) ?? 0) + 1);
  }

  const triggers = flow.nodes.filter((node) => node.type === 'trigger');
  if (triggers.length !== 1) errors.push(`A flow needs exactly one trigger; found ${triggers.length}.`);
  for (const trigger of triggers) {
    if (inboundCount.get(trigger.id)) errors.push(`Trigger "${trigger.id}" cannot have an incoming edge.`);
  }

  for (const node of flow.nodes) {
    const edges = outgoing.get(node.id) ?? [];
    if (node.type === 'condition') {
      const branches = edges.map((edge) => edge.branch);
      if (edges.length !== 2 || !branches.includes('true') || !branches.includes('false')) {
        errors.push(`Condition "${node.id}" needs exactly one true branch and one false branch.`);
      }
      if (node.config.operator === 'at_least' && typeof node.config.value !== 'number') {
        errors.push(`Condition "${node.id}" uses "at_least" and needs a numeric value.`);
      }
      if (NUMERIC_CONDITION_SOURCES.includes(node.config.source) !== (typeof node.config.value === 'number')) {
        errors.push(`Condition "${node.id}" compares "${node.config.source}" against the wrong value type.`);
      }
    } else if (node.type === 'draft_email' || node.type === 'escalate') {
      if (edges.length) errors.push(`Outcome node "${node.id}" cannot have an outgoing edge.`);
    } else {
      if (edges.length > 1) errors.push(`Node "${node.id}" can have at most one outgoing edge.`);
      if (edges.some((edge) => edge.branch)) errors.push(`Only a condition can use a true or false branch; "${node.id}" cannot.`);
      if (!edges.length) errors.push(`Node "${node.id}" has no outcome; every path must end in a draft or an escalation.`);
    }
  }

  // Reachability and acyclicity, from the single trigger.
  const entry = triggers[0];
  const order: string[] = [];
  if (entry) {
    const state = new Map<string, 'open' | 'done'>();
    let cyclic = false;
    // Edges to unknown nodes are already reported; skip them so the rest of the
    // graph is still checked for cycles and unreachable nodes.
    const walk = (id: string) => {
      const seen = state.get(id);
      if (seen === 'done') return;
      if (seen === 'open') { cyclic = true; return; }
      state.set(id, 'open');
      for (const edge of outgoing.get(id) ?? []) if (byId.has(edge.to)) walk(edge.to);
      state.set(id, 'done');
      order.unshift(id);
    };
    walk(entry.id);
    if (cyclic) errors.push('The graph contains a cycle and cannot be executed.');
    for (const node of flow.nodes) {
      if (!state.has(node.id)) errors.push(`Node "${node.id}" is not reachable from the trigger.`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, order };
}

/**
 * The default SI-to-BL checking flow: read the current request, compare the
 * seven fields against real sources, then either confirm a clean match or hand
 * an unresolved case to a person. It mirrors the direct pipeline so the two
 * must agree on the same case.
 */
export const SEED_SI_BL_FLOW: Flow = {
  id: 'si-bl-default',
  name: 'SI to BL checking',
  version: FLOW_VERSION,
  nodes: [
    { id: 'trigger', type: 'trigger', config: { category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS' }, position: { x: 0, y: 0 } },
    { id: 'expectation', type: 'jev_question', config: { question: 'expectation' }, position: { x: 220, y: 0 } },
    { id: 'compare', type: 'compare_fields', config: { fields: ['shipper', 'consignee', 'notify_party', 'port_of_loading', 'port_of_discharge', 'container_count', 'gross_weight_kg'] }, position: { x: 440, y: 0 } },
    { id: 'verified', type: 'condition', config: { source: 'verificationState', operator: 'equals', value: 'COMPLETE' }, position: { x: 660, y: 0 } },
    { id: 'clean', type: 'condition', config: { source: 'mismatchCount', operator: 'equals', value: 0 }, position: { x: 880, y: -90 } },
    { id: 'confirm', type: 'draft_email', config: { replyType: 'CONFIRM_MATCH' }, position: { x: 1100, y: -160 } },
    { id: 'amend', type: 'draft_email', config: { replyType: 'REQUEST_AMENDMENT' }, position: { x: 1100, y: -20 } },
    { id: 'unresolved', type: 'escalate', config: { reason: 'Evidence incomplete after bounded retrieval' }, position: { x: 880, y: 120 } },
  ],
  edges: [
    { id: 'e1', from: 'trigger', to: 'expectation', branch: null },
    { id: 'e2', from: 'expectation', to: 'compare', branch: null },
    { id: 'e3', from: 'compare', to: 'verified', branch: null },
    { id: 'e4', from: 'verified', to: 'clean', branch: 'true' },
    { id: 'e5', from: 'verified', to: 'unresolved', branch: 'false' },
    { id: 'e6', from: 'clean', to: 'confirm', branch: 'true' },
    { id: 'e7', from: 'clean', to: 'amend', branch: 'false' },
  ],
};
