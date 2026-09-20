import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import { CargoLensController } from "./content.js";
import { gmailAdapter, outlookAdapter } from "./adapters.js";
import type { ContentRuntime } from "./content.js";
import type { ExtensionMessage, RowResultMessage } from "./messages.js";

function fixture(): string {
  return readFileSync(fileURLToPath(new URL("../testfixtures/gmail-inbox.html", import.meta.url)), "utf8");
}

function result(id: string, confidence = 0.92, urgency: { level: string; score: number; confidence: number } | null = null): RowResultMessage["result"] {
  return {
    id,
    status: "classified",
    classification: {
      id,
      category: "BL_COMPARISON",
      confidence,
      probabilities: { BL_COMPARISON: confidence, GENERAL: 1 - confidence },
      urgency,
      expectation: null,
      expectationConfidence: null,
      model: "fixture-model",
      usage: null,
      elapsedMs: 2,
      questionVersion: "fixture-v1",
      cached: false,
    },
  };
}

function setup(enabled: boolean, outlook = false, options: { inbox?: unknown; html?: string } = {}) {
  const window = new Window({ url: "https://mail.google.com/mail/u/0/#inbox" });
  window.document.body.innerHTML = options.html ?? fixture();
  if (outlook) window.document.body.innerHTML = '<div role="listbox"><div role="option" data-convid="conversation-1"><input type="checkbox"><div class="ESO13">Operations</div><div><span class="TtcXM">Verify draft BL</span></div><span class="ASFJj">SI attached</span></div></div>';
  const listeners: Array<(message: ExtensionMessage) => void> = [];
  const sent: ExtensionMessage[] = [];
  const runtime: ContentRuntime = {
    sendMessage: vi.fn(async (message: ExtensionMessage) => {
      sent.push(message);
      if (message.type === "GET_SETTINGS") return { enabled, apiUrl: "http://127.0.0.1:3001", ...(options.inbox !== undefined ? { inbox: options.inbox } : {}) };
      return { accepted: 1, rejected: 0 };
    }),
    onMessage: (listener) => { listeners.push(listener); return () => undefined; },
  };
  return { window, sent, listeners, runtime, controller: new CargoLensController(window.document, outlook ? outlookAdapter : gmailAdapter, runtime) };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

it.each([false, true])("stops permanently when messaging loses extension context (async=%s)", async (asyncFailure) => {
  const state = setup(true, true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    vi.useFakeTimers();
    await state.controller.start();
    await vi.advanceTimersByTimeAsync(60);
    const request = state.sent.find((message) => message.type === "CLASSIFY_ROWS") as Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }>;
    const item = request.items[0];
    state.listeners[0]({ type: "CLASSIFY_RESULTS", epoch: 0, items: [{ rowKey: item.rowKey, fingerprint: item.fingerprint, result: result(item.email.id) }] });
    expect(state.window.document.querySelector("[data-cargolens-badge]")).not.toBeNull();
    vi.mocked(state.runtime.sendMessage).mockImplementation(() => {
      const error = new Error("Extension context invalidated.");
      if (asyncFailure) return Promise.reject(error);
      throw error;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.controller.isEnabled).toBe(false);
    expect(state.window.document.querySelector("[data-cargolens-badge]")).toBeNull();
    state.listeners[0]({ type: "TOGGLE_ENABLED" });
    expect(state.controller.isEnabled).toBe(false);
    const count = vi.mocked(state.runtime.sendMessage).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.runtime.sendMessage).toHaveBeenCalledTimes(count);
  } finally {
    vi.useRealTimers();
    state.controller.stop();
    globalThis.MutationObserver = prior;
  }
});

it("handles synchronous context loss during startup and listener cleanup", async () => {
  const state = setup(true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  state.runtime.onMessage = () => () => { throw new Error("Extension context invalidated."); };
  vi.mocked(state.runtime.sendMessage).mockImplementation(() => { throw new Error("Extension context invalidated."); });
  try {
    await expect(state.controller.start()).resolves.toBeUndefined();
    expect(state.controller.isEnabled).toBe(false);
    await state.controller.scan();
    expect(state.runtime.sendMessage).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.MutationObserver = prior;
  }
});

it("waits for stored disabled settings before scanning or sending rows", async () => {
  const state = setup(false);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start();
    await flush();
    expect(state.sent.map((message) => message.type)).toEqual(["GET_SETTINGS"]);
  } finally {
    globalThis.MutationObserver = prior;
    state.controller.stop();
  }
});

