import { describe, expect, it } from "vitest";
import { acceptFormattingVerdict, isFormattingOnlyDifference, isPartyWithOmittedAddress, normaliseFieldValue } from "./value-comparison.js";

describe("field value comparison policy", () => {
  it("normalizes exact numeric fields without semantic comparison", () => {
    expect(normaliseFieldValue("gross_weight_kg", "243,588 KG")).toBe("243588");
    expect(normaliseFieldValue("container_count", "12 x 20'FCL")).toBe("12");
    expect(isFormattingOnlyDifference("gross_weight_kg", "243588", "243,588")).toBe(false);
  });

  it("allows only whitespace, line-break, punctuation and symbol presentation differences", () => {
    expect(isFormattingOnlyDifference("shipper",
      "APRIL FINE PAPER TRADING | 77 ROBINSON ROAD, #21-01; SINGAPORE 068896",
      "APRIL FINE PAPER TRADING\n77 ROBINSON ROAD #21-01\nSINGAPORE 068896")).toBe(true);
    expect(isFormattingOnlyDifference("consignee", "A & B TRADING", "A AND B TRADING")).toBe(true);
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

  it("permits an omitted postal address only for the same party and a confident Jev verdict", () => {
    const company = "APRIL FAR EAST (M) SDN BHD";
    const companyWithAddress = "APRIL FAR EAST (M) SDN BHD\nTOWER 2, AVENUE 5, LEVEL 6\n59200 KUALA LUMPUR, MALAYSIA";
    expect(isPartyWithOmittedAddress("shipper", company, companyWithAddress)).toBe(true);
    expect(acceptFormattingVerdict("shipper", company, companyWithAddress, { equivalent: true, confidence: 0.95 })).toBe(true);
    expect(acceptFormattingVerdict("shipper", company, companyWithAddress, { equivalent: false, confidence: 1 })).toBe(false);
    expect(isPartyWithOmittedAddress("port_of_loading", "KUALA LUMPUR, MALAYSIA", "MALAYSIA")).toBe(false);
    expect(isPartyWithOmittedAddress("shipper", "ACME TRADING", "ACME TRADING SUBSIDIARY")).toBe(false);
  });
});
