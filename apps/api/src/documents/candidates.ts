import { createHash } from "node:crypto";
import type { SourceSpan } from "./index.js";
import { hasDamagedCharacters } from "./readability.js";

export interface LabelValueCandidate {
  id: string;
  label: string;
  value: string;
  pairing: "delimiter" | "adjacent-cell" | "next-row" | "adjacent-paragraph";
  source: { sha256: string; labelSpans: SourceSpan[]; valueSpans: SourceSpan[] };
}

interface CandidateInput { sha256: string; text: string; spans: SourceSpan[] }
export interface CandidateOptions { adjacentParagraphs?: boolean }

function slice(span: SourceSpan, start: number, end: number): SourceSpan {
  return { ...span, start: span.start + start, end: span.start + end, text: span.text.slice(start, end) };
}

function trimmed(span: SourceSpan, stripColon = false): SourceSpan {
  const start = span.text.length - span.text.trimStart().length;
  const end = (stripColon ? span.text.replace(/[:：]\s*$/u, "") : span.text).trimEnd().length;
  return slice(span, start, end);
}

function isLabel(text: string): boolean {
  return text.length > 0 && text.length <= 120 && /\p{L}/u.test(text) && !hasDamagedCharacters(text);
}

function delimited(span: SourceSpan): { label: SourceSpan; value: SourceSpan } | null {
  const match = /^(\s*)([^:=：\t\r\n]{1,120}?)(\s*(?:[:=：]|\t+| {2,})\s*)(.*)$/u.exec(span.text);
  if (!match) return null;
  const label = slice(span, match[1].length, match[1].length + match[2].trimEnd().length);
  if (!isLabel(label.text) || match[4].startsWith("//")) return null;
  const valueStart = match[1].length + match[2].length + match[3].length;
  return { label, value: slice(span, valueStart, span.text.trimEnd().length) };
}

function candidate(input: CandidateInput, labelSpans: SourceSpan[], valueSpans: SourceSpan[], pairing: LabelValueCandidate["pairing"]): LabelValueCandidate | null {
  if (!labelSpans.length || !valueSpans.length) return null;
  if (valueSpans.some((span, index) => index > 0 && (span.start < valueSpans[index - 1].end || input.text.slice(valueSpans[index - 1].end, span.start).trim().length > 0))) return null;
  const label = input.text.slice(labelSpans[0].start, labelSpans.at(-1)!.end);
  const value = input.text.slice(valueSpans[0].start, valueSpans.at(-1)!.end);
  if (!isLabel(label) || !value.trim() || hasDamagedCharacters(value)) return null;
  const source = { sha256: input.sha256, labelSpans, valueSpans };
  const id = `candidate_${createHash("sha256").update(JSON.stringify({ source, pairing })).digest("hex").slice(0, 24)}`;
  return { id, label, value, pairing, source };
}

function lineCandidates(input: CandidateInput, lines: SourceSpan[], allowUnindentedContinuation = false): LabelValueCandidate[] {
  const result: LabelValueCandidate[] = [];
  for (let index = 0; index < lines.length; index++) {
    const parsed = delimited(lines[index]);
    if (!parsed) continue;
    const values: SourceSpan[] = parsed.value.text ? [parsed.value] : [];
    let next = index + 1;
    while (next < lines.length) {
      const line = lines[next];
      const nestedDelimiter = delimited(line);
      if (!line.text.trim()
        || (nestedDelimiter && !(allowUnindentedContinuation && values.length > 0 && /^\s/u.test(line.text)))
        || (values.length > 0 && !allowUnindentedContinuation && !/^\s/u.test(line.text))) break;
      const value = values.length ? slice(line, 0, line.text.trimEnd().length) : trimmed(line);
      values.push(value); next++;
    }
    const entry = candidate(input, [parsed.label], values, "delimiter");
    if (entry) result.push(entry);
    index = next - 1;
  }
  return result;
}