it("ignores stale fingerprints, prunes virtual rows, and leaves native row clicks usable", async () => {
  const state = setup(true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  let nativeClicks = 0;
  try {
    const firstRow = state.window.document.querySelector("tr.zA") as HTMLElement;
    firstRow.addEventListener("click", () => { nativeClicks += 1; });
    await state.controller.start();
    await flush();
    const firstRequest = state.sent.find((message) => message.type === "CLASSIFY_ROWS") as Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }>;
    expect(firstRequest.items).toHaveLength(1);
    expect(firstRequest.items[0].context).toBe("gmail:0");
    const firstItem = firstRequest.items[0];
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", epoch: 0, items: [{ rowKey: firstItem.rowKey, fingerprint: firstItem.fingerprint, result: result(firstItem.email.id, 0.92, { level: "blocking", score: 3, confidence: 0.9 }) }] }));
    expect(firstRow.querySelector("[data-cargolens-badge]")).not.toBeNull();
    expect(state.window.document.querySelector("#cargolens-urgent-tray")).not.toBeNull();

    const subject = firstRow.querySelector(".y6") as HTMLElement;
    subject.textContent = "Updated BL";
    await state.controller.scan();
    await flush();
    const requests = state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS");
    const secondItem = requests[1].items[0];
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", epoch: 0, items: [{ rowKey: firstItem.rowKey, fingerprint: firstItem.fingerprint, result: result(firstItem.email.id, 0.2) }] }));
    const staleLabel = firstRow.querySelector("[data-cargolens-badge]")?.shadowRoot?.textContent ?? "";
    expect(staleLabel).toContain("scanning");
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", epoch: 0, items: [{ rowKey: secondItem.rowKey, fingerprint: secondItem.fingerprint, result: result(secondItem.email.id, 0.2) }] }));
    expect(firstRow.querySelector("[data-cargolens-badge]")?.shadowRoot?.textContent).toContain("uncertain");
    expect(firstRow.querySelector("[data-cargolens-badge]")?.shadowRoot?.textContent).toContain("Urgency unclear");
    expect(state.window.document.querySelector("#cargolens-urgent-tray")).toBeNull();

    const replacement = state.window.document.createElement("tr");
    replacement.className = "zA";
    replacement.setAttribute("data-thread-id", "thread-1");
    replacement.innerHTML = '<td class="message-cell"><span class="yW" email="ops@example.test">Operations</span><span class="y6">Replacement BL</span><span class="y2">Updated row</span></td>';
    replacement.addEventListener("click", () => { nativeClicks += 1; });
    firstRow.replaceWith(replacement);
    await state.controller.scan();
    expect(firstRow.querySelector("[data-cargolens-badge]")).toBeNull();
    replacement.click();
    expect(nativeClicks).toBe(1);
  } finally {
    globalThis.MutationObserver = prior;
    state.controller.stop();
  }
});

