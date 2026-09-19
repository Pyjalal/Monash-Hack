export type MailSource = "gmail" | "outlook";

export interface InboxRowCandidate {
  source: MailSource;
  rowKey: string;
  subject: string;
  from: string;
  snippet: string;
  element?: Element;
}

export interface InboxAdapter {
  readonly source: MailSource;
  extractRows(root: Document): InboxRowCandidate[];
}

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function firstAttribute(element: Element | null | undefined, names: string[]): string {
  if (!element) return "";
  for (const name of names) {
    const value = element.getAttribute(name)?.trim();
    if (value) return value;
  }
  return "";
}

function uniqueRows(root: Document, selectors: string[]): Element[] {
  const rows: Element[] = [];
  const seen = new Set<Element>();
  for (const selector of selectors) {
    for (const row of root.querySelectorAll(selector)) {
      if (seen.has(row)) continue;
      seen.add(row);
      rows.push(row);
    }
  }
  return rows;
}

function descendantText(row: Element, selectors: string[]): string {
  for (const selector of selectors) {
    const value = textOf(row.querySelector(selector));
    if (value) return value;
  }
  return "";
}

function fallbackKey(source: MailSource, row: Element, index: number): string {
  return firstAttribute(row, ["data-thread-id", "data-convid", "data-conversation-id", "aria-label"]) || `${source}-row-${index}`;
}

const gmailSelectors = [
  '[role="main"] tr.zA',
  'tr.zA',
  '[role="main"] tr[role="row"]',
  '[role="main"] [data-thread-id]',
];

const outlookSelectors = [
  '[role="main"] [role="listitem"]',
  '[role="main"] [role="option"]',
  '[role="listitem"]',
  '[role="option"]',
  '[role="main"] [data-convid]',
  '[role="main"] [data-conversation-id]',
];

export const gmailAdapter: InboxAdapter = {
  source: "gmail",
  extractRows(root) {
    return uniqueRows(root, gmailSelectors).map((row, index) => ({
      source: "gmail",
      rowKey: fallbackKey("gmail", row, index),
      subject: firstAttribute(row, ["data-subject"]) || descendantText(row, [".bog", ".y6", "[data-subject]"]),
      from: firstAttribute(row, ["data-from", "email"]) || firstAttribute(row.querySelector("[email]"), ["email"]) || descendantText(row, [".yW", ".yX"]),
      snippet: firstAttribute(row, ["data-snippet"]) || descendantText(row, [".y2", "[data-snippet]"]),
      element: row,
    }));
  },
};

export const outlookAdapter: InboxAdapter = {
  source: "outlook",
  extractRows(root) {
    return uniqueRows(root, outlookSelectors).map((row, index) => ({
      source: "outlook",
      rowKey: fallbackKey("outlook", row, index),
      subject: firstAttribute(row, ["data-subject"]) || descendantText(row, ["[role=heading]", "[data-subject]"]),
      from: firstAttribute(row, ["data-from"]) || descendantText(row, ["[data-from]", "[data-sender]"]),
      snippet: firstAttribute(row, ["data-snippet", "data-preview"]) || descendantText(row, ["[data-snippet]", "[data-preview]"]),
      element: row,
    }));
  },
};

export function adapterForHost(hostname: string): InboxAdapter | null {
  const host = hostname.toLowerCase();
  if (host === "mail.google.com" || host.endsWith(".mail.google.com")) return gmailAdapter;
  if (host === "outlook.live.com" || host === "outlook.office.com" || host.endsWith(".outlook.office.com")) return outlookAdapter;
  return null;
}
