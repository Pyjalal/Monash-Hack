import { expect, it } from "vitest";
import { fingerprintCandidate } from "./fingerprints.js";

it("fingerprints visible content while keeping row correlation opaque", async () => {
  const first = await fingerprintCandidate({ source: "gmail", rowKey: "thread-1", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft" });
  const sameContent = await fingerprintCandidate({ source: "gmail", rowKey: "thread-2", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft" });
  const changed = await fingerprintCandidate({ source: "gmail", rowKey: "thread-1", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the signed draft" });

  expect(first.fingerprint).toBe(sameContent.fingerprint);
  expect(first.email.id).not.toBe(sameContent.email.id);
  expect(first.fingerprint).not.toBe(changed.fingerprint);
  expect(first.email.contentScope).toBe("inbox_snippet");
  expect(first.email.attachments).toEqual([]);
  expect(first.email.id.includes("thread-1")).toBe(false);
});
