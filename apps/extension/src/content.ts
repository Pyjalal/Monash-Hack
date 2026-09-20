import type { InboxAdapter } from "./adapters.js";
import { adapterForHost } from "./adapters.js";
import type { ClassificationPreview, ExtensionMessage, RowClassifyResult, RowResultMessage } from "./messages.js";
import { fingerprintCandidate, type FingerprintedRow } from "./fingerprints.js";
import { decideRow, isUrgent, type RowDecision } from "./inbox-actions.js";
import { defaultInboxPolicy, parseInboxPolicy, type InboxPolicy } from "./settings.js";

export const HIDDEN_ATTRIBUTE = "data-cargolens-hidden";
const PINNED_ATTRIBUTE = "data-cargolens-pinned";
const HIGHLIGHT_ATTRIBUTE = "data-cargolens-highlight";

interface RowLayout {
  element: Element;
  originalParent: Element | null;
  originalNext: Element | null;
  inlineDisplay: string;
  inlineBoxShadow: string;
}

export interface ContentRuntime {
  sendMessage(message: ExtensionMessage): Promise<unknown>;
  onMessage(listener: (message: ExtensionMessage) => void): () => void;
}

interface RowRecord extends FingerprintedRow {
  element: Element;
  result?: RowClassifyResult;
  decision?: RowDecision;
}

type BadgeState =
  | { kind: "loading" }
  | { kind: "error"; code: string; message: string }
  | { kind: "classified"; classification: ClassificationPreview };

const palette = {
  bg: "#f4f0f4",
  surface: "#fdfafd",
  accent: "#754369",
  ink: "#342732",
  muted: "#735e70",
  wash: "#eae1e8",
};

const badgeStyle = `
:host { all: initial; display: inline-flex; vertical-align: middle; margin-inline-start: 8px; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.badge { align-items: center; border: 1px solid ${palette.wash}; border-radius: 999px; background: ${palette.bg}; color: ${palette.ink}; display: inline-flex; gap: 5px; line-height: 1; max-width: 300px; padding: 5px 8px; font-size: 11px; font-weight: 650; }
.badge.urgent { background: ${palette.accent}; border-color: ${palette.accent}; color: ${palette.surface}; }
.badge.error { color: ${palette.accent}; }
.badge.uncertain { border-color: ${palette.accent}; color: ${palette.accent}; }
.badge.filtered { border-color: ${palette.accent}; }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { border: 0; border-radius: 999px; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 2px 4px; }
button:focus-visible { outline: 2px solid ${palette.accent}; outline-offset: 2px; }
`;

export class CargoLensController {
  private readonly root: Document;
  private readonly adapter: InboxAdapter;
  private readonly runtime: ContentRuntime;
  private cacheContext: string | undefined;
  private enabled = true;
  private observer: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private revisionTimer: ReturnType<typeof setInterval> | null = null;
  private scanToken = 0;
  private settingsReady = false;
  private settingsEpoch = 0;
  private apiUrl = "http://127.0.0.1:3001";
  private knownRevision: string | undefined;
  private revisionNeedsRefresh = false;
  private trayCollapsed = false;
  private inbox: InboxPolicy = defaultInboxPolicy();
  private revealHidden = false;
  private readonly current = new Map<string, RowRecord>();
  private readonly pending = new Map<string, RowRecord>();
  private readonly badgeHosts = new Map<string, HTMLElement>();
  private readonly urgent = new Map<string, RowRecord>();
  private readonly hidden = new Map<string, RowLayout>();
  private readonly pinned = new Map<string, RowLayout>();
  private readonly highlighted = new Map<string, RowLayout>();
  private trayHost: HTMLElement | null = null;
  private removeRuntimeListener: (() => void) | null = null;

  constructor(root: Document, adapter: InboxAdapter, runtime: ContentRuntime) {
    this.root = root;
    this.adapter = adapter;
    this.runtime = runtime;
    this.cacheContext = cacheContext(root);
  }

