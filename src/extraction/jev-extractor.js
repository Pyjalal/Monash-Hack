import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_MODEL } from '../classification/jev-classifier.js';

const execFileAsync = promisify(execFile);

export const COMPARISON_FIELDS = [
  'shipper',
  'consignee',
  'notify_party',
  'port_of_loading',
  'port_of_discharge',
  'container_count',
  'gross_weight_kg',
];

const FIELD_GUIDANCE = {
  shipper: 'the shipper/exporter legal name',
  consignee: 'the consignee or to-the-order-of legal name',
  notify_party: 'the notify party legal name',
  port_of_loading: 'the port of loading (POL)',
  port_of_discharge: 'the port of discharge (POD)',
  container_count: 'the total number of containers, not a container identifier',
  gross_weight_kg: 'the total gross weight in kilograms, not a per-container weight',
};

const PLACEHOLDER = /^(?:\?+|_+|-+|tba|n\/?a|nil|unknown)$/i;

function compact(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Build a field-agnostic closed candidate set. Attachment parsing only exposes
 * document values; Jev performs every semantic field selection.
 */
export function findDocumentCandidates(text) {
  const lines = text.split(/\r?\n/).map(compact).filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    if (/^[=_–—-]{3,}$/.test(line)) continue;
    const separatorIndex = line.indexOf(':');
    const value = compact(separatorIndex >= 0 ? line.slice(separatorIndex + 1) : line);
    if (
      value &&
      !PLACEHOLDER.test(value) &&
      value.length <= 500 &&
      !candidates.includes(value)
    ) {
      candidates.push(value);
    }
  }
  return candidates.slice(0, 120);
}

