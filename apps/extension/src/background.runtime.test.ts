import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ExtensionMessage, QueueItem } from "./messages.js";

type RuntimeListener = (message: unknown, sender: { tab?: { id?: number } }, sendResponse: (response: unknown) => void) => void | boolean;

function item(): QueueItem {
  return {
    source: "gmail",
    rowKey: "thread-1",
    fingerprint: "1".repeat(64),
    email: { id: "gmail:thread-1:message", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft", contentScope: "inbox_snippet", attachments: [] },
  };
}

function responseFor(id: string) {
  return {
    id,
    status: "classified" as const,
    classification: {
      id,
      category: "BL_COMPARISON",
      confidence: 0.94,
      probabilities: { BL_COMPARISON: 0.94, GENERAL: 0.06 },
      urgency: null,
      expectation: null,
      expectationConfidence: null,
      model: "fixture-model",
      usage: null,
      elapsedMs: 1,
      questionVersion: "fixture-v1",
      cached: false,
    },
  };
}

function installChrome(settings: { enabled: boolean; apiUrl: string }, initialSessionCache: unknown[] = []) {
  let listener: RuntimeListener | undefined;
  const storage = { ...settings };
  let sessionCache: unknown[] = initialSessionCache;
  const chromeMock = {
    runtime: { onMessage: { addListener: (value: RuntimeListener) => { listener = value; } } },
    storage: {
      sync: {
        get: vi.fn(async () => ({ ...storage })),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(storage, value); }),
      },
      session: {
        get: vi.fn(async () => ({ cargolensPreviewCache: sessionCache })),
        set: vi.fn(async (value: Record<string, unknown>) => { sessionCache = value.cargolensPreviewCache as unknown[]; }),
      },
    },
    tabs: {
      query: vi.fn(async () => [] as Array<{ id?: number }>),
      sendMessage: vi.fn(async () => undefined),
    },
    commands: { onCommand: { addListener: vi.fn() } },
  };
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = chromeMock;
  return { chromeMock, getListener: () => listener, getSessionCache: () => sessionCache };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
});

it("loads a custom API URL before a cold-worker classify request", async () => {
  const state = installChrome({ enabled: true, apiUrl: "http://localhost:4555" });
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") return new Response(JSON.stringify({ classifierRevision: "a".repeat(64) }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as { emails: QueueItem["email"][] };
    return new Response(JSON.stringify({ results: body.emails.map((email) => responseFor(email.id)) }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await import("./background.js");
  const listener = state.getListener();
  expect(listener).toBeDefined();
  const sendResponse = vi.fn();
  const message: ExtensionMessage = { type: "CLASSIFY_ROWS", epoch: 1, items: [item()] };
  listener?.(message, { tab: { id: 41 } }, sendResponse);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith("http://localhost:4555/classify", expect.any(Object));
  expect(sendResponse).toHaveBeenCalledWith({ accepted: 1, rejected: 0 });
});

it("resynchronizes an existing tab after its background worker restarts", async () => {
  const state = installChrome({ enabled: true, apiUrl: "http://localhost:4555" });
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "GET"
    ? new Response(JSON.stringify({ classifierRevision: "a".repeat(64) }), { status: 200 })
    : new Response(JSON.stringify({ results: [responseFor(item().email.id)] })));
  vi.stubGlobal("fetch", fetchMock);
  await import("./background.js");
  const staleResponse = vi.fn();
  state.getListener()?.({ type: "CLASSIFY_ROWS", epoch: 7, items: [item()] }, { tab: { id: 41 } }, staleResponse);
  await vi.waitFor(() => expect(staleResponse).toHaveBeenCalled());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(state.chromeMock.tabs.sendMessage).toHaveBeenCalledWith(41, {
    type: "SETTINGS_UPDATED", enabled: true, apiUrl: "http://localhost:4555", epoch: 1,
  });
  const currentResponse = vi.fn();
  state.getListener()?.({ type: "CLASSIFY_ROWS", epoch: 1, items: [item()] }, { tab: { id: 41 } }, currentResponse);
  await vi.waitFor(() => expect(currentResponse).toHaveBeenCalledWith({ accepted: 1, rejected: 0 }));
  await vi.waitFor(() => expect(state.chromeMock.tabs.sendMessage).toHaveBeenCalledWith(41,
    expect.objectContaining({ type: "CLASSIFY_RESULTS", epoch: 1 })));
});

it("does not fetch when a cold worker loads disabled settings", async () => {
  const state = installChrome({ enabled: false, apiUrl: "http://localhost:4555" });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await import("./background.js");
  const sendResponse = vi.fn();
  state.getListener()?.({ type: "RETRY_ROW", epoch: 0, item: item() }, { tab: { id: 41 } }, sendResponse);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sendResponse).toHaveBeenCalledWith({ accepted: 0, rejected: 1, disabled: true });
});

it("rehydrates the session cache after a custom-URL worker restart", async () => {
  const first = installChrome({ enabled: true, apiUrl: "http://localhost:4555" });
  const firstFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "GET"
    ? new Response(JSON.stringify({ classifierRevision: "a".repeat(64) }), { status: 200 })
    : new Response(JSON.stringify({ results: [responseFor(item().email.id)] })));
  vi.stubGlobal("fetch", firstFetch);
  await import("./background.js");
  const firstResponse = vi.fn();
  first.getListener()?.({ type: "CLASSIFY_ROWS", epoch: 1, items: [item()] }, { tab: { id: 41 } }, firstResponse);
  await vi.waitFor(() => expect(firstResponse).toHaveBeenCalledWith({ accepted: 1, rejected: 0 }));
  await vi.waitFor(() => expect(first.chromeMock.tabs.sendMessage).toHaveBeenCalledWith(41, expect.objectContaining({ type: "CLASSIFY_RESULTS" })));
  const sessionCache = first.getSessionCache();

  vi.resetModules();
  vi.unstubAllGlobals();
  const second = installChrome({ enabled: true, apiUrl: "http://localhost:4555" }, sessionCache);
  const secondFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "GET"
    ? new Response(JSON.stringify({ classifierRevision: "a".repeat(64) }), { status: 200 })
    : new Response(JSON.stringify({ results: [responseFor(item().email.id)] })));
  vi.stubGlobal("fetch", secondFetch);
  await import("./background.js");
  const secondResponse = vi.fn();
  second.getListener()?.({ type: "CLASSIFY_ROWS", epoch: 1, items: [item()] }, { tab: { id: 41 } }, secondResponse);
  await vi.waitFor(() => expect(secondResponse).toHaveBeenCalledWith({ accepted: 1, rejected: 0 }));
  await vi.waitFor(() => expect(second.chromeMock.tabs.sendMessage).toHaveBeenCalledWith(41, expect.objectContaining({ type: "CLASSIFY_RESULTS" })));
  expect(secondFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  expect(secondFetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
});
