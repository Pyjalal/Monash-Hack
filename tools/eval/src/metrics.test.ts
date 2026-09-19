import { describe, expect, it } from "vitest";
import { classificationMetrics, templateGroup, groupedSplit, pacedMap } from "./metrics.js";

describe("classification evaluation", () => {
  it("counts provider failures and abstentions as uncovered incorrect predictions", () => {
    const report = classificationMetrics([
      { expected: "BL_COMPARISON", predicted: "BL_COMPARISON" },
      { expected: "BL_COMPARISON", predicted: "UNCERTAIN" },
      { expected: "SI_REQUEST", predicted: null },
      { expected: "INVOICE_QUERY", predicted: "INVOICE_QUERY" },
      { expected: "GENERAL", predicted: "GENERAL" },
      { expected: "SPAM", predicted: "SPAM" },
    ]);
    expect(report.accuracy).toBeCloseTo(4 / 6);
    expect(report.providerCoverage).toBeCloseTo(5 / 6);
    expect(report.decisionCoverage).toBeCloseTo(4 / 6);
    expect(report.macroF1).toBeCloseTo((2 / 3 + 0 + 1 + 1 + 1) / 5);
  });

  it("keeps normalized request templates together despite changed shipment numbers", () => {
    expect(templateGroup("Dear Alex,\nPlease send draft BL for ABC12345 for checking.\nThank you.\nAlex"))
      .toBe(templateGroup("Dear Nina,\nPlease send draft BL for XYZ99999 for checking.\nThank you.\nNina"));
    const records = Array.from({ length: 20 }, (_, index) => ({ id: String(index), group: `g${index % 5}`, category: "GENERAL" }));
    const split = groupedSplit(records);
    expect(split.dev.filter(row => split.holdout.some(other => other.group === row.group))).toHaveLength(0);
    expect(split.dev.length + split.holdout.length).toBe(20);
    expect(split.holdout.length).toBeGreaterThan(0);
  });

  it("bounds workers and keeps outputs aligned with their inputs", async () => {
    let active = 0; let maxActive = 0;
    const results = await pacedMap([0, 1, 2, 3, 4], 2, async value => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; return value * 2;
    });
    expect(results).toEqual([0, 2, 4, 6, 8]);
    expect(maxActive).toBe(2);
  });
});
