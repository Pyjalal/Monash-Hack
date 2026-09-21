import {
  FIELD_NAMES,
  OperationalDecisionSchema,
  type Attachment,
  type Email,
  type FieldResult,
  type OperationalDecision,
} from '@cargolens/shared';
import type { VisionProvider, VisionRecoveryResult } from '../ai/vision.js';
import type { CaseRecord } from '../store.js';
import {
  detectedRole,
  extractDocumentFields,
  type DocumentFieldExtraction,
  type DocumentRole,
  type FallbackExtractor,
} from './field-extraction.js';
import { readAttachment, renderPdfPageImages, type AttachmentReadResult } from './index.js';
import { acceptFormattingVerdict, isConfidentSemanticDifference, weightValueWithSourceUnit, normaliseFieldValue } from './value-comparison.js';
import { pairReferences, referencesMatch } from './pair-reference.js';

type FieldName = (typeof FIELD_NAMES)[number];
type ReadDocument = { attachment: Attachment; reading: AttachmentReadResult; role: DocumentRole };

export interface FullPipelineComparisonRequest { field: FieldName; si: string; bl: string }
export interface FullPipelineComparisonVerdict { equivalent: boolean; confidence: number | null; placeholder?: boolean }
export type FullPipelineComparisonFallback = (
  requests: FullPipelineComparisonRequest[],
) => Promise<Partial<Record<FieldName, FullPipelineComparisonVerdict>>>;

export interface FullPipelineDependencies {
  fallback: FallbackExtractor;
  compareFallback: FullPipelineComparisonFallback;
  vision: VisionProvider | null;
}

async function documentsFor(email: Email, root: string) {
  const result: Record<DocumentRole, ReadDocument | undefined> = { si: undefined, bl: undefined };
  const blockers: string[] = [];
  let reason: 'missing_attachment' | 'unreadable' | 'wrong_doc_type' | 'missing_value' | null = null;
  if (email.attachments.length !== 2) return { ...result, blockers: ['UNAMBIGUOUS_PAIR_REQUIRED'], reason: 'missing_attachment' as const };
  const documents = await Promise.all(email.attachments.map(async attachment => {
    if (!attachment.relativePath) return undefined;
    const reading = await readAttachment({ root, relativePath: attachment.relativePath, mimeType: attachment.mimeType });
    return { role: detectedRole(reading.text), attachment, reading };
  }));
  if (documents.some(document => !document)) { blockers.push('SOURCE_PATH_MISSING'); reason = 'missing_attachment'; }
  else if (documents.some(document => document!.reading.status !== 'READABLE')) { blockers.push('UNREADABLE'); reason = 'unreadable'; }
  else if (documents.some(document => document!.role === 'other')) { blockers.push('WRONG_DOC_TYPE'); reason = 'wrong_doc_type'; }
  for (const role of ['si', 'bl'] as const) {
    const matches = documents.filter(document => document?.role === role);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match) result[role] = match as ReadDocument;
  }
  if (!result.si || !result.bl) { blockers.push('DOCUMENT_ROLES_UNVERIFIED'); reason ??= 'missing_value'; }
  else {
    const refs = [result.si, result.bl].map(document =>
      (document.reading.candidates ?? []).flatMap(candidate => pairReferences(candidate.label, candidate.value)));
    const paired = referencesMatch(refs[0], refs[1])
      && result.si.reading.sha256 !== result.bl.reading.sha256
      && result.si.attachment.id !== result.bl.attachment.id;
    if (!paired) { blockers.push('SHIPMENT_REFERENCE_UNVERIFIED'); reason ??= 'missing_value'; }
  }
  return { ...result, blockers, reason };
}

export function explicitlyRequestsComparison(email: Email): boolean {
  return /\bcompare\b[\s\S]{0,200}\b(?:SI|shipping\s+instructions?)\b[\s\S]{0,200}\b(?:draft\s+)?(?:B\s*\/\s*L|BL|bill\s+of\s+lading)\b/iu.test(`${email.subject}\n${email.body}`);
}

function fieldsNeedingVision(extraction: DocumentFieldExtraction): FieldName[] {
  const fields = new Set<FieldName>(extraction.unresolvedFields);
  for (const reason of extraction.assessment.reasons) {
    const match = /^(?:missing_expected_label|ambiguous_expected_label|implausible_value):(.+)$/u.exec(reason);
    if (match && FIELD_NAMES.includes(match[1] as FieldName)) fields.add(match[1] as FieldName);
  }
  return [...fields];
}

