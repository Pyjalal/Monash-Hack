import { describe, expect, it } from "vitest";
import { acceptFormattingVerdict, isConfidentSemanticDifference, isFormattingOnlyDifference, isPartyWithOmittedAddress, normaliseFieldValue, semanticVerdictFromSameProbability, weightValueWithSourceUnit } from "./value-comparison.js";

describe("field value comparison policy", () => {
  it("normalizes exact numeric fields without semantic comparison", () => {
    expect(normaliseFieldValue("gross_weight_kg", "243,588 KG")).toBe("243588");
    expect(normaliseFieldValue("gross_weight_kg", "(KGS): 143,940 KG")).toBe("143940");
    expect(normaliseFieldValue("container_count", "12 x 20'FCL")).toBe("12");
    expect(isFormattingOnlyDifference("gross_weight_kg", "243588", "243,588")).toBe(false);
  });

  it("supplies kilograms for a bare value from an explicit gross-weight field", () => {
    expect(weightValueWithSourceUnit("341715", "GROSS WEIGHT")).toBe("341715 KG");
    expect(normaliseFieldValue("gross_weight_kg", weightValueWithSourceUnit("341715", "GROSS WEIGHT"))).toBe("341715");
    expect(weightValueWithSourceUnit("341715", "Invoice total")).toBe("341715");
  });

  it("allows only whitespace, line-break, punctuation and symbol presentation differences", () => {
    expect(isFormattingOnlyDifference("shipper",
      "APRIL FINE PAPER TRADING | 77 ROBINSON ROAD, #21-01; SINGAPORE 068896",
      "APRIL FINE PAPER TRADING\n77 ROBINSON ROAD #21-01\nSINGAPORE 068896")).toBe(true);
    expect(isFormattingOnlyDifference("consignee", "A & B TRADING", "A AND B TRADING")).toBe(true);
    expect(normaliseFieldValue("consignee", "A & B TRADING")).toBe(normaliseFieldValue("consignee", "A AND B TRADING"));
  });

  it("rejects missing specificity even if an AI were to call the values equivalent", () => {
    expect(isFormattingOnlyDifference("port_of_loading", "KUALA LUMPUR, MALAYSIA", "MALAYSIA")).toBe(false);
    expect(isFormattingOnlyDifference("shipper", "ACME TRADING, 12 MAIN ROAD", "ACME TRADING")).toBe(false);
    expect(acceptFormattingVerdict("port_of_loading", "KUALA LUMPUR, MALAYSIA", "MALAYSIA", { equivalent: true, confidence: 1 })).toBe(false);
  });

  it("requires both a formatting-only difference and a confident AI verdict", () => {
    const si = "AL GURG STATIONERY LLC | P.O. BOX 5069; DUBAI";
    const bl = "AL GURG STATIONERY LLC\nP.O. BOX 5069\nDUBAI";
    expect(acceptFormattingVerdict("consignee", si, bl, { equivalent: true, confidence: 0.95 })).toBe(true);
    expect(acceptFormattingVerdict("consignee", si, bl, { equivalent: true, confidence: 0.7 })).toBe(false);
    expect(acceptFormattingVerdict("consignee", si, bl, { equivalent: false, confidence: 1 })).toBe(false);
  });

  it("uses separate confidence boundaries for same and different verdicts", () => {
    const same = semanticVerdictFromSameProbability(0.9);
    const different = semanticVerdictFromSameProbability(0.14);
    const uncertain = semanticVerdictFromSameProbability(0.16);
    expect(same).toEqual({ equivalent: true, confidence: 0.9 });
    expect(acceptFormattingVerdict("consignee", "ACME, LTD", "ACME LTD", same)).toBe(true);
    expect(different).toEqual({ equivalent: false, confidence: 0.86 });
    expect(isConfidentSemanticDifference(different)).toBe(true);
    expect(isConfidentSemanticDifference(uncertain)).toBe(false);
  });

  it("rejects omitted postal address even with a confident model verdict", () => {
    const company = "APRIL FAR EAST (M) SDN BHD";
    const companyWithAddress = "APRIL FAR EAST (M) SDN BHD\nTOWER 2, AVENUE 5, LEVEL 6\n59200 KUALA LUMPUR, MALAYSIA";
    expect(isPartyWithOmittedAddress("shipper", company, companyWithAddress)).toBe(false);
    expect(acceptFormattingVerdict("shipper", company, companyWithAddress, { equivalent: true, confidence: 0.95 })).toBe(false);
    expect(acceptFormattingVerdict("shipper", company, companyWithAddress, { equivalent: false, confidence: 1 })).toBe(false);
    expect(isPartyWithOmittedAddress("port_of_loading", "KUALA LUMPUR, MALAYSIA", "MALAYSIA")).toBe(false);
    expect(isPartyWithOmittedAddress("shipper", "ACME TRADING", "ACME TRADING SUBSIDIARY")).toBe(false);
  });
});


describe("untrusted numeric and text values", () => {
  it("preserves units and rejects ambiguous numeric fragments", () => {
    expect(normaliseFieldValue("gross_weight_kg", "100 KG")).not.toBe(normaliseFieldValue("gross_weight_kg", "100 MT"));
    expect(normaliseFieldValue("gross_weight_kg", "1 MT")).toBe(normaliseFieldValue("gross_weight_kg", "1,000 KG"));
    expect(normaliseFieldValue("gross_weight_kg", "100")).toBe("100");
    for (const value of ["100 LB", "100 KG / 200 KG", "TBA"]) expect(normaliseFieldValue("gross_weight_kg", value)).toBeNull();
    for (const value of ["abc 2", "2 or 3", "0", "1.5"]) expect(normaliseFieldValue("container_count", value)).toBeNull();
  });
  it("does not erase non-Latin company names or accept invalid confidence", () => {
    expect(normaliseFieldValue("shipper", "中远")).not.toBe(normaliseFieldValue("shipper", "中海"));
    for (const confidence of [NaN, Infinity, 1.1, -1]) expect(acceptFormattingVerdict("shipper", "ACME, LTD", "ACME LTD", { equivalent: true, confidence })).toBe(false);
  });
});
