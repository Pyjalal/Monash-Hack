import { afterEach, expect, it } from "vitest";
import { Store } from "./store.js";
import { dashboardReports } from "./dashboard.js";
import { createApp } from "./app.js";
import { ClassificationService } from "./pipeline.js";
import type { Classification } from "@cargolens/shared";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
it("persists exact measured run artifacts and keeps unavailable values null", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const r = dashboardReports(store);
  const record = store.upsertEmail({
    id: "a",
    subject: "Shipping request",
    from: "ops@example.test",
    contentScope: "full_message",
    attachments: [],
  });
  const run = r.begin(["a"], "question-version");
  const classification: Classification = {
    id: "a",
    category: "SI_REQUEST",
    confidence: 1,
    probabilities: { SI_REQUEST: 1 },
    urgency: null,
    expectation: null,
    expectationConfidence: null,
    model: "test",
    usage: { input_tokens: 50, output_tokens: 2 },
    elapsedMs: 321,
    questionVersion: "v1",
    cached: false,
  };
  store.saveClassification("a", record.sourceVersion, classification);
  store.recordUsage({
    requestId: "req",
    model: "test",
    usage: classification.usage!,
    elapsedMs: 321,
    emailCount: 1,
  });
  const artifact = run.finish();
  expect(r.all()[0]).toEqual(artifact);
  expect(artifact).toMatchObject({
    total: 1,
    classified: 1,
    failed: 0,
    pending: 0,
    requests: 1,
    inputTokens: 50,
    p50Ms: 321,
    p95Ms: 321,
    costUsd: null,
    falseClears: null,
  });
  expect(artifact.wallMs).toBeGreaterThanOrEqual(0);
  const warm = r.begin(["a"], "question-version").finish();
  expect(warm.reused).toBe(1);
  expect(warm.requests).toBe(0);
  expect(warm.p95Ms).toBeNull();
});
it("protects dashboard data, evidence, import, replies and connector controls", async () => {
  const store = new Store(":memory:");
  stores.push(store);
  const service = new ClassificationService({
    store,
    classifier: async () => {
      throw Error("unused");
    },
    configurationKey: "test",
  });
  const app = createApp({ store, service, dashboardToken: "test-token" });
  for (const [method, path] of [
    ["GET", "/dashboard"],
    ["GET", "/runs/test"],
    ["GET", "/cases/test/sources"],
    ["GET", "/cases/test/activity"],
    ["POST", "/import"],
    ["POST", "/cases/test/decision"],
    ["POST", "/cases/test/draft"],
    ["POST", "/cases/test/recover"],
    ["POST", "/gmail/dispatch"],
    ["POST", "/gmail/sync"],
  ])
    expect((await app.request(path, { method })).status).toBe(401);
  const response = await app.request("/dashboard", {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).counts).toEqual({
    total: 0,
    classified: 0,
    failed: 0,
    pending: 0,
  });
});
