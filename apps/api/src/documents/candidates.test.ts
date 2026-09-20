import { describe, expect, it } from "vitest";
import { splitLabelValueCandidates } from "./candidates.js";
import type { SourceSpan } from "./index.js";

function lines(text: string): SourceSpan[] {
  let start = 0;
  return text.split("\n").map((value, index) => {
    const span: SourceSpan = { kind: "line", start, end: start + value.length, line: index + 1, text: value };
    start += value.length + 1;
    return span;
  });
}

describe("sourced label/value candidates", () => {
  it("keeps Unicode labels, multiline values and exact source slices", () => {
    const text = "发货人：公司甲\n  上海港\nWeight (kg): 1,250\nEmpty:\n\nUnlabelled prose";
    const input = { sha256: "a".repeat(64), text, spans: lines(text) };
    const candidates = splitLabelValueCandidates(input);
    expect(candidates.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "发货人", value: "公司甲\n  上海港" }, { label: "Weight (kg)", value: "1,250" },
    ]);
    expect(candidates[0].source.valueSpans.map(span => span.kind === "line" ? span.line : null)).toEqual([1, 2]);
    for (const candidate of candidates) {
      expect(candidate.source.sha256).toBe(input.sha256);
      for (const span of [...candidate.source.labelSpans, ...candidate.source.valueSpans]) expect(text.slice(span.start, span.end)).toBe(span.text);
    }
    expect(splitLabelValueCandidates(input)).toEqual(candidates);
    expect(splitLabelValueCandidates({ ...input, sha256: "b".repeat(64) })[0].id).not.toBe(candidates[0].id);
  });

  it("keeps page provenance and never consumes a value from a different page", () => {
    const first = "Address:\n  First line\n  Second line\nMissing:";
    const second = "Unrelated page\nCount: 12";
    const text = `${first}\n\f\n${second}`;
    const spans: SourceSpan[] = [
      { kind: "page", start: 0, end: first.length, page: 1, text: first },
      { kind: "page", start: first.length + 3, end: text.length, page: 2, text: second },
    ];
    const candidates = splitLabelValueCandidates({ sha256: "a".repeat(64), text, spans });
    expect(candidates.map(candidate => candidate.label)).toEqual(["Address", "Count"]);
    expect(candidates[0].value).toBe("First line\n  Second line");
    expect(candidates[0].source.valueSpans.every(span => span.kind === "page" && span.page === 1)).toBe(true);
    expect(candidates[1].source.valueSpans[0]).toMatchObject({ kind: "page", page: 2, text: "12" });
  });

  it("recovers PDF-style aligned labels and their unindented continuation lines", () => {
    const page = "Shipper   Acme Trading\nAddress line one\nAddress line two\nConsignee   Buyer Limited";
    const input = { sha256: "a".repeat(64), text: page, spans: [{ kind: "page" as const, start: 0, end: page.length, page: 1, text: page }] };
    expect(splitLabelValueCandidates(input).map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "Shipper", value: "Acme Trading\nAddress line one\nAddress line two" },
      { label: "Consignee", value: "Buyer Limited" },
    ]);
  });

  it("uses adjacent spreadsheet cells and aligned next rows without crossing sheets", () => {
    const cells = [
      { text: "Weight", sheet: "Sheet A", cell: "A1" }, { text: "1250", sheet: "Sheet A", cell: "B1" },
      { text: "Country:", sheet: "Sheet A", cell: "A2" }, { text: "日本", sheet: "Sheet A", cell: "A3" },
      { text: "Empty:", sheet: "Sheet A", cell: "A4" }, { text: "Other sheet", sheet: "Sheet B", cell: "A5" },
    ];
    let text = "";
    const spans: SourceSpan[] = cells.map(cell => {
      if (text) text += "\n";
      const start = text.length; text += cell.text;
      return { kind: "cell", ...cell, start, end: text.length };
    });
    const candidates = splitLabelValueCandidates({ sha256: "a".repeat(64), text, spans });
    expect(candidates.map(({ label, value }) => ({ label, value }))).toEqual([{ label: "Weight", value: "1250" }, { label: "Country", value: "日本" }]);
    expect(candidates[0].source.labelSpans[0]).toMatchObject({ kind: "cell", sheet: "Sheet A", cell: "A1", text: "Weight" });
    expect(candidates[0].source.valueSpans[0]).toMatchObject({ kind: "cell", sheet: "Sheet A", cell: "B1", text: "1250" });
  });

  it("does not manufacture missing or replacement-corrupted values", () => {
    const text = "Missing:\n\nBroken: \ufffd\ufffd\ufffd\nStandalone title\n";
    expect(splitLabelValueCandidates({ sha256: "a".repeat(64), text, spans: lines(text) })).toEqual([]);
    expect(splitLabelValueCandidates({ sha256: "a".repeat(64), text: "", spans: [] })).toEqual([]);
  });

  it("keeps every source line of long values without silently truncating evidence", () => {
    const value = Array.from({ length: 15 }, (_, index) => `  Address line ${index + 1}`).join("\n");
    const text = `Address:\n${value}\nCount: 1`;
    const candidates = splitLabelValueCandidates({ sha256: "a".repeat(64), text, spans: lines(text) });
    expect(candidates[0].value).toBe(value.trimStart());
    expect(candidates[0].source.valueSpans).toHaveLength(15);
  });

  it("never absorbs text omitted from the provided source spans", () => {
    const text = "Name: Acme\nMissing source segment\n  continuation";
    const spans = lines(text); spans.splice(1, 1);
    expect(splitLabelValueCandidates({ sha256: "a".repeat(64), text, spans })).toEqual([]);
  });

  it("pairs delimiter-only DOCX paragraphs with their adjacent value paragraph", () => {
    const text = "Company:\n\nAcme Ltd\n\n";
    const candidates = splitLabelValueCandidates({ sha256: "a".repeat(64), text, spans: lines(text) }, { adjacentParagraphs: true });
    expect(candidates.map(({ label, value, pairing }) => ({ label, value, pairing }))).toEqual([{ label: "Company", value: "Acme Ltd", pairing: "adjacent-paragraph" }]);
  });
});
