import {
  MAX_RULES,
  RULE_ACTIONS,
  RULE_PRESETS,
  type RuleAction,
} from "@cargolens/shared/rules";

export { MAX_RULES, RULE_ACTIONS, RULE_PRESETS, type RuleAction, type RulePreset } from "@cargolens/shared/rules";

export const DEFAULT_API_URL = "http://127.0.0.1:3001";

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

export function defaultInboxPolicy(): InboxPolicy {
  return { hideSpam: true, spamThreshold: 0.8, pinUrgent: true,
    rules: RULE_PRESETS.map(preset => ({ id: preset.id, label: preset.label, condition: preset.condition, action: preset.action, threshold: preset.threshold, enabled: false, preset: true })) };
}

/**
 * An API origin the extension may call.
 *
 * Loopback may stay on plain HTTP because the request never leaves the machine.
 * A remote API must be HTTPS: inbox subjects and senders travel in the request
 * body, so plaintext to a remote host is not acceptable. Credentials, paths,
 * queries and fragments are never part of an API origin and are rejected so a
 * stored setting cannot redirect requests somewhere unexpected.
 */
export function isAllowedApiUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value.trim());
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return false;
    return url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && (url.pathname === "/" || url.pathname === "");
  } catch {
    return false;
  }
}

export function normalizeApiUrl(value: unknown): string {
  if (!isAllowedApiUrl(value)) return DEFAULT_API_URL;
  return new URL(value.trim()).origin;
}

/**
 * Chrome only permits fetches to origins the extension actually holds. Loopback
 * ships in the manifest; every other HTTPS origin is optional and has to be
 * granted by the user. Must be called from a user gesture, or Chrome rejects
 * the request. Resolves true when the origin is already granted outside Chrome
 * (tests, bundling) so callers can treat it as a single gate.
 */
export async function ensureHostPermission(apiUrl: string): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.permissions) return true;
  const origins = [`${normalizeApiUrl(apiUrl)}/*`];
  try {
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
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
