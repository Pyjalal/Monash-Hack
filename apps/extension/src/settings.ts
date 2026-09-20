export const DEFAULT_API_URL = "http://127.0.0.1:3001";

export const RULE_ACTIONS = ["pin", "hide", "highlight"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export const MAX_RULES = 8;

/** A smart filter: Jev judges `condition`; the extension applies `action` when the probability reaches `threshold`. */
export interface FilterRule {
  id: string;
  label: string;
  condition: string;
  action: RuleAction;
  threshold: number;
  enabled: boolean;
  preset?: boolean;
}

/** How the content script acts on classified rows. Everything here is local policy; changing it never re-runs Jev. */
export interface InboxPolicy {
  hideSpam: boolean;
  spamThreshold: number;
  pinUrgent: boolean;
  rules: FilterRule[];
}

export interface ExtensionSettings {
  enabled: boolean;
  apiUrl: string;
  inbox: InboxPolicy;
}

export interface RulePreset { id: string; label: string; description: string; condition: string; action: RuleAction; threshold: number }

/**
 * Shipping-and-logistics starter filters. Mirrors `@cargolens/shared/rules` presets; kept inline so the
 * content bundle stays dependency-free. Thresholds were chosen from `tools/eval/src/rules.ts` runs.
 */
export const RULE_PRESETS: readonly RulePreset[] = [
  { id: "needs_reply_now", label: "Needs my reply now", action: "pin", threshold: 0.7,
    description: "Direct questions, confirmations, approvals or documents the sender is waiting on today.",
    condition: "The sender is waiting on a reply or action from the recipient's operations team and expects it today or before an imminent stated cutoff: a direct question, a request to confirm, approve, amend or send documents, or a decision that is blocking them. Pure FYI updates, thank-you notes and automated notices do not qualify." },
  { id: "cargo_blocked", label: "Cargo or release blocked", action: "pin", threshold: 0.7,
    description: "Customs holds, missing documents, unpaid charges or unreleased delivery orders stopping cargo.",
    condition: "Cargo release, customs clearance, loading, gate-in or delivery for a specific booked shipment (identified by a booking, container, vessel or BL reference) is currently on hold or blocked pending an action, for example a customs hold or inspection, a missing or rejected document, unpaid charges, or a delivery order that has not been released. Generic parcel-delivery or small-fee payment notices with no shipment reference and a link to pay do not qualify." },
  { id: "schedule_change", label: "Vessel or cut-off change", action: "highlight", threshold: 0.7,
    description: "Rollovers, blank sailings, cut-off changes, port omissions and transshipment delays.",
    condition: "A vessel schedule change affecting a booked shipment: a rollover to a later vessel, blank sailing, changed SI or cargo cut-off, port omission, transshipment delay or revised ETD/ETA that the recipient must plan around." },
  { id: "charges_dispute", label: "Charges or payment issue", action: "highlight", threshold: 0.7,
    description: "Demurrage, detention, storage disputes and overdue freight payment reminders.",
    condition: "A dispute or reminder about money for a shipment: demurrage, detention, storage or other surcharge disputes, an overdue freight invoice, a payment reminder, or a request to correct billed amounts." },
  { id: "automated_notice", label: "Automated notice, no action", action: "hide", threshold: 0.8,
    description: "Tracking updates, auto-acknowledgements, EDI status messages and process-completed notices.",
    condition: "An automated system notification that requires no action from the recipient, such as a container tracking update, an auto-acknowledgement or ticket receipt, an EDI or portal status message, or a process-completed notice. Anything asking for a decision, document or reply does not qualify." },
  { id: "marketing", label: "Marketing and newsletters", action: "hide", threshold: 0.8,
    description: "Rate promotions, webinars, newsletters and carrier or forwarder advertising not tied to a booking.",
    condition: "Marketing or promotional content not tied to a specific booked shipment: newsletters, webinar or event invitations, rate promotions, service announcements sent to a mailing list, or carrier and forwarder advertising." },
];

export function defaultInboxPolicy(): InboxPolicy {
  return { hideSpam: true, spamThreshold: 0.8, pinUrgent: true,
    rules: RULE_PRESETS.map(preset => ({ id: preset.id, label: preset.label, condition: preset.condition, action: preset.action, threshold: preset.threshold, enabled: false, preset: true })) };
}

export function isLoopbackApiUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && (url.pathname === "/" || url.pathname === "");
  } catch {
    return false;
  }
}

