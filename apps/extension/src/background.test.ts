import { expect, it } from "vitest";
import { ClassificationQueue } from "./background.js";
import type { QueueItem } from "./messages.js";

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
  expect(requests).toHaveLength(2);
  expect(requests.map((batch) => batch.length)).toEqual([20, 2]);
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