async function recoverPdfFields(
  document: ReadDocument,
  extraction: DocumentFieldExtraction,
  root: string,
  vision: VisionProvider | null,
): Promise<{ extraction: DocumentFieldExtraction; visionRecovery?: VisionRecoveryResult }> {
  const fields = fieldsNeedingVision(extraction);
  if (!vision || !fields.length || !document.attachment.relativePath || !document.reading.pdfLayout?.length) return { extraction };
  const pages = document.reading.pdfLayout.slice(0, 3).map(page => page.page);
  try {
    const images = await renderPdfPageImages({ root, relativePath: document.attachment.relativePath, mimeType: document.attachment.mimeType }, pages);
    const visionRecovery = await vision.recover({
      unresolvedPages: pages,
      unresolvedFields: fields,
      pageImages: images.map(({ page, mimeType, base64 }) => ({ page, mimeType, base64 })),
      positionedText: document.reading.pdfLayout.filter(page => pages.includes(page.page)).map(page => ({
        page: page.page, width: page.width, height: page.height,
        blocks: page.blocks.map(({ id, text, x, y, width, height }) => ({ id, text, x, y, width, height })),
      })),
    });
    return { extraction, visionRecovery };
  } catch {
    return { extraction };
  }
}

/** The exact extraction/comparison implementation used by `npm run pipeline:full`. */
export async function extractWithFullPipeline(
  email: Email,
  root: string,
  fallback: FallbackExtractor,
  compareFallback: FullPipelineComparisonFallback,
  vision: VisionProvider | null,
  options: { assumeKilograms?: boolean; benchmarkSemanticPolicy?: boolean } = {},
) {
  const assumptions: string[] = [];
  const documents = await documentsFor(email, root);
  if (documents.reason || !documents.si || !documents.bl) return { email_id: email.id, review_reason: documents.reason ?? 'missing_value' as const, documents, defect_fields: [] as FieldName[] };
  const [siNativeExtraction, blNativeExtraction] = await Promise.all([
    extractDocumentFields(documents.si.reading, 'si', fallback),
    extractDocumentFields(documents.bl.reading, 'bl', fallback),
  ]);
  const [siRecovered, blRecovered] = await Promise.all([
    recoverPdfFields(documents.si, siNativeExtraction, root, vision),
    recoverPdfFields(documents.bl, blNativeExtraction, root, vision),
  ]);
  const siExtraction = siRecovered.extraction; const blExtraction = blRecovered.extraction;
  const extraction = { si: siExtraction, bl: blExtraction, vision: { si: siRecovered.visionRecovery, bl: blRecovered.visionRecovery } };
  if (siExtraction.status === 'wrong_document_type' || blExtraction.status === 'wrong_document_type') return { email_id: email.id, review_reason: 'wrong_doc_type' as const, documents, extraction, defect_fields: [] as FieldName[] };
  let unresolved = siExtraction.status !== 'complete' || blExtraction.status !== 'complete';
  const fields = { si: siExtraction.fields, bl: blExtraction.fields } as Record<DocumentRole, Record<FieldName, { value: string; candidateId: string; confidence: number; method: string }>>;
  const comparison = Object.fromEntries(FIELD_NAMES.map(field => {
    const siNormalized = normaliseFieldValue(field, sourceValue(documents.si!, field, fields.si[field], options.assumeKilograms, assumptions));
    const blNormalized = normaliseFieldValue(field, sourceValue(documents.bl!, field, fields.bl[field], options.assumeKilograms, assumptions));
    if (siNormalized === null || blNormalized === null) unresolved = true;
    return [field, {
      si: fields.si[field]?.value ?? null,
      bl: fields.bl[field]?.value ?? null,
      siNormalized,
      blNormalized,
      matches: siNormalized !== null && blNormalized !== null && siNormalized === blNormalized,
      method: siNormalized !== null && blNormalized !== null && siNormalized === blNormalized ? 'normalized_exact' : 'different',
      comparisonConfidence: null as number | null,
    }];
  })) as Record<FieldName, { si: string | null; bl: string | null; siNormalized: string | null; blNormalized: string | null; matches: boolean; method: string; comparisonConfidence: number | null }>;
  const pending = FIELD_NAMES.filter(field => comparison[field].siNormalized !== null && comparison[field].blNormalized !== null && !comparison[field].matches && field !== 'container_count' && field !== 'gross_weight_kg')
    .map(field => ({ field, si: fields.si[field].value, bl: fields.bl[field].value }));
  if (pending.length) {
    try {
      const verdicts = await compareFallback(pending);
      for (const request of pending) {
        const verdict = verdicts[request.field];
        if (verdict?.placeholder) {
          unresolved = true;
          comparison[request.field].comparisonConfidence = verdict.confidence ?? null;
          comparison[request.field].matches = false;
          comparison[request.field].method = 'jev_placeholder_missing_value';
        } else {
          const isSame = options.benchmarkSemanticPolicy ? verdict?.equivalent === true : acceptFormattingVerdict(request.field, request.si, request.bl, verdict);
          const isDifferent = options.benchmarkSemanticPolicy ? !isSame : isConfidentSemanticDifference(verdict);
          if (!isSame && !isDifferent) unresolved = true;
          comparison[request.field].comparisonConfidence = verdict?.confidence ?? null;
          comparison[request.field].matches = isSame;
          comparison[request.field].method = isSame ? 'jev_format_equivalent' : isDifferent ? 'different' : 'semantic_unresolved';
        }
      }
    } catch {
      unresolved = true;
      for (const request of pending) {
        comparison[request.field].matches = false;
        comparison[request.field].method = 'semantic_unresolved';
      }
    }
  }
  const defect_fields = FIELD_NAMES.filter(field =>
    comparison[field].siNormalized !== null &&
    comparison[field].blNormalized !== null &&
    !comparison[field].matches &&
    comparison[field].method !== 'jev_placeholder_missing_value' && comparison[field].method !== 'semantic_unresolved');
  for (const document of [documents.si, documents.bl]) {
    const fresh = await readAttachment({ root, relativePath: document.attachment.relativePath!, mimeType: document.attachment.mimeType });
    if (fresh.sha256 !== document.reading.sha256) { documents.blockers.push('SOURCE_HASH_CHANGED'); unresolved = true; }
  }
  return { email_id: email.id, review_reason: unresolved ? 'missing_value' as const : null, documents, extraction, fields, comparison, defect_fields, assumptions };
}

