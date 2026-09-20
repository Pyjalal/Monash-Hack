import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COMPARISON_FIELDS,
  extractEmail,
  findDocumentCandidates,
  normaliseFieldValue,
} from '../src/extraction/jev-extractor.js';

const documentText = `SHIPPING INSTRUCTION
Shipper/Exporter: APRIL PAPER SDN BHD
CONSIGNEE: EXAMPLE BUYER
Notify: EXAMPLE AGENT
Port of Loading (POL): PORT KLANG, MALAYSIA (MYPKG)
POD: CALLAO, PERU (PECLL)
No. of Containers or Packages: 3 x 40'HC
GROSS WEIGHT (KG)
ABCD1234567
TOTAL Gross Wt (kgs): 65,500 KG`;

test('findDocumentCandidates exposes neutral values without field-specific extraction', () => {
  const candidates = findDocumentCandidates(documentText);
  assert.ok(candidates.includes('APRIL PAPER SDN BHD'));
  assert.ok(candidates.includes('CALLAO, PERU (PECLL)'));
  assert.ok(candidates.includes('65,500 KG'));
  assert.ok(candidates.includes('ABCD1234567'));
  assert.deepEqual(findDocumentCandidates('Gross Weight: ???'), []);
});

test('normaliseFieldValue compares counts, weights, and port codes consistently', () => {
  assert.equal(normaliseFieldValue('container_count', "3 x 40'HC"), '3');
  assert.equal(normaliseFieldValue('gross_weight_kg', '65,500 KG'), '65500');
  assert.equal(normaliseFieldValue('port_of_loading', 'Port Klang, Malaysia (MYPKG)'), 'PORT KLANG MALAYSIA');
});

test('extractEmail escalates a no-attachment email without calling Jev', async () => {
  const result = await extractEmail(
    { email_id: 'email_001', category: 'BL_COMPARISON', attachments: [] },
    { evaluator: () => assert.fail('Jev must not be called without attachment content') },
  );
  assert.equal(result.attachment_status, 'NO_ATTACHMENTS');
  assert.equal(result.review_reason, 'missing_attachment');
});

test('extractEmail skips extraction for categories outside BL_COMPARISON', async () => {
  const result = await extractEmail(
    { email_id: 'email_002', category: 'INVOICE_QUERY', attachments: [] },
    { evaluator: () => assert.fail('Jev must not be called for another category') },
  );
  assert.equal(result.attachment_status, 'NOT_APPLICABLE');
  assert.equal(result.review_reason, null);
  assert.equal(result.skipped, true);
});

test('extractEmail maps Jev candidate choices into all seven extracted fields', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'jev-extractor-'));
  const attachmentDirectory = path.join(temporaryDirectory, 'attachments');
  await mkdir(attachmentDirectory);
  await Promise.all([
    writeFile(path.join(attachmentDirectory, 'email_001_SI.txt'), documentText),
    writeFile(
      path.join(attachmentDirectory, 'email_001_BL.txt'),
      documentText.replace('SHIPPING INSTRUCTION', 'BILL OF LADING (DRAFT)'),
    ),
  ]);
  const fieldValues = {
    shipper: 'APRIL PAPER SDN BHD',
    consignee: 'EXAMPLE BUYER',
    notify_party: 'EXAMPLE AGENT',
    port_of_loading: 'PORT KLANG, MALAYSIA (MYPKG)',
    port_of_discharge: 'CALLAO, PERU (PECLL)',
    container_count: "3 x 40'HC",
    gross_weight_kg: '65,500 KG',
  };
  const evaluator = async request => ({
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([questionId, question]) => {
        if (questionId.endsWith('document_type')) {
          return [questionId, { type: 'choice', choice: questionId.startsWith('si_') ? 'shipping_instruction' : 'bill_of_lading' }];
        }
        const field = COMPARISON_FIELDS.find(name => questionId.endsWith(`_${name}`));
        const choice = Object.entries(question.criteria).find(
          ([key, description]) => key !== 'missing' && description.endsWith(fieldValues[field]),
        )?.[0];
        return [questionId, { type: 'choice', choice, probabilities: { [choice]: 0.99 } }];
      }),
    ),
  });
  try {
    const result = await extractEmail(
      {
        email_id: 'email_001',
        category: 'BL_COMPARISON',
        attachments: ['attachments/email_001_SI.txt', 'attachments/email_001_BL.txt'],
      },
      { dataDir: temporaryDirectory, evaluator },
    );

    assert.equal(COMPARISON_FIELDS.length, 7);
    assert.equal(result.review_reason, null);
    assert.deepEqual(result.defect_fields, []);
    assert.deepEqual(Object.keys(result.documents.si.fields), COMPARISON_FIELDS);
    assert.equal(result.documents.si.fields.gross_weight_kg.normalized_value, '65500');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
