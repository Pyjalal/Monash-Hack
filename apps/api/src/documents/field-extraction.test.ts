import { describe, expect, it, vi } from "vitest";
import { FIELD_NAMES } from "@cargolens/shared";
import { splitLabelValueCandidates, type AttachmentReadResult, type SourceSpan } from "./index.js";
import { assessExpectedFormat, extractDocumentFields, type DocumentRole } from "./field-extraction.js";

function reading(text: string): AttachmentReadResult {
  let offset = 0;
  const spans: SourceSpan[] = text.split("\n").map((line, index) => {
    const span: SourceSpan = { kind: "line", start: offset, end: offset + line.length, line: index + 1, text: line };
    offset += line.length + 1;
    return span;
  });
  const result: AttachmentReadResult = { sha256: "a".repeat(64), text, spans, status: "READABLE" };
  return { ...result, candidates: splitLabelValueCandidates(result) };
}

const expected = `SHIPPING INSTRUCTION
Shipper/Exporter: Acme Trading
CONSIGNEE: Buyer Limited
Notify: Agent Limited
Port of Loading (POL): Port Klang (MYPKG)
POD: Rotterdam (NLRTM)
No. of Containers: 2 x 40HC
Gross Wt (kgs): 42,500 KG`;

function completeFallback(input: { candidates: Array<{ id: string }> }, role: DocumentRole = "si") {
  return { detectedRole: role, fields: Object.fromEntries(FIELD_NAMES.map((field, index) => [field, { candidateId: input.candidates[index].id, confidence: 0.95 }])) };
}

describe("hybrid SI/BL field extraction", () => {
  it("uses the deterministic path only when the expected format contract is complete", async () => {
    const fallback = vi.fn();
    const result = await extractDocumentFields(reading(expected), "si", fallback);
    expect(result).toMatchObject({ status: "complete", method: "deterministic", unresolvedFields: [] });
    expect(Object.keys(result.fields)).toEqual(FIELD_NAMES);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("routes an unfamiliar label to the source-backed fallback", async () => {
    const changed = reading(expected.replace("Shipper/Exporter", "Exporter legal entity"));
    const fallback = vi.fn(async (input) => completeFallback(input));
    const result = await extractDocumentFields(changed, "si", fallback);
    expect(result.method).toBe("llm_fallback");
    expect(result.assessment.reasons).toContain("missing_expected_label:shipper");
    expect(result.fallbackSelection?.detectedRole).toBe("si");
    expect(result.fallbackSelection?.fields.shipper).toBeDefined();
    expect(result.fields.consignee?.method).toBe("deterministic");
    expect(fallback.mock.calls[0][0].requestedFields).toEqual(["shipper"]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("authoritatively rejects an explicitly labelled non-BL document", async () => {
    const packingList = reading("PACKING LIST\nShipper: Acme Trading\nConsignee: Buyer Limited");
    const fallback = vi.fn();
    const result = await extractDocumentFields(packingList, "bl", fallback);
    expect(result).toMatchObject({ status: "wrong_document_type", method: "deterministic" });
    expect(result.assessment.detectedRole).toBe("other");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("treats duplicate expected labels and malformed numeric values as format drift", () => {
    const duplicate = reading(`${expected}\nNotify Party: Second Agent`);
    expect(assessExpectedFormat(duplicate, "si").reasons).toContain("ambiguous_expected_label:notify_party");
    const malformed = reading(expected.replace("42,500 KG", "weight pending"));
    expect(assessExpectedFormat(malformed, "si").reasons).toContain("implausible_value:gross_weight_kg");
  });

  it("accepts the observed OCR suffix on total gross weight labels", () => {
    const ocrLabel = reading(expected.replace("Gross Wt (kgs): 42,500 KG", "TOTAL Gross Weight nn: (KGS): 42,500 KG"));
    expect(assessExpectedFormat(ocrLabel, "si").reasons).not.toContain("missing_expected_label:gross_weight_kg");
  });

  it("treats blank markers and pending placeholders as missing values", () => {
    const placeholders = reading(expected
      .replace("Port Klang (MYPKG)", "____MT")
      .replace("Rotterdam (NLRTM)", "TBA"));
    expect(assessExpectedFormat(placeholders, "si").reasons).toContain("implausible_value:port_of_loading");
    expect(assessExpectedFormat(placeholders, "si").reasons).toContain("implausible_value:port_of_discharge");
  });

  it("rejects wrong-role and invented fallback selections without replacing supported native fields", async () => {
    const changed = reading(expected.replace("Shipper/Exporter", "Exporter legal entity"));
    const wrongRole = await extractDocumentFields(changed, "si", async input => completeFallback(input, "bl"));
    expect(wrongRole.status).toBe("unresolved");
    expect(wrongRole.fields.consignee?.method).toBe("deterministic");

    const unsafe = await extractDocumentFields(changed, "si", async input => {
      const value = completeFallback(input);
      value.fields.shipper = { candidateId: "invented", confidence: 0.99 };
      value.fields.consignee = { ...value.fields.consignee, confidence: 0.2 };
      return value;
    });
    expect(unsafe.status).toBe("unresolved");
    expect(unsafe.unresolvedFields).toEqual(["shipper"]);
    expect(unsafe.fields.consignee?.method).toBe("deterministic");
  });

  it("fails closed when the fallback provider is unavailable", async () => {
    const changed = reading(expected.replace("Shipper/Exporter", "Exporter legal entity"));
    const result = await extractDocumentFields(changed, "si", async () => { throw new Error("provider unavailable"); });
    expect(result).toMatchObject({ status: "unresolved", method: "llm_fallback", unresolvedFields: ["shipper"] });
    expect(Object.keys(result.fields)).toHaveLength(FIELD_NAMES.length - 1);
    expect(result.assessment.reasons).toContain("fallback_failed");
    expect(result.fallbackError).toBe("Field recovery failed");
  });

  it("accepts verbatim values extracted directly from raw text by fallback without candidate IDs", async () => {
    const changed = reading(expected.replace("Shipper/Exporter", "Exporter legal entity"));
    const result = await extractDocumentFields(changed, "si", async () => ({
      detectedRole: "si",
      fields: {
        shipper: { value: "Acme Trading", confidence: 0.95 },
      },
    }));
    expect(result.status).toBe("complete");
    expect(result.method).toBe("llm_fallback");
    expect(result.fields.shipper?.value).toBe("Acme Trading");
    expect(result.fields.shipper?.confidence).toBe(0.95);
  });
});


it("blocks conflicting role headers before consulting a model", async () => {
  const fallback = vi.fn();
  const result = await extractDocumentFields(reading(`BILL OF LADING
${expected}`), "si", fallback);
  expect(result.status).toBe("unresolved");
  expect(result.assessment.detectedRole).toBe("ambiguous");
  expect(fallback).not.toHaveBeenCalled();
});
it.each([NaN, Infinity, 1.1, -1])("rejects invalid fallback probability %s", async confidence => {
  const input = reading(expected.replace("Shipper/Exporter", "Exporter legal entity"));
  const result = await extractDocumentFields(input, "si", async request => ({ detectedRole: "si", fields: { shipper: { candidateId: request.candidates[0].id, confidence } } }));
  expect(result.unresolvedFields).toContain("shipper");
  expect(result.fields.consignee?.value).toBe("Buyer Limited");
});
