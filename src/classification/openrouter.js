export const OPENROUTER_DECISIONS_URL =
  'https://openrouter.ai/api/alpha/decisions';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 524, 529]);

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Jev is a decisions model, so OpenRouter serves it through the dedicated
 * alpha decisions endpoint rather than chat/completions or responses.
 */
export function createOpenRouterEvaluator({
  apiKey,
  fetchImplementation = globalThis.fetch,
  maxRetries = 3,
}) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required');
  }

  return async function evaluate({ model, state, questions }) {
    const requestBody = { model, state, questions };

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImplementation(OPENROUTER_DECISIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-OpenRouter-Title': 'Monash Hack SDOC Classifier',
          },
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        await wait(500 * 2 ** attempt);
        continue;
      }

      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`OpenRouter returned non-JSON data (HTTP ${response.status})`);
      }

      if (response.ok) {
        if (!body.answers || typeof body.answers !== 'object') {
          throw new Error('OpenRouter response did not contain an answers object');
        }
        return body;
      }

      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        await wait(500 * 2 ** attempt);
        continue;
      }

      const message = body.error?.message ?? body.message ?? response.statusText;
      throw new Error(`OpenRouter Decisions request failed (${response.status}): ${message}`);
    }
  };
}
