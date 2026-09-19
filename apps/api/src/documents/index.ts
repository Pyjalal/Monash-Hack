import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { splitLabelValueCandidates, type CandidateOptions, type LabelValueCandidate } from "./candidates.js";
import { assessReadability, type ReadabilityFacts } from "./readability.js";

export { splitLabelValueCandidates } from "./candidates.js";
export type { LabelValueCandidate } from "./candidates.js";

export type AttachmentStatus =
  | "READABLE"
  | "OCR_REQUIRED"
  | "UNSUPPORTED"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "EMPTY"
  | "GARBLED"
  | "PARSE_ERROR"
  | "TOO_LARGE";

export type SourceSpan =
  | { kind: "line"; start: number; end: number; line: number; text: string }
  | { kind: "page"; start: number; end: number; page: number; text: string }
  | { kind: "cell"; start: number; end: number; text: string; sheet: string; cell: string };

export interface ReadAttachmentOptions {
  root: string;
  relativePath: string;
  mimeType?: string;
}

export interface AttachmentReadResult {
  sha256: string;
  text: string;
  spans: SourceSpan[];
  status: AttachmentStatus;
  pagesNeedingOcr?: number[];
  candidates?: LabelValueCandidate[];
  readability?: ReadabilityFacts;
}

const TEXT_MIME_TYPES = new Set(["text/plain", "text/csv", "text/tab-separated-values"]);
const PDF_MIME_TYPES = new Set(["application/pdf"]);
const DOCX_MIME_TYPES = new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const XLSX_MIME_TYPES = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type AttachmentKind = "text" | "pdf" | "docx" | "xlsx" | "unsupported";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function emptyResult(status: AttachmentStatus): AttachmentReadResult {
  return { sha256: "", text: "", spans: [], status, candidates: [], readability: assessReadability("").facts };
}

function resultWithHash(sha256: string, status: AttachmentStatus): AttachmentReadResult {
  return { ...emptyResult(status), sha256 };
}

function withCandidates(result: AttachmentReadResult, options: CandidateOptions = {}): AttachmentReadResult {
  const reading = assessReadability(result.text);
  const status = reading.status === "GARBLED" ? "GARBLED" : result.status === "READABLE" ? reading.status : result.status;
  return { ...result, status, readability: reading.facts,
    candidates: status === "READABLE" || status === "OCR_REQUIRED" ? splitLabelValueCandidates(result, options) : [] };
}

function lineSpans(text: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const lines = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let line = 1;
  let match: RegExpExecArray | null;
  while ((match = lines.exec(text))) {
    const value = match[1];
    const delimiter = match[2];
    if (!delimiter && !value && match.index === text.length) break;
    spans.push({ kind: "line", start: match.index, end: match.index + value.length, line, text: value });
    line += 1;
    if (!delimiter) break;
  }
  return spans;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function resolveAttachment(rootInput: string, relativePath: string): Promise<string | AttachmentStatus> {
  if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) return "INVALID_PATH";

  const root = await realpath(rootInput).catch(() => null);
  if (!root) return "INVALID_PATH";

  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate)) return "INVALID_PATH";

  const existing = await realpath(candidate).catch(() => null);
  if (!existing) return "NOT_FOUND";
  return isInside(root, existing) ? existing : "INVALID_PATH";
}

function attachmentKind(filePath: string, mimeType?: string): AttachmentKind {
  const mime = mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (TEXT_MIME_TYPES.has(mime)) return "text";
  if (PDF_MIME_TYPES.has(mime)) return "pdf";
  if (DOCX_MIME_TYPES.has(mime)) return "docx";
  if (XLSX_MIME_TYPES.has(mime)) return "xlsx";
  if (mime && mime !== "application/octet-stream" && mime !== "binary/octet-stream") return "unsupported";

  switch (extname(filePath).toLowerCase()) {
    case ".txt":
    case ".csv":
    case ".tsv":
      return "text";
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".xlsx":
      return "xlsx";
    default:
      return "unsupported";
  }
}

function textResult(sha256: string, text: string, options: CandidateOptions = {}): AttachmentReadResult {
  if (text.length === 0) return resultWithHash(sha256, "EMPTY");
  const spans = lineSpans(text);
  return withCandidates({ sha256, text, spans, status: text.trim().length === 0 ? "EMPTY" : "READABLE" }, options);
}

