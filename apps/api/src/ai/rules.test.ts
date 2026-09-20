import { expect, test, vi } from "vitest";
import type { Email } from "@cargolens/shared";
import { RULE_PRESETS } from "@cargolens/shared/rules";
import { createApp } from "../app.js";
import { ClassificationService } from "../pipeline.js";
import { Store } from "../store.js";
import { createJevRuleEvaluator, RuleService } from "./rules.js";

const emails: Email[] = [
  { id: "a", subject: "Customs hold on MSKU123", from: "ops@example.test", snippet: "Container is on hold pending the missing packing list. Please send today.", contentScope: "inbox_snippet", attachments: [] },
  { id: "b", subject: "Weekly rates newsletter", from: "promo@example.test", snippet: "Save 10% on transpacific bookings this month.", contentScope: "inbox_snippet", attachments: [] },
];
const rules = RULE_PRESETS.filter(rule => ["cargo_blocked", "marketing"].includes(rule.id)).map(({ id, condition }) => ({ id, condition }));

function fakeFetch(answer: (key: string, index: number) => number) {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { instructions: { task: string } }> };
    const answers = Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: "noul", noul: answer(key, Number(key.match(/^e(\d+)_/)![1])) }]));
    return new Response(JSON.stringify({ model: "jev-test", usage: { input_tokens: 10, output_tokens: 2 }, answers }), { headers: { "Content-Type": "application/json" } });
  });
}

test("packs one Noul question per email and rule and scopes each to its message", async () => {
  const fetch = fakeFetch((key, index) => key.endsWith("cargo_blocked") ? (index === 0 ? 0.93 : 0.02) : (index === 1 ? 0.88 : 0.01));
  const evaluate = createJevRuleEvaluator({ apiKey: "test", fetch: fetch as never });
  const result = await evaluate(emails, rules);
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as { state: { emails: unknown[] }; questions: Record<string, { type: string; instructions: { task: string; condition: string } }> };
  expect(request.state.emails).toHaveLength(2);
  expect(Object.keys(request.questions).sort()).toEqual(["e0_cargo_blocked", "e0_marketing", "e1_cargo_blocked", "e1_marketing"]);
  expect(request.questions.e1_marketing.type).toBe("noul");
  expect(request.questions.e1_marketing.instructions.task).toContain("`emails[1]`");
  expect(request.questions.e1_marketing.instructions.condition).toBe(rules[1].condition);
  expect(result.probabilities.get("a")).toEqual({ cargo_blocked: 0.93, marketing: 0.01 });
  expect(result.probabilities.get("b")).toEqual({ cargo_blocked: 0.02, marketing: 0.88 });
});

test("caches per email and rule so only misses reach Jev and the endpoint stays public", async () => {
  const store = new Store(":memory:");
  try {
    const evaluator = vi.fn(async (batch: Email[], wanted: typeof rules) => ({
      probabilities: new Map(batch.map(email => [email.id, Object.fromEntries(wanted.map(rule => [rule.id, email.id === "a" ? 0.9 : 0.1]))])),
      usage: { input_tokens: 1, output_tokens: 1 }, model: "jev-test", elapsedMs: 1,
    }));
    const rulesService = new RuleService({ store, model: "jev-test", evaluator });
    const first = await rulesService.evaluate(emails, rules);
    expect(first).toEqual([
      { id: "a", status: "evaluated", rules: { cargo_blocked: 0.9, marketing: 0.9 }, cached: false },
      { id: "b", status: "evaluated", rules: { cargo_blocked: 0.1, marketing: 0.1 }, cached: false },
    ]);
    expect(evaluator).toHaveBeenCalledTimes(1);
    const extra = { id: "needs_reply_now", condition: RULE_PRESETS[0].condition };
    const second = await rulesService.evaluate(emails, [...rules, extra]);
    expect(evaluator).toHaveBeenCalledTimes(2);
    expect(evaluator.mock.calls[1][1]).toEqual([extra]);
    expect(second[0]).toMatchObject({ status: "evaluated", cached: false, rules: { cargo_blocked: 0.9, marketing: 0.9, needs_reply_now: 0.9 } });
    const third = await rulesService.evaluate([emails[0]], rules);
    expect(evaluator).toHaveBeenCalledTimes(2);
    expect(third[0]).toMatchObject({ cached: true });

    const service = new ClassificationService({ store, classifier: async () => { throw new Error("unused"); }, configurationKey: "fixture" });
    const app = createApp({ store, service, rules: rulesService, dashboardToken: "token" });
    const response = await app.request("/rules/evaluate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: emails.map(({ id, subject, from, snippet }) => ({ id, subject, from, snippet })), rules }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { results: unknown[]; rulesVersion: string };
    expect(body.results).toHaveLength(2);
    expect(body.rulesVersion).toBe("jev-test:cargolens-rules-v1");
    const invalid = await app.request("/rules/evaluate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails, rules: [{ id: "Bad Id", condition: "short" }] }) });
    expect(invalid.status).toBe(400);
  } finally { store.close(); }
});

test("reports failures per email without caching partial answers", async () => {
  const store = new Store(":memory:");
  try {
    const rulesService = new RuleService({ store, model: "jev-test", evaluator: async () => { throw new Error("offline"); } });
    const results = await rulesService.evaluate(emails, rules);
    expect(results.every(result => result.status === "error" && result.error.code === "RULES_UNAVAILABLE")).toBe(true);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM rule_cache").get()).toEqual({ count: 0 });
  } finally { store.close(); }
});
