import { expect, it } from "vitest";
import { adapterForHost, gmailAdapter, outlookAdapter } from "./adapters.js";

class FixtureElement {
  readonly textContent: string;
  readonly parentElement: FixtureElement | null = null;
  private readonly attributes: Record<string, string>;
  private readonly descendants: Map<string, FixtureElement>;
  constructor(textContent = "", attributes: Record<string, string> = {}, descendants: Record<string, FixtureElement> = {}) {
    this.textContent = textContent;
    this.attributes = attributes;
    this.descendants = new Map(Object.entries(descendants));
  }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  hasAttribute(name: string): boolean { return name in this.attributes; }
  querySelector(selector: string): FixtureElement | null { return this.descendants.get(selector) ?? null; }
}

class FixtureDocument {
  readonly defaultView = undefined;
  private readonly rows: Map<string, FixtureElement[]>;
  constructor(rows: Map<string, FixtureElement[]>) { this.rows = rows; }
  querySelectorAll(selector: string): FixtureElement[] { return this.rows.get(selector) ?? []; }
}

it("Gmail adapter extracts visible row fields and deduplicates overlapping selectors", () => {
  const row = new FixtureElement("Draft BL", { "data-thread-id": "thread-1" }, {
    "[email]": new FixtureElement("Operations", { email: "ops@example.test" }), ".bog": new FixtureElement("Draft BL"), ".y2": new FixtureElement("Please send the draft for checking"),
  });
  const root = new FixtureDocument(new Map([["tr.zA", [row]], ['[role="main"] tr.zA', [row]]]));
  expect(gmailAdapter.extractRows(root as unknown as Document)).toEqual([{ source: "gmail", rowKey: "thread-1", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft for checking", element: row, badgeTarget: row }]);
});

it("Outlook adapter reads data attributes and host routing is explicit", () => {
  const row = new FixtureElement("Check SI", { "data-convid": "conversation-1", "data-subject": "Check SI", "data-from": "ops@example.test", "data-preview": "Compare the SI and draft BL" });
  const root = new FixtureDocument(new Map([[`[role="option"]`, [row]]]));
  expect(outlookAdapter.extractRows(root as unknown as Document)).toEqual([{ source: "outlook", rowKey: "conversation-1", subject: "Check SI", from: "ops@example.test", snippet: "Compare the SI and draft BL", element: row, badgeTarget: row }]);
  expect(adapterForHost("mail.google.com")).toBe(gmailAdapter);
  expect(adapterForHost("outlook.office.com")).toBe(outlookAdapter);
  expect(adapterForHost("example.test")).toBeNull();
});

it("adapters skip blank subjects used by inbox dropdowns", () => {
  const root = new FixtureDocument(new Map([["tr.zA", [new FixtureElement("dropdown")]]]));
  expect(gmailAdapter.extractRows(root as unknown as Document)).toEqual([]);
});
