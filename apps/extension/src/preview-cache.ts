import type { ClassificationPreview, RowClassifyResult } from "./messages.js";
import { isClassifyResult } from "./messages.js";
import { sha256Hex } from "./fingerprints.js";

export const PREVIEW_CACHE_STORAGE_KEY = "cargolensPreviewCache";
export const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
export const PREVIEW_CACHE_MAX_ENTRIES = 200;

export interface SessionStorageArea {
  get(keys?: Record<string, unknown>): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface StoredCacheEntry {
  key: string;
  expiresAt: number;
  result: RowClassifyResult;
}

const categoryProbabilityKeys = new Set(["BL_COMPARISON", "SI_REQUEST", "INVOICE_QUERY", "GENERAL", "SPAM", "UNCERTAIN"]);
const urgencyProbabilityKeys = new Set(["routine", "week", "today", "blocking"]);

function safeProbabilities(value: unknown, allowed: Set<string>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => allowed.has(key) && typeof entry === "number" && Number.isFinite(entry)));
}

function sanitizedResult(result: RowClassifyResult): RowClassifyResult | null {
  if (!isClassifyResult(result) || result.status !== "classified") return null;
  const classification = result.classification as ClassificationPreview & Record<string, unknown>;
  const urgencyValue = classification.urgency as (Record<string, unknown> & { level: string; score: number; confidence: number }) | null;
  const urgency = urgencyValue
    ? {
        level: urgencyValue.level,
        score: urgencyValue.score,
        confidence: urgencyValue.confidence,
        probabilities: safeProbabilities(urgencyValue.probabilities, urgencyProbabilityKeys),
      }
    : null;
  const usageValue = classification.usage as (Record<string, unknown> & { input_tokens: number; output_tokens: number }) | null;
  const usage = usageValue
    ? { input_tokens: usageValue.input_tokens, output_tokens: usageValue.output_tokens }
    : null;
  return {
    id: result.id,
    status: "classified",
    classification: {
      id: result.id,
      category: classification.category,
      confidence: classification.confidence,
      probabilities: safeProbabilities(classification.probabilities, categoryProbabilityKeys),
      urgency,
      expectation: classification.expectation,
      expectationConfidence: classification.expectationConfidence,
      model: classification.model ?? "unknown",
      usage,
      usageRequestId: classification.usageRequestId,
      elapsedMs: classification.elapsedMs ?? 0,
      questionVersion: classification.questionVersion ?? "unknown",
      cached: classification.cached,
    } as ClassificationPreview,
  };
}

function storedEntry(value: unknown): value is StoredCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.key === "string"
    && typeof entry.expiresAt === "number"
    && Number.isFinite(entry.expiresAt)
    && isClassifyResult(entry.result)
    && entry.result.status === "classified";
}

export function resultForEmail(result: RowClassifyResult, id: string, cached: boolean): RowClassifyResult | null {
  const clean = sanitizedResult(result);
  if (!clean || clean.status !== "classified") return null;
  return {
    id,
    status: "classified",
    classification: { ...clean.classification, id, cached },
  };
}

export function cacheResultForEmail(result: RowClassifyResult, id: string): RowClassifyResult | null {
  return resultForEmail(result, id, true);
}

export class PreviewCache {
  private readonly storage: SessionStorageArea;
  private readonly now: () => number;
  private readonly records = new Map<string, StoredCacheEntry>();
  private hydration: Promise<void> | null = null;

  constructor(storage: SessionStorageArea, now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
  }

  get size(): number {
    return this.records.size;
  }

  async hydrate(): Promise<void> {
    if (!this.hydration) {
      this.hydration = this.storage.get({ [PREVIEW_CACHE_STORAGE_KEY]: [] }).then(async (values) => {
        const entries = values[PREVIEW_CACHE_STORAGE_KEY];
        if (!Array.isArray(entries)) return;
        const now = this.now();
        let changed = false;
        for (const value of entries) {
          if (!storedEntry(value) || value.expiresAt <= now) {
            changed = true;
            continue;
          }
          const clean = sanitizedResult(value.result);
          if (!clean) {
            changed = true;
            continue;
          }
          const key = /^[a-f0-9]{64}$/.test(value.key) ? value.key : await sha256Hex(value.key);
          if (key !== value.key || JSON.stringify(clean) !== JSON.stringify(value.result)) changed = true;
          this.records.set(key, { ...value, key, result: clean });
        }
        this.trim();
        if (this.records.size !== entries.length) changed = true;
        if (changed) await this.storage.set({ [PREVIEW_CACHE_STORAGE_KEY]: [...this.records.values()] });
      });
    }
    await this.hydration;
  }

  async get(key: string): Promise<RowClassifyResult | null> {
    await this.hydrate();
    const storageKey = await sha256Hex(key);
    const entry = this.records.get(storageKey);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.records.delete(storageKey);
      await this.persist();
      return null;
    }
    return entry.result;
  }

  async set(key: string, result: RowClassifyResult): Promise<void> {
    await this.hydrate();
    const clean = sanitizedResult(result);
    if (!clean) return;
    const storageKey = await sha256Hex(key);
    this.records.delete(storageKey);
    this.records.set(storageKey, { key: storageKey, expiresAt: this.now() + PREVIEW_CACHE_TTL_MS, result: clean });
    this.trim();
    await this.persist();
  }

  async clear(): Promise<void> {
    await this.hydrate();
    this.records.clear();
    await this.persist();
  }

  private trim(): void {
    while (this.records.size > PREVIEW_CACHE_MAX_ENTRIES) {
      const first = this.records.keys().next().value;
      if (typeof first !== "string") break;
      this.records.delete(first);
    }
  }

  private async persist(): Promise<void> {
    await this.storage.set({ [PREVIEW_CACHE_STORAGE_KEY]: [...this.records.values()] });
  }
}
