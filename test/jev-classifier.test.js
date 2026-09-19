import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyBatch, classifyEmails } from '../src/classification/jev-classifier.js';

const emails = [
  {
    email_id: 'email_001',
    from: 'docs@example.com',
    subject: 'Please confirm draft BL',
    body: 'Check the BL against the SI.',
    attachments: ['attachments/email_001_SI.txt', 'attachments/email_001_BL.txt'],
  },
  {
    email_id: 'email_002',
    from: 'billing@example.com',
    subject: 'Invoice query',
    body: 'Please confirm local charges.',
    attachments: [],
  },
];

test('classifyBatch maps typed Jev choices and probabilities', async () => {
  const evaluator = async request => {
    assert.equal(request.model, 'typesafe/jev-1.13');
    assert.equal(request.state.length, 2);
    assert.equal(request.state[0].attachment_count, 2);
    assert.deepEqual(Object.keys(request.questions), ['email_001', 'email_002']);
    return {
      answers: {
        email_001: {
          type: 'choice',
          choice: 'BL_COMPARISON',
          probabilities: { BL_COMPARISON: 0.98, GENERAL: 0.02 },
        },
        email_002: {
          type: 'choice',
          choice: 'INVOICE_QUERY',
          probabilities: { INVOICE_QUERY: 0.95, GENERAL: 0.05 },
        },
      },
    };
  };

  const result = await classifyBatch(emails, { evaluator });
  assert.deepEqual(
    result.map(item => [item.email_id, item.category, item.confidence]),
    [
      ['email_001', 'BL_COMPARISON', 0.98],
      ['email_002', 'INVOICE_QUERY', 0.95],
    ],
  );
});

test('classifyEmails batches all records without changing input order', async () => {
  const manyEmails = Array.from({ length: 7 }, (_, index) => ({
    ...emails[0],
    email_id: `email_${String(index + 1).padStart(3, '0')}`,
  }));
  let calls = 0;
  const evaluator = async request => {
    calls += 1;
    return {
      answers: Object.fromEntries(
        Object.keys(request.questions).map(emailId => [
          emailId,
          { type: 'choice', choice: 'BL_COMPARISON' },
        ]),
      ),
    };
  };

  const result = await classifyEmails(manyEmails, {
    evaluator,
    batchSize: 3,
    concurrency: 2,
  });

  assert.equal(calls, 3);
  assert.deepEqual(
    result.map(item => item.email_id),
    manyEmails.map(item => item.email_id),
  );
});

test('classifyBatch rejects categories outside the submission schema', async () => {
  const evaluator = async () => ({
    answers: { email_001: { type: 'choice', choice: 'UNKNOWN' } },
  });

  await assert.rejects(
    classifyBatch([emails[0]], { evaluator }),
    /invalid category for email_001/,
  );
});
