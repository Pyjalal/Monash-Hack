import { randomUUID } from 'node:crypto';
import type { Classification, Email } from '@cargolens/shared';
import { buildClassificationState } from '@cargolens/shared/questions';
import { InvalidJevResponseError, type Classifier } from './ai/classify.js';
import type { BatchClassificationResult } from './ai/jev-batch.js';
import { hash, Store, type RequestUsage } from './store.js';
import { compareDocuments } from './documents/comparison.js';

export class QueueFullError extends Error { constructor() { super('Classification queue is full'); this.name = 'QueueFullError'; } }

type BatchClassifier = (emails: Email[]) => Promise<BatchClassificationResult>;
interface Work {
  email: Email;
  resolve: (result: Classification) => void;
  reject: (error: unknown) => void;
}
interface ServiceOptions {
  store: Store;
  classifier: Classifier;
  batchClassifier?: BatchClassifier;
  configurationKey: string;
  concurrency?: number;
  requestsPerMinute?: number;
  maxQueue?: number;
  batchSize?: number;
  flushMs?: number;
}

export class ClassificationService {
  private readonly pending = new Map<string, Promise<Classification>>();
  private readonly waiting: Work[] = [];
  private active = 0;
  private nextStart = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly concurrency: number;
  private readonly requestsPerMinute: number;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private documentsActive = 0;
  private readonly documentWaiters: (() => void)[] = [];

  constructor(private readonly options: ServiceOptions) {
    const defaultConcurrency = options.batchClassifier ? 8 : 24;
    if (![options.concurrency ?? defaultConcurrency, options.requestsPerMinute ?? 1100, options.maxQueue ?? 600].every(value => Number.isSafeInteger(value) && value > 0))
      throw new RangeError('Scheduler limits must be positive finite integers');
    if (options.batchSize !== undefined && (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 8))
      throw new RangeError('batchSize must be an integer from 1 to 8');
    if (options.flushMs !== undefined && (!Number.isFinite(options.flushMs) || options.flushMs < 0 || options.flushMs > 1000))
      throw new RangeError('flushMs must be between 0 and 1000');
    this.concurrency = Math.min(64, options.concurrency ?? defaultConcurrency);
    this.requestsPerMinute = Math.min(1200, options.requestsPerMinute ?? 1100);
    this.batchSize = options.batchClassifier ? options.batchSize ?? 8 : 1;
    this.flushMs = options.flushMs ?? 8;
  }

  private cacheConfiguration() {
    return { config: this.options.configurationKey,
      packing: this.options.batchClassifier ? { policy: 'packed-v1', size: this.batchSize } : 'individual' };
  }

  get configurationRevision(): string { return hash(this.cacheConfiguration()); }

