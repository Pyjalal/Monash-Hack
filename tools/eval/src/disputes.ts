import { z } from 'zod';
import { SubmissionRowSchema, type SubmissionRow } from '@cargolens/shared';

export const DisputeLedgerSchema = z.object({ version: z.literal(1), datasetSha256: z.string().regex(/^[a-f0-9]{64}$/), entries: z.array(z.object({
  id: z.string().min(1), emailId: z.string().min(1), target: z.enum(['category', 'status', 'review_reason', 'defect_fields', 'has_defect']),
  kind: z.enum(['SCHEMA_CONVENTION', 'CAPABILITY_ASSUMPTION', 'SOURCE_LABEL_CONTRADICTION', 'AMBIGUOUS_SOURCE', 'SCORER_LIMITATION']),
  status: z.enum(['PROPOSED', 'ACCEPTED', 'REJECTED']), rationale: z.string().min(1),
  evidence: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1) }).strict()).min(1),
  reviewer: z.string().min(1).optional(), reviewedAt: z.string().datetime().optional(), corrected: z.unknown().optional(),
}).strict()) }).strict();
export type DisputeLedger = z.infer<typeof DisputeLedgerSchema>;

/** Evaluation-only overlay. Never import this module from apps/api or packages/shared. */
export function adjudicate(truth: Record<string, SubmissionRow>, raw: unknown) {
  const ledger = DisputeLedgerSchema.parse(raw);
  const overlay = structuredClone(truth);
  const excluded: Record<string, string[]> = {};
  const accepted: string[] = []; const seen = new Set<string>(); const ids = new Set<string>();
  for (const entry of ledger.entries) {
    if (!truth[entry.emailId] || ids.has(entry.id)) throw new Error('Unknown dispute source or duplicate dispute ID'); ids.add(entry.id);
    if (entry.evidence.some(span => span.end <= span.start)) throw new Error('Invalid dispute span');
    const key = `${entry.emailId}:${entry.target}`;
    if (entry.status !== 'REJECTED' && seen.has(key)) throw new Error('Conflicting active adjudications');
    if (entry.status !== 'REJECTED') seen.add(key);
    if (entry.status === 'ACCEPTED') {
      if (!entry.reviewer || !entry.reviewedAt || entry.corrected === undefined) throw new Error('Accepted adjudication requires human review and correction');
      (overlay[entry.emailId] as unknown as Record<string, unknown>)[entry.target] = entry.corrected;
      accepted.push(entry.id);
    } else if (entry.status === 'PROPOSED') (excluded[entry.emailId] ??= []).push(entry.target);
  }
  for (const value of Object.values(overlay)) SubmissionRowSchema.parse(value);
  return { overlay, excluded, accepted, unresolvedByTarget: Object.fromEntries(['category', 'status', 'review_reason', 'defect_fields', 'has_defect'].map(target =>
    [target, Object.values(excluded).filter(targets => targets.includes(target)).length])) };
}

export function targetMetrics(truth: Record<string, SubmissionRow>, submission: Record<string, SubmissionRow>, excluded: Record<string, string[]> = {}) {
  return Object.fromEntries((['category', 'status', 'review_reason', 'defect_fields', 'has_defect'] as const).map(target => {
    const rows = Object.entries(truth).filter(([id]) => !excluded[id]?.includes(target));
    const equal = (left: unknown, right: unknown) => JSON.stringify(Array.isArray(left) ? [...left].sort() : left) === JSON.stringify(Array.isArray(right) ? [...right].sort() : right);
    const correct = rows.filter(([id, row]) => submission[id] && equal(row[target], submission[id][target])).length;
    return [target, { total: rows.length, correct, excluded: Object.keys(truth).length - rows.length, accuracy: rows.length ? correct / rows.length : null }];
  }));
}