export function normalizeApiUrl(value: unknown): string {
  if (!isLoopbackApiUrl(value)) return DEFAULT_API_URL;
  return new URL(value.trim()).origin;
}

export function classifyEndpoint(apiUrl: string): string {
  return `${normalizeApiUrl(apiUrl)}/classify`;
}

export function rulesEndpoint(apiUrl: string): string {
  return `${normalizeApiUrl(apiUrl)}/rules/evaluate`;
}

export function healthEndpoint(apiUrl: string): string {
  return `${normalizeApiUrl(apiUrl)}/health`;
}

const ruleIdPattern = /^[a-z0-9_-]{1,48}$/;

function threshold(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 0.99 ? Math.round(value * 100) / 100 : fallback;
}

export function parseRule(value: unknown): FilterRule | null {
  if (!value || typeof value !== "object") return null;
  const rule = value as Record<string, unknown>;
  if (typeof rule.id !== "string" || !ruleIdPattern.test(rule.id)) return null;
  const condition = typeof rule.condition === "string" ? rule.condition.trim().slice(0, 600) : "";
  if (condition.length < 8) return null;
  const preset = RULE_PRESETS.find(candidate => candidate.id === rule.id);
  const label = typeof rule.label === "string" && rule.label.trim() ? rule.label.trim().slice(0, 60) : preset?.label ?? rule.id;
  const action = RULE_ACTIONS.includes(rule.action as RuleAction) ? rule.action as RuleAction : preset?.action ?? "highlight";
  return { id: rule.id, label, condition, action, threshold: threshold(rule.threshold, preset?.threshold ?? 0.7), enabled: rule.enabled === true, preset: !!preset && rule.preset !== false };
}

export function parseInboxPolicy(value: unknown): InboxPolicy {
  const defaults = defaultInboxPolicy();
  if (!value || typeof value !== "object") return defaults;
  const policy = value as Record<string, unknown>;
  const rules: FilterRule[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(policy.rules) ? policy.rules : []) {
    const rule = parseRule(raw);
    if (!rule || seen.has(rule.id) || rules.length >= MAX_RULES) continue;
    seen.add(rule.id);
    rules.push(rule);
  }
  for (const preset of defaults.rules) if (!seen.has(preset.id) && rules.length < MAX_RULES) rules.push(preset);
  return {
    hideSpam: typeof policy.hideSpam === "boolean" ? policy.hideSpam : defaults.hideSpam,
    spamThreshold: threshold(policy.spamThreshold, defaults.spamThreshold),
    pinUrgent: typeof policy.pinUrgent === "boolean" ? policy.pinUrgent : defaults.pinUrgent,
    rules,
  };
}

/** Rules Jev must evaluate. Only enabled rules cost a question; the key changes only when their conditions do. */
export function activeRules(policy: InboxPolicy): Array<{ id: string; condition: string }> {
  return policy.rules.filter(rule => rule.enabled).map(rule => ({ id: rule.id, condition: rule.condition }));
}

export function rulesKey(policy: InboxPolicy): string {
  return activeRules(policy).map(rule => `${rule.id}=${rule.condition}`).sort().join("\u241f");
}

export function parseSettings(value: unknown): ExtensionSettings {
  const settings = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: settings.enabled !== false,
    apiUrl: normalizeApiUrl(settings.apiUrl),
    inbox: parseInboxPolicy(settings.inbox),
  };
}
