import type { QueueItem, RowClassifyResult, RowResultMessage } from "./messages.js";
import { isClassifyResult } from "./messages.js";
import { activeRules, classifyEndpoint, DEFAULT_API_URL, defaultInboxPolicy, normalizeApiUrl, parseInboxPolicy, parseSettings, rulesKey, type InboxPolicy } from "./settings.js";
import { PreviewCache, resultForEmail } from "./preview-cache.js";

const MAX_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 120;
const FETCH_TIMEOUT_MS = 8_000;

interface QueueEntry extends QueueItem {
  tabId: number;
  settingsEpoch: number;
  bypassCache: boolean;
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

type RuleList = Array<{ id: string; condition: string }>;

export class ClassificationQueue {
  private readonly pending: QueueEntry[] = [];
  private readonly keys = new Set<string>();
  private readonly transport: QueueTransport;
  private readonly apiUrl: string | (() => string);
  private readonly cache: PreviewCache | null;
  private readonly rules: () => RuleList;
  private readonly activeControllers = new Set<AbortController>();
  private pumpPromise: Promise<void> | null = null;
  private accepting = true;
  private generation = 0;
  private cacheRevision: string | null = null;

  constructor(transport: QueueTransport, apiUrl: string | (() => string) = () => classifyEndpoint(DEFAULT_API_URL), cache: PreviewCache | null = null, rules: () => RuleList = () => []) {
    this.transport = transport;
    this.apiUrl = apiUrl;
    this.cache = cache;
    this.rules = rules;
  }

  enqueue(tabId: number, items: unknown[], settingsEpoch = 0, bypassCache = false): { accepted: QueueItem[]; rejected: QueueRejection[] } {
    const accepted: QueueItem[] = [];
    const rejected: QueueRejection[] = [];
    for (const raw of items) {
      const item = raw as QueueItem;
      if (!validItem(item)) {
        rejected.push({ item, error: { code: "INVALID_ROW", message: "The visible row did not match the preview contract." } });
        continue;
      }
      if (!this.accepting) {
        rejected.push({ item, error: { code: "DISABLED", message: "CargoLens preview is disabled." } });
        continue;
      }
      const key = `${tabId}\u241f${item.source}\u241f${item.rowKey}\u241f${item.fingerprint}`;
      if (this.keys.has(key)) continue;
      if (this.pending.length >= MAX_QUEUE_SIZE) {
        rejected.push({ item, error: { code: "QUEUE_FULL", message: "CargoLens preview queue is full; retry this row." } });
        continue;
      }
      this.keys.add(key);
      this.pending.push({ ...item, tabId, settingsEpoch, bypassCache: bypassCache || item.bypassCache === true });
      accepted.push(item);
    }
    this.startPump();
    return { accepted, rejected };
  }

  get size(): number {
    return this.pending.length;
  }

  setEnabled(enabled: boolean): void {
    this.accepting = enabled;
    this.invalidate();
  }

  invalidate(): void {
    this.generation += 1;
    this.pending.splice(0, this.pending.length);
    this.keys.clear();
    for (const controller of this.activeControllers) controller.abort();
  }

  async invalidateCache(): Promise<void> {
    this.cacheRevision = null;
    await this.cache?.clear();
  }

  async checkRevision(): Promise<string | null> {
    if (!this.cache) return null;
    return this.prepareCache();
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
    const generation = this.generation;
    const revision = await this.prepareCache();
    if (generation !== this.generation) return;
    while (this.pending.length) {
      if (generation !== this.generation) return;
      const batch = this.pending.splice(0, MAX_BATCH_SIZE);
      await this.classify(batch, revision);
    }
  }