export function normaliseFieldValue(field, value) {
  if (value === null || value === undefined) return null;
  const cleaned = compact(String(value)).toUpperCase();
  if (field === 'container_count') {
    const number = cleaned.match(/\d[\d,]*/)?.[0];
    return number ? String(Number(number.replaceAll(',', ''))) : cleaned;
  }
  if (field === 'gross_weight_kg') {
    const numbers = [...cleaned.matchAll(/\d[\d,]*(?:\.\d+)?/g)];
    const number = numbers.at(-1)?.[0];
    return number ? String(Number(number.replaceAll(',', ''))) : cleaned;
  }
  return cleaned
    .replace(/\s*\|.*$/, '')
    .replace(/\s*\([A-Z]{5}\)\s*$/, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function workbookToText(result) {
  return result.sheets
    .flatMap(sheet => [
      `SHEET: ${sheet.name}`,
      ...sheet.rows.map(row => row.filter(value => String(value).trim()).join(': ')),
    ])
    .join('\n');
}

export async function readAttachment(
  filePath,
  {
    python = process.env.PYTHON_EXECUTABLE ?? 'python',
    helperPath = path.resolve('src/viewer/extract_attachment.py'),
  } = {},
) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.txt') {
    const text = (await readFile(filePath, 'utf8')).trim();
    if (!text) return { readable: false, format: 'TXT', error: 'Text attachment is empty' };
    return { readable: true, format: 'TXT', text };
  }

  try {
    const { stdout } = await execFileAsync(python, [helperPath, filePath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    if (result.kind === 'text' && result.content?.trim()) {
      return { readable: true, format: result.format, text: result.content.trim() };
    }
    if (result.kind === 'workbook') {
      const text = workbookToText(result);
      if (text.trim()) return { readable: true, format: result.format, text };
    }
    return {
      readable: false,
      format: result.format ?? extension.slice(1).toUpperCase(),
      error: result.message ?? 'Attachment contained no readable content',
    };
  } catch (error) {
    return {
      readable: false,
      format: extension.slice(1).toUpperCase(),
      error: error.message,
    };
  }
}

function documentRole(filename) {
  if (/_SI\b/i.test(path.basename(filename, path.extname(filename)))) return 'si';
  if (/_BL\b/i.test(path.basename(filename, path.extname(filename)))) return 'bl';
  return null;
}

function makeDocumentTypeQuestion(role) {
  return {
    type: 'choice',
    instructions: {
      task: `Identify the document type of \`${role}_document.text\`.`,
      guidance: 'Use the document content, not only its filename. Select other for invoices, packing lists, certificates, or unrelated documents.',
    },
    criteria: {
      shipping_instruction: 'A Shipping Instruction, BL Instruction, or customer SI.',
      bill_of_lading: 'A Bill of Lading or draft Bill of Lading.',
      other: 'A different readable document type.',
    },
  };
}

function makeFieldQuestion(role, field, candidates) {
  const criteria = Object.fromEntries(
    candidates.map((value, index) => [
      `candidate_${index}`,
      `Candidate text from the document: ${value}`,
    ]),
  );
  criteria.missing = `The ${FIELD_GUIDANCE[field]} is blank, a placeholder, or none of the candidates is supported by the document.`;
  return {
    type: 'choice',
    instructions: {
      task: `Extract ${FIELD_GUIDANCE[field]} from \`${role}_document.text\`.`,
      guidance:
        'Choose the candidate that is the field value itself. Do not choose a label, address, reference number, per-container row, or unrelated value. For counts and weights, prefer the explicitly labelled total. Choose missing for blanks/placeholders or when no candidate is supported.',
    },
    criteria,
  };
}

function confidenceFor(answer) {
  if (typeof answer.confidence === 'number') return answer.confidence;
  return answer.probabilities?.[answer.choice] ?? null;
}

export async function extractEmail(
  email,
  { dataDir, evaluator, model = DEFAULT_MODEL, python } = {},
) {
  if (email.category !== 'BL_COMPARISON') {
    return {
      email_id: email.email_id,
      attachment_status: 'NOT_APPLICABLE',
      review_reason: null,
      documents: {},
      defect_fields: [],
      skipped: true,
      skipped_reason: `Category ${email.category ?? 'UNKNOWN'} does not require SI/BL extraction`,
    };
  }

  const attachmentNames = email.attachments ?? [];
  if (attachmentNames.length === 0) {
    return {
      email_id: email.email_id,
      attachment_status: 'NO_ATTACHMENTS',
      review_reason: 'missing_attachment',
      documents: {},
      defect_fields: [],
    };
  }

  const documents = {};
  for (const name of attachmentNames) {
    const role = documentRole(name);
    if (!role || documents[role]) continue;
    documents[role] = {
      filename: name,
      ...(await readAttachment(path.resolve(dataDir, name), { python })),
    };
  }

  const attachmentStatus = documents.si && documents.bl ? 'COMPLETE' : 'INCOMPLETE_ATTACHMENTS';
  const readableDocuments = Object.fromEntries(
    Object.entries(documents).filter(([, document]) => document.readable),
  );
  const questions = {};
  const candidateMap = {};
  for (const [role, document] of Object.entries(readableDocuments)) {
    questions[`${role}_document_type`] = makeDocumentTypeQuestion(role);
    candidateMap[role] = {};
    const documentCandidates = findDocumentCandidates(document.text);
    for (const field of COMPARISON_FIELDS) {
      candidateMap[role][field] = documentCandidates;
      questions[`${role}_${field}`] = makeFieldQuestion(role, field, documentCandidates);
    }
  }

  let answers = {};
  if (Object.keys(questions).length > 0) {
    if (typeof evaluator !== 'function') throw new Error('A Jev evaluator function is required');
    const state = Object.fromEntries(
      Object.entries(readableDocuments).map(([role, document]) => [
        `${role}_document`,
        { filename: document.filename, format: document.format, text: document.text },
      ]),
    );
    const result = await evaluator({ model, state, questions });
    answers = result.answers;
  }

  for (const [role, document] of Object.entries(readableDocuments)) {
    const typeAnswer = answers[`${role}_document_type`];
    document.document_type = typeAnswer?.choice ?? null;
    document.document_type_confidence = typeAnswer ? confidenceFor(typeAnswer) : null;
    document.fields = {};
    for (const field of COMPARISON_FIELDS) {
      const answer = answers[`${role}_${field}`];
      const choice = answer?.choice;
      const candidateIndex = /^candidate_(\d+)$/.exec(choice ?? '')?.[1];
      const value = candidateIndex === undefined ? null : candidateMap[role][field][Number(candidateIndex)] ?? null;
      document.fields[field] = {
        value,
        normalized_value: normaliseFieldValue(field, value),
        confidence: answer ? confidenceFor(answer) : null,
        candidates: candidateMap[role][field],
      };
    }
    delete document.text;
  }

  let reviewReason = null;
  if (attachmentStatus !== 'COMPLETE') {
    reviewReason = 'missing_attachment';
  } else if (Object.values(documents).some(document => !document.readable)) {
    reviewReason = 'unreadable';
  } else if (
    documents.si.document_type !== 'shipping_instruction' ||
    documents.bl.document_type !== 'bill_of_lading'
  ) {
    reviewReason = 'wrong_doc_type';
  } else if (
    COMPARISON_FIELDS.some(
      field => documents.si.fields[field].value === null || documents.bl.fields[field].value === null,
    )
  ) {
    reviewReason = 'missing_value';
  }

  const defectFields = reviewReason
    ? []
    : COMPARISON_FIELDS.filter(
        field =>
          documents.si.fields[field].normalized_value !==
          documents.bl.fields[field].normalized_value,
      ).sort();

  return {
    email_id: email.email_id,
    attachment_status: attachmentStatus,
    review_reason: reviewReason,
    documents,
    defect_fields: defectFields,
  };
}

export async function extractEmails(
  emails,
  {
    dataDir,
    evaluator,
    model = DEFAULT_MODEL,
    python,
    concurrency = 3,
    onEmailComplete = () => {},
  } = {},
) {
  const results = new Array(emails.length);
  let nextIndex = 0;
  let processed = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= emails.length) return;
      results[index] = await extractEmail(emails[index], { dataDir, evaluator, model, python });
      processed += 1;
      onEmailComplete({ processed, total: emails.length, result: results[index] });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, emails.length) }, () => worker()),
  );
  return results;
}
