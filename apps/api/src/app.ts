import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ClassifyRequestSchema, OperationalDecisionSchema, type ClassifyResult } from '@cargolens/shared';
import { loadDataset } from './dataset.js';
import { ClassificationService, QueueFullError } from './pipeline.js';
import { Store } from './store.js';
import type { GmailAutomation } from './gmail/automation.js';
import { verifyOperationalEvidence } from './gmail/evidence-validation.js';

export type AppOptions = { store: Store; service: ClassificationService; dashboardToken: string; datasetRoot?: string; allowedOrigins?: string[];
  gmail?: Pick<GmailAutomation, 'sync' | 'status' | 'outbox' | 'validateDecision' | 'processDecision' | 'dispatchPending'> };
function tokenMatches(value: string, expected: string): boolean {
  const actual = Buffer.from(value); const wanted = Buffer.from(`Bearer ${expected}`);
  return expected.length > 0 && actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value ?? fallback); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono(); const { store, service } = options;
  const origins = options.allowedOrigins ?? ['http://localhost:5173', 'http://127.0.0.1:5173'];
  let previewBudget = 600; let refillAt = Date.now(); let importing = false;
  app.use('*', cors({ origin: origin => origins.includes(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : undefined,
    allowHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'], allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 }));
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'PAYLOAD_TOO_LARGE' }, 413) }));
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || (c.req.path === '/classify' && c.req.method === 'POST') || c.req.method === 'OPTIONS') return next();
    if (!tokenMatches(c.req.header('Authorization') ?? '', options.dashboardToken)) return c.json({ error: 'UNAUTHORIZED' }, 401);
    await next();
  });
  app.onError((_error, c) => c.json({ error: 'INTERNAL_ERROR' }, 500));
  app.get('/health', c => c.json({ service: 'CargoLens', apiVersion: 1, status: 'ready' }));
  app.post('/classify', async c => {
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: 'JSON_REQUIRED' }, 415);
    const parsed = ClassifyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'INVALID_BATCH', details: parsed.error.flatten() }, 400);
    previewBudget = Math.min(600, previewBudget + (Date.now() - refillAt) / 6000); refillAt = Date.now();
    if (previewBudget < parsed.data.emails.length) return c.json({ error: 'PREVIEW_BUDGET_EXHAUSTED', retryAfterSeconds: 60 }, 429);
    previewBudget -= parsed.data.emails.length;
    const start = performance.now();
    const results: ClassifyResult[] = await Promise.all(parsed.data.emails.map(async source => {
      const email = { id: source.id, subject: source.subject, from: source.from, snippet: source.snippet ?? '', contentScope: 'inbox_snippet' as const, attachments: [] };
      try { return { id: email.id, status: 'classified' as const, classification: await service.classify(email) }; }
      catch (error) { return { id: email.id, status: 'error' as const, error: { code: error instanceof QueueFullError ? 'QUEUE_FULL' : 'CLASSIFICATION_FAILED', message: 'Classification unavailable; retry this row.' } }; }
    }));
    const requestIds = new Set(results.flatMap(result => result.status === 'classified' && !result.classification.cached && result.classification.usageRequestId ? [result.classification.usageRequestId] : []));
    const usage = { input_tokens: 0, output_tokens: 0, requests: 0 };
    for (const id of requestIds) { const request = store.getRequestUsage(id); if (request) { usage.requests++; usage.input_tokens += request.usage.input_tokens; usage.output_tokens += request.usage.output_tokens; } }
    return c.json({ results, elapsedMs: performance.now() - start, usage });
  });
  app.get('/usage', c => c.json({ ...store.usageSummary(), coverage: 'successful_provider_requests' }));
  app.get('/emails', c => {
    const cases = store.listCases(boundedInteger(c.req.query('limit'), 520, 1000), boundedInteger(c.req.query('offset'), 0, 1_000_000));
    return c.json({ emails: cases.map(record => ({ id: record.email.id, subject: record.email.subject, from: record.email.from, status: record.status,
      classification: record.classification ? { ...record.classification, raw: undefined } : null, workflowState: record.decision?.workflowState ?? 'PROCESSING', sourceVersion: record.sourceVersion })), queue: service.stats() });
  });
  app.get('/cases/:id', c => { const record = store.getCase(c.req.param('id')); return record ? c.json(record) : c.json({ error: 'NOT_FOUND' }, 404); });
  app.post('/import', async c => {
    if (!options.datasetRoot) return c.json({ error: 'DATASET_NOT_CONFIGURED' }, 503);
    if (importing) return c.json({ error: 'IMPORT_RUNNING' }, 409);
    importing = true;
    try {
      const emails = await loadDataset(options.datasetRoot);
      for (const email of emails) store.upsertEmail(email);
      const job = `import-${Date.now()}`;
      store.emit('import.started', null, { job, count: emails.length });
      void Promise.all(emails.map(email => service.processCase(email))).then(() => store.emit('import.completed', null, { job, count: emails.length }))
        .catch(() => store.emit('import.failed', null, { job })).finally(() => { importing = false; });
      return c.json({ job, queued: emails.length, events: '/events' }, 202);
    } catch { importing = false; return c.json({ error: 'IMPORT_FAILED' }, 400); }
  });
  app.post('/cases/:id/retry', async c => {
    const record = store.getCase(c.req.param('id'));
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    await service.processCase(record.email); return c.json(store.getCase(record.email.id));
  });
  app.post('/cases/:id/decision', async c => {
    const parsed = OperationalDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'INVALID_DECISION', details: parsed.error.flatten() }, 400);
    const id = c.req.param('id');
    const current = store.getCase(id);
    if (!current || current.sourceVersion !== parsed.data.sourceVersion || parsed.data.decisionVersion <= (current.decision?.decisionVersion ?? 0)) return c.json({ error: 'STALE_OR_MISSING_CASE' }, 409);
    try {
      if (id.startsWith('gmail:')) {
        if (!options.gmail) return c.json({ error: 'GMAIL_NOT_CONFIGURED' }, 503);
        await options.gmail.validateDecision(id, parsed.data);
      } else {
        const claims = parsed.data.verificationState === 'COMPLETE' || parsed.data.fieldResults.some(field => field.outcome === 'MATCH' || field.outcome === 'MISMATCH');
        if (claims && !options.datasetRoot) return c.json({ error: 'EVIDENCE_READER_NOT_CONFIGURED' }, 503);
        if (claims) await verifyOperationalEvidence(current, parsed.data, options.datasetRoot!);
      }
    } catch { return c.json({ saved: false, error: 'SOURCE_EVIDENCE_VALIDATION_FAILED' }, 422); }
    if (!store.saveDecision(id, parsed.data)) return c.json({ error: 'STALE_OR_MISSING_CASE' }, 409);
    if (id.startsWith('gmail:') && options.gmail) {
      try { await options.gmail.processDecision(id); }
      catch { store.emit('outbound.blocked', id, { code: 'REPLY_VALIDATION_FAILED' }); return c.json({ saved: true, outbound: 'blocked', error: 'REPLY_VALIDATION_FAILED' }, 422); }
    }
    return c.json({ saved: true });
  });
  app.get('/gmail/status', c => c.json(options.gmail ? { configured: true, ...options.gmail.status() } : { configured: false, enabled: false }));
  app.get('/gmail/outbox', c => options.gmail ? c.json({ items: options.gmail.outbox() }) : c.json({ error: 'GMAIL_NOT_CONFIGURED' }, 503));
  app.post('/gmail/sync', async c => {
    if (!options.gmail) return c.json({ error: 'GMAIL_NOT_CONFIGURED' }, 503);
    const parsed = z.object({ query: z.string().max(1000).optional(), pageToken: z.string().max(2000).optional(), maxMessages: z.number().int().min(1).max(100).optional() })
      .strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'INVALID_SYNC_REQUEST' }, 400);
    if (options.gmail.status().busy) return c.json({ error: 'GMAIL_BUSY' }, 409);
    const job = `gmail-${Date.now()}`; store.emit('gmail.sync.started', null, { job });
    void options.gmail.sync(parsed.data).then(result => store.emit('gmail.sync.completed', null, { job, ...result })).catch(() => store.emit('gmail.sync.failed', null, { job }));
    return c.json({ job, events: '/events' }, 202);
  });
  app.post('/gmail/dispatch', c => {
    if (!options.gmail) return c.json({ error: 'GMAIL_NOT_CONFIGURED' }, 503);
    if (!options.gmail.status().enabled) return c.json({ error: 'GMAIL_AUTOMATION_DISABLED' }, 409);
    if (options.gmail.status().busy) return c.json({ error: 'GMAIL_BUSY' }, 409);
    void options.gmail.dispatchPending().catch(() => store.emit('gmail.dispatch.failed', null, {}));
    return c.json({ queued: true }, 202);
  });
  app.get('/events', c => streamSSE(c, async stream => {
    let cursor = boundedInteger(c.req.header('Last-Event-ID') ?? c.req.query('after'), 0, Number.MAX_SAFE_INTEGER);
    let open = true; stream.onAbort(() => { open = false; });
    while (open) {
      const events = store.eventsAfter(cursor);
      for (const event of events) {
        if (!open) break;
        await stream.writeSSE({ id: String(event.sequence), event: event.type, data: JSON.stringify(event) }); cursor = event.sequence;
      }
      if (events.length === 0) { await stream.writeSSE({ event: 'heartbeat', data: '{}' }); await stream.sleep(1000); }
    }
  }));
  return app;
}
