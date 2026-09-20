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
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("treats duplicate expected labels and malformed numeric values as format drift", () => {
    const duplicate = reading(`${expected}\nNotify Party: Second Agent`);
    expect(assessExpectedFormat(duplicate, "si").reasons).toContain("ambiguous_expected_label:notify_party");
    const malformed = reading(expected.replace("42,500 KG", "weight pending"));
    expect(assessExpectedFormat(malformed, "si").reasons).toContain("implausible_value:gross_weight_kg");
  });

  it("rejects wrong-role, invented, and low-confidence fallback selections", async () => {
    const changed = reading(expected.replace("Shipper/Exporter", "Exporter legal entity"));
    const wrongRole = await extractDocumentFields(changed, "si", async input => completeFallback(input, "bl"));
    expect(wrongRole.status).toBe("wrong_document_type");

    const unsafe = await extractDocumentFields(changed, "si", async input => {
      const value = completeFallback(input);
      value.fields.shipper = { candidateId: "invented", confidence: 0.99 };
      value.fields.consignee = { ...value.fields.consignee, confidence: 0.2 };
      return value;
    });
    expect(unsafe.status).toBe("unresolved");
    expect(unsafe.unresolvedFields).toEqual(expect.arrayContaining(["shipper", "consignee"]));
  });

  it("fails closed when the fallback provider is unavailable", async () => {
    const changed = reading(expected.replace("Shipper/Exporter", "Exporter legal entity"));
    const result = await extractDocumentFields(changed, "si", async () => { throw new Error("provider unavailable"); });
    expect(result).toMatchObject({ status: "unresolved", method: "llm_fallback", unresolvedFields: FIELD_NAMES });
    expect(result.assessment.reasons).toContain("fallback_failed");
    expect(result.fallbackError).toBe("provider unavailable");
  });
});