async function readPdf(bytes: Buffer, sha256: string): Promise<AttachmentReadResult> {
  let document: {
    numPages: number;
    getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: Array<unknown> }> }>;
    destroy(): Promise<void>;
  } | undefined;
  try {
    document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const pages: Array<{ page: number; text: string }> = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => {
          if (!item || typeof item !== "object" || !("str" in item) || typeof item.str !== "string") return "";
          return `${item.str}${"hasEOL" in item && item.hasEOL ? "\n" : " "}`;
        })
        .join("")
        .trim();
      pages.push({ page: pageNumber, text: pageText });
    }
    const pagesNeedingOcr = pages.filter(({ text }) => assessReadability(text).status !== "READABLE").map(({ page }) => page);

    if (pages.every(page => !page.text.trim())) return { ...resultWithHash(sha256, "OCR_REQUIRED"), pagesNeedingOcr };

    let text = "";
    const spans: SourceSpan[] = [];
    for (const page of pages) {
      if (!page.text) continue;
      if (text) text += "\n\f\n";
      const start = text.length;
      text += page.text;
      spans.push({ kind: "page", start, end: text.length, page: page.page, text: page.text });
    }
    return withCandidates(pagesNeedingOcr.length > 0
      ? { sha256, text, spans, status: "OCR_REQUIRED", pagesNeedingOcr }
      : { sha256, text, spans, status: "READABLE" });
  } catch {
    return resultWithHash(sha256, "PARSE_ERROR");
  } finally {
    if (document) await document.destroy().catch(() => undefined);
  }
}

async function readDocx(bytes: Buffer, sha256: string): Promise<AttachmentReadResult> {
  try {
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    return textResult(sha256, extracted.value, { adjacentParagraphs: true });
  } catch {
    return resultWithHash(sha256, "PARSE_ERROR");
  }
}

async function readXlsx(bytes: Buffer, sha256: string): Promise<AttachmentReadResult> {
  try {
    const workbook = new ExcelJS.Workbook();
    const workbookBytes = bytes as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(workbookBytes);

    const rows: Array<Array<{ text: string; sheet: string; cell: string }>> = [];
    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow({ includeEmpty: false }, (row: ExcelJS.Row) => {
        const values: Array<{ text: string; sheet: string; cell: string }> = [];
        row.eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell) => {
          if (cell.isMerged && cell.master.address !== cell.address) return;
          const text = cell.text;
          if (text.trim()) values.push({ text, sheet: worksheet.name, cell: cell.address });
        });
        if (values.length) rows.push(values);
      });
    }

    if (rows.length === 0) return resultWithHash(sha256, "EMPTY");

    const spans: SourceSpan[] = [];
    const textRows: string[] = [];
    for (const row of rows) {
      const rowText: string[] = [];
      for (const cell of row) {
        if (rowText.length) rowText.push("\t");
        rowText.push(cell.text);
        spans.push({ kind: "cell", start: 0, end: 0, text: cell.text, sheet: cell.sheet, cell: cell.cell });
      }
      textRows.push(rowText.join(""));
    }

    const text = textRows.join("\n");
    let offset = 0;
    let spanIndex = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
        const cell = row[cellIndex];
        const span = spans[spanIndex];
        span.start = offset;
        span.end = offset + cell.text.length;
        offset += cell.text.length;
        if (cellIndex < row.length - 1) offset += 1;
        spanIndex += 1;
      }
      if (rowIndex < rows.length - 1) offset += 1;
    }
    return withCandidates({ sha256, text, spans, status: "READABLE" });
  } catch {
    return resultWithHash(sha256, "PARSE_ERROR");
  }
}

export async function readAttachment(options: ReadAttachmentOptions): Promise<AttachmentReadResult> {
  const resolved = await resolveAttachment(options.root, options.relativePath);
  if (resolved === "INVALID_PATH" || resolved === "NOT_FOUND") return emptyResult(resolved);
  if (typeof resolved !== "string") return emptyResult("INVALID_PATH");

  const file = await stat(resolved).catch(() => null);
  if (!file || !file.isFile()) return emptyResult("UNSUPPORTED");

  if (file.size > MAX_ATTACHMENT_BYTES) return emptyResult("TOO_LARGE");

  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch {
    return emptyResult("PARSE_ERROR");
  }
  const sha256 = digest(bytes);
  switch (attachmentKind(resolved, options.mimeType)) {
    case "text":
      return textResult(sha256, bytes.toString("utf8"));
    case "pdf":
      return readPdf(bytes, sha256);
    case "docx":
      return readDocx(bytes, sha256);
    case "xlsx":
      return readXlsx(bytes, sha256);
    default:
      return resultWithHash(sha256, "UNSUPPORTED");
  }
}
