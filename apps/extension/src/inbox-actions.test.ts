import { expect, it } from "vitest";
import { decideRow } from "./inbox-actions.js";
import { defaultInboxPolicy, parseInboxPolicy, rulesKey, activeRules } from "./settings.js";
import type { ClassificationPreview } from "./messages.js";

function preview(overrides: Partial<ClassificationPreview> = {}): ClassificationPreview {
  return { id: "x", category: "GENERAL", confidence: 0.9, urgency: { level: "routine", score: 0, confidence: 0.9 }, expectation: null, expectationConfidence: null, cached: false, ...overrides };
}

it("hides confident spam even when an action rule fires, and never hides pinned rows", () => {
  const policy = defaultInboxPolicy();
  policy.rules = policy.rules.map(rule => ({ ...rule, enabled: ["cargo_blocked", "automated_notice"].includes(rule.id) }));
  const phishing = decideRow(policy, preview({ category: "SPAM", confidence: 0.95, rules: { cargo_blocked: 0.9 } }));
  expect(phishing).toMatchObject({ hide: true, pin: false, reasons: ["Spam"] });
  expect(decideRow(policy, preview({ category: "SPAM", confidence: 0.6 }))).toMatchObject({ hide: false, spam: false });
  const both = decideRow(policy, preview({ rules: { cargo_blocked: 0.8, automated_notice: 0.9 } }));
  expect(both).toMatchObject({ hide: false, pin: true, reasons: ["Cargo or release blocked", "Automated notice, no action"] });
  expect(decideRow(policy, preview({ rules: { automated_notice: 0.85 } }))).toMatchObject({ hide: true, pin: false, highlight: false });
  expect(decideRow(policy, preview({ rules: { automated_notice: 0.5 } }))).toMatchObject({ hide: false, reasons: [] });
});

it("ranks blocking urgency above today above rule pins and respects the pinUrgent switch", () => {
  const policy = defaultInboxPolicy();
  policy.rules[0].enabled = true;
  const blocking = decideRow(policy, preview({ urgency: { level: "blocking", score: 3, confidence: 0.9 } }));
  const today = decideRow(policy, preview({ urgency: { level: "today", score: 2, confidence: 0.9 } }));
  const reply = decideRow(policy, preview({ rules: { needs_reply_now: 0.95 } }));
  expect(blocking.pinRank).toBeGreaterThan(today.pinRank);
  expect(today.pinRank).toBeGreaterThan(reply.pinRank);
  expect(reply.pin).toBe(true);
  expect(decideRow(policy, preview({ urgency: { level: "today", score: 2, confidence: 0.4 } })).pin).toBe(false);
  expect(decideRow({ ...policy, pinUrgent: false }, preview({ urgency: { level: "blocking", score: 3, confidence: 0.9 } })).pin).toBe(false);
});

it("parses stored policies defensively and keys the Jev request on enabled conditions only", () => {
  const parsed = parseInboxPolicy({ hideSpam: false, spamThreshold: 2, pinUrgent: "yes", rules: [
    { id: "needs_reply_now", enabled: true, threshold: 0.65, condition: "custom wording for replies", action: "hide" },
    { id: "Bad Id!", condition: "long enough condition", enabled: true },
    { id: "my_rule", label: "Mine", condition: "Mentions a container that missed its cut-off", action: "highlight", threshold: 0.9, enabled: false },
    { id: "short", condition: "tiny", enabled: true },
  ] });
  expect(parsed.hideSpam).toBe(false);
  expect(parsed.spamThreshold).toBe(0.8);
  expect(parsed.pinUrgent).toBe(true);
  expect(parsed.rules.map(rule => rule.id)).toEqual(["needs_reply_now", "my_rule", "cargo_blocked", "schedule_change", "charges_dispute", "automated_notice", "marketing"]);
  expect(parsed.rules[0]).toMatchObject({ enabled: true, threshold: 0.65, action: "hide", condition: "custom wording for replies", preset: true, label: "Needs my reply now" });
  expect(parsed.rules[1]).toMatchObject({ preset: false, label: "Mine", enabled: false });
  expect(activeRules(parsed)).toEqual([{ id: "needs_reply_now", condition: "custom wording for replies" }]);
  const relabelled = parseInboxPolicy({ ...parsed, rules: parsed.rules.map(rule => ({ ...rule, action: "pin", threshold: 0.9 })) });
  expect(rulesKey(relabelled)).toBe(rulesKey(parsed));
  expect(rulesKey(parseInboxPolicy({ ...parsed, rules: parsed.rules.map(rule => ({ ...rule, enabled: true })) }))).not.toBe(rulesKey(parsed));
});
