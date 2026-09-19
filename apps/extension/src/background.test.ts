import assert from "node:assert/strict";
import test from "node:test";
import { ClassificationQueue } from "./background.ts";
import type { QueueItem } from "./messages.ts";

function item(index: number, fingerprint = String(index).padStart(64, "0")): QueueItem {
  return {
    source: index % 2 ? "gmail" : "outlook",
    rowKey: `row-${index}`,
    fingerprint,
    email: {
      id: `source:${index}`,
      subject: "Draft BL",
      from: "ops@example.test",
      snippet: "Please send the draft",
      contentScope: "inbox_snippet",
      attachments: [],
    },
  };
}

test("classification queue keeps row updates, deduplicates exact snapshots, and batches at twenty", async () => {
  const requests: QueueItem[][] = [];
  const sent: Array<{ tabId: number; message: any }> = [];
  const queue = new ClassificationQueue({
    request: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { emails: QueueItem["email"][] };
      requests.push(body.emails.map((email) => ({ ...item(Number(email.id.split(":")[1])), email })));
      return new Response(JSON.stringify({ results: body.emails.map((email) => ({ id: email.id, status: "classified", classification: { category: "GENERAL", confidence: 0.6 } })) }), { status: 200 });
    },
    send: async (tabId, message) => { sent.push({ tabId, message }); },
  });

  const rows = Array.from({ length: 21 }, (_, index) => item(index));
  const outcome = queue.enqueue(7, [...rows, rows[0], item(0, "f".repeat(64))]);
  await queue.drain();

  assert.equal(outcome.accepted.length, 22);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((batch) => batch.length), [20, 2]);
  assert.equal(sent.length, 2);
  assert.equal(sent.flatMap(({ message }) => message.items).length, 22);
  assert.equal(queue.size, 0);
});

test("classification queue returns per-row errors when preview service is unavailable", async () => {
  const sent: any[] = [];
  const queue = new ClassificationQueue({
    request: async () => new Response("offline", { status: 503 }),
    send: async (_tabId, message) => { sent.push(message); },
  });

  queue.enqueue(3, [item(1)]);
  await queue.drain();

  assert.equal(sent[0].type, "CLASSIFY_RESULTS");
  assert.equal(sent[0].items[0].result.status, "error");
  assert.equal(sent[0].items[0].result.error.code, "PREVIEW_UNAVAILABLE");
});
