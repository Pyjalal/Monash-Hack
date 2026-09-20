import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { TextRecovery } from './text-recovery.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
const input = { caseId: 'c1', sourceVersion: 'v1', attachmentId: 'si', sha256: 'a'.repeat(64), unresolvedFields: ['shipper' as const], regions: [{ locator: 'line:1', text: 'Shipper: Acme Trading' }] };
const catalog = { data: [{ id: 'google/gemini-2.5-flash-lite', pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['response_format'] }] };
function setup(candidates: unknown = [{ field: 'shipper', value: 'Acme Trading', locator: 'line:1' }]) {
  const store = new Store(':memory:'); stores.push(store);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/models') ? Response.json(catalog) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidates }) } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.000018 } }));
  return { store, fetcher, recovery: new TextRecovery({ store, apiKey: 'secret', fetch: fetcher }) };
}
describe('bounded OpenRouter text recovery', () => {
  it('returns source-bound proposals, sends only selected regions, and logs usage', async () => {
    const { store, fetcher, recovery } = setup();
    const result = await recovery.recover(input);
    expect(result.candidates[0].source).toEqual({ attachmentId: 'si', sha256: input.sha256, locator: 'line:1', text: 'Acme Trading' });
    expect(result.requiresSemanticValidation).toBe(true);
    const body = JSON.parse(String(fetcher.mock.calls[1][1]!.body));
    expect(body.messages[1].content).not.toContain('c1'); expect(body.provider.max_price).toEqual({ prompt: 0.1, completion: 0.4 });
    expect(store.eventsAfter(0)[0].data).not.toHaveProperty('apiKey');
    expect(store.getCase('c1')).toBeNull();
  });
  it.each([
    [{ field: 'shipper', value: 'Invented company', locator: 'line:1' }],
    [{ field: 'consignee', value: 'Acme Trading', locator: 'line:1' }],
    [{ field: 'shipper', value: 'Acme Trading', locator: 'line:2' }],
  ])('rejects unsupported candidates %j', async candidate => {
    const { recovery } = setup([candidate]); await expect(recovery.recover(input)).rejects.toThrow('UNSUPPORTED_RECOVERY_CANDIDATE');
  });
  it('does not reset budgets across instances or source changes and atomically bounds concurrent requests', async () => {
    const { store, fetcher } = setup();
    const provider = () => new TextRecovery({ store, apiKey: 'secret', fetch: fetcher, maxCaseAttempts: 1 });
    const results = await Promise.allSettled([provider().recover(input), provider().recover(input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(provider().recover({ ...input, sourceVersion: 'v2' })).rejects.toThrow('RECOVERY_BUDGET_EXHAUSTED');
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/completions'))).toHaveLength(1);
  });
  it('charges failed retries and stops when the case budget is exhausted', async () => {
    const { store } = setup();
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/models') ? Response.json(catalog) : new Response('', { status: 503 }));
    const provider = new TextRecovery({ store, apiKey: 'secret', fetch: fetcher, maxCaseAttempts: 1 });
    await expect(provider.recover(input)).rejects.toThrow('RECOVERY_BUDGET_EXHAUSTED');
    expect(store.eventsAfter(0)).toHaveLength(1);
  });
  it('returns explicit configuration/model errors without fabricated candidates', async () => {
    const { store, fetcher } = setup();
    await expect(new TextRecovery({ store, fetch: fetcher }).recover(input)).rejects.toThrow('OPENROUTER_NOT_CONFIGURED');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(new TextRecovery({ store, apiKey: 'secret', model: 'missing', fetch: fetcher }).recover(input)).rejects.toThrow('MODEL_UNAVAILABLE');
    expect(store.eventsAfter(0)).toHaveLength(0);
  });
  it('rejects invalid limits and token/spend ceilings before a completion request', async () => {
    const { store, fetcher } = setup();
    expect(() => new TextRecovery({ store, maxCaseUsd: NaN })).toThrow();
    for (const limits of [{ maxCaseTokens: 1 }, { maxCaseUsd: 0.000000001 }])
      await expect(new TextRecovery({ store, apiKey: 'secret', fetch: fetcher, ...limits }).recover(input)).rejects.toThrow('RECOVERY_BUDGET_EXHAUSTED');
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/models'))).toBe(true);
  });
});

it('checks only the selected model and ignores prices for modalities absent from the text request', async () => {
  const { store, fetcher } = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (...args) => String(args[0]).endsWith('/models') ? Response.json({ data: [
    { id: 'unrelated-model', pricing: { overrides: [{ prompt: 'expensive' }] } },
    { ...catalog.data[0], pricing: { ...catalog.data[0].pricing, image: '0.01', audio: '0.02', web_search: '0.014', input_cache_read: '0.00000001', internal_reasoning: '0.0000004' } },
  ] }) : original(...args));
  expect((await new TextRecovery({ store, apiKey: 'secret', fetch: fetcher }).recover(input)).candidates).toHaveLength(1);
  const body = JSON.parse(String(fetcher.mock.calls[1][1]!.body));
  expect(body.tools).toBeUndefined(); expect(body.plugins).toBeUndefined();
  expect(body.messages.every((message: { content: unknown }) => typeof message.content === 'string')).toBe(true);
});

it.each(['request', 'input_cache_write', 'internal_reasoning'])('rejects unbudgeted %s charges', async key => {
  const { store, fetcher } = setup();
  fetcher.mockResolvedValue(Response.json({ data: [{ ...catalog.data[0], pricing: { ...catalog.data[0].pricing, [key]: '1' } }] }));
  await expect(new TextRecovery({ store, apiKey: 'secret', fetch: fetcher }).recover(input)).rejects.toThrow('MODEL_EXCEEDS_PRICE_LIMIT');
});
