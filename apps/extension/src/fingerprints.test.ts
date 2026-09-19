import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintCandidate } from "./fingerprints.ts";

test("fingerprints visible content while keeping row correlation opaque", async () => {
  const first = await fingerprintCandidate({ source: "gmail", rowKey: "thread-1", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft" });
  const sameContent = await fingerprintCandidate({ source: "gmail", rowKey: "thread-2", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft" });
  const changed = await fingerprintCandidate({ source: "gmail", rowKey: "thread-1", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the signed draft" });

  assert.equal(first.fingerprint, sameContent.fingerprint);
  assert.notEqual(first.email.id, sameContent.email.id);
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.equal(first.email.contentScope, "inbox_snippet");
  assert.deepEqual(first.email.attachments, []);
  assert.equal(first.email.id.includes("thread-1"), false);
});
