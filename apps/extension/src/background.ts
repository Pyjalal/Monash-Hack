import type { QueueItem, RowClassifyResult, RowResultMessage } from "./messages.js";
import { isClassifyResult } from "./messages.js";

const API_URL = "http://127.0.0.1:3001/classify";
const MAX_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 120;
const FETCH_TIMEOUT_MS = 8_000;

interface QueueEntry extends QueueItem {
  tabId: number;
}

interface QueueTransport {
  request(input: string, init: RequestInit): Promise<Response>;
  send(tabId: number, message: unknown): Promise<unknown>;
}

interface QueueRejection {
  item: QueueItem;
  error: { code: string; message: string };
}

function validItem(item: unknown): item is QueueItem {
  if (!item || typeof item !== "object") return false;
  const value = item as Partial<QueueItem>;
  return !!value.email && typeof value.email === "object"
    && typeof value.email.id === "string" && value.email.id.length > 0 && value.email.id.length <= 512
    && typeof value.email.subject === "string" && value.email.subject.length <= 4096
    && typeof value.email.from === "string" && value.email.from.length <= 512
    && typeof value.email.snippet === "string" && value.email.snippet.length <= 8192
    && value.email.contentScope === "inbox_snippet"
    && Array.isArray(value.email.attachments) && value.email.attachments.length === 0
    && (value.source === "gmail" || value.source === "outlook")
    && typeof value.rowKey === "string" && value.rowKey.length > 0 && value.rowKey.length <= 512
    && typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function errorResult(item: Partial<QueueItem> | undefined, code: string, message: string): RowResultMessage {
  const email = item?.email as Partial<QueueItem["email"]> | undefined;
  return {
    rowKey: typeof item?.rowKey === "string" ? item.rowKey : "",
    fingerprint: typeof item?.fingerprint === "string" ? item.fingerprint : "",
    result: { id: typeof email?.id === "string" ? email.id : "unknown-row", status: "error", error: { code, message } },
  };
}

export class ClassificationQueue {
  private readonly pending: QueueEntry[] = [];
  private readonly keys = new Set<string>();
  private readonly transport: QueueTransport;
  private readonly apiUrl: string;
  private pumpPromise: Promise<void> | null = null;

  constructor(transport: QueueTransport, apiUrl = API_URL) {
    this.transport = transport;
    this.apiUrl = apiUrl;
  }

  enqueue(tabId: number, items: unknown[]): { accepted: QueueItem[]; rejected: QueueRejection[] } {
    const accepted: QueueItem[] = [];
    const rejected: QueueRejection[] = [];
    for (const raw of items) {
      const item = raw as QueueItem;
      if (!validItem(item)) {
        rejected.push({ item, error: { code: "INVALID_ROW", message: "The visible row did not match the preview contract." } });
        continue;
      }
      const key = `${item.rowKey}\u241f${item.fingerprint}`;
      if (this.keys.has(key)) continue;
      if (this.pending.length >= MAX_QUEUE_SIZE) {
        rejected.push({ item, error: { code: "QUEUE_FULL", message: "CargoLens preview queue is full; retry this row." } });
        continue;
      }
      this.keys.add(key);
      this.pending.push({ ...item, tabId });
      accepted.push(item);
    }
    this.startPump();
    return { accepted, rejected };
  }

  get size(): number {
    return this.pending.length;
  }

  async drain(): Promise<void> {
    while (this.pending.length || this.pumpPromise) {
      if (!this.pumpPromise) this.startPump();
      else await this.pumpPromise;
    }
  }

  private startPump(): void {
    if (this.pumpPromise) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      if (this.pending.length) this.startPump();
    });
  }

  private async pump(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0, MAX_BATCH_SIZE);
      await this.classify(batch);
    }
  }

  private async classify(batch: QueueEntry[]): Promise<void> {
    let results: RowClassifyResult[] | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await this.transport.request(this.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails: batch.map(({ email }) => email) }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const body = await response.json() as { results?: unknown };
        if (!Array.isArray(body.results) || body.results.some((result) => !isClassifyResult(result))) throw new Error("INVALID_RESPONSE");
        results = body.results;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const code = error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : "PREVIEW_UNAVAILABLE";
      await this.sendResults(batch, batch.map((entry) => errorResult(entry, code, "CargoLens could not reach the local preview service.")));
      for (const entry of batch) this.keys.delete(`${entry.rowKey}\u241f${entry.fingerprint}`);
      return;
    }

    const byId = new Map(results!.map((result) => [result.id, result]));
    const messages = batch.map((entry) => {
      const result = byId.get(entry.email.id);
      return result
        ? { rowKey: entry.rowKey, fingerprint: entry.fingerprint, result }
        : errorResult(entry, "MISSING_RESULT", "The preview service did not return this row.");
    });
    await this.sendResults(batch, messages);
    for (const entry of batch) this.keys.delete(`${entry.rowKey}\u241f${entry.fingerprint}`);
  }

  private async sendResults(batch: QueueEntry[], messages: RowResultMessage[]): Promise<void> {
    const byTab = new Map<number, RowResultMessage[]>();
    for (let index = 0; index < batch.length; index += 1) {
      const tabMessages = byTab.get(batch[index].tabId) ?? [];
      tabMessages.push(messages[index]);
      byTab.set(batch[index].tabId, tabMessages);
    }
    try {
      await Promise.all([...byTab.entries()].map(([tabId, items]) => this.transport.send(tabId, { type: "CLASSIFY_RESULTS", items })));
    } catch {
      return;
    }
  }
}

const runtimeQueue = typeof chrome === "undefined"
  ? null
  : new ClassificationQueue({
      request: (input, init) => fetch(input, init),
      send: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    });

if (typeof chrome !== "undefined" && runtimeQueue) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const value = message as { type?: string; items?: unknown[]; item?: unknown; enabled?: boolean };
    const tabId = sender.tab?.id;
    if (value.type === "CLASSIFY_ROWS" || value.type === "RETRY_ROW") {
      if (typeof tabId !== "number") {
        sendResponse({ accepted: 0, rejected: 1 });
        return false;
      }
      const items = value.type === "CLASSIFY_ROWS" ? value.items ?? [] : [value.item];
      const outcome = runtimeQueue.enqueue(tabId, items);
      for (const rejected of outcome.rejected) void chrome.tabs.sendMessage(tabId, { type: "CLASSIFY_RESULTS", items: [errorResult(rejected.item, rejected.error.code, rejected.error.message)] });
      sendResponse({ accepted: outcome.accepted.length, rejected: outcome.rejected.length });
      return false;
    }
    if (value.type === "GET_SETTINGS") {
      void chrome.storage.sync.get({ enabled: true }).then((settings) => sendResponse({ enabled: settings.enabled !== false }));
      return true;
    }
    if (value.type === "SET_ENABLED" && typeof value.enabled === "boolean") {
      void chrome.storage.sync.set({ enabled: value.enabled }).then(() => sendResponse({ enabled: value.enabled }));
      return true;
    }
    return false;
  });

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-cargolens") return;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId === "number") await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_ENABLED" });
  });
}
