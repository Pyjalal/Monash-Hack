import { describe, expect, it, vi } from "vitest";
import type { Classification, Email } from "@cargolens/shared";
import { ClassificationService } from "./pipeline.js";
import { Store } from "./store.js";
import type { BatchClassificationResult } from "./ai/jev-batch.js";

const email = (index: number): Email => ({ id: `mail-${index}`, subject: `Draft ${index}`, body: `Please send draft ${index}.`, from: "ops@example.test", contentScope: "full_message", attachments: [] });
const classification = (source: Email): Classification => ({ id: source.id, category: "BL_COMPARISON", confidence: 0.99,
  probabilities: { BL_COMPARISON: 1 }, urgency: null, expectation: "FUTURE_DRAFT", expectationConfidence: 1,
  model: "test", usage: { input_tokens: 10, output_tokens: 2 }, elapsedMs: 1, questionVersion: "v3", cached: false });
const packed = (emails: Email[]): BatchClassificationResult => ({ classifications: emails.map(source => {
  const { usage: _usage, raw: _raw, ...result } = classification(source); void _usage; void _raw; return result;
}).reverse(), usage: { input_tokens: 100, output_tokens: 20 }, model: "test", elapsedMs: 2, questionVersion: "v3:packed-v1" });

describe("runtime microbatch classification", () => {
  it("coalesces twenty unique emails into at most eight per request and persists usage once", async () => {
    const store = new Store(":memory:");
    const batchClassifier = vi.fn(async (sources: Email[]) => packed(sources));
    const service = new ClassificationService({ store, classifier: async source => classification(source), batchClassifier,
      configurationKey: "test:v3", batchSize: 8, flushMs: 8, concurrency: 2, requestsPerMinute: 1200 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => service.classify(email(index))));
    expect(batchClassifier.mock.calls.map(([sources]) => sources.length)).toEqual([8, 8, 4]);
    expect(results.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => `mail-${index}`));
    expect(results.every(row => row.usage === null && row.usageRequestId)).toBe(true);
    expect(store.usageSummary()).toEqual({ requests: 3, input_tokens: 300, output_tokens: 60 });
    expect(store.eventsAfter(0).filter(event => event.type === "ai.request")).toHaveLength(3);
    store.close();
  });

  it("deduplicates pending semantic input and remaps the caller's ID without billing twice", async () => {
    const store = new Store(":memory:"); const batchClassifier = vi.fn(async (sources: Email[]) => packed(sources));
    const service = new ClassificationService({ store, classifier: async source => classification(source), batchClassifier, configurationKey: "test:v3" });
    const results = await Promise.all([service.classify(email(1)), service.classify({ ...email(1), id: "duplicate-id" })]);
    expect(batchClassifier).toHaveBeenCalledTimes(1);
    expect(batchClassifier.mock.calls[0][0]).toHaveLength(1);
    expect(results.map(row => row.id)).toEqual(["mail-1", "duplicate-id"]);
    expect(results[0].usageRequestId).toBe(results[1].usageRequestId);
    const cached = await service.classify(email(1));
    expect(cached.cached).toBe(true); expect(cached.usage).toBeNull();
    expect(store.usageSummary().requests).toBe(1);
    store.close();
  });

  it("separates caches by packing policy and pack size", async () => {
    const store = new Store(":memory:"); const batchClassifier = vi.fn(async (sources: Email[]) => packed(sources));
    const classifier = vi.fn(async (source: Email) => classification(source));
    await new ClassificationService({ store, classifier, configurationKey: "same-model-prompts" }).classify(email(1));
    await new ClassificationService({ store, classifier, batchClassifier, batchSize: 4, configurationKey: "same-model-prompts" }).classify(email(1));
    await new ClassificationService({ store, classifier, batchClassifier, batchSize: 8, configurationKey: "same-model-prompts" }).classify(email(1));
    expect(classifier).toHaveBeenCalledTimes(1); expect(batchClassifier).toHaveBeenCalledTimes(2);
    expect(store.usageSummary().requests).toBe(3); store.close();
  });

  it("flushes a partial batch without waiting for eight messages", async () => {
    const store = new Store(":memory:"); const batchClassifier = vi.fn(async (sources: Email[]) => packed(sources));
    const service = new ClassificationService({ store, classifier: async source => classification(source), batchClassifier, configurationKey: "test:v3", flushMs: 1 });
    expect((await service.classify(email(1))).id).toBe("mail-1");
    expect(batchClassifier).toHaveBeenCalledTimes(1); store.close();
  });

  it("rejects every affected email on provider failure and never caches the failure", async () => {
    const store = new Store(":memory:");
    const batchClassifier = vi.fn().mockRejectedValueOnce(new Error("provider unavailable")).mockImplementation(async (sources: Email[]) => packed(sources));
    const service = new ClassificationService({ store, classifier: async source => classification(source), batchClassifier, configurationKey: "test:v3", flushMs: 1 });
    const outcomes = await Promise.allSettled([service.classify(email(1)), service.classify(email(2))]);
    expect(outcomes.every(row => row.status === "rejected")).toBe(true);
    expect(store.usageSummary().requests).toBe(0);
    expect((await service.classify(email(1))).category).toBe("BL_COMPARISON");
    expect(batchClassifier).toHaveBeenCalledTimes(2); store.close();
  });

  it("falls back to individual calls only when a local batch size guard rejects the request", async () => {
    const store = new Store(":memory:"); const classifier = vi.fn(async (source: Email) => classification(source));
    const batchClassifier = vi.fn(async () => { throw new RangeError("Packed request exceeds conservative context budget; split into smaller batches"); });
    const service = new ClassificationService({ store, classifier, batchClassifier, configurationKey: "test:v3", flushMs: 1, requestsPerMinute: 1200 });
    const rows = await Promise.all([service.classify(email(1)), service.classify(email(2))]);
    expect(rows).toHaveLength(2); expect(classifier).toHaveBeenCalledTimes(2);
    expect(store.usageSummary()).toEqual({ requests: 2, input_tokens: 20, output_tokens: 4 }); store.close();
  });

  it("keeps concurrent revisions with the same correlation ID in separate requests", async () => {
    const store = new Store(":memory:"); const batchClassifier = vi.fn(async (sources: Email[]) => packed(sources));
    const service = new ClassificationService({ store, classifier: async source => classification(source), batchClassifier,
      configurationKey: "test:v3", batchSize: 2, requestsPerMinute: 1200 });
    await Promise.all([service.classify(email(1)), service.classify({ ...email(1), body: "New invoice evidence" })]);
    expect(batchClassifier.mock.calls.map(([sources]) => sources.length)).toEqual([1, 1]);
    expect(store.usageSummary().requests).toBe(2); store.close();
  });

  it("rejects unrecognized range failures without duplicating provider work", async () => {
    const store = new Store(":memory:"); const classifier = vi.fn(async (source: Email) => classification(source));
    const batchClassifier = vi.fn(async () => { throw new RangeError("Unexpected provider parsing error"); });
    const service = new ClassificationService({ store, classifier, batchClassifier, configurationKey: "test:v3", flushMs: 1 });
    await expect(service.classify(email(1))).rejects.toThrow("Unexpected provider parsing error");
    expect(classifier).not.toHaveBeenCalled(); expect(store.usageSummary().requests).toBe(0); store.close();
  });

  it("rejects incorrect batch correlation instead of assigning another email's classification", async () => {
    const store = new Store(":memory:");
    const service = new ClassificationService({ store, classifier: async source => classification(source),
      batchClassifier: async () => packed([email(999)]), configurationKey: "test:v3", flushMs: 1 });
    await expect(service.classify(email(1))).rejects.toThrow("Invalid Jev response at packed.ids");
    expect(store.usageSummary().requests).toBe(0); store.close();
  });
});