  private async prepareCache(): Promise<string | null> {
    if (!this.cache) return null;
    const generation = this.generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    this.activeControllers.add(controller);
    try {
      await this.cache.hydrate();
      const endpoint = typeof this.apiUrl === "function" ? this.apiUrl() : this.apiUrl;
      const healthUrl = endpoint.endsWith("/classify") ? `${endpoint.slice(0, -"/classify".length)}/health` : `${endpoint}/health`;
      const response = await this.transport.request(healthUrl, { method: "GET", cache: "no-store", signal: controller.signal });
      if (!response.ok) return null;
      if (generation !== this.generation) return null;
      const body = await response.json() as { classifierRevision?: unknown };
      if (typeof body.classifierRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.classifierRevision)) return null;
      if (this.cacheRevision && this.cacheRevision !== body.classifierRevision) await this.cache.clear();
      this.cacheRevision = body.classifierRevision;
      return body.classifierRevision;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private async classify(batch: QueueEntry[], revision: string | null): Promise<void> {
    const generation = this.generation;
    const controller = new AbortController();
    const endpoint = typeof this.apiUrl === "function" ? this.apiUrl() : this.apiUrl;
    const resultByGroup = new Map<string, RowClassifyResult>();
    const groupEntries = new Map<string, QueueEntry[]>();
    const cachedGroups = new Set<string>();
    const rules = this.rules();
    const rulesTag = rules.map((rule) => `${rule.id}=${rule.condition}`).sort().join("\u241e");
    const cacheKey = (entry: QueueEntry): string => `cache\u241f${entry.context || `tab:${entry.tabId}`}\u241f${endpoint}\u241f${revision ?? "no-revision"}\u241f${rulesTag}\u241f${entry.fingerprint}`;
    const groupKey = (entry: QueueEntry): string => entry.bypassCache
      ? `retry:${entry.rowKey}\u241f${entry.context || `tab:${entry.tabId}`}\u241f${endpoint}\u241f${revision ?? "no-revision"}\u241f${rulesTag}\u241f${entry.fingerprint}`
      : cacheKey(entry);

    if (revision && this.cache) {
      for (const entry of batch) {
        const key = groupKey(entry);
        if (entry.bypassCache) {
          const entries = groupEntries.get(key) ?? [];
          entries.push(entry);
          groupEntries.set(key, entries);
          continue;
        }
        if (cachedGroups.has(key)) {
          groupEntries.get(key)?.push(entry);
          continue;
        }
        const existing = groupEntries.get(key);
        if (existing) {
          existing.push(entry);
          continue;
        }
        let cached: RowClassifyResult | null = null;
        try {
          cached = await this.cache.get(key);
        } catch {
          cached = null;
        }
        if (cached) {
          resultByGroup.set(key, cached);
          cachedGroups.add(key);
          groupEntries.set(key, [entry]);
        } else {
          groupEntries.set(key, [entry]);
        }
      }
    } else {
      for (const entry of batch) {
        const key = groupKey(entry);
        const entries = groupEntries.get(key) ?? [];
        entries.push(entry);
        groupEntries.set(key, entries);
      }
    }

    const misses = [...groupEntries.entries()].filter(([key]) => !resultByGroup.has(key));
    const requestBatches: Array<{ groups: Array<[string, QueueEntry[]]>; emails: QueueItem["email"][] }> = [];
    for (const [key, entries] of misses) {
      const entry = entries[0];
      let requestBatch = requestBatches.find((candidate) => !candidate.emails.some((email) => email.id === entry.email.id));
      if (!requestBatch) {
        requestBatch = { groups: [], emails: [] };
        requestBatches.push(requestBatch);
      }
      requestBatch.groups.push([key, entries]);
      requestBatch.emails.push(entry.email);
    }
    try {
      this.activeControllers.add(controller);
      for (const requestBatch of requestBatches) {
        if (generation !== this.generation) return;
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const response = await this.transport.request(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ emails: requestBatch.emails }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP_${response.status}`);
          if (generation !== this.generation) return;
          const body = await response.json() as { results?: unknown };
          if (!Array.isArray(body.results) || body.results.some((result) => !isClassifyResult(result))) throw new Error("INVALID_RESPONSE");
          const expectedIds = new Set(requestBatch.emails.map((email) => email.id));
          const resultIds = new Set(body.results.map((result) => (result as RowClassifyResult).id));
          if (resultIds.size !== body.results.length || [...resultIds].some((id) => !expectedIds.has(id))) throw new Error("INVALID_RESPONSE");
          const byId = new Map(body.results.map((result) => [result.id, result]));
          if (rules.length) await this.attachRules(endpoint, requestBatch.emails, rules, byId, controller.signal);
          if (generation !== this.generation) return;
          for (const [key, entries] of requestBatch.groups) {
            const result = byId.get(entries[0].email.id);
            if (result) {
              resultByGroup.set(key, result);
              if (revision && this.cache) {
                try {
                  await this.cache.set(cacheKey(entries[0]), result);
                  if (generation !== this.generation) {
                    await this.cache.clear();
                    return;
                  }
                } catch {
                  continue;
                }
              }
            }
          }
        } catch (error) {
          if (generation !== this.generation) return;
          const code = error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : "PREVIEW_UNAVAILABLE";
          for (const [key] of requestBatch.groups) resultByGroup.set(key, errorResult(groupEntries.get(key)?.[0], code, "CargoLens could not reach the local preview service.").result);
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      this.activeControllers.delete(controller);
    }

    if (generation !== this.generation) return;

    const messages = batch.map((entry) => {
      const key = groupKey(entry);
      const result = resultByGroup.get(key);
      if (!result) return errorResult(entry, "MISSING_RESULT", "The preview service did not return this row.");
      if (result.status === "error") return errorResult(entry, result.error.code, result.error.message);
      const adapted = resultForEmail(result, entry.email.id, cachedGroups.has(key));
      return adapted
        ? { rowKey: entry.rowKey, fingerprint: entry.fingerprint, result: adapted }
        : errorResult(entry, "MISSING_RESULT", "The preview service did not return this row.");
    });
    await this.sendResults(batch, messages, batch[0]?.settingsEpoch ?? 0, revision);
    for (const entry of batch) this.keys.delete(this.keyFor(entry));
  }

  /** Smart filters are best-effort: a failed evaluation leaves the classification untouched rather than erroring the row. */
  private async attachRules(endpoint: string, emails: QueueItem["email"][], rules: RuleList, byId: Map<string, RowClassifyResult>, signal: AbortSignal): Promise<void> {
    const url = endpoint.endsWith("/classify") ? `${endpoint.slice(0, -"/classify".length)}/rules/evaluate` : `${endpoint}/rules/evaluate`;
    try {
      const response = await this.transport.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: emails.map(({ id, subject, from, snippet }) => ({ id, subject, from, snippet })), rules }),
        signal,
      });
      if (!response.ok) return;
      const body = await response.json() as { results?: unknown };
      if (!Array.isArray(body.results)) return;
      for (const raw of body.results) {
        const result = raw as { id?: unknown; status?: unknown; rules?: unknown };
        if (typeof result.id !== "string" || result.status !== "evaluated" || !result.rules || typeof result.rules !== "object") continue;
        const target = byId.get(result.id);
        if (!target || target.status !== "classified") continue;
        const probabilities = Object.fromEntries(Object.entries(result.rules).filter(([key, value]) => rules.some((rule) => rule.id === key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1));
        byId.set(result.id, { ...target, classification: { ...target.classification, rules: probabilities } });
      }
    } catch {
      return;
    }
  }

  private keyFor(entry: QueueEntry): string {
    return `${entry.tabId}\u241f${entry.source}\u241f${entry.rowKey}\u241f${entry.fingerprint}`;
  }

  private async sendResults(batch: QueueEntry[], messages: RowResultMessage[], settingsEpoch: number, revision: string | null = null): Promise<void> {
    const byTab = new Map<number, RowResultMessage[]>();
    for (let index = 0; index < batch.length; index += 1) {
      const tabMessages = byTab.get(batch[index].tabId) ?? [];
      tabMessages.push(messages[index]);
      byTab.set(batch[index].tabId, tabMessages);
    }
    try {
      await Promise.all([...byTab.entries()].map(([tabId, items]) => {
        const message = revision
          ? { type: "CLASSIFY_RESULTS", epoch: settingsEpoch, revision, items }
          : { type: "CLASSIFY_RESULTS", epoch: settingsEpoch, items };
        return this.transport.send(tabId, message);
      }));
    } catch {
      return;
    }
  }
}

let configuredApiUrl = DEFAULT_API_URL;
let configuredEnabled = true;
let configuredInbox: InboxPolicy = defaultInboxPolicy();
let settingsEpoch = 0;
let settingsReady: Promise<void> | null = null;
let settingsInitialized = false;

const runtimeCache = typeof chrome === "undefined" ? null : new PreviewCache(chrome.storage.session);

const runtimeQueue = typeof chrome === "undefined"
  ? null
  : new ClassificationQueue({
      request: (input, init) => fetch(input, init),
      send: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    }, () => classifyEndpoint(configuredApiUrl), runtimeCache, () => activeRules(configuredInbox));

function settingsSnapshot() {
  return { enabled: configuredEnabled, apiUrl: configuredApiUrl, inbox: configuredInbox, epoch: settingsEpoch };
}

function applySettings(enabled: boolean, apiUrl: string, inbox: InboxPolicy = configuredInbox): void {
  const transportChanged = configuredEnabled !== enabled || configuredApiUrl !== apiUrl || rulesKey(inbox) !== rulesKey(configuredInbox);
  const changed = transportChanged || JSON.stringify(inbox) !== JSON.stringify(configuredInbox);
  const invalidateCache = settingsInitialized && transportChanged;
  configuredEnabled = enabled;
  configuredApiUrl = apiUrl;
  configuredInbox = inbox;
  settingsInitialized = true;
  if (changed) {
    settingsEpoch += 1;
    runtimeQueue?.setEnabled(enabled);
    if (invalidateCache) void runtimeQueue?.invalidateCache();
  }
}

async function loadSettings(): Promise<void> {
  const settings = parseSettings(await chrome.storage.sync.get({ enabled: true, apiUrl: DEFAULT_API_URL, inbox: null }));
  applySettings(settings.enabled, settings.apiUrl, settings.inbox);
}

function ensureSettings(): Promise<void> {
  if (!settingsReady) settingsReady = loadSettings();
  return settingsReady;
}

async function broadcastSettings(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.flatMap((tab) => typeof tab.id === "number"
    ? [chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", ...settingsSnapshot() })]
    : []));
}

if (typeof chrome !== "undefined" && runtimeQueue) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const value = message as { type?: string; items?: unknown[]; item?: unknown; enabled?: boolean; apiUrl?: unknown; inbox?: unknown; epoch?: unknown; bypassCache?: unknown };
    const tabId = sender.tab?.id;
    if (value.type === "CLASSIFY_ROWS" || value.type === "RETRY_ROW") {
      if (typeof tabId !== "number") {
        sendResponse({ accepted: 0, rejected: 1 });
        return false;
      }
      const items = value.type === "CLASSIFY_ROWS" ? value.items ?? [] : [value.item];
      void ensureSettings().then(() => {
        if (!configuredEnabled) {
          void chrome.tabs.sendMessage(tabId, { type: "SETTINGS_UPDATED", ...settingsSnapshot() }).catch(() => undefined);
          sendResponse({ accepted: 0, rejected: items.length, disabled: true });
          return;
        }
        if (value.epoch !== settingsEpoch) {
          void chrome.tabs.sendMessage(tabId, { type: "SETTINGS_UPDATED", ...settingsSnapshot() }).catch(() => undefined);
          sendResponse({ accepted: 0, rejected: items.length, staleSettings: true });
          return;
        }
        const outcome = runtimeQueue.enqueue(tabId, items, settingsEpoch, value.type === "RETRY_ROW" && value.bypassCache === true);
        for (const rejected of outcome.rejected) void chrome.tabs.sendMessage(tabId, { type: "CLASSIFY_RESULTS", epoch: settingsEpoch, items: [errorResult(rejected.item, rejected.error.code, rejected.error.message)] }).catch(() => undefined);
        sendResponse({ accepted: outcome.accepted.length, rejected: outcome.rejected.length });
      }).catch(() => sendResponse({ accepted: 0, rejected: items.length, error: "SETTINGS_UNAVAILABLE" }));
      return true;
    }
    if (value.type === "CHECK_REVISION") {
      void ensureSettings().then(async () => {
        sendResponse({ revision: configuredEnabled ? await runtimeQueue.checkRevision() : null });
      }).catch(() => sendResponse({ revision: null }));
      return true;
    }
    if (value.type === "GET_SETTINGS") {
      void ensureSettings().then(() => sendResponse(settingsSnapshot()));
      return true;
    }
    if (value.type === "SET_ENABLED" && typeof value.enabled === "boolean") {
      void chrome.storage.sync.set({ enabled: value.enabled }).then(async () => {
        await ensureSettings();
        const settings = parseSettings(await chrome.storage.sync.get({ enabled: value.enabled, apiUrl: configuredApiUrl, inbox: configuredInbox }));
        applySettings(settings.enabled, settings.apiUrl, settings.inbox);
        await broadcastSettings();
        sendResponse(settingsSnapshot());
      });
      return true;
    }
    if (value.type === "SET_SETTINGS" && typeof value.enabled === "boolean" && typeof value.apiUrl === "string") {
      const enabled = value.enabled;
      const apiUrl = normalizeApiUrl(value.apiUrl);
      if (apiUrl !== value.apiUrl.trim().replace(/\/$/, "")) {
        sendResponse({ error: "INVALID_API_URL" });
        return false;
      }
      void ensureSettings().then(async () => {
        const inbox = value.inbox === undefined ? configuredInbox : parseInboxPolicy(value.inbox);
        await chrome.storage.sync.set({ enabled, apiUrl, inbox });
        applySettings(enabled, apiUrl, inbox);
        await broadcastSettings();
        sendResponse(settingsSnapshot());
      });
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
