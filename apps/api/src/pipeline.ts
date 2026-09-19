import type { Classification, Email } from '@cargolens/shared';
import { buildClassificationState } from '@cargolens/shared/questions';
import type { Classifier } from './ai/classify.js';
import { hash, Store } from './store.js';

export class QueueFullError extends Error { constructor() { super('Classification queue is full'); this.name = 'QueueFullError'; } }
export class ClassificationService {
  private readonly pending = new Map<string, Promise<Classification>>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  private nextStart = 0;
  private readonly concurrency: number;
  private readonly requestsPerMinute: number;
  constructor(private readonly options: { store: Store; classifier: Classifier; configurationKey: string; concurrency?: number; requestsPerMinute?: number; maxQueue?: number }) {
    if (![options.concurrency ?? 24, options.requestsPerMinute ?? 1100, options.maxQueue ?? 600].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Scheduler limits must be positive finite numbers');
    this.concurrency = Math.max(1, Math.min(64, options.concurrency ?? 24));
    this.requestsPerMinute = Math.max(1, Math.min(1200, options.requestsPerMinute ?? 1100));
  }
  async classify(email: Email): Promise<Classification> {
    const key = hash({ config: this.options.configurationKey, state: buildClassificationState(email) });
    const cached = this.options.store.getCached(key);
    if (cached) return { ...cached, id: email.id, cached: true, elapsedMs: 0 };
    const existing = this.pending.get(key);
    if (existing) return { ...await existing, id: email.id };
    if (this.pending.size >= (this.options.maxQueue ?? 600)) throw new QueueFullError();
    const promise = this.run(email).then(result => { this.options.store.cache(key, result); return result; }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  private async run(email: Email): Promise<Classification> {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      const now = Date.now(); const wait = Math.max(0, this.nextStart - now);
      this.nextStart = Math.max(now, this.nextStart) + 60000 / this.requestsPerMinute;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      return await this.options.classifier(email);
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
  async processCase(email: Email): Promise<void> {
    const record = this.options.store.upsertEmail(email);
    if (record.classification && `${record.classification.model}:${record.classification.questionVersion}` === this.options.configurationKey) return;
    try { this.options.store.saveClassification(email.id, record.sourceVersion, await this.classify(email)); }
    catch (error) { this.options.store.markFailed(email.id, record.sourceVersion, error instanceof QueueFullError ? 'QUEUE_FULL' : 'CLASSIFICATION_FAILED'); }
  }
  stats(): { active: number; queued: number; inFlight: number } { return { active: this.active, queued: this.waiting.length, inFlight: this.pending.size }; }
}
