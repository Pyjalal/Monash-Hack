import { expect, it, vi } from "vitest";
import { ClassificationQueue } from "./background.js";
import type { QueueItem } from "./messages.js";
import { PreviewCache, PREVIEW_CACHE_STORAGE_KEY } from "./preview-cache.js";

function item(index: number, fingerprint = String(index).padStart(64, "0"), id = `source:${index}`): QueueItem {
  return {
    source: index % 2 ? "gmail" : "outlook",
    rowKey: `row-${index}`,
    fingerprint,
    email: { id, subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft", contentScope: "inbox_snippet", attachments: [] },
  };
}

function classified(id: string) {
  return { id, status: "classified" as const, classification: {
    id, category: "GENERAL", confidence: 0.6, probabilities: { GENERAL: 1 }, urgency: null,
    expectation: null, expectationConfidence: null, model: "test-model", usage: null, elapsedMs: 1,
    questionVersion: "test-v1", cached: false,
  } };
}

function cacheStorage() {
  let values: Record<string, unknown> = { [PREVIEW_CACHE_STORAGE_KEY]: [] };
  return {
    get: async () => values,
    set: async (next: Record<string, unknown>) => { values = next; },
  };
}

it("keeps row updates, deduplicates exact snapshots, fans out duplicate IDs, and batches at twenty", async () => {
  const requests: QueueItem["email"][][] = [];
  const sent: Array<{ tabId: number; message: { type: string; items: unknown[] } }> = [];
  const queue = new ClassificationQueue({
    request: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { emails: QueueItem["email"][] };
      requests.push(body.emails);
      return new Response(JSON.stringify({ results: body.emails.map((email) => classified(email.id)) }), { status: 200 });
    },
    send: async (tabId, message) => { sent.push({ tabId, message: message as { type: string; items: unknown[] } }); },
  });
  const rows = Array.from({ length: 21 }, (_, index) => item(index));
  const outcome = queue.enqueue(7, [...rows, rows[0], item(0, "f".repeat(64))]);
  queue.enqueue(8, [item(0)]);
  await queue.drain();
  expect(outcome.accepted).toHaveLength(22);
  expect(requests).toHaveLength(3);
  expect(requests.map((batch) => batch.length)).toEqual([20, 2, 1]);
  for (const batch of requests) expect(new Set(batch.map((email) => email.id)).size).toBe(batch.length);
  expect(sent.map(({ tabId }) => tabId).sort()).toEqual([7, 7, 8]);
  expect(sent.flatMap(({ message }) => message.items)).toHaveLength(23);
  expect(queue.size).toBe(0);
});

it("returns per-row errors when preview service is unavailable", async () => {
  const sent: Array<{ type: string; items: Array<{ result: { status: string; error?: { code: string } } }> }> = [];
  const queue = new ClassificationQueue({
    request: async () => new Response("offline", { status: 503 }),
    send: async (_tabId, message) => { sent.push(message as typeof sent[number]); },
  });
  queue.enqueue(3, [item(1)]);
  await queue.drain();
  expect(sent[0].type).toBe("CLASSIFY_RESULTS");
  expect(sent[0].items[0].result.status).toBe("error");
  expect(sent[0].items[0].result.error?.code).toBe("PREVIEW_UNAVAILABLE");
});

it("drops queued and in-flight work when disabled", async () => {
  const sent: unknown[] = [];
  let resolveRequest: ((response: Response) => void) | undefined;
  const queue = new ClassificationQueue({
    request: vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; })),
    send: async (_tabId, message) => { sent.push(message); },
  });
  queue.enqueue(3, [item(1)]);
  await vi.waitFor(() => expect(resolveRequest).toBeDefined());
  queue.setEnabled(false);
  resolveRequest?.(new Response(JSON.stringify({ results: [classified("source:1")] }), { status: 200 }));
  await queue.drain();
  expect(sent).toEqual([]);
  expect(queue.enqueue(3, [item(2)]).rejected[0].error.code).toBe("DISABLED");
});

