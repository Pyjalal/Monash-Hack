import { expect, it, vi } from "vitest";
import { PREVIEW_CACHE_MAX_ENTRIES, PREVIEW_CACHE_STORAGE_KEY, PREVIEW_CACHE_TTL_MS, PreviewCache } from "./preview-cache.js";
import type { RowClassifyResult } from "./messages.js";

function classified(id: string): RowClassifyResult {
  return {
    id,
    status: "classified",
    classification: {
      id,
      category: "GENERAL",
      confidence: 0.8,
      probabilities: { GENERAL: 0.8, UNCERTAIN: 0.2 },
      urgency: null,
      expectation: null,
      expectationConfidence: null,
      model: "fixture-model",
      usage: null,
      elapsedMs: 4,
      questionVersion: "fixture-v1",
      cached: false,
    },
  };
}

function storage() {
  let values: Record<string, unknown> = { [PREVIEW_CACHE_STORAGE_KEY]: [] };
  return {
    get: vi.fn(async () => values),
    set: vi.fn(async (next: Record<string, unknown>) => { values = next; }),
    read: () => values,
  };
}

it("persists only successful metadata, rehydrates, expires, and bounds session entries", async () => {
  let now = 1000;
  const backing = storage();
  const cache = new PreviewCache(backing, () => now);
  const result = classified("mail-1");
  result.classification = {
    ...result.classification,
    raw: "secret body",
    probabilities: { GENERAL: 0.8, UNCERTAIN: 0.2, SECRET_PROBABILITY_KEY: 0 },
    urgency: { level: "today", score: 2, confidence: 0.8, probabilities: { today: 1, SECRET_PROBABILITY_KEY: 0 }, sourceText: "secret body" },
    usage: { input_tokens: 1, output_tokens: 1, sourceText: "secret body" },
  } as typeof result.classification;
  const cacheKey = "scope\u241fendpoint\u241frevision\u241ffingerprint";
  await cache.set(cacheKey, result);
  await cache.set("PRIVATE_CONTEXT", classified("mail-2"));
  const serialized = JSON.stringify(backing.read());
  expect(serialized).not.toContain("secret body");
  expect(serialized).not.toContain("subject");
  expect(serialized).not.toContain("SECRET_PROBABILITY_KEY");
  expect(serialized).not.toContain("PRIVATE_CONTEXT");

  const restarted = new PreviewCache(backing, () => now);
  expect(await restarted.get(cacheKey)).toMatchObject({ id: "mail-1", status: "classified" });
  now += PREVIEW_CACHE_TTL_MS + 1;
  expect(await restarted.get(cacheKey)).toBeNull();
  expect(JSON.stringify(backing.read())).not.toContain("mail-1");

  now = 2000;
  const bounded = new PreviewCache(storage(), () => now);
  for (let index = 0; index < PREVIEW_CACHE_MAX_ENTRIES + 1; index += 1) await bounded.set(`key-${index}`, classified(`mail-${index}`));
  expect(bounded.size).toBe(PREVIEW_CACHE_MAX_ENTRIES);
});

it("does not persist failed results", async () => {
  const backing = storage();
  const cache = new PreviewCache(backing);
  await cache.set("failed", { id: "failed", status: "error", error: { code: "PREVIEW_UNAVAILABLE", message: "offline" } });
  expect(await cache.get("failed")).toBeNull();
  expect(backing.set).not.toHaveBeenCalled();
});
