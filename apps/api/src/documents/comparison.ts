import { FIELD_NAMES, OperationalDecisionSchema, type Attachment, type FieldResult, type OperationalDecision } from '@cargolens/shared';
import type { CaseRecord } from '../store.js';
import { normaliseFieldValue, weightValueWithSourceUnit } from './value-comparison.js';
import { readAttachment, type AttachmentReadResult } from './index.js';
import { inlineBodyDocuments } from './inline-body.js';
import { candidatesByField, detectedRole, supportedNativeFields } from './field-extraction.js';
import { readAttachmentWithRecovery, type AttachmentRecoveryResult } from './recovery.js';
import { pairReferences, referencesMatch, type PairReference } from './pair-reference.js';

type Span = NonNullable<FieldResult['si']>;
interface Line { text: string; locator: string; trusted: boolean }
export interface ComparisonEvidence { attachmentId: string; recovery: AttachmentRecoveryResult }
interface Document { attachment: Attachment; sha256: string; lines: Line[]; blockers: string[]; reading?: AttachmentReadResult }
const aliases: Record<typeof FIELD_NAMES[number], string[]> = {
  shipper: ['shipper'], consignee: ['consignee'], notify_party: ['notify party'],
  port_of_loading: ['port of loading'], port_of_discharge: ['port of discharge'],
  container_count: ['container count', 'number of containers'], gross_weight_kg: ['gross weight kg', 'gross weight (kg)', 'gross weight'],
};
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

function inlineRecovery(reading: AttachmentReadResult): AttachmentRecoveryResult {
  return {
    before: reading, ocr: null,
    profile: {
      parser_readable: reading.status === 'READABLE', parser_status: reading.status, parser_readability: reading.readability,
      pages_needing_ocr: [], ocr_attempted: false, ocr_ok: null, ocr_average_confidence: null, ocr_unresolved_pages: [],
      reader_profile: reading.status === 'READABLE' ? 'native' : 'native_blocked',
    },
  };
}

function sourceLines(attachment: Attachment, recovery: AttachmentRecoveryResult): Document {
  const { before, ocr, profile } = recovery;
  const document: Document = { attachment, sha256: before.sha256, lines: [], blockers: [] };
  if (attachment.sha256 && attachment.sha256 !== before.sha256) document.blockers.push('SOURCE_HASH_CHANGED');
  if (before.status === 'READABLE') {
    document.reading = before;
    if (detectedRole(before.text) === 'other') document.blockers.push('WRONG_DOC_TYPE');
    for (const span of before.spans) {
      const locator = span.kind === 'line' ? `line:${span.line}` : span.kind === 'page' ? `page:${span.page}` : `cell:${span.sheet}!${span.cell}`;
      for (const text of span.text.split(/\r?\n/)) if (text.trim()) document.lines.push({ text, locator, trusted: true });
    }
    return document;
  }
  if (profile.reader_profile !== 'ocr_recovered' || !ocr?.ok) {
    document.blockers.push(ocr && !ocr.ok ? ocr.error.code : `SOURCE_${profile.reader_profile.toUpperCase()}`);
    return document;
  }
  // Preserve engine order; only consecutive words on the same visual line join.
  // No language-model value repair or opposite-document text enters this path.
  for (const page of ocr.pages) {
    let start = 0;
    for (let end = 1; end <= page.words.length; end++) {
      const a = page.words[end - 1]; const b = page.words[end];
      if (b && Math.abs((a.bbox.y + a.bbox.height / 2) - (b.bbox.y + b.bbox.height / 2)) <= Math.min(a.bbox.height, b.bbox.height) / 2 && b.bbox.x >= a.bbox.x) continue;
      const words = page.words.slice(start, end);
      document.lines.push({ text: words.map(word => word.text).join(' '), locator: `ocr:page:${page.page}:words:${start}-${end}`,
        trusted: words.every(word => word.confidence !== null && word.confidence >= 85) });
      start = end;
    }
  }
  return document;
}
function entries(document: Document, labels: string[]): Line[] {
  return document.lines.filter(line => {
    const colon = line.text.indexOf(':');
    return colon >= 0 && labels.includes(normalize(line.text.slice(0, colon)).replace(/_/g, ' '));
  });
}
function value(line: Line): string { return line.text.slice(line.text.indexOf(':') + 1).trim(); }
function documentReferences(document: Document): PairReference[] {
  return document.lines.flatMap(line => {
    if (!line.trusted) return [];
    const colon = line.text.indexOf(':');
    return colon < 0 ? [] : pairReferences(line.text.slice(0, colon), line.text.slice(colon + 1));
  });
}
function role(document: Document): 'si' | 'bl' | null {
  const header = document.lines.slice(0, 3);
  if (header.some(line => !line.trusted)) return null;
  const detected = detectedRole(header.map(line => line.text).join('\n'));
  return detected === 'si' || detected === 'bl' ? detected : null;
}
function field(document: Document, name: typeof FIELD_NAMES[number]): { span?: Span; canonical?: string; outcome?: FieldResult['outcome'] } {
  if (document.reading && candidatesByField(document.reading.candidates ?? [])[name].length > 1) return { outcome: 'AMBIGUOUS' };
  const rows = entries(document, aliases[name]);
  if (!rows.length && document.reading) {
    const selected = supportedNativeFields(document.reading)[name];
    const candidate = document.reading.candidates?.find(candidate => candidate.id === selected?.candidateId);
    if (selected && candidate) {
      const start = candidate.source.valueSpans[0]?.start;
      const end = candidate.source.valueSpans.at(-1)?.end;
      if (start === undefined || end === undefined || document.reading.text.slice(start, end) !== selected.value) return { outcome: 'AMBIGUOUS' };
      const input = name === 'gross_weight_kg' ? weightValueWithSourceUnit(selected.value, candidate.label) : selected.value;
      const canonical = normaliseFieldValue(name, input);
      if (canonical === null) return { outcome: 'AMBIGUOUS' };
      return { canonical, span: { attachmentId: document.attachment.id, sha256: document.sha256, locator: `chars:${start}-${end}`, text: selected.value } };
    }
  }
  if (!rows.length) return { outcome: 'MISSING' };
  if (rows.length !== 1) return { outcome: 'AMBIGUOUS' };
  const line = rows[0]; if (!line.trusted) return { outcome: 'UNREADABLE' };
  const text = value(line); if (!text) return { outcome: 'MISSING' };
  if (/^(?:\?+|_+|[-–—]+|TBA|TBD|N\s*\/\s*A|PENDING)$/iu.test(text)) return { outcome: 'MISSING' };
  const label = line.text.slice(0, line.text.indexOf(':'));
  const input = name === 'gross_weight_kg' ? weightValueWithSourceUnit(text, label) : text;
  const canonical = normaliseFieldValue(name, input);
  if (canonical === null) return { outcome: 'AMBIGUOUS' };
  return { span: { attachmentId: document.attachment.id, sha256: document.sha256, locator: line.locator, text: line.text }, canonical };
}

