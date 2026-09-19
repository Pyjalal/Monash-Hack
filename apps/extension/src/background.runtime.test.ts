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

function installChrome(settings: { enabled: boolean; apiUrl: string }) {
  let listener: RuntimeListener | undefined;
  const storage = { ...settings };
  const chromeMock = {
    runtime: { onMessage: { addListener: (value: RuntimeListener) => { listener = value; } } },
    storage: { sync: {
      get: vi.fn(async () => ({ ...storage })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(storage, value); }),
    } },
    tabs: {
      query: vi.fn(async () => [] as Array<{ id?: number }>),
      sendMessage: vi.fn(async () => undefined),
    },
    commands: { onCommand: { addListener: vi.fn() } },
  };
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = chromeMock;
  return { chromeMock, getListener: () => listener };
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
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [responseFor(item().email.id)] })));
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