  async start(): Promise<void> {
    this.removeRuntimeListener = this.runtime.onMessage((message) => this.handleMessage(message));
    this.root.addEventListener("keydown", this.handleKeydown);
    this.root.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.observer = new MutationObserver(() => {
      if (!this.settingsReady) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.scan(), 250);
    });
    const target = this.root.body ?? this.root.documentElement;
    if (target) this.observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "class", "data-conversation-id", "data-convid", "data-from", "data-preview", "data-snippet", "data-subject", "data-thread-id", "data-legacy-thread-id", "email", "aria-label", "hidden", "role", "style"],
    });
    await this.runtime.sendMessage({ type: "GET_SETTINGS" }).then((response) => {
      if (response && typeof response === "object" && "enabled" in response && typeof response.enabled === "boolean") {
        const value = response as { enabled: boolean; apiUrl?: unknown; epoch?: unknown; inbox?: unknown };
        this.enabled = value.enabled;
        if (typeof value.apiUrl === "string") this.apiUrl = value.apiUrl;
        if (typeof value.epoch === "number" && Number.isInteger(value.epoch)) this.settingsEpoch = value.epoch;
        if (value.inbox !== undefined) this.inbox = parseInboxPolicy(value.inbox);
        if (!this.enabled) this.clearPresentation();
      }
    }).catch(() => undefined);
    this.settingsReady = true;
    this.revisionTimer = setInterval(() => this.checkRevision(), 30_000);
    if (this.enabled) await this.scan();
  }

  stop(): void {
    this.observer?.disconnect();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.revisionTimer) clearInterval(this.revisionTimer);
    this.removeRuntimeListener?.();
    this.root.removeEventListener("keydown", this.handleKeydown);
    this.root.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearPresentation();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async scan(): Promise<void> {
    if (!this.enabled) return;
    this.syncContext();
    const token = ++this.scanToken;
    const candidates = this.adapter.extractRows(this.root);
    const candidateKeys = new Set(candidates.map((candidate) => candidate.rowKey));
    this.prune(candidateKeys);
    const rows = await Promise.all(candidates.map((candidate) => fingerprintCandidate(candidate)));
    if (token !== this.scanToken || !this.enabled) return;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const element = candidates[index].element;
      if (!element) continue;
      const prior = this.current.get(row.candidate.rowKey);
      if (prior?.fingerprint === row.fingerprint && prior.element === element) {
        prior.candidate.badgeTarget = row.candidate.badgeTarget;
        if (!this.badgeAttached(prior)) this.renderBadge(prior, this.badgeStateFor(prior));
        continue;
      }
      this.removePending(row.candidate.rowKey);
      const record: RowRecord = { ...row, element };
      this.current.set(row.candidate.rowKey, record);
      this.pending.set(`${row.candidate.rowKey}\u241f${row.fingerprint}`, record);
      this.renderBadge(record, { kind: "loading" });
    }
    this.applyLayout();
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.pending.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const rows = [...this.pending.values()];
      this.pending.clear();
      for (let index = 0; index < rows.length; index += 20) {
        const chunk = rows.slice(index, index + 20).map(({ candidate, fingerprint, email }) => ({
          source: candidate.source,
          context: this.cacheContext,
          rowKey: candidate.rowKey,
          fingerprint,
          email,
        }));
        const epoch = this.settingsEpoch;
        void this.runtime.sendMessage({ type: "CLASSIFY_ROWS", epoch, items: chunk }).catch(() => {
          if (!this.enabled || epoch !== this.settingsEpoch) return;
          for (const row of rows.slice(index, index + 20)) {
            if (this.current.get(row.candidate.rowKey) === row && isVisible(row.element))
              this.renderBadge(row, { kind: "error", code: "PREVIEW_UNAVAILABLE", message: "Preview unavailable" });
          }
        });
      }
    }, 40);
  }

  private queueRevisionCheck(): void {
    if (!this.enabled || this.root.visibilityState === "hidden") return;
    if (this.syncContext()) {
      void this.scan();
      return;
    }
    for (const record of this.current.values()) {
      if (isVisible(record.element)) this.pending.set(`${record.candidate.rowKey}\u241f${record.fingerprint}`, record);
    }
    this.revisionNeedsRefresh = false;
    this.scheduleFlush();
  }

  private checkRevision(): void {
    if (!this.enabled || this.root.visibilityState === "hidden") return;
    const epoch = this.settingsEpoch;
    const context = this.cacheContext;
    void this.runtime.sendMessage({ type: "CHECK_REVISION" }).then((response) => {
      if (!this.enabled || epoch !== this.settingsEpoch || context !== this.cacheContext || !response || typeof response !== "object" || !("revision" in response) || typeof response.revision !== "string") return;
      const shouldRefresh = this.revisionNeedsRefresh || this.knownRevision === undefined || this.knownRevision !== response.revision;
      this.knownRevision = response.revision;
      if (shouldRefresh) this.queueRevisionCheck();
    }).catch(() => undefined);
  }

  private handleVisibilityChange = (): void => {
    if (this.root.visibilityState !== "visible") return;
    if (this.syncContext()) void this.scan();
    else this.checkRevision();
  };

  private syncContext(): boolean {
    const nextContext = cacheContext(this.root);
    if (nextContext === this.cacheContext) return false;
    this.cacheContext = nextContext;
    this.clearPresentation();
    return true;
  }

  private handleMessage(message: ExtensionMessage): void {
    if (message.type === "TOGGLE_ENABLED") {
      this.setEnabled(!this.enabled);
      return;
    }
    if (message.type === "SETTINGS_UPDATED") {
      const changed = message.enabled !== this.enabled || message.apiUrl !== this.apiUrl || message.epoch !== this.settingsEpoch;
      if (changed) this.applySettings(message.enabled, message.apiUrl, message.epoch, message.inbox);
      return;
    }
    if (message.type !== "CLASSIFY_RESULTS" || message.epoch !== this.settingsEpoch) return;
    const revisionChanged = !!message.revision && !!this.knownRevision && message.revision !== this.knownRevision;
    if (message.revision) this.knownRevision = message.revision;
    for (const item of message.items) this.applyResult(item);
    if (revisionChanged) {
      this.revisionNeedsRefresh = true;
      this.queueRevisionCheck();
    }
  }

  private applyResult(item: RowResultMessage): void {
    if (!this.enabled) return;
    const record = this.current.get(item.rowKey);
    if (!record || record.fingerprint !== item.fingerprint) return;
    const fresh = this.adapter.extractRows(this.root).find(row => row.element === record.element && row.rowKey === item.rowKey);
    if (!fresh || fresh.subject !== record.candidate.subject || fresh.from !== record.candidate.from || fresh.snippet !== record.candidate.snippet) return;
    record.result = item.result;
    record.decision = item.result.status === "classified" ? decideRow(this.inbox, item.result.classification) : undefined;
    this.renderBadge(record, this.badgeStateFor(record));
    this.applyLayout();
  }

  private badgeStateFor(record: RowRecord): BadgeState {
    const result = record.result;
    if (!result) return { kind: "loading" };
    return result.status === "classified"
      ? { kind: "classified", classification: result.classification }
      : { kind: "error", code: result.error.code, message: result.error.message };
  }

  private badgeAttached(record: RowRecord): boolean {
    const host = this.badgeHosts.get(record.candidate.rowKey);
    const target = record.candidate.badgeTarget ?? record.element;
    return !!host && host.isConnected !== false && host.parentElement === target;
  }

  private setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.settingsEpoch += 1;
    this.clearPresentation();
    void this.runtime.sendMessage({ type: "SET_ENABLED", enabled }).catch(() => undefined);
    if (enabled) void this.scan();
  }

  private applySettings(enabled: boolean, apiUrl: string, epoch: number, inbox?: unknown): void {
    this.enabled = enabled;
    this.apiUrl = apiUrl;
    this.settingsEpoch = epoch;
    if (inbox !== undefined) this.inbox = parseInboxPolicy(inbox);
    this.clearPresentation();
    if (enabled) void this.scan();
  }

  private prune(candidateKeys: Set<string>): void {
    for (const [rowKey, record] of this.current) {
      if (!candidateKeys.has(rowKey) || !isVisible(record.element)) this.removeRecord(rowKey);
    }
    for (const [rowKey, record] of this.urgent) {
      if (!this.current.has(rowKey) || !isVisible(record.element)) this.urgent.delete(rowKey);
    }
    for (const [rowKey, host] of this.badgeHosts) {
      if (!this.current.has(rowKey) || host.isConnected === false) {
        host.remove();
        this.badgeHosts.delete(rowKey);
      }
    }
    this.renderTray();
  }

  private removePending(rowKey: string): void {
    for (const [key, row] of this.pending) if (row.candidate.rowKey === rowKey) this.pending.delete(key);
  }

  private removeRecord(rowKey: string): void {
    this.current.delete(rowKey);
    this.removePending(rowKey);
    this.urgent.delete(rowKey);
    this.restoreRow(rowKey);
    const host = this.badgeHosts.get(rowKey);
    host?.remove();
    this.badgeHosts.delete(rowKey);
  }

  private clearPresentation(): void {
    this.scanToken += 1;
    this.pending.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const rowKey of [...this.hidden.keys(), ...this.highlighted.keys()]) this.restoreRow(rowKey);
    this.unpinAll();
    this.current.clear();
    for (const host of this.badgeHosts.values()) host.remove();
    this.badgeHosts.clear();
    this.urgent.clear();
    this.trayHost?.remove();
    this.trayHost = null;
  }

  /** Number of rows currently removed from view by spam or filter policy. */
  get hiddenCount(): number {
    return this.hidden.size;
  }

  private layoutFor(record: RowRecord): RowLayout {
    const element = record.element as HTMLElement;
    return { element, originalParent: element.parentElement, originalNext: element.nextElementSibling, inlineDisplay: element.style.display, inlineBoxShadow: element.style.boxShadow };
  }

  /**
   * Re-applies hide/pin/highlight for every classified row. Idempotent so it can run after each scan:
   * hosts re-render rows and reset inline styles or order, and rows whose decision changed are restored first.
   */
  private applyLayout(): void {
    const byParent = new Map<Element, Array<{ record: RowRecord; rank: number }>>();
    for (const [rowKey, record] of this.current) {
      const decision = record.decision;
      // A row awaiting a fresh result keeps its previous placement so hidden spam does not flash back in.
      const hide = (decision ? decision.hide : this.hidden.has(rowKey)) && !this.revealHidden;
      const pin = decision ? decision.pin : this.pinned.has(rowKey);
      const element = record.element as HTMLElement;
      if (hide) {
        if (!this.hidden.has(rowKey)) this.hidden.set(rowKey, this.layoutFor(record));
        element.setAttribute(HIDDEN_ATTRIBUTE, "true");
        if (element.style.display !== "none") element.style.setProperty("display", "none", "important");
      } else if (this.hidden.has(rowKey)) this.unhide(rowKey);
      if (pin && !hide) {
        if (!this.pinned.has(rowKey)) this.pinned.set(rowKey, this.layoutFor(record));
        element.setAttribute(PINNED_ATTRIBUTE, "true");
        const parent = element.parentElement;
        if (parent) {
          const rows = byParent.get(parent) ?? [];
          rows.push({ record, rank: decision?.pinRank ?? 0 });
          byParent.set(parent, rows);
        }
      } else if (this.pinned.has(rowKey)) this.unpin(rowKey);
      if (decision?.highlight && !hide) {
        if (!this.highlighted.has(rowKey)) this.highlighted.set(rowKey, this.layoutFor(record));
        element.setAttribute(HIGHLIGHT_ATTRIBUTE, "true");
        element.style.setProperty("box-shadow", `inset 4px 0 0 ${palette.accent}`);
      } else if (this.highlighted.has(rowKey)) this.unhighlight(rowKey);
    }
    for (const [parent, rows] of byParent) {
      rows.sort((a, b) => b.rank - a.rank);
      rows.forEach(({ record }, index) => {
        const target = parent.children[index];
        if (target !== record.element) parent.insertBefore(record.element, target ?? null);
      });
    }
    this.renderTray();
  }

  private unhide(rowKey: string): void {
    const layout = this.hidden.get(rowKey);
    if (!layout) return;
    this.hidden.delete(rowKey);
    const element = layout.element as HTMLElement;
    element.removeAttribute(HIDDEN_ATTRIBUTE);
    if (layout.inlineDisplay) element.style.display = layout.inlineDisplay; else element.style.removeProperty("display");
  }

  private unpin(rowKey: string): void {
    const layout = this.pinned.get(rowKey);
    if (!layout) return;
    this.pinned.delete(rowKey);
    const { element, originalParent, originalNext } = layout;
    element.removeAttribute(PINNED_ATTRIBUTE);
    if (!element.isConnected || !originalParent?.isConnected || element.parentElement !== originalParent) return;
    if (originalNext && originalNext.parentElement === originalParent) { if (originalNext !== element.nextElementSibling) originalParent.insertBefore(element, originalNext); }
    else if (!originalNext && originalParent.lastElementChild !== element) originalParent.append(element);
  }

  /** Restores pinned rows so that a row's original neighbour is back in place before the row is moved after it. */
  private unpinAll(): void {
    const remaining = new Map(this.pinned);
    while (remaining.size) {
      let progressed = false;
      for (const [rowKey, layout] of remaining) {
        const anchorPinned = [...remaining.values()].some(other => other !== layout && other.element === layout.originalNext);
        if (anchorPinned) continue;
        this.unpin(rowKey);
        remaining.delete(rowKey);
        progressed = true;
      }
      if (!progressed) { for (const rowKey of remaining.keys()) this.unpin(rowKey); break; }
    }
  }

  private unhighlight(rowKey: string): void {
    const layout = this.highlighted.get(rowKey);
    if (!layout) return;
    this.highlighted.delete(rowKey);
    const element = layout.element as HTMLElement;
    element.removeAttribute(HIGHLIGHT_ATTRIBUTE);
    if (layout.inlineBoxShadow) element.style.boxShadow = layout.inlineBoxShadow; else element.style.removeProperty("box-shadow");
  }

  private restoreRow(rowKey: string): void {
    this.unhide(rowKey);
    this.unpin(rowKey);
    this.unhighlight(rowKey);
  }

  private renderBadge(record: RowRecord, state: BadgeState): void {
    const document = this.root;
    const target = record.candidate.badgeTarget ?? record.element;
    let host = this.badgeHosts.get(record.candidate.rowKey);
    if (!host || host.parentElement !== target) {
      host?.remove();
      host = document.createElement("span");
      host.dataset.cargolensBadge = "true";
      host.style.pointerEvents = "auto";
      target.append(host);
      this.badgeHosts.set(record.candidate.rowKey, host);
    }
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = badgeStyle;
    shadow.append(style);
    const badge = document.createElement("span");
    const categoryUncertain = state.kind === "classified" && (state.classification.category === "UNCERTAIN" || state.classification.confidence < 0.8);
    const urgencyUnclear = state.kind === "classified" && (!state.classification.urgency || state.classification.urgency.confidence < 0.6);
    badge.className = `badge${state.kind === "classified" && isUrgent(state.classification.urgency) ? " urgent" : ""}${categoryUncertain ? " uncertain" : ""}${state.kind === "error" ? " error" : ""}`;
    const label = document.createElement("span");
    label.className = "label";
    const categoryLabel = state.kind === "classified" ? categoryLabels[state.classification.category] ?? state.classification.category.replaceAll("_", " ") : "";
    const urgencyLabel = state.kind === "classified" && state.classification.urgency ? urgencyLabels[state.classification.urgency.level] : "";
    const confidenceLabel = categoryUncertain && state.classification.category !== "UNCERTAIN" ? "Uncertain" : "";
    const reasons = record.decision?.reasons.filter(reason => reason !== "Spam") ?? [];
    label.textContent = state.kind === "loading"
      ? "CargoLens · scanning"
      : state.kind === "error"
        ? `CargoLens · ${state.code}`
        : ["CargoLens", categoryLabel, urgencyUnclear ? "Urgency unclear" : urgencyLabel, confidenceLabel, ...reasons].filter(Boolean).join(" · ");
    if (reasons.length) badge.classList.add("filtered");
    badge.append(label);
    if (state.kind === "error") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.setAttribute("aria-label", `Retry CargoLens preview for ${record.candidate.subject || "this row"}`);
      retry.addEventListener("keydown", event => event.stopPropagation());
      retry.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        this.renderBadge(record, { kind: "loading" });
        void this.runtime.sendMessage({ type: "RETRY_ROW", epoch: this.settingsEpoch, bypassCache: true, item: { source: record.candidate.source, context: this.cacheContext, rowKey: record.candidate.rowKey, fingerprint: record.fingerprint, email: record.email } }).catch(() => {
          if (this.enabled && this.current.get(record.candidate.rowKey) === record) this.renderBadge(record, { kind: "error", code: "PREVIEW_UNAVAILABLE", message: "Preview unavailable" });
        });
      });
      badge.append(retry);
    }
    badge.title = state.kind === "classified"
      ? `CargoLens preview only. Model confidence ${Math.round(state.classification.confidence * 100)}%; ${urgencyUnclear ? "urgency is unclear; " : ""}this does not verify shipping documents.`
      : "CargoLens preview state";
    badge.setAttribute("aria-label", badge.title);
    shadow.append(badge);
    if (state.kind === "classified" && isUrgent(state.classification.urgency)) this.urgent.set(record.candidate.rowKey, record);
    else this.urgent.delete(record.candidate.rowKey);
    this.renderTray();
  }

  private renderTray(): void {
    const hiddenCount = this.hidden.size + (this.revealHidden ? [...this.current.values()].filter(record => record.decision?.hide).length : 0);
    if (this.urgent.size === 0 && hiddenCount === 0) {
      this.trayHost?.remove();
      this.trayHost = null;
      return;
    }
    const document = this.root;
    if (!this.trayHost) {
      this.trayHost = document.createElement("aside");
      this.trayHost.id = "cargolens-urgent-tray";
      this.trayHost.setAttribute("aria-label", "CargoLens urgent preview tray");
      document.body?.append(this.trayHost);
    }
    const shadow = this.trayHost.shadowRoot ?? this.trayHost.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `:host { all: initial; position: fixed; z-index: 2147483646; top: 76px; right: 16px; width: 280px; font-family: Inter, ui-sans-serif, system-ui, sans-serif; } .tray { border: 1px solid ${palette.wash}; border-radius: 14px; background: ${palette.surface}; box-shadow: 0 16px 40px rgba(52,39,50,.18); color: ${palette.ink}; padding: 10px; } .header { align-items: center; display: flex; gap: 8px; justify-content: space-between; } .title { font-size: 12px; font-weight: 750; letter-spacing: .04em; text-transform: uppercase; } .count { color: ${palette.accent}; font-size: 11px; } button { border: 0; border-radius: 9px; background: ${palette.bg}; color: ${palette.ink}; cursor: pointer; display: block; font: inherit; margin-top: 8px; padding: 9px; text-align: left; width: 100%; } button:hover, button:focus-visible { background: ${palette.wash}; outline: 2px solid ${palette.accent}; outline-offset: 1px; } .hint { color: ${palette.muted}; font-size: 11px; margin: 8px 0 0; }`;
    shadow.append(style);
    const tray = document.createElement("div");
    tray.className = "tray";
    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "CargoLens";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = [this.urgent.size ? `${this.urgent.size} urgent` : "", hiddenCount ? `${hiddenCount} hidden` : ""].filter(Boolean).join(" · ");
    header.append(title, count);
    tray.append(header);
    if (hiddenCount) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "reveal";
      reveal.textContent = this.revealHidden ? `Hide ${hiddenCount} filtered row${hiddenCount === 1 ? "" : "s"} again` : `Show ${hiddenCount} hidden row${hiddenCount === 1 ? "" : "s"} (spam and filters)`;
      reveal.setAttribute("aria-pressed", String(this.revealHidden));
      reveal.addEventListener("click", () => { this.revealHidden = !this.revealHidden; this.applyLayout(); });
      tray.append(reveal);
    }
    if (!this.trayCollapsed) {
      for (const record of this.urgent.values()) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${record.candidate.subject || "Untitled"} · ${record.candidate.source}`;
        button.addEventListener("click", () => {
          record.element.scrollIntoView({ block: "center", behavior: "smooth" });
          (record.element as HTMLElement).click();
        });
        tray.append(button);
      }
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Preview only · use the native inbox to open a row.";
      tray.append(hint);
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = this.trayCollapsed ? "Show tray" : "Hide tray";
    toggle.addEventListener("click", () => { this.trayCollapsed = !this.trayCollapsed; this.renderTray(); });
    tray.append(toggle);
    shadow.append(tray);
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      this.setEnabled(!this.enabled);
    }
  };
}

function cacheContext(root: Document): string | undefined {
  const href = root.defaultView?.location?.href ?? "";
  const match = href.match(/\/mail\/u\/([^/?#]+)/i);
  return match?.[1] ? `gmail:${match[1]}` : undefined;
}

const categoryLabels: Record<string, string> = {
  BL_COMPARISON: "BL check",
  SI_REQUEST: "Shipping instructions",
  INVOICE_QUERY: "Invoice",
  GENERAL: "General",
  SPAM: "Spam",
  UNCERTAIN: "Uncertain",
};

const urgencyLabels: Record<string, string> = {
  routine: "Routine",
  week: "This week",
  today: "Today",
  blocking: "Blocking",
};

export function startContentScript(document: Document = window.document, runtime: ContentRuntime = chromeRuntime()): CargoLensController | null {
  const adapter = adapterForHost(window.location.hostname);
  if (!adapter) return null;
  const controller = new CargoLensController(document, adapter, runtime);
  void controller.start();
  return controller;
}

function isVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.isConnected === false || current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") return false;
    if (current.getAttribute(HIDDEN_ATTRIBUTE) === "true") continue;
    const style = view?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

function chromeRuntime(): ContentRuntime {
  return {
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    onMessage: (listener) => {
      const wrapped = (message: unknown) => listener(message as ExtensionMessage);
      chrome.runtime.onMessage.addListener(wrapped);
      return () => chrome.runtime.onMessage.removeListener(wrapped);
    },
  };
}

if (typeof window !== "undefined" && typeof chrome !== "undefined") startContentScript();
