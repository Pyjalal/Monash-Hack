import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import { CargoLensController } from "./content.js";
import { gmailAdapter } from "./adapters.js";
import type { ContentRuntime } from "./content.js";
import type { ExtensionMessage, RowResultMessage } from "./messages.js";

function fixture(): string {
  return readFileSync(fileURLToPath(new URL("../testfixtures/gmail-inbox.html", import.meta.url)), "utf8");
}

function result(id: string, confidence = 0.92): RowResultMessage["result"] {
  return {
    id,
    status: "classified",
    classification: {
      id,
      category: "BL_COMPARISON",
      confidence,
      probabilities: { BL_COMPARISON: confidence, GENERAL: 1 - confidence },
      urgency: null,
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

function setup(enabled: boolean) {
  const window = new Window({ url: "https://mail.google.com/mail/u/0/#inbox" });
  window.document.body.innerHTML = fixture();
  const listeners: Array<(message: ExtensionMessage) => void> = [];
  const sent: ExtensionMessage[] = [];
  const runtime: ContentRuntime = {
    sendMessage: vi.fn(async (message: ExtensionMessage) => {
      sent.push(message);
      if (message.type === "GET_SETTINGS") return { enabled, apiUrl: "http://127.0.0.1:3001" };
      return { accepted: 1, rejected: 0 };
    }),
    onMessage: (listener) => { listeners.push(listener); return () => undefined; },
  };
  return { window, sent, listeners, runtime, controller: new CargoLensController(window.document, gmailAdapter, runtime) };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

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
    const firstItem = firstRequest.items[0];
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", items: [{ rowKey: firstItem.rowKey, fingerprint: firstItem.fingerprint, result: result(firstItem.email.id) }] }));
    expect(firstRow.querySelector("[data-cargolens-badge]")).not.toBeNull();

    const subject = firstRow.querySelector(".y6") as HTMLElement;
    subject.textContent = "Updated BL";
    await state.controller.scan();
    await flush();
    const requests = state.sent.filter((message): message is Extract<ExtensionMessage, { type: "CLASSIFY_ROWS" }> => message.type === "CLASSIFY_ROWS");
    const secondItem = requests[1].items[0];
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", items: [{ rowKey: firstItem.rowKey, fingerprint: firstItem.fingerprint, result: result(firstItem.email.id, 0.2) }] }));
    const staleLabel = firstRow.querySelector("[data-cargolens-badge]")?.shadowRoot?.textContent ?? "";
    expect(staleLabel).toContain("scanning");
    state.listeners.forEach((listener) => listener({ type: "CLASSIFY_RESULTS", items: [{ rowKey: secondItem.rowKey, fingerprint: secondItem.fingerprint, result: result(secondItem.email.id, 0.2) }] }));
    expect(firstRow.querySelector("[data-cargolens-badge]")?.shadowRoot?.textContent).toContain("uncertain");

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
