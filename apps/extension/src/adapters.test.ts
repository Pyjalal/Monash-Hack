import assert from "node:assert/strict";
import test from "node:test";
import { adapterForHost, gmailAdapter, outlookAdapter } from "./adapters.ts";

class FixtureElement {
  readonly textContent: string;
  private readonly attributes: Record<string, string>;
  private readonly descendants: Map<string, FixtureElement>;

  constructor(textContent = "", attributes: Record<string, string> = {}, descendants: Record<string, FixtureElement> = {}) {
    this.textContent = textContent;
    this.attributes = attributes;
    this.descendants = new Map(Object.entries(descendants));
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  querySelector(selector: string): FixtureElement | null {
    return this.descendants.get(selector) ?? null;
  }
}

class FixtureDocument {
  private readonly rows: Map<string, FixtureElement[]>;

  constructor(rows: Map<string, FixtureElement[]>) {
    this.rows = rows;
  }

  querySelectorAll(selector: string): FixtureElement[] {
    return this.rows.get(selector) ?? [];
  }
}

test("Gmail adapter extracts visible row fields and deduplicates overlapping selectors", () => {
  const row = new FixtureElement("Draft BL", { "data-thread-id": "thread-1" }, {
    "[email]": new FixtureElement("Operations", { email: "ops@example.test" }),
    ".bog": new FixtureElement("Draft BL"),
    ".y2": new FixtureElement("Please send the draft for checking"),
  });
  const root = new FixtureDocument(new Map([["tr.zA", [row]], ['[role="main"] tr.zA', [row]]]));

  const rows = gmailAdapter.extractRows(root as unknown as Document);

  assert.deepEqual(rows, [{ source: "gmail", rowKey: "thread-1", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft for checking", element: row }]);
});

test("Outlook adapter reads data attributes and host routing is explicit", () => {
  const row = new FixtureElement("Check SI", { "data-convid": "conversation-1", "data-subject": "Check SI", "data-from": "ops@example.test", "data-preview": "Compare the SI and draft BL" });
  const root = new FixtureDocument(new Map([["[role=\"option\"]", [row]]]));

  assert.deepEqual(outlookAdapter.extractRows(root as unknown as Document), [{
    source: "outlook", rowKey: "conversation-1", subject: "Check SI", from: "ops@example.test", snippet: "Compare the SI and draft BL", element: row,
  }]);
  assert.equal(adapterForHost("mail.google.com"), gmailAdapter);
  assert.equal(adapterForHost("outlook.office.com"), outlookAdapter);
  assert.equal(adapterForHost("example.test"), null);
});