it("reuses content and revision scoped previews without storing email text", async () => {
  const backing = cacheStorage();
  const cache = new PreviewCache(backing);
  let revision = "a".repeat(64);
  let healthAvailable = true;
  let healthCalls = 0;
  let postCalls = 0;
  const sent: Array<{ type: string; items: Array<{ result: { status: string; classification?: { cached: boolean } } }> }> = [];
  const transport = {
    request: async (_url: string, init: RequestInit) => {
      if (init.method === "GET") {
        healthCalls += 1;
        if (!healthAvailable) return new Response("offline", { status: 503 });
        return new Response(JSON.stringify({ classifierRevision: revision }), { status: 200 });
      }
      postCalls += 1;
      const body = JSON.parse(String(init.body)) as { emails: QueueItem["email"][] };
      return new Response(JSON.stringify({ results: body.emails.map((email) => classified(email.id)) }), { status: 200 });
    },
    send: async (_tabId: number, message: unknown) => { sent.push(message as typeof sent[number]); },
  };
  const first = { ...item(1), context: "gmail:0" };
  const queue = new ClassificationQueue(transport, "http://127.0.0.1:3001/classify", cache);
  queue.enqueue(4, [first]);
  await queue.drain();
  queue.enqueue(4, [first]);
  await queue.drain();
  expect(postCalls).toBe(1);
  expect(healthCalls).toBe(2);
  expect(sent.at(-1)?.items[0].result.classification?.cached).toBe(true);
  const persisted = JSON.stringify(await backing.get());
  expect(persisted).not.toContain(first.email.snippet);
  expect(persisted).not.toContain("gmail:0");
  expect(persisted).not.toContain("127.0.0.1:3001");

  healthAvailable = false;
  queue.enqueue(4, [first]);
  await queue.drain();
  expect(postCalls).toBe(2);
  expect(sent.at(-1)?.items[0].result.classification?.cached).toBe(false);
  healthAvailable = true;

  const otherEndpoint = new ClassificationQueue(transport, "http://localhost:4555/classify", cache);
  otherEndpoint.enqueue(4, [first]);
  await otherEndpoint.drain();
  expect(postCalls).toBe(3);
  queue.enqueue(5, [{ ...first, context: "gmail:1" }]);
  await queue.drain();
  queue.enqueue(4, [{ ...first, fingerprint: "f".repeat(64) }]);
  await queue.drain();
  expect(postCalls).toBe(5);

  revision = "b".repeat(64);
  queue.enqueue(4, [first]);
  await queue.drain();
  expect(postCalls).toBe(6);
  const restarted = new ClassificationQueue(transport, "http://127.0.0.1:3001/classify", new PreviewCache(backing));
  restarted.enqueue(4, [first]);
  await restarted.drain();
  expect(postCalls).toBe(6);
});

it("does not cache unavailable responses and retry bypasses a successful cache hit", async () => {
  const cache = new PreviewCache(cacheStorage());
  let postCalls = 0;
  let unavailable = true;
  const transport = {
    request: async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return new Response(JSON.stringify({ classifierRevision: "a".repeat(64) }), { status: 200 });
      postCalls += 1;
      if (unavailable) return new Response("offline", { status: 503 });
      const body = JSON.parse(String(init.body)) as { emails: QueueItem["email"][] };
      return new Response(JSON.stringify({ results: body.emails.map((email) => classified(email.id)) }), { status: 200 });
    },
    send: async () => undefined,
  };
  const queue = new ClassificationQueue(transport, "http://127.0.0.1:3001/classify", cache);
  const row = { ...item(3), context: "gmail:0" };
  queue.enqueue(6, [row]);
  await queue.drain();
  unavailable = false;
  queue.enqueue(6, [row]);
  await queue.drain();
  queue.enqueue(6, [row], 0, true);
  await queue.drain();
  expect(postCalls).toBe(3);
});

it("rejects ambiguous duplicate result IDs before caching", async () => {
  const backing = cacheStorage();
  const cache = new PreviewCache(backing);
  const row = item(4);
  const sent: Array<{ items: Array<{ result: { status: string; error?: { code: string } } }> }> = [];
  const transport = {
    request: async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return new Response(JSON.stringify({ classifierRevision: "a".repeat(64) }), { status: 200 });
      const duplicate = classified(row.email.id);
      return new Response(JSON.stringify({ results: [duplicate, duplicate] }), { status: 200 });
    },
    send: async (_tabId: number, message: unknown) => { sent.push(message as typeof sent[number]); },
  };
  const queue = new ClassificationQueue(transport, "http://127.0.0.1:3001/classify", cache);
  queue.enqueue(9, [row]);
  await queue.drain();
  expect(sent[0].items[0].result.error?.code).toBe("PREVIEW_UNAVAILABLE");
  expect(JSON.stringify(await backing.get())).not.toContain(row.email.id);
});