  async classify(email: Email): Promise<Classification> {
    const key = hash({ ...this.cacheConfiguration(), state: buildClassificationState(email) });
    const cached = this.options.store.getCached(key);
    if (cached) return { ...cached, id: email.id, cached: true, elapsedMs: 0, usage: null };
    const existing = this.pending.get(key);
    if (existing) return { ...await existing, id: email.id, usage: null };
    if (this.pending.size >= (this.options.maxQueue ?? 600)) throw new QueueFullError();
    const work = new Promise<Classification>((resolve, reject) => this.waiting.push({ email, resolve, reject }));
    const promise = work.then(result => { this.options.store.cache(key, result); return result; }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    this.pump(false);
    return promise;
  }

  private pump(flushPartial: boolean): void {
    while (this.active < this.concurrency && this.waiting.length && (flushPartial || this.waiting.length >= this.batchSize)) {
      const batch: Work[] = [];
      const ids = new Set<string>();
      for (let index = 0; index < this.waiting.length && batch.length < this.batchSize;) {
        const work = this.waiting[index];
        if (ids.has(work.email.id)) { index++; continue; }
        ids.add(work.email.id);
        batch.push(...this.waiting.splice(index, 1));
      }
      this.active++;
      void this.dispatch(batch).finally(() => { this.active--; this.pump(true); });
    }
    if (!this.waiting.length && this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.waiting.length && !this.flushTimer && this.active < this.concurrency)
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.pump(true); }, this.flushMs);
  }

  private async pace(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextStart - now);
    this.nextStart = Math.max(now, this.nextStart) + 60000 / this.requestsPerMinute;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  }

  private recordRequest(request: RequestUsage, questionVersion: string): void {
    this.options.store.recordUsage(request);
    this.options.store.emit('ai.request', null, { ...request, questionVersion, requests: 1 });
  }

  private async individual(email: Email): Promise<Classification> {
    await this.pace();
    const result = await this.options.classifier(email);
    if (!result.usage || result.id !== email.id) throw new InvalidJevResponseError('individual.usage_or_id');
    const requestId = randomUUID();
    this.recordRequest({ requestId, model: result.model, usage: result.usage, elapsedMs: result.elapsedMs, emailCount: 1 }, result.questionVersion);
    return { ...result, usageRequestId: requestId };
  }

  private async dispatch(batch: Work[]): Promise<void> {
    try {
      if (!this.options.batchClassifier) { batch[0].resolve(await this.individual(batch[0].email)); return; }
      await this.pace();
      let result: BatchClassificationResult;
      try { result = await this.options.batchClassifier(batch.map(work => work.email)); }
      catch (error) {
        if (!(error instanceof RangeError) || error.message !== 'Packed request exceeds conservative context budget; split into smaller batches') throw error;
        for (const work of batch) {
          try { work.resolve(await this.individual(work.email)); }
          catch (failure) { work.reject(failure); }
        }
        return;
      }
      const mapped = new Map(result.classifications.map(row => [row.id, row]));
      if (result.classifications.length !== batch.length || mapped.size !== batch.length || batch.some(work => !mapped.has(work.email.id)))
        throw new InvalidJevResponseError('packed.ids');
      const requestId = randomUUID();
      this.recordRequest({ requestId, model: result.model, usage: result.usage, elapsedMs: result.elapsedMs, emailCount: batch.length }, result.questionVersion);
      for (const work of batch) work.resolve({ ...mapped.get(work.email.id)!, usage: null, usageRequestId: requestId });
    } catch (error) { for (const work of batch) work.reject(error); }
  }

  async processCase(email: Email, attachmentRoot?: string): Promise<void> {
    const record = this.options.store.upsertEmail(email);
    const revision = record.classification && `${record.classification.model}:${record.classification.questionVersion}`;
    if (!revision || !(this.options.configurationKey === revision || this.options.configurationKey.startsWith(`${revision}:`))) {
      try { this.options.store.saveClassification(email.id, record.sourceVersion, await this.classify(email)); }
      catch (error) { this.options.store.markFailed(email.id, record.sourceVersion, error instanceof QueueFullError ? 'QUEUE_FULL' : 'CLASSIFICATION_FAILED'); return; }
    }
    if (!attachmentRoot) return;
    // Bound document parsing independently of the fast classification queue.
    if (this.documentsActive >= 2) await new Promise<void>(resolve => this.documentWaiters.push(resolve));
    else this.documentsActive++;
    try {
      const current = this.options.store.getCase(email.id);
      const decision = current?.decision;
      if (!current || current.sourceVersion !== record.sourceVersion || !decision || decision.decisionVersion !== 1 ||
        decision.category !== 'BL_COMPARISON' || decision.requestedAction !== 'VERIFY_DOCUMENTS' || decision.documentExpectation !== 'EXPECTED_NOW' || decision.blockers.length) return;
      const inlineBodyAvailable = current.classification?.bodyDocument === 'HAS_SI_BL_CONTENT'
        && (current.classification.bodyDocumentConfidence ?? 0) >= 0.8;
      if (!current.email.attachments.length && !inlineBodyAvailable) {
        this.options.store.saveDecision(email.id, { ...decision, decisionVersion: 2, verificationState: 'BLOCKED', workflowState: 'AWAITING_DOCUMENTS',
          blockers: ['MISSING_ATTACHMENT'], nextAction: 'REQUEST_DOCUMENTS' });
        return;
      }
      try {
        const comparison = await compareDocuments(current, attachmentRoot);
        this.options.store.saveDocumentComparison(email.id, comparison.decision, comparison.evidence);
      } catch {
        this.options.store.saveDecision(email.id, { ...decision, decisionVersion: 2, verificationState: 'FAILED', workflowState: 'FAILED',
          blockers: ['COMPARISON_FAILED'], nextAction: 'WAIT' });
        this.options.store.emit('comparison.failed', email.id, { sourceVersion: record.sourceVersion, code: 'COMPARISON_FAILED' });
      }
    } finally {
      const next = this.documentWaiters.shift();
      if (next) next(); else this.documentsActive--;
    }
  }

  stats(): { active: number; queued: number; inFlight: number } { return { active: this.active, queued: this.waiting.length, inFlight: this.pending.size }; }
}
