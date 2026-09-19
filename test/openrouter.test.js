import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOpenRouterEvaluator,
  OPENROUTER_DECISIONS_URL,
} from '../src/classification/openrouter.js';

test('OpenRouter evaluator calls the dedicated decisions endpoint', async () => {
  const fetchImplementation = async (url, request) => {
    assert.equal(url, OPENROUTER_DECISIONS_URL);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'typesafe/jev-1.13');
    assert.deepEqual(body.state, { subject: 'Draft BL' });
    return new Response(
      JSON.stringify({
        answers: {
          category: { type: 'choice', choice: 'BL_COMPARISON' },
        },
      }),
      { status: 200 },
    );
  };

  const evaluator = createOpenRouterEvaluator({
    apiKey: 'test-key',
    fetchImplementation,
  });
  const result = await evaluator({
    model: 'typesafe/jev-1.13',
    state: { subject: 'Draft BL' },
    questions: { category: { type: 'choice', criteria: {} } },
  });

  assert.equal(result.answers.category.choice, 'BL_COMPARISON');
});

test('OpenRouter evaluator reports API errors without exposing the key', async () => {
  const evaluator = createOpenRouterEvaluator({
    apiKey: 'do-not-leak',
    maxRetries: 0,
    fetchImplementation: async () =>
      new Response(JSON.stringify({ error: { message: 'Bad request' } }), {
        status: 400,
      }),
  });

  await assert.rejects(
    evaluator({ model: 'bad', state: {}, questions: {} }),
    error =>
      error.message.includes('Bad request') &&
      !error.message.includes('do-not-leak'),
  );
});
