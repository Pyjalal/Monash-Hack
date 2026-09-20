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
  expect(gmailAdapter.extractRows(root as unknown as Document)).toEqual([{ source: "gmail", rowKey: "thread-1", subject: "Draft BL", from: "ops@example.test", snippet: "Please send the draft for checking", element: row, badgeTarget: row.querySelector(".bog") }]);
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

it('uses nested Gmail thread identity and never annotates nested identity spans as rows', async () => {
  const { Window } = await import('happy-dom');
  const window = new Window();
  window.document.body.innerHTML = '<main role="main"><table><tbody><tr class="zA"><td><span email="sender@example.test">Sender</span><div class="y6"><span class="bog"><span data-thread-id="thread-real">Draft BL</span></span><span class="y2">Check</span></div></td></tr></tbody></table></main>';
  const rows = gmailAdapter.extractRows(window.document);
  expect(rows).toHaveLength(1); expect(rows[0].rowKey).toBe('thread-real');
  window.document.querySelector('[data-thread-id]')!.setAttribute('data-thread-id', 'recycled-real');
  expect(gmailAdapter.extractRows(window.document)[0].rowKey).toBe('recycled-real');
  window.happyDOM.abort();
});
it('fallback keys stay with elements when rows reorder and do not collide for identical subjects', async () => {
  const { Window } = await import('happy-dom'); const window = new Window();
  window.document.body.innerHTML = '<table><tbody><tr class="zA"><td class="bog">Same</td></tr><tr class="zA"><td class="bog">Same</td></tr></tbody></table>';
  const before = gmailAdapter.extractRows(window.document);
  window.document.querySelector('tbody')!.append(window.document.querySelector('tr')!);
  const after = gmailAdapter.extractRows(window.document);
  expect(before[0].rowKey).not.toBe(before[1].rowKey);
  expect(after.map(row => row.rowKey)).toEqual([before[1].rowKey, before[0].rowKey]);
  window.happyDOM.abort();
});
it('supports the observed Outlook web layout while leaving unrelated options alone', async () => {
  const { Window } = await import('happy-dom'); const window = new Window();
  window.document.body.innerHTML = '<div role="listbox" aria-label="Message list"><div role="option" data-convid="real-conversation" tabindex="0" aria-selected="false"><div class="ESO13"><span>Operations</span></div><div><span class="TtcXM">BL draft</span><span class="ASFJj">Please verify</span></div></div></div><div role="option">Sort by date</div>';
  const row = outlookAdapter.extractRows(window.document)[0];
  expect(row).toMatchObject({ rowKey: 'real-conversation', from: 'Operations', subject: 'BL draft', snippet: 'Please verify' });
  expect(outlookAdapter.extractRows(window.document)).toHaveLength(1);
  row.element!.setAttribute('hidden', ''); expect(outlookAdapter.extractRows(window.document)).toHaveLength(0);
  window.happyDOM.abort();
});
