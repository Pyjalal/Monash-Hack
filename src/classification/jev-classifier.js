import { CATEGORY_CRITERIA, isCategory } from './categories.js';

export const DEFAULT_MODEL = 'typesafe/jev-1.13';

function emailState(email) {
  return {
    email_id: email.email_id,
    from: email.from,
    subject: email.subject,
    body: email.body,
    attachments: email.attachments ?? [],
    attachment_count: email.attachments?.length ?? 0,
  };
}

function makeQuestion(emailId) {
  return {
    type: 'choice',
    instructions: {
      task: `Classify the email whose email_id is ${emailId}.`,
      guidance:
        'Use the message intent from its subject, body, sender, and attachment metadata. Choose exactly one category. Ignore quoted-thread boilerplate when it conflicts with the current message intent.',
    },
    criteria: CATEGORY_CRITERIA,
  };
}

/**
 * Classify one batch with a single Jev request. Jev supports multiple typed
 * questions against shared state, so every email gets its own choice answer.
 * The evaluator parameter makes this function testable without a network key.
 */
export async function classifyBatch(
  emails,
  { model = DEFAULT_MODEL, evaluator } = {},
) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return [];
  }
  if (typeof evaluator !== 'function') {
    throw new Error('A Jev evaluator function is required');
  }

  const questions = Object.fromEntries(
    emails.map(email => [email.email_id, makeQuestion(email.email_id)]),
  );

  const result = await evaluator({
    model,
    state: emails.map(emailState),
    questions,
  });

  return emails.map(email => {
    const answer = result.answers[email.email_id];
    if (!answer || answer.type !== 'choice' || !isCategory(answer.choice)) {
      throw new Error(`Jev returned an invalid category for ${email.email_id}`);
    }

    return {
      email_id: email.email_id,
      category: answer.choice,
      confidence: answer.probabilities?.[answer.choice] ?? null,
      probabilities: answer.probabilities ?? null,
    };
  });
}

export async function classifyEmails(
  emails,
  {
    model = DEFAULT_MODEL,
    evaluator,
    batchSize = 20,
    concurrency = 3,
    onBatchComplete = () => {},
  } = {},
) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }

  const batches = [];
  for (let i = 0; i < emails.length; i += batchSize) {
    batches.push(emails.slice(i, i + batchSize));
  }

  const predictions = new Map();
  let nextBatch = 0;

  async function worker() {
    while (true) {
      const batchIndex = nextBatch++;
      if (batchIndex >= batches.length) return;

      const batchPredictions = await classifyBatch(batches[batchIndex], {
        model,
        evaluator,
      });
      for (const prediction of batchPredictions) {
        predictions.set(prediction.email_id, prediction);
      }
      onBatchComplete({
        batchIndex,
        batchCount: batches.length,
        processed: predictions.size,
        total: emails.length,
        predictions: batchPredictions,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()),
  );

  return emails.map(email => predictions.get(email.email_id));
}