function paragraphCandidates(input: CandidateInput, lines: SourceSpan[]): LabelValueCandidate[] {
  const blocks: SourceSpan[][] = [];
  let block: SourceSpan[] = [];
  for (const line of lines) {
    if (line.text.trim()) block.push(line);
    else if (block.length) { blocks.push(block); block = []; }
  }
  if (block.length) blocks.push(block);
  const result: LabelValueCandidate[] = [];
  for (let index = 0; index + 1 < blocks.length; index++) {
    const label = blocks[index]; const value = blocks[index + 1];
    if (label.length !== 1 || delimited(label[0])?.value.text) continue;
    const entry = candidate(input, [delimited(label[0])?.label ?? trimmed(label[0], true)], value.map((span, i) => i ? slice(span, 0, span.text.trimEnd().length) : trimmed(span)), "adjacent-paragraph");
    if (entry) { result.push(entry); index++; }
  }
  return result;
}

function pageLines(span: SourceSpan): SourceSpan[] {
  const result: SourceSpan[] = [];
  const expression = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of span.text.matchAll(expression)) {
    if (!match[0]) break;
    result.push(slice(span, match.index, match.index + match[1].length));
  }
  return result;
}

function cellPosition(span: Extract<SourceSpan, { kind: "cell" }>): { row: number; column: number } | null {
  const match = /^([A-Z]+)([1-9]\d*)$/u.exec(span.cell);
  if (!match) return null;
  return { row: Number(match[2]), column: [...match[1]].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) };
}

function cellCandidates(input: CandidateInput, spans: Array<Extract<SourceSpan, { kind: "cell" }>>): LabelValueCandidate[] {
  const sheets = new Map<string, Map<number, Array<{ span: SourceSpan; column: number }>>>();
  const result: LabelValueCandidate[] = [];
  for (const span of spans) {
    result.push(...lineCandidates(input, [span]));
    const position = cellPosition(span); if (!position) continue;
    const rows = sheets.get(span.sheet) ?? new Map();
    const cells = rows.get(position.row) ?? [];
    cells.push({ span, column: position.column }); rows.set(position.row, cells); sheets.set(span.sheet, rows);
  }
  for (const rows of sheets.values()) {
    const consumed = new Set<number>();
    for (const [row, cells] of [...rows.entries()].sort(([a], [b]) => a - b)) {
      if (consumed.has(row)) continue;
      cells.sort((a, b) => a.column - b.column);
      for (let index = 0; index + 1 < cells.length; index++) {
        const left = cells[index]; const right = cells[index + 1];
        if (delimited(left.span)?.value.text) continue;
        const entry = candidate(input, [trimmed(left.span, true)], [trimmed(right.span)], "adjacent-cell");
        if (entry) { result.push(entry); index++; }
      }
      const next = rows.get(row + 1);
      if (cells.length === 1 && next?.length === 1 && cells[0].column === next[0].column && !delimited(cells[0].span)?.value.text) {
        const entry = candidate(input, [trimmed(cells[0].span, true)], [trimmed(next[0].span)], "next-row");
        if (entry) { result.push(entry); consumed.add(row + 1); }
      }
    }
  }
  return result;
}

export function splitLabelValueCandidates(input: CandidateInput, options: CandidateOptions = {}): LabelValueCandidate[] {
  if (!input.sha256 || !input.text) return [];
  const spans = input.spans.filter(span => Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end >= span.start && span.end <= input.text.length && input.text.slice(span.start, span.end) === span.text);
  const lines = spans.filter(span => span.kind === "line");
  const candidates = lineCandidates(input, lines);
  if (options.adjacentParagraphs) candidates.push(...paragraphCandidates(input, lines));
  for (const span of spans.filter(span => span.kind === "page")) candidates.push(...lineCandidates(input, pageLines(span), true));
  candidates.push(...cellCandidates(input, spans.filter((span): span is Extract<SourceSpan, { kind: "cell" }> => span.kind === "cell")));
  const structuralValues = candidates.filter(entry => entry.pairing !== "delimiter").flatMap(entry => entry.source.valueSpans);
  const withoutNestedDelimiters = candidates.filter(entry => entry.pairing !== "delimiter" || !structuralValues.some(span =>
    entry.source.labelSpans[0].start >= span.start && entry.source.valueSpans.at(-1)!.end <= span.end));
  return [...new Map(withoutNestedDelimiters.map(entry => [entry.id, entry])).values()].sort((a, b) => a.source.labelSpans[0].start - b.source.labelSpans[0].start);
}