it("invalidates pending results across endpoint and enabled-setting races", async () => {
  const state = setup(true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start();
    await flush();
    const first = state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS")[0].items[0];
    state.listeners.forEach((listener) => listener({ type: "SETTINGS_UPDATED", enabled: true, apiUrl: "http://localhost:4555", epoch: 1 }));
    await flush();
    const requests = state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS");
    const second = requests[requests.length - 1].items[0];
    expect(requests.at(-1)?.epoch).toBe(1);
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", epoch: 0, items: [{ rowKey: first.rowKey, fingerprint: first.fingerprint, result: result(first.email.id) }] }));
    expect(state.window.document.querySelector("[data-cargolens-badge]")?.shadowRoot?.textContent).toContain("scanning");
    state.listeners.forEach((listener) => listener({ type: "SETTINGS_UPDATED", enabled: false, apiUrl: "http://localhost:4555", epoch: 2 }));
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", epoch: 1, items: [{ rowKey: second.rowKey, fingerprint: second.fingerprint, result: result(second.email.id) }] }));
    expect(state.window.document.querySelector("[data-cargolens-badge]")).toBeNull();
    state.listeners.forEach((listener) => listener({ type: "SETTINGS_UPDATED", enabled: true, apiUrl: "http://localhost:4555", epoch: 3 }));
    await flush();
    const third = state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS").at(-1)?.items[0];
    expect(third).toBeDefined();
    expect(state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS").at(-1)?.epoch).toBe(3);
  } finally {
    globalThis.MutationObserver = prior;
    state.controller.stop();
  }
});

it("refreshes the cache context after a Gmail account switch", async () => {
  const state = setup(true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start();
    await flush();
    const first = state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS")[0];
    expect(first.items[0].context).toBe("gmail:0");
    state.window.history.pushState({}, "", "https://mail.google.com/mail/u/1/#inbox");
    await state.controller.scan();
    await flush();
    const requests = state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS");
    expect(requests.at(-1)?.items[0].context).toBe("gmail:1");
  } finally {
    globalThis.MutationObserver = prior;
    state.controller.stop();
  }
});

it("refreshes older visible rows when a new row first reveals a changed classifier revision", async () => {
  const state = setup(true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  const requests = () => state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS");
  try {
    await state.controller.start();
    await flush();
    const first = requests()[0].items[0];
    state.listeners.forEach(listener => listener({ type: "CLASSIFY_RESULTS", epoch: 0, revision: "a".repeat(64), items: [{ rowKey: first.rowKey, fingerprint: first.fingerprint, result: result(first.email.id) }] }));
    const newRow = state.window.document.querySelector("tr.zA")!.cloneNode(true) as HTMLElement;
    newRow.querySelectorAll("[data-cargolens-badge]").forEach(badge => badge.remove());
    newRow.setAttribute("data-thread-id", "thread-new");
    newRow.querySelector(".y6")!.textContent = "New arrival after model update";
    state.window.document.querySelector("tbody")!.append(newRow);
    await state.controller.scan();
    await flush();
    const newlyClassified = requests().at(-1)!.items[0];
    expect(newlyClassified.rowKey).not.toBe(first.rowKey);
    state.listeners.forEach(listener => listener({ type: "CLASSIFY_RESULTS", epoch: 0, revision: "b".repeat(64), items: [{ rowKey: newlyClassified.rowKey, fingerprint: newlyClassified.fingerprint, result: result(newlyClassified.email.id) }] }));
    await flush();
    expect(requests().at(-1)!.items.some(item => item.rowKey === first.rowKey)).toBe(true);
  } finally {
    state.controller.stop();
    globalThis.MutationObserver = prior;
  }
});

it("does not restore a badge when a pending transport rejects after disabling", async () => {
  const state = setup(true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  let rejectRequest: (reason: Error) => void = () => undefined;
  vi.mocked(state.runtime.sendMessage).mockImplementation(async message => {
    if (message.type === "GET_SETTINGS") return { enabled: true, apiUrl: "http://127.0.0.1:3001", epoch: 0 };
    return new Promise((_resolve, reject) => { rejectRequest = reject; });
  });
  try {
    await state.controller.start();
    await flush();
    state.listeners.forEach(listener => listener({ type: "SETTINGS_UPDATED", enabled: false, apiUrl: "http://127.0.0.1:3001", epoch: 1 }));
    rejectRequest(new Error("Worker disconnected"));
    await flush();
    expect(state.window.document.querySelector("[data-cargolens-badge]")).toBeNull();
  } finally {
    state.controller.stop();
    globalThis.MutationObserver = prior;
  }
});

it('rejects Outlook results arriving after a row is recycled but before the observer scans', async () => {
  const state = setup(true, true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start(); await flush();
    const request = state.sent.find(message => message.type === 'CLASSIFY_ROWS') as Extract<ExtensionMessage, { type: 'CLASSIFY_ROWS' }>;
    const item = request.items[0];
    const row = state.window.document.querySelector('[data-convid]')!;
    row.querySelector('.TtcXM')!.textContent = 'Different shipment';
    state.listeners.forEach(listener => listener({ type: 'CLASSIFY_RESULTS', epoch: 0, items: [{ rowKey: item.rowKey, fingerprint: item.fingerprint, result: result(item.email.id) }] }));
    expect(row.querySelector('[data-cargolens-badge]')?.shadowRoot?.textContent).toContain('scanning');
    await state.controller.scan(); await flush();
    expect(row.querySelectorAll('[data-cargolens-badge]')).toHaveLength(1);
    expect(state.sent.filter(message => message.type === 'CLASSIFY_ROWS')).toHaveLength(2);
  } finally { state.controller.stop(); globalThis.MutationObserver = prior; }
});

it('restores Outlook badges after the host re-renders row content on return to the list view', async () => {
  const state = setup(true, true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start(); await flush();
    const request = state.sent.find(message => message.type === 'CLASSIFY_ROWS') as Extract<ExtensionMessage, { type: 'CLASSIFY_ROWS' }>;
    const item = request.items[0];
    const row = state.window.document.querySelector('[data-convid]')!;
    state.listeners.forEach(listener => listener({ type: 'CLASSIFY_RESULTS', epoch: 0, items: [{ rowKey: item.rowKey, fingerprint: item.fingerprint, result: result(item.email.id) }] }));
    expect(row.querySelector('[data-cargolens-badge]')?.shadowRoot?.textContent).toContain('BL check');
    // Outlook opens a message and returns to the list: same row element and convid, but the inner content is rebuilt.
    row.innerHTML = row.innerHTML.replace(/<span data-cargolens-badge[\s\S]*?<\/span>/, '');
    expect(row.querySelector('[data-cargolens-badge]')).toBeNull();
    await state.controller.scan(); await flush();
    const badge = row.querySelector('[data-cargolens-badge]');
    expect(badge?.shadowRoot?.textContent).toContain('BL check');
    expect(badge?.parentElement).toBe(row.querySelector('.TtcXM')!.parentElement);
    expect(state.sent.filter(message => message.type === 'CLASSIFY_ROWS')).toHaveLength(1);
  } finally { state.controller.stop(); globalThis.MutationObserver = prior; }
});

function gmailRow(thread: string, subject: string): string {
  return `<tr class="zA" data-thread-id="${thread}"><td class="message-cell"><span class="yW" email="ops@example.test">Ops</span><span class="y6">${subject}</span><span class="y2">snippet ${thread}</span></td></tr>`;
}

it.each(["disable", "context loss"])("hides spam, pins urgent rows, and restores native layout on %s", async (shutdown) => {
  const html = `<div role="main"><table><tbody>${gmailRow("t1", "Newsletter")}${gmailRow("t2", "Routine SI")}${gmailRow("t3", "Reply needed")}${gmailRow("t4", "Release blocked")}</tbody></table></div>`;
  const inbox = { hideSpam: true, spamThreshold: 0.8, pinUrgent: true, rules: [{ id: "needs_reply_now", condition: "sender waits on a reply today", action: "pin", threshold: 0.7, enabled: true }] };
  const state = setup(true, false, { html, inbox });
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start(); await flush();
    const request = state.sent.find(message => message.type === "CLASSIFY_ROWS") as Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }>;
    expect(request.items).toHaveLength(4);
    const item = (thread: string) => request.items.find(candidate => candidate.rowKey === thread)!;
    const classified = (thread: string, overrides: Record<string, unknown>) => {
      const base = result(item(thread).email.id) as Extract<RowResultMessage["result"], { status: "classified" }>;
      return { rowKey: thread, fingerprint: item(thread).fingerprint, result: { ...base, classification: { ...base.classification, ...overrides } } as RowResultMessage["result"] };
    };
    state.listeners.forEach(listener => listener({ type: "CLASSIFY_RESULTS", epoch: 0, items: [
      classified("t1", { category: "SPAM", confidence: 0.97 }),
      classified("t2", {}),
      classified("t3", { rules: { needs_reply_now: 0.91 } }),
      classified("t4", { urgency: { level: "blocking", score: 3, confidence: 0.9 } }),
    ] }));
    const tbody = state.window.document.querySelector("tbody")!;
    const order = () => [...tbody.querySelectorAll("tr")].map(row => row.getAttribute("data-thread-id"));
    const spam = tbody.querySelector('[data-thread-id="t1"]') as unknown as HTMLElement;
    expect(order()).toEqual(["t4", "t3", "t1", "t2"]);
    expect(spam.style.display).toBe("none");
    expect(spam.getAttribute("data-cargolens-hidden")).toBe("true");
    expect(tbody.querySelector('[data-thread-id="t3"] [data-cargolens-badge]')!.shadowRoot!.textContent).toContain("Needs my reply now");
    expect(state.controller.hiddenCount).toBe(1);
    const tray = state.window.document.querySelector("#cargolens-urgent-tray")!.shadowRoot!;
    expect(tray.textContent).toContain("1 hidden");

    // The host re-renders: rows keep their identity but our inline style and order are reset.
    spam.style.removeProperty("display");
    tbody.append(tbody.querySelector('[data-thread-id="t4"]')!);
    await state.controller.scan(); await flush();
    expect(order()).toEqual(["t4", "t3", "t1", "t2"]);
    expect(spam.style.display).toBe("none");
    expect(state.sent.filter(message => message.type === "CLASSIFY_ROWS")).toHaveLength(1);

    (tray.querySelector("button.reveal") as unknown as HTMLElement).click();
    expect(spam.style.display).toBe("");
    expect(state.controller.hiddenCount).toBe(0);
    (state.window.document.querySelector("#cargolens-urgent-tray")!.shadowRoot!.querySelector("button.reveal") as unknown as HTMLElement).click();
    expect(spam.style.display).toBe("none");

    if (shutdown === "disable") {
      state.listeners.forEach(listener => listener({ type: "TOGGLE_ENABLED" }));
    } else {
      vi.mocked(state.runtime.sendMessage).mockImplementation(() => { throw new Error("Extension context invalidated."); });
      state.window.document.dispatchEvent(new state.window.Event("visibilitychange"));
      await flush();
      expect(state.controller.isEnabled).toBe(false);
    }
    expect(spam.style.display).toBe("");
    expect(spam.hasAttribute("data-cargolens-hidden")).toBe(false);
    expect(order()).toEqual(["t1", "t2", "t3", "t4"]);
    expect(tbody.querySelectorAll("[data-cargolens-pinned]")).toHaveLength(0);
  } finally { state.controller.stop(); globalThis.MutationObserver = prior; }
});

it("leaves rows untouched when hiding and pinning are switched off", async () => {
  const html = `<div role="main"><table><tbody>${gmailRow("t1", "Newsletter")}${gmailRow("t2", "Release blocked")}</tbody></table></div>`;
  const state = setup(true, false, { html, inbox: { hideSpam: false, pinUrgent: false, rules: [] } });
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start(); await flush();
    const request = state.sent.find(message => message.type === "CLASSIFY_ROWS") as Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }>;
    const items = request.items.map(item => {
      const base = result(item.email.id, 0.97, item.rowKey === "t2" ? { level: "blocking", score: 3, confidence: 0.9 } : null) as Extract<RowResultMessage["result"], { status: "classified" }>;
      const classification = item.rowKey === "t1" ? { ...base.classification, category: "SPAM" } : base.classification;
      return { rowKey: item.rowKey, fingerprint: item.fingerprint, result: { ...base, classification } as RowResultMessage["result"] };
    });
    state.listeners.forEach(listener => listener({ type: "CLASSIFY_RESULTS", epoch: 0, items }));
    const rows = [...state.window.document.querySelectorAll("tr")] as unknown as HTMLElement[];
    expect(rows.map(row => row.getAttribute("data-thread-id"))).toEqual(["t1", "t2"]);
    expect(rows.every(row => !row.style.display && !row.hasAttribute("data-cargolens-hidden"))).toBe(true);
    expect(state.controller.hiddenCount).toBe(0);
  } finally { state.controller.stop(); globalThis.MutationObserver = prior; }
});

