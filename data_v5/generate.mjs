import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const ROOT = resolve(import.meta.dirname);
const INBOX = resolve(ROOT, "inbox");
const ATTACHMENTS = resolve(ROOT, "attachments");
const fields = ["shipper", "consignee", "notify_party", "port_of_loading", "port_of_discharge", "container_count", "gross_weight_kg"];
const ports = [
  ["PORT KLANG, MALAYSIA", "JEBEL ALI, UAE"],
  ["SINGAPORE, SINGAPORE", "LONG BEACH, USA"],
  ["NANTONG, CHINA", "ROTTERDAM, NETHERLANDS"],
  ["SURABAYA, INDONESIA", "NHAVA SHEVA, INDIA"],
  ["LAEM CHABANG, THAILAND", "BUSAN, SOUTH KOREA"],
];
const companies = [
  ["APRIL FINE PAPER TRADING SDN BHD", "PACIFIC PAPER MERCHANTS LLC"],
  ["NUSANTARA PULP AND PAPER LTD", "WEST COAST PAPER IMPORTS INC"],
  ["ASIA PACIFIC RESOURCES INTERNATIONAL", "GLOBAL STATIONERY FZE"],
  ["RIVERLAND EXPORTS PTE LTD", "METRO PRINTING SOLUTIONS BV"],
];
const aliases = {
  shipper: ["Shipper", "Shipper / Exporter"],
  consignee: ["Consignee", "Consignee (Non-Negotiable)"],
  notify_party: ["Notify Party", "Notify"],
  port_of_loading: ["Port of Loading", "POL"],
  port_of_discharge: ["Port of Discharge", "POD"],
  container_count: ["Container Count", "No. of Containers"],
  gross_weight_kg: ["Gross Weight (KG)", "Total Gross Weight KGS"],
};