type FullResult = Awaited<ReturnType<typeof extractWithFullPipeline>>;

function sourceValue(document: ReadDocument, field: FieldName, extracted: { value: string; candidateId: string } | undefined, assumeKilograms = false, assumptions: string[] = []): string | null {
  if (!extracted) return null;
  const candidate = document.reading.candidates?.find(item => item.id === extracted.candidateId);
  if (!candidate || candidate.value !== extracted.value) return null;
  const value = field === 'gross_weight_kg' ? weightValueWithSourceUnit(extracted.value, candidate.label) : extracted.value;
  if (field === 'gross_weight_kg' && assumeKilograms && /^[\d,.]+$/u.test(value.normalize('NFKC').trim())) {
    assumptions.push(`${document.role}:gross_weight_kg:benchmark_assumed_kg`);
    return `${value} KG`;
  }
  return value;
}

function sourceSpan(
  document: ReadDocument,
  extracted: { value: string; candidateId: string } | undefined,
): NonNullable<FieldResult['si']> | undefined {
  if (!extracted) return undefined;
  const candidate = document.reading.candidates?.find(item => item.id === extracted.candidateId);
  if (!candidate || candidate.value !== extracted.value) return undefined;
  const starts = candidate.source.valueSpans;
  const start = starts[0]?.start;
  const end = starts.at(-1)?.end;
  if (start === undefined || end === undefined || start < 0 || end <= start) return undefined;
  const text = document.reading.text.slice(start, end);
  if (!text || text !== extracted.value) return undefined;
  return { attachmentId: document.attachment.id, sha256: document.reading.sha256, locator: `chars:${start}-${end}`, text };
}

/** Converts the shared benchmark result into durable, source-bound operational state. */
export async function compareCaseWithFullPipeline(
  record: CaseRecord,
  root: string,
  dependencies: FullPipelineDependencies,
): Promise<{ decision: OperationalDecision; evidence: unknown }> {
  const result: FullResult = await extractWithFullPipeline(record.email, root, dependencies.fallback, dependencies.compareFallback, dependencies.vision);
  const blockers = [...new Set(result.documents.blockers)];
  const fieldResults: FieldResult[] = [];
  if ('comparison' in result && result.comparison && result.documents.si && result.documents.bl && 'fields' in result && result.fields) {
    for (const field of FIELD_NAMES) {
      const compared = result.comparison[field];
      const si = sourceSpan(result.documents.si, result.fields.si[field]);
      const bl = sourceSpan(result.documents.bl, result.fields.bl[field]);
      const missing = compared.method === 'jev_placeholder_missing_value' || compared.siNormalized === null || compared.blNormalized === null;
      const outcome: FieldResult['outcome'] = compared.method === 'semantic_unresolved' ? 'AMBIGUOUS' : missing ? 'MISSING' : !si || !bl ? 'UNREADABLE' : compared.matches ? 'MATCH' : 'MISMATCH';
      fieldResults.push({ field, outcome, ...(si ? { si } : {}), ...(bl ? { bl } : {}) });
      if (!['MATCH', 'MISMATCH'].includes(outcome)) blockers.push(`${field}:${outcome}`);
    }
  }
  if (result.review_reason && !blockers.length) blockers.push(result.review_reason.toUpperCase());
  const pairValidated = Boolean(result.documents.si && result.documents.bl && !result.documents.blockers.includes('SHIPMENT_REFERENCE_UNVERIFIED'));
  const complete = !result.review_reason && pairValidated && !blockers.length && fieldResults.length === FIELD_NAMES.length;
  const knownMismatches = fieldResults.filter(row => row.outcome === 'MISMATCH').map(row => row.field);
  const decision = OperationalDecisionSchema.parse({
    category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW',
    verificationState: complete ? 'COMPLETE' : 'BLOCKED',
    workflowState: complete ? knownMismatches.length ? 'MISMATCH' : 'VERIFIED' : 'BLOCKED',
    nextAction: complete ? knownMismatches.length ? 'REQUEST_AMENDMENT' : 'CONFIRM_MATCH' : 'REQUEST_CLARIFICATION',
    pairValidated, blockers: [...new Set(blockers)], knownMismatches, fieldResults,
    sourceVersion: record.sourceVersion, decisionVersion: (record.decision?.decisionVersion ?? 0) + 1,
  });
  return { decision, evidence: { pipeline: 'full-v1', result } };
}
