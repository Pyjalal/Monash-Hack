import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { readAttachment } from "./index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "cargolens-documents-"));
  temporaryRoots.push(root);
  return root;
}

describe("readAttachment", () => {
  it("exposes readable Unicode candidates and stable IDs independently of filenames", async () => {
    const root = await createRoot();
    const text = "收货人：上海公司\n重量: 1,250 公斤\n";
    await writeFile(join(root, "first.txt"), text, "utf8");
    await writeFile(join(root, "unrelated-name.txt"), text, "utf8");
    const first = await readAttachment({ root, relativePath: "first.txt" });
    const second = await readAttachment({ root, relativePath: "unrelated-name.txt" });
    expect(first.status).toBe("READABLE");
    expect(first.candidates?.map(candidate => candidate.value)).toEqual(["上海公司", "1,250 公斤"]);
    expect(first.candidates).toEqual(second.candidates);
    expect(first.readability?.replacementCharacters).toBe(0);
  });

  it("distinguishes replacement-corrupted text from empty, unsupported and parser failures", async () => {
    const root = await createRoot();
    const text = "Name: \ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\n";
    await writeFile(join(root, "corrupt.txt"), text, "utf8");
    const result = await readAttachment({ root, relativePath: "corrupt.txt" });
    expect(result.status).toBe("GARBLED");
    expect(result.text).toBe(text);
    expect(result.candidates).toEqual([]);
    expect(result.readability?.replacementCharacters).toBe(6);
    expect(result.spans[0].text).toContain("\ufffd");
  });

  it("extracts spreadsheet pairs while preserving spaces and exact cells", async () => {
    const root = await createRoot(); const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Original");
    sheet.getCell("A1").value = "Name"; sheet.getCell("B1").value = "  公司甲  ";
    sheet.getCell("A2").value = "Quantity"; sheet.getCell("B2").value = 0;
    await workbook.xlsx.writeFile(join(root, "data.xlsx"));
    const result = await readAttachment({ root, relativePath: "data.xlsx" });
    expect(result.spans.find(span => span.kind === "cell" && span.cell === "B1")?.text).toBe("  公司甲  ");
    expect(result.candidates?.map(({ label, value }) => ({ label, value }))).toEqual([{ label: "Name", value: "公司甲" }, { label: "Quantity", value: "0" }]);
    expect(result.candidates?.[0].source.valueSpans[0]).toMatchObject({ kind: "cell", sheet: "Original", cell: "B1", text: "公司甲" });
  });

  it("returns a hash, text, and one-based line spans for a UTF-8 text attachment", async () => {
    const root = await createRoot();
    const relativePath = "attachments/si.txt";
    const text = "Shipper: Acme\nPort of Loading: Port Klang\n";
    await mkdir(join(root, "attachments"));
    await writeFile(join(root, relativePath), text, "utf8");

    const result = await readAttachment({ root, relativePath, mimeType: "text/plain" });

    expect(result).toMatchObject({
      sha256: createHash("sha256").update(text).digest("hex"),
      text,
      spans: [
        { kind: "line", start: 0, end: 13, line: 1, text: "Shipper: Acme" },
        { kind: "line", start: 14, end: 41, line: 2, text: "Port of Loading: Port Klang" },
      ],
      status: "READABLE",
    });
  });

  it("rejects relative paths that escape the configured dataset root", async () => {
    const root = await createRoot();
    const result = await readAttachment({ root, relativePath: "../outside.txt", mimeType: "text/plain" });

    expect(result).toMatchObject({ sha256: "", text: "", spans: [], status: "INVALID_PATH", candidates: [] });
  });

  it("rejects a symlink that resolves outside the configured dataset root", async () => {
    const root = await createRoot();
    const outsideRoot = await createRoot();
    const outsidePath = join(outsideRoot, "secret.txt");
    await writeFile(outsidePath, "private", "utf8");
    const linkPath = join(root, "linked.txt");

    try {
      await symlink(outsidePath, linkPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const result = await readAttachment({ root, relativePath: "linked.txt", mimeType: "text/plain" });

    expect(result).toMatchObject({ sha256: "", text: "", spans: [], status: "INVALID_PATH", candidates: [] });
  });

  it("reports an empty text attachment explicitly", async () => {
    const root = await createRoot();
    await writeFile(join(root, "empty.txt"), "", "utf8");

    const result = await readAttachment({ root, relativePath: "empty.txt", mimeType: "text/plain" });

    expect(result.status).toBe("EMPTY");
    expect(result.sha256).toHaveLength(64);
    expect(result.spans).toEqual([]);
  });

  it("marks a scanned PDF with no embedded text as requiring OCR", async () => {
    const root = join(process.cwd(), "training_data/sdoc-hackathon-docker/extracted/data_v2");
    const relativePath = "attachments/email_512_SI.pdf";
    const bytes = await readFile(join(root, relativePath));

    const result = await readAttachment({ root, relativePath, mimeType: "application/pdf" });

    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.status).toBe("OCR_REQUIRED");
    expect(result.pagesNeedingOcr).toEqual([1]);
    expect(result.text).toBe("");
    expect(result.spans).toEqual([]);
  });

  it("returns page provenance for a text-bearing PDF", async () => {
    const root = await createRoot();
    const relativePath = "attachments/embedded.pdf";
    await mkdir(join(root, "attachments"));
    const bytes = minimalTextPdf("Hello PDF");
    await writeFile(join(root, relativePath), bytes);

    const result = await readAttachment({ root, relativePath, mimeType: "application/pdf" });

    expect(result.status).toBe("READABLE");
    expect(result.text).toContain("Hello PDF");
    expect(result.spans).toEqual([{ kind: "page", start: 0, end: result.text.length, page: 1, text: result.text }]);
  });

  it("retains extracted pages while marking image-only pages for OCR", async () => {
    const root = await createRoot();
    const relativePath = "attachments/mixed.pdf";
    await mkdir(join(root, "attachments"));
    await writeFile(join(root, relativePath), minimalTextPdfPages(["Page one", ""]));

    const result = await readAttachment({ root, relativePath, mimeType: "application/pdf" });

    expect(result.status).toBe("OCR_REQUIRED");
    expect(result.pagesNeedingOcr).toEqual([2]);
    expect(result.text).toContain("Page one");
    expect(result.spans).toEqual([{ kind: "page", start: 0, end: result.text.length, page: 1, text: result.text }]);
  });

  it("reports a parser failure for malformed PDF bytes", async () => {
    const root = await createRoot();
    const relativePath = "attachments/malformed.pdf";
    await mkdir(join(root, "attachments"));
    await writeFile(join(root, relativePath), "this is not a PDF", "utf8");

    const result = await readAttachment({ root, relativePath, mimeType: "application/pdf" });

    expect(result.status).toBe("PARSE_ERROR");
    expect(result.sha256).toHaveLength(64);
  });

  it("reports unsupported formats without trying to infer document meaning", async () => {
    const root = await createRoot();
    const relativePath = "attachments/archive.zip";
    await mkdir(join(root, "attachments"));
    await writeFile(join(root, relativePath), "PK\u0003\u0004", "binary");

    const result = await readAttachment({ root, relativePath, mimeType: "application/zip" });

    expect(result.status).toBe("UNSUPPORTED");
    expect(result.text).toBe("");
    expect(result.spans).toEqual([]);
    expect(result.sha256).toHaveLength(64);
  });

  it("extracts DOCX text without using the filename as document role evidence", async () => {
    const root = join(process.cwd(), "training_data/sdoc-hackathon-docker/extracted/data_v2");

    const result = await readAttachment({
      root,
      relativePath: "attachments/email_055_BL.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(result.status).toBe("READABLE");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.spans.every((span) => span.kind === "line")).toBe(true);
    expect(result.spans.some((span) => span.start < span.end)).toBe(true);
    expect(result.candidates?.some(candidate => candidate.label === "Consignee (收货人)" && candidate.value.startsWith("AL GURG STATIONERY"))).toBe(true);
    expect(result.candidates?.every(candidate => [...candidate.source.labelSpans, ...candidate.source.valueSpans].every(span => result.text.slice(span.start, span.end) === span.text))).toBe(true);
  });

  it("extracts XLSX values with sheet and cell provenance", async () => {
    const root = join(process.cwd(), "training_data/sdoc-hackathon-docker/extracted/data_v2");

    const result = await readAttachment({
      root,
      relativePath: "attachments/email_005_SI.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.status).toBe("READABLE");
    expect(result.spans.length).toBeGreaterThan(0);
    expect(result.spans.every((span) => span.kind === "cell" && span.sheet.length > 0 && span.cell.length > 0)).toBe(true);
    for (const span of result.spans) expect(result.text.slice(span.start, span.end)).toBe(span.text);
  });
});

function minimalTextPdf(text: string): Buffer {
  return minimalTextPdfPages([text]);
}

function minimalTextPdfPages(pages: string[]): Buffer {
  const pageObjects = pages.map((_, index) => 3 + index);
  const fontObject = 3 + pages.length;
  const contentObjects = pages.map((_, index) => fontObject + 1 + index);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageObjects.map((object) => `${object} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pages.map((text, index) => {
      return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjects[index]} 0 R >>`;
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.map((text) => {
      const stream = text ? `BT /F1 12 Tf 50 250 Td (${text}) Tj ET` : "";
      return `<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}