/** Conservative source-only comparison. Unsupported layouts remain explicit blockers. */
export async function compareDocuments(record: CaseRecord, root: string): Promise<{ decision: OperationalDecision; evidence: ComparisonEvidence[] }> {
  const evidence: ComparisonEvidence[] = []; const documents: Document[] = []; const blockers: string[] = [];
  const useInlineBody = !record.email.attachments.length && record.classification?.bodyDocument === 'HAS_SI_BL_CONTENT'
    && (record.classification.bodyDocumentConfidence ?? 0) >= 0.8;
  const inline = useInlineBody ? inlineBodyDocuments(record.email) : [];
  const sources = inline.length
    ? inline.map(item => ({ ...item, inline: true as const }))
    : record.email.attachments.map(attachment => ({ attachment, inline: false as const }));
  if (sources.length !== 2) blockers.push('UNAMBIGUOUS_PAIR_REQUIRED');
  // A hard cap avoids starting OCR for an unbounded/ambiguous attachment set.
  if (!blockers.length) for (const source of sources) {
    const { attachment } = source;
    if (!source.inline && !attachment.relativePath) { blockers.push('SOURCE_PATH_MISSING'); continue; }
    const recovery = source.inline ? inlineRecovery(source.reading)
      : await readAttachmentWithRecovery({ root, relativePath: attachment.relativePath!, mimeType: attachment.mimeType });
    evidence.push({ attachmentId: attachment.id, recovery });
    const document = sourceLines(attachment, recovery); documents.push(document); blockers.push(...document.blockers);
  }
  const si = documents.filter(document => role(document) === 'si'); const bl = documents.filter(document => role(document) === 'bl');
  let pairValidated = false; const fieldResults: FieldResult[] = [];
  if (si.length !== 1 || bl.length !== 1 || si[0].sha256 === bl[0].sha256 || si[0].attachment.id === bl[0].attachment.id) blockers.push('DOCUMENT_ROLES_UNVERIFIED');
  else {
    const refs = [si[0], bl[0]].map(document => documentReferences(document));
    pairValidated = referencesMatch(refs[0], refs[1]);
    if (!pairValidated) blockers.push('SHIPMENT_REFERENCE_UNVERIFIED');
    if (pairValidated && !blockers.length) for (const name of FIELD_NAMES) {
      const a = field(si[0], name); const b = field(bl[0], name);
      const outcome = a.outcome ?? b.outcome ?? (a.canonical === b.canonical ? 'MATCH' : 'MISMATCH');
      fieldResults.push({ field: name, outcome, ...(a.span ? { si: a.span } : {}), ...(b.span ? { bl: b.span } : {}) });
      if (!['MATCH', 'MISMATCH'].includes(outcome)) blockers.push(`${name}:${outcome}`);
    }
  }
  // Recovery runs asynchronously; reject mutations during either document read.
  for (const document of documents) {
    if (!document.attachment.relativePath) {
      if (document.sha256 !== inlineBodyDocuments(record.email).find(item => item.attachment.id === document.attachment.id)?.reading.sha256)
        blockers.push('SOURCE_HASH_CHANGED');
      continue;
    }
    const current = await readAttachment({ root, relativePath: document.attachment.relativePath!, mimeType: document.attachment.mimeType });
    if (current.sha256 !== document.sha256) blockers.push('SOURCE_HASH_CHANGED');
  }
  const complete = pairValidated && !blockers.length && fieldResults.length === 7;
  const knownMismatches = fieldResults.filter(row => row.outcome === 'MISMATCH').map(row => row.field);
  const decision = OperationalDecisionSchema.parse({ category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW',
    verificationState: complete ? 'COMPLETE' : 'BLOCKED', workflowState: complete ? knownMismatches.length ? 'MISMATCH' : 'VERIFIED' : 'BLOCKED',
    nextAction: complete ? knownMismatches.length ? 'REQUEST_AMENDMENT' : 'CONFIRM_MATCH' : 'REQUEST_CLARIFICATION',
    pairValidated, blockers: [...new Set(blockers)], knownMismatches, fieldResults, sourceVersion: record.sourceVersion, decisionVersion: (record.decision?.decisionVersion ?? 0) + 1 });
  return { decision, evidence };
}
