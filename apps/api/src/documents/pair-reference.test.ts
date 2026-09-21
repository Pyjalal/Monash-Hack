import { describe, expect, it } from "vitest";
import { pairReferences, referencesMatch } from "./pair-reference.js";

describe("document pair references", () => {
  it("parses a combined PDF BL and booking-number candidate", () => {
    expect(pairReferences("B/L NUMBER", "SINF90600780   BOOKING NO. ONEYSINF68671")).toEqual([
      { kind: "bill_of_lading", value: "SINF90600780" },
      { kind: "booking", value: "ONEYSINF68671" },
    ]);
  });

  it("matches the shared shipment identifier across XLSX and DOCX template labels", () => {
    const spreadsheet = pairReferences("BL INSTRUCTION", "3658202970");
    const wordDocument = pairReferences("ORDER NO.", "3658202970   FREIGHT PREPAID");
    const secondSpreadsheet = pairReferences("BILL OF LADING", "3658202970");

    expect(spreadsheet).toEqual([{ kind: "shipment", value: "3658202970" }]);
    expect(wordDocument).toEqual([{ kind: "shipment", value: "3658202970" }]);
    expect(referencesMatch(spreadsheet, wordDocument)).toBe(true);
    expect(referencesMatch(spreadsheet, secondSpreadsheet)).toBe(true);
  });

  it("matches only equal identifiers of the same explicit kind", () => {
    expect(referencesMatch(pairReferences("Booking Ref", "ONEYSINF68671"), pairReferences("Booking Reference", "ONEYSINF68671"))).toBe(true);
    expect(referencesMatch(pairReferences("Booking Ref", "ONEYSINF68671"), pairReferences("Booking Ref", "OTHER1234"))).toBe(false);
    expect(referencesMatch(pairReferences("Shipper", "ONEYSINF68671"), pairReferences("Shipper", "ONEYSINF68671"))).toBe(false);
  });
});