it('keeps Outlook retry failures visible without triggering native row actions', async () => {
  const state = setup(true, true);
  const prior = globalThis.MutationObserver;
  globalThis.MutationObserver = state.window.MutationObserver as unknown as typeof MutationObserver;
  try {
    await state.controller.start(); await flush();
    const request = state.sent.find(message => message.type === 'CLASSIFY_ROWS') as Extract<ExtensionMessage, { type: 'CLASSIFY_ROWS' }>;
    const item = request.items[0];
    const row = state.window.document.querySelector('[data-convid]')!;
    let clicks = 0; let keys = 0;
    row.addEventListener('click', () => { clicks++; });
    row.addEventListener('keydown', () => { keys++; });
    state.listeners.forEach(listener => listener({ type: 'CLASSIFY_RESULTS', epoch: 0, items: [{ rowKey: item.rowKey, fingerprint: item.fingerprint, result: { id: item.email.id, status: 'error', error: { code: 'PREVIEW_UNAVAILABLE', message: 'Offline' } } }] }));
    vi.mocked(state.runtime.sendMessage).mockRejectedValue(new Error('Worker unavailable'));
    const retry = row.querySelector('[data-cargolens-badge]')!.shadowRoot!.querySelector('button')!;
    retry.dispatchEvent(new state.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    retry.click(); await flush();
    expect(clicks).toBe(0); expect(keys).toBe(0);
    expect(row.querySelector('[data-cargolens-badge]')!.shadowRoot!.textContent).toContain('PREVIEW_UNAVAILABLE');
    const checkbox = row.querySelector('input')!;
    checkbox.click();
    expect(checkbox.checked).toBe(true); expect(clicks).toBe(1);
  } finally { state.controller.stop(); globalThis.MutationObserver = prior; }
});