const xml = value => String(value).replace(/[<>&'"]/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]);
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const idFor = number => `v5_email_${String(number).padStart(3, "0")}`;

function baseValues(index) {
  const [shipper, consignee] = companies[index % companies.length];
  const [loading, discharge] = ports[index % ports.length];
  return {
    shipper,
    consignee,
    notify_party: index % 3 === 0 ? "SAME AS CONSIGNEE" : consignee,
    port_of_loading: loading,
    port_of_discharge: discharge,
    container_count: String(1 + index % 5),
    gross_weight_kg: String(18_500 + index * 375),
  };
}

function formatted(values, variant) {
  const output = { ...values };
  if (variant === "presentation") {
    output.shipper = output.shipper.replace(" AND ", " & ").replace(/ LTD$/u, " LTD.");
    output.consignee = output.consignee.replace(/ LLC$/u, " L.L.C.");
    output.container_count = `${output.container_count} x 40' HC`;
    output.gross_weight_kg = `${(Number(output.gross_weight_kg) / 1000).toFixed(3)} MT`;
  }
  return output;
}

function lines(role, reference, values, variant = 0) {
  const title = role === "si" ? "SHIPPING INSTRUCTIONS" : "DRAFT BILL OF LADING";
  const result = [title, `Booking Reference: ${reference}`];
  fields.forEach((field, index) => result.push(`${aliases[field][(variant + index) % aliases[field].length]}: ${values[field]}`));
  result.push("Cargo Description: PRINTING PAPER IN REELS", "Freight Terms: PREPAID");
  return result;
}

async function writeDocx(path, documentLines) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentLines.map(line => `<w:p><w:r><w:t>${xml(line)}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writeXlsx(path, documentLines) {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Document");
  for (const line of documentLines) {
    const delimiter = line.indexOf(":");
    if (delimiter > 0) sheet.addRow([line.slice(0, delimiter), line.slice(delimiter + 1).trim()]);
    else sheet.addRow([line]);
  }
  await workbook.xlsx.writeFile(path);
}

async function writeDocument(id, role, format, documentLines) {
  const name = `${id}_${role.toUpperCase()}.${format}`; const path = resolve(ATTACHMENTS, name);
  if (format === "txt") await writeFile(path, `${documentLines.join("\n")}\n`, "utf8");
  else if (format === "docx") await writeDocx(path, documentLines);
  else if (format === "xlsx") await writeXlsx(path, documentLines);
  else if (format === "pdf") await writeFile(path, Buffer.from("not a readable PDF"));
  return `attachments/${name}`;
}

function truth(category, status = "OK", reviewReason = null, defectFields = [], extractionGroundTruth = null, scenario = "") {
  return { category, status, review_reason: reviewReason, defect_fields: defectFields, has_defect: status === "MISMATCH", scenario, extraction_ground_truth: extractionGroundTruth };
}

function email(id, subject, body, attachments = []) { return { email_id: id, from: "documentation@carrier-example.com", subject, body, attachments }; }

await rm(INBOX, { recursive: true, force: true });
await rm(ATTACHMENTS, { recursive: true, force: true });
await mkdir(INBOX, { recursive: true }); await mkdir(ATTACHMENTS, { recursive: true });
const groundTruth = {}; const sample = {}; const manifest = [];
let number = 0;

async function add(record, expected, metadata) {
  await writeFile(resolve(INBOX, `${record.email_id}.json`), pretty(record), "utf8");
  groundTruth[record.email_id] = expected;
  sample[record.email_id] = { category: "GENERAL", status: "OK", review_reason: null, defect_fields: [], has_defect: false };
  manifest.push({ id: record.email_id, ...metadata, expected: { category: expected.category, status: expected.status, review_reason: expected.review_reason, defect_fields: expected.defect_fields } });
}

for (let index = 0; index < 12; index++) {
  const id = idFor(++number); const reference = `V5BK${10000 + number}`; const source = baseValues(index); const draft = formatted(source, index % 2 ? "presentation" : "plain");
  const formats = [["txt", "txt"], ["docx", "xlsx"], ["xlsx", "docx"]][index % 3];
  const attachments = [await writeDocument(id, "si", formats[0], lines("si", reference, source, index)), await writeDocument(id, "bl", formats[1], lines("bl", reference, draft, index + 1))];
  await add(email(id, `Please approve revised draft BL · ${reference}`, `Hi documentation team,\n\nPlease compare the attached current SI and revised draft BL for booking ${reference}. The older draft quoted below is superseded.\n\n> Earlier draft was sent before the consignee punctuation correction.\n\nPlease confirm today if all seven shipping fields agree.`, attachments),
    truth("BL_COMPARISON", "OK", null, [], { si: source, bl: draft }, "verified match across formatting and mixed native formats"), { family: "match", formats });
}

for (let index = 0; index < 12; index++) {
  const id = idFor(++number); const reference = `V5BK${10000 + number}`; const source = baseValues(index + 20); const draft = { ...source }; const defect = fields[index % fields.length];
  if (defect === "container_count") draft[defect] = String(Number(source[defect]) + 1);
  else if (defect === "gross_weight_kg") draft[defect] = String(Number(source[defect]) + 750);
  else if (defect === "port_of_loading") draft[defect] = "MANILA, PHILIPPINES";
  else if (defect === "port_of_discharge") draft[defect] = "HAMBURG, GERMANY";
  else draft[defect] = `${source[defect]} HOLDINGS`;
  const formats = [["txt", "docx"], ["xlsx", "txt"], ["docx", "xlsx"]][index % 3];
  const attachments = [await writeDocument(id, "si", formats[0], lines("si", reference, source, index)), await writeDocument(id, "bl", formats[1], lines("bl", reference, draft, index + 1))];
  await add(email(id, `Cut-off today — check SI against draft BL ${reference}`, `Current request: verify the attached SI and draft bill of lading for ${reference}. Report factual differences before the carrier cut-off.\n\nQuoted history: invoice query resolved last week; no billing action remains.`, attachments),
    truth("BL_COMPARISON", "MISMATCH", null, [defect], { si: source, bl: draft }, `single factual defect in ${defect}`), { family: "mismatch", defect, formats });
}

for (let index = 0; index < 8; index++) {
  const id = idFor(++number); const reference = `V5BK${10000 + number}`; const source = baseValues(index + 40); const reason = ["missing_attachment", "wrong_doc_type", "unreadable", "missing_value"][Math.floor(index / 2)];
  const attachments = [];
  if (reason === "missing_attachment") attachments.push(await writeDocument(id, "si", "txt", lines("si", reference, source)));
  else if (reason === "wrong_doc_type") {
    attachments.push(await writeDocument(id, "si", "txt", lines("si", reference, source)));
    attachments.push(await writeDocument(id, "bl", "txt", ["COMMERCIAL INVOICE", `Booking Reference: ${reference}`, "Invoice Total: USD 18,250"]));
  } else if (reason === "unreadable") {
    attachments.push(await writeDocument(id, "si", "txt", lines("si", reference, source)));
    attachments.push(await writeDocument(id, "bl", "pdf", []));
  } else {
    const draft = { ...source, consignee: "TBA" };
    attachments.push(await writeDocument(id, "si", "txt", lines("si", reference, source)));
    attachments.push(await writeDocument(id, "bl", "docx", lines("bl", reference, draft)));
  }
  await add(email(id, `Document check requires attention · ${reference}`, `Please verify the attached SI and current draft BL for ${reference}. Do not confirm unless the source evidence is complete and readable.`, attachments),
    truth("BL_COMPARISON", "NEEDS_REVIEW", reason, [], reason === "missing_value" ? { si: source, bl: { ...source, consignee: null } } : null, `safe escalation for ${reason}`), { family: "review", reason });
}

for (let index = 0; index < 4; index++) {
  const id = idFor(++number); const reference = `V5BK${10000 + number}`;
  await add(email(id, `Please issue first draft BL · ${reference}`, `Shipping instructions were submitted through the portal. Please prepare and return the first draft bill of lading when available. There is no draft to compare yet.`),
    truth("BL_COMPARISON", "OK", null, [], null, "future draft request; extraction must be deferred"), { family: "future_draft" });
}

for (let index = 0; index < 8; index++) {
  const id = idFor(++number); const values = baseValues(index + 60); const reference = `V5BK${10000 + number}`;
  const attachment = await writeDocument(id, "si", index % 2 ? "xlsx" : "txt", lines("si", reference, values));
  await add(email(id, `Updated shipping instructions · ${reference}`, `Please use the attached updated shipping instructions. Once processed, send us a future draft BL for review.`, [attachment]),
    truth("SI_REQUEST", "OK", null, [], null, "SI provision with secondary future-draft request"), { family: "si_request" });
}

for (let index = 0; index < 6; index++) {
  const id = idFor(++number); await add(email(id, `Invoice clarification for shipment V5-${number}`, `Please explain the documentation surcharge and send a corrected freight invoice. The BL number is included only as the billing reference.`),
    truth("INVOICE_QUERY", "OK", null, [], null, "billing request mentioning a BL reference"), { family: "invoice" });
}
for (let index = 0; index < 6; index++) {
  const id = idFor(++number); await add(email(id, `Weekly vessel operations update V5-${number}`, `Please note the revised ETA and terminal opening hours. This is an operational update; no SI, draft BL, invoice, or approval action is requested.`),
    truth("GENERAL", "OK", null, [], null, "legitimate operational update"), { family: "general" });
}
for (let index = 0; index < 4; index++) {
  const id = idFor(++number); await add(email(id, `Exclusive freight leads for your logistics desk ${number}`, `Buy our global shipper database today. Guaranteed leads, crypto payment accepted, unsubscribe by replying with your password.`),
    truth("SPAM", "OK", null, [], null, "unsolicited logistics-themed promotion"), { family: "spam" });
}

await writeFile(resolve(ROOT, "ground_truth.json"), pretty(groundTruth), "utf8");
await writeFile(resolve(ROOT, "sample_submission.json"), pretty(sample), "utf8");
await writeFile(resolve(ROOT, "manifest.json"), pretty({ schema_version: 1, name: "CargoLens real-world scenario dataset V5", seed: "deterministic-v5", count: manifest.length, cases: manifest }), "utf8");
console.log(`Generated ${manifest.length} V5 cases in ${ROOT}`);
