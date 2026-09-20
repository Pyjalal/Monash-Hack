import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ClassifyRequestSchema, FieldNameSchema, OperationalDecisionSchema, type ClassifyResult } from '@cargolens/shared';
import { RulesRequestSchema } from '@cargolens/shared/rules';
import type { RuleService } from './ai/rules.js';
import { loadDataset } from './dataset.js';
import { ClassificationService, QueueFullError } from './pipeline.js';
import { Store } from './store.js';
import type { GmailAutomation } from './gmail/automation.js';
import { verifyOperationalEvidence } from './gmail/evidence-validation.js';
import { GmailAuthorizationError, type GmailAuthorization } from './gmail/oauth.js';
import type { GmailPoller } from './gmail/polling.js';
import { draftCase, DraftError } from './drafts.js';
import { RecoveryError, type TextRecovery } from './ai/text-recovery.js';
import { readAttachment } from './documents/index.js';
import { compareDocuments } from './documents/comparison.js';
import { dashboardReports } from './dashboard.js';

export type AppOptions = { store: Store; service: ClassificationService; dashboardToken: string; datasetRoot?: string; allowedOrigins?: string[];
  dataMode?: 'operational' | 'synthetic';
  documentationContact?: string;
  textRecovery?: TextRecovery; gmailAttachmentRoot?: string;
  rules?: RuleService; gmailAuthorization?: GmailAuthorization; gmailPoller?: GmailPoller;
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
  const reports = dashboardReports(store);
  const origins = options.allowedOrigins ?? ['http://localhost:5173', 'http://127.0.0.1:5173'];
  let previewBudget = 600; let refillAt = Date.now(); let importing = false;
  app.use('*', cors({ origin: origin => origins.includes(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : undefined,
    allowHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'], allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 }));
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'PAYLOAD_TOO_LARGE' }, 413) }));
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' && ['/gmail/oauth/callback', '/gmail/connection-result'].includes(c.req.path)) return next();
    if (c.req.path === '/health' || (['/classify', '/rules/evaluate'].includes(c.req.path) && c.req.method === 'POST') || c.req.method === 'OPTIONS') return next();
    if (!tokenMatches(c.req.header('Authorization') ?? '', options.dashboardToken)) return c.json({ error: 'UNAUTHORIZED' }, 401);
    await next();
  });
  app.onError((_error, c) => c.json({ error: 'INTERNAL_ERROR' }, 500));
  app.get('/health', c => c.json({ service: 'CargoLens', apiVersion: 1, status: 'ready', classifierRevision: service.configurationRevision }, 200, { 'Cache-Control': 'no-store' }));
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
  app.post('/rules/evaluate', async c => {
    if (!options.rules) return c.json({ error: 'RULES_NOT_CONFIGURED' }, 503);
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: 'JSON_REQUIRED' }, 415);
    const parsed = RulesRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'INVALID_RULES_BATCH', details: parsed.error.flatten() }, 400);
    previewBudget = Math.min(600, previewBudget + (Date.now() - refillAt) / 6000); refillAt = Date.now();
    if (previewBudget < parsed.data.emails.length) return c.json({ error: 'PREVIEW_BUDGET_EXHAUSTED', retryAfterSeconds: 60 }, 429);
    previewBudget -= parsed.data.emails.length;
    const start = performance.now();
    const emails = parsed.data.emails.map(source => ({ ...source, snippet: source.snippet ?? '', contentScope: 'inbox_snippet' as const, attachments: [] }));
    const results = await options.rules.evaluate(emails, parsed.data.rules);
    return c.json({ results, elapsedMs: performance.now() - start, rulesVersion: options.rules.rulesVersion });
  });
  app.get('/usage', c => c.json({ ...store.usageSummary(), coverage: 'successful_provider_requests' }));
  app.get('/dashboard', c => c.json({ ...reports.snapshot(), mode: options.dataMode ?? 'operational' }));
  app.get('/runs/:id', c => {
    const report = reports.all().find(row => row.id === c.req.param('id'));
    return report ? c.json(report) : c.json({ error: 'NOT_FOUND' }, 404);
  });
  app.get('/cases/:id/activity', c => {
    if (!store.getCase(c.req.param('id'))) return c.json({ error: 'NOT_FOUND' }, 404);
    const events = store.db.prepare('SELECT sequence,type,at,data_json FROM events WHERE case_id=? ORDER BY sequence DESC LIMIT 100').all(c.req.param('id')) as { sequence: number; type: string; at: string; data_json: string }[];
    return c.json({ events: events.map(row => ({ sequence: row.sequence, type: row.type, at: row.at, data: JSON.parse(row.data_json) })) });
  });
  app.get('/cases/:id/sources', async c => {
    const record = store.getCase(c.req.param('id')); if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    const root = record.email.id.startsWith('gmail:') ? options.gmailAttachmentRoot : options.datasetRoot;
    if (!root) return c.json({ error: 'EVIDENCE_READER_NOT_CONFIGURED' }, 503);
    const sources = [];
    for (const attachment of record.email.attachments) {
      if (!attachment.relativePath) continue;
      const reading = await readAttachment({ root, relativePath: attachment.relativePath, mimeType: attachment.mimeType });
      sources.push({ id: attachment.id, name: attachment.name ?? attachment.id, ...reading,
        hashMatches: !attachment.sha256 || attachment.sha256 === reading.sha256 });
    }
    if (store.getCase(record.email.id)?.sourceVersion !== record.sourceVersion) return c.json({ error: 'STALE_DECISION' }, 409);
    return c.json({ sourceVersion: record.sourceVersion, sources });
  });
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
      const run = reports.begin(emails.map(email => email.id), service.configurationRevision, options.dataMode);
      store.emit('import.started', null, { job, count: emails.length });
      void Promise.all(emails.map(email => service.processCase(email, options.datasetRoot))).then(() => { run.finish(); store.emit('import.completed', null, { job, count: emails.length, runId: run.id }); })
        .catch(() => { run.finish(true); store.emit('import.failed', null, { job }); }).finally(() => { importing = false; });
      return c.json({ job, queued: emails.length, events: '/events' }, 202);
    } catch { importing = false; return c.json({ error: 'IMPORT_FAILED' }, 400); }
  });
  app.post('/cases/:id/retry', async c => {
    const record = store.getCase(c.req.param('id'));
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    await service.processCase(record.email, record.email.id.startsWith('gmail:') ? undefined : options.datasetRoot); return c.json(store.getCase(record.email.id));
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
  app.get('/cases/:id/comparison', c => {
    const evidence = store.getDocumentComparison(c.req.param('id'));
    return evidence ? c.json(evidence) : c.json({ error: 'NOT_FOUND' }, 404);
  });
  app.post('/cases/:id/compare', async c => {
    const parsed = z.object({ sourceVersion: z.string().min(1), decisionVersion: z.number().int().positive() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'INVALID_COMPARISON_REQUEST' }, 400);
    const record = store.getCase(c.req.param('id'));
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    const prior = record.decision;
    if (!prior || record.sourceVersion !== parsed.data.sourceVersion || prior.decisionVersion !== parsed.data.decisionVersion) return c.json({ error: 'STALE_DECISION' }, 409);
    if (prior.category !== 'BL_COMPARISON' || prior.requestedAction !== 'VERIFY_DOCUMENTS' || prior.documentExpectation !== 'EXPECTED_NOW'
      || prior.blockers.some(code => ['THREAD_CONTEXT_REQUIRED', 'UNCERTAIN_INTENT', 'LOW_CATEGORY_CONFIDENCE', 'CATEGORY_EXPECTATION_CONFLICT'].includes(code))) return c.json({ error: 'COMPARISON_INTENT_UNVERIFIED' }, 422);
    const root = record.email.id.startsWith('gmail:') ? options.gmailAttachmentRoot : options.datasetRoot;
    if (!root) return c.json({ error: 'EVIDENCE_READER_NOT_CONFIGURED' }, 503);
    const comparison = await compareDocuments(record, root);
    if (record.email.id.startsWith('gmail:')) {
      if (!options.gmail) return c.json({ error: 'GMAIL_NOT_CONFIGURED' }, 503);
      try { await options.gmail.validateDecision(record.email.id, comparison.decision); }
      catch { return c.json({ error: 'SOURCE_EVIDENCE_VALIDATION_FAILED' }, 422); }
    }
    if (!store.saveDocumentComparison(record.email.id, comparison.decision, comparison.evidence)) return c.json({ error: 'STALE_DECISION' }, 409);
    if (record.email.id.startsWith('gmail:') && options.gmail) {
      try { await options.gmail.processDecision(record.email.id); }
      catch { return c.json({ saved: true, outbound: 'blocked', error: 'REPLY_VALIDATION_FAILED' }, 422); }
    }
    return c.json({ saved: true, decision: comparison.decision });
  });
  app.post('/cases/:id/draft', async c => {
    const parsed = z.object({ sourceVersion: z.string().min(1), decisionVersion: z.number().int().positive() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'INVALID_DRAFT_REQUEST' }, 400);
    try {
      const draft = await draftCase(store, c.req.param('id'), parsed.data, async (record, decision) => {
        if (record.email.id.startsWith('gmail:')) {
          if (!options.gmail) throw new DraftError('EVIDENCE_READER_NOT_CONFIGURED');
          await options.gmail.validateDecision(record.email.id, decision);
        } else {
          if (!options.datasetRoot) throw new DraftError('EVIDENCE_READER_NOT_CONFIGURED');
          await verifyOperationalEvidence(record, decision, options.datasetRoot);
        }
      }, options.documentationContact);
      return c.json({ draft });
    } catch (error) {
      const code = error instanceof DraftError ? error.code : 'SOURCE_EVIDENCE_VALIDATION_FAILED';
      return c.json({ error: code }, code === 'NOT_FOUND' ? 404 : code === 'STALE_DECISION' ? 409 : code === 'EVIDENCE_READER_NOT_CONFIGURED' ? 503 : 422);
    }
  });
  app.post('/cases/:id/recover', async c => {
    const parsed = z.object({ sourceVersion: z.string().min(1), decisionVersion: z.number().int().positive(), attachmentId: z.string().min(1),
      fields: z.array(FieldNameSchema).min(1).max(7), locators: z.array(z.string().min(1)).min(1).max(8) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'INVALID_RECOVERY_REQUEST' }, 400);
    const record = store.getCase(c.req.param('id'));
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (!record.decision || record.sourceVersion !== parsed.data.sourceVersion || record.decision.decisionVersion !== parsed.data.decisionVersion) return c.json({ error: 'STALE_DECISION' }, 409);
    if (record.decision.verificationState === 'COMPLETE' || parsed.data.fields.some(field => record.decision!.fieldResults.some(row => row.field === field && ['MATCH', 'MISMATCH'].includes(row.outcome)))) return c.json({ error: 'ONLY_UNRESOLVED_FIELDS' }, 422);
    const root = record.email.id.startsWith('gmail:') ? options.gmailAttachmentRoot : options.datasetRoot;
    const attachment = record.email.attachments.find(row => row.id === parsed.data.attachmentId);
    if (!root || !options.textRecovery) return c.json({ error: 'RECOVERY_NOT_CONFIGURED' }, 503);
    if (!attachment?.relativePath) return c.json({ error: 'ATTACHMENT_NOT_FOUND' }, 404);
    const reading = await readAttachment({ root, relativePath: attachment.relativePath, mimeType: attachment.mimeType });
    if (reading.status !== 'READABLE' || attachment.sha256 && attachment.sha256 !== reading.sha256) return c.json({ error: 'SOURCE_NOT_READABLE' }, 422);
    const regions = reading.spans.map(span => ({ locator: span.kind === 'line' ? `line:${span.line}` : span.kind === 'page' ? `page:${span.page}` : `cell:${span.sheet}!${span.cell}`, text: span.text }))
      .filter(region => parsed.data.locators.includes(region.locator));
    if (regions.length !== parsed.data.locators.length) return c.json({ error: 'INVALID_SOURCE_REGIONS' }, 422);
    try {
      const recovery = await options.textRecovery.recover({ caseId: record.email.id, sourceVersion: record.sourceVersion, attachmentId: attachment.id, sha256: reading.sha256, unresolvedFields: parsed.data.fields, regions });
      const current = store.getCase(record.email.id);
      if (current?.sourceVersion !== record.sourceVersion || current.decision?.decisionVersion !== parsed.data.decisionVersion) return c.json({ error: 'STALE_DECISION' }, 409);
      const latestReading = await readAttachment({ root, relativePath: attachment.relativePath, mimeType: attachment.mimeType });
      if (latestReading.status !== 'READABLE' || latestReading.sha256 !== reading.sha256) return c.json({ error: 'SOURCE_EVIDENCE_CHANGED' }, 409);
      return c.json({ recovery });
    } catch (error) {
      const code = error instanceof RecoveryError ? error.code : 'RECOVERY_FAILED';
      return c.json({ error: code }, ['RECOVERY_BUDGET_EXHAUSTED', 'RECOVERY_BUSY'].includes(code) ? 429 : code === 'OPENROUTER_NOT_CONFIGURED' ? 503 : 422);
    }
  });
  app.post('/gmail/oauth/start', c => {
    if (!options.gmailAuthorization) return c.json({ error: 'GMAIL_OAUTH_NOT_CONFIGURED' }, 503);
    c.header('Cache-Control', 'no-store');
    return c.json(options.gmailAuthorization.begin());
  });
  app.get('/gmail/oauth/callback', async c => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    if (!options.gmailAuthorization) return c.text('Gmail OAuth is not configured.', 503);
    try {
      await options.gmailAuthorization.complete({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error') });
      return c.redirect('/gmail/connection-result?status=connected', 303);
    } catch (error) {
      const code = error instanceof GmailAuthorizationError ? error.code : 'OAUTH_CONNECTION_FAILED';
      return c.redirect(`/gmail/connection-result?status=${encodeURIComponent(code)}`, 303);
    }
  });
  app.get('/gmail/connection-result', c => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    return c.text(c.req.query('status') === 'connected'
      ? 'CargoLens Gmail connected. You can close this tab. Ingestion uses server-held authorization; sending remains controlled by GMAIL_AUTOMATION_ENABLED.'
      : 'CargoLens Gmail connection was not completed. Check the local connector status and restart authorization.');
  });
  app.post('/gmail/disconnect', async c => {
    if (!options.gmailAuthorization) return c.json({ error: 'GMAIL_OAUTH_NOT_CONFIGURED' }, 503);
    try { await options.gmailAuthorization.disconnect(); return c.json({ authorization: 'disconnected' }); }
    catch { return c.json({ authorization: 'disconnected', error: 'REMOTE_REVOCATION_UNCONFIRMED' }, 502); }
  });
  app.get('/gmail/status', c => c.json({ ...(options.gmail ? { configured: true, ...options.gmail.status() } : { configured: false, enabled: false }),
    ...(options.gmailAuthorization?.status() ?? {}), ...(options.gmailPoller?.status() ?? {}) }));
  app.get('/gmail/outbox', c => options.gmail ? c.json({ items: options.gmail.outbox() }) : c.json({ error: 'GMAIL_NOT_CONFIGURED' }, 503));
  app.post('/gmail/sync', async c => {
    if (!options.gmail) return c.json({ error: 'GMAIL_NOT_CONFIGURED' }, 503);
    if (options.gmailAuthorization && options.gmailAuthorization.status().authorization !== 'connected') return c.json({ error: 'GMAIL_AUTHORIZATION_REQUIRED', ...options.gmailAuthorization.status() }, 409);
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
