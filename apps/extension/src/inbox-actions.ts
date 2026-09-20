import type { ClassificationPreview } from "./messages.js";
import type { InboxPolicy } from "./settings.js";

export interface RowDecision {
  /** Remove the row from view. Never true when the row is pinned. */
  hide: boolean;
  /** Move the row to the top of its list; higher `pinRank` sorts first. */
  pin: boolean;
  pinRank: number;
  /** Visually emphasise the row without moving it. */
  highlight: boolean;
  /** Human-readable labels of the filters that fired, for the badge and tooltip. */
  reasons: string[];
  spam: boolean;
}

export function isUrgent(urgency: { level: string; confidence: number } | null | undefined): boolean {
  return !!urgency && urgency.confidence >= 0.6 && (urgency.level === "blocking" || urgency.level === "today");
}

/**
 * Turns Jev's judgments into inbox actions using only local policy. Precedence:
 * confident spam always hides (phishing can satisfy an "action needed" rule literally);
 * otherwise any pin outranks a rule-based hide so nothing needing action disappears.
 */
export function decideRow(policy: InboxPolicy, classification: ClassificationPreview): RowDecision {
  const spam = classification.category === "SPAM" && classification.confidence >= policy.spamThreshold;
  if (spam && policy.hideSpam) return { hide: true, pin: false, pinRank: 0, highlight: false, reasons: ["Spam"], spam };
  let pin = false, hide = false, highlight = false, pinRank = 0;
  const reasons: string[] = [];
  if (policy.pinUrgent && isUrgent(classification.urgency)) {
    pin = true;
    pinRank = classification.urgency!.level === "blocking" ? 30 : 20;
  }
  const probabilities = classification.rules ?? {};
  for (const rule of policy.rules) {
    const probability = probabilities[rule.id];
    if (!rule.enabled || typeof probability !== "number" || probability < rule.threshold) continue;
    reasons.push(rule.label);
    if (rule.action === "pin") { pin = true; pinRank = Math.max(pinRank, 10 + probability); }
    else if (rule.action === "hide") hide = true;
    else highlight = true;
  }
  if (pin) hide = false;
  return { hide, pin, pinRank, highlight: highlight && !hide, reasons, spam };
}
