import { z } from 'zod';

export const CategorySchema = z.enum(['BL_COMPARISON', 'SI_REQUEST', 'INVOICE_QUERY', 'GENERAL', 'SPAM', 'UNCERTAIN']);
export type Category = z.infer<typeof CategorySchema>;
export const ExpectationSchema = z.enum(['FUTURE_DRAFT', 'VERIFY_NOW', 'REPORTS_MISSING', 'UNCLEAR']);
export type Expectation = z.infer<typeof ExpectationSchema>;
export const AttachmentSchema = z.object({
  id: z.string().min(1).max(512), mimeType: z.string().max(200),
  relativePath: z.string().max(1024).optional(), name: z.string().max(512).optional(),
  messageId: z.string().max(512).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
export const EmailSchema = z.object({
  id: z.string().min(1).max(512), subject: z.string().max(4096), from: z.string().max(512),
  snippet: z.string().max(8192).optional(), body: z.string().max(128000).optional(),
  contentScope: z.enum(['full_message', 'inbox_snippet']).default('full_message'),
  attachments: z.array(AttachmentSchema).max(100).default([]), threadId: z.string().max(512).optional(),
});
export type Email = z.infer<typeof EmailSchema>;
const probability = z.number().finite().min(0).max(1);
export const UrgencySchema = z.object({
  score: z.number().finite().min(0).max(3), level: z.enum(['routine', 'week', 'today', 'blocking']),
  confidence: probability, probabilities: z.record(probability),
});
export type Urgency = z.infer<typeof UrgencySchema>;
export const UsageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });
export type Usage = z.infer<typeof UsageSchema>;
export const ClassificationSchema = z.object({
  id: z.string(), category: CategorySchema, confidence: probability, probabilities: z.record(probability),
  urgency: UrgencySchema.nullable(), expectation: ExpectationSchema.nullable(), expectationConfidence: probability.nullable(),
  model: z.string().min(1), usage: UsageSchema, elapsedMs: z.number().finite().nonnegative(),
  questionVersion: z.string().min(1), cached: z.boolean(), raw: z.unknown().optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;
export const ClassifyRequestSchema = z.object({ emails: z.array(EmailSchema).min(1).max(20) }).superRefine((value, ctx) => {
  if (new Set(value.emails.map(email => email.id)).size !== value.emails.length) ctx.addIssue({ code: 'custom', message: 'Email IDs must be unique within a batch' });
});
export const ClassifyResultSchema = z.discriminatedUnion('status', [
  z.object({ id: z.string(), status: z.literal('classified'), classification: ClassificationSchema }),
  z.object({ id: z.string(), status: z.literal('error'), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ClassifyResult = z.infer<typeof ClassifyResultSchema>;
export const ClassifyResponseSchema = z.object({ results: z.array(ClassifyResultSchema), elapsedMs: z.number().nonnegative() });

export const FIELD_NAMES = ['shipper', 'consignee', 'notify_party', 'port_of_loading', 'port_of_discharge', 'container_count', 'gross_weight_kg'] as const;
export const FieldNameSchema = z.enum(FIELD_NAMES);
export const SourceSpanSchema = z.object({
  attachmentId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  locator: z.string().min(1), text: z.string().min(1),
});
export const FieldResultSchema = z.object({
  field: FieldNameSchema, outcome: z.enum(['MATCH', 'MISMATCH', 'MISSING', 'AMBIGUOUS', 'UNREADABLE']),
  si: SourceSpanSchema.optional(), bl: SourceSpanSchema.optional(),
});
export const OperationalDecisionSchema = z.object({
  category: CategorySchema,
  requestedAction: z.enum(['REQUEST_DRAFT', 'VERIFY_DOCUMENTS', 'AMEND_DOCUMENTS', 'OTHER', 'UNCERTAIN']),
  documentExpectation: z.enum(['DEFERRED', 'EXPECTED_NOW', 'UNCERTAIN']),
  verificationState: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE', 'FAILED']),
  workflowState: z.enum(['AWAITING_DOCUMENTS', 'PROCESSING', 'BLOCKED', 'VERIFIED', 'MISMATCH', 'NOT_APPLICABLE', 'FAILED']),
  knownMismatches: z.array(FieldNameSchema), blockers: z.array(z.string().min(1)), fieldResults: z.array(FieldResultSchema).max(7),
  nextAction: z.enum(['FETCH_THREAD', 'REQUEST_DOCUMENTS', 'REQUEST_CLARIFICATION', 'REQUEST_AMENDMENT', 'CONFIRM_MATCH', 'RECOVER_FIELDS', 'WAIT', 'NONE']),
  sourceVersion: z.string().min(1), decisionVersion: z.number().int().positive(),
  pairValidated: z.boolean().default(false),
}).superRefine((value, ctx) => {
  const fields = new Set(value.fieldResults.map(result => result.field));
  const complete = value.pairValidated && value.blockers.length === 0 && fields.size === 7 && value.fieldResults.every(result =>
    ['MATCH', 'MISMATCH'].includes(result.outcome) && result.si && result.bl && result.si.attachmentId !== result.bl.attachmentId);
  const mismatches = value.fieldResults.filter(result => result.outcome === 'MISMATCH').map(result => result.field).sort();
  if (fields.size !== value.fieldResults.length || new Set(value.knownMismatches).size !== value.knownMismatches.length || JSON.stringify(mismatches) !== JSON.stringify([...value.knownMismatches].sort())) {
    ctx.addIssue({ code: 'custom', message: 'Field results and established mismatches must agree' });
  }
  if (value.verificationState === 'COMPLETE' && !complete) ctx.addIssue({ code: 'custom', message: 'Complete comparison requires seven sourced outcomes and a validated pair' });
  if ((value.workflowState === 'VERIFIED' || value.nextAction === 'CONFIRM_MATCH') && !(complete && value.verificationState === 'COMPLETE' && mismatches.length === 0)) {
    ctx.addIssue({ code: 'custom', message: 'Match confirmation requires seven verified matches' });
  }
});
export type OperationalDecision = z.infer<typeof OperationalDecisionSchema>;

export const CaseEventSchema = z.object({ sequence: z.number().int(), type: z.string(), caseId: z.string().nullable(), at: z.string(), data: z.unknown() });
export type CaseEvent = z.infer<typeof CaseEventSchema>;
