import { describe, expect, it } from "vitest";
import { evaluationRoute } from "./evaluation-routing.js";

describe("evaluation routing", () => {
  it("waits for a confidently future draft instead of extracting current attachments", () => {
    expect(evaluationRoute({ category: "BL_COMPARISON", expectation: "FUTURE_DRAFT", expectationConfidence: 0.95 })).toMatchObject({
      route: "WAITING_FOR_FUTURE_DRAFT", requestedAction: "REQUEST_DRAFT", documentExpectation: "DEFERRED", selectedForExtraction: false,
    });
  });

  it("routes current verification states into extraction", () => {
    expect(evaluationRoute({ category: "BL_COMPARISON", expectation: "VERIFY_NOW", expectationConfidence: 0.8 }).selectedForExtraction).toBe(true);
    expect(evaluationRoute({ category: "BL_COMPARISON", expectation: "VERIFY_NOW", expectationConfidence: 0.79 }).selectedForExtraction).toBe(true);
    expect(evaluationRoute({ category: "BL_COMPARISON", expectation: "REPORTS_MISSING", expectationConfidence: 1 }).selectedForExtraction).toBe(false);
    expect(evaluationRoute({ category: "BL_COMPARISON", expectation: "UNCERTAIN" }).route).toBe("EXPECTATION_UNCERTAIN");
    expect(evaluationRoute({ category: "BL_COMPARISON" }).route).toBe("EXPECTATION_UNCERTAIN");
  });

  it("treats wrong documents as an independent issue only for BL comparison", () => {
    expect(evaluationRoute({ category: "BL_COMPARISON", documentIssue: "WRONG_DOCS", documentIssueConfidence: 0.8 }).route).toBe("WRONG_DOCUMENTS");
    expect(evaluationRoute({ category: "GENERAL", documentIssue: "WRONG_DOCS", documentIssueConfidence: 1 }).route).toBe("NOT_APPLICABLE");
    expect(evaluationRoute({ category: "BL_COMPARISON", documentIssue: "WRONG_DOCS", documentIssueConfidence: 0.79 }).route).toBe("EXPECTATION_UNCERTAIN");
  });

  it("does not route unrelated categories into document verification", () => {
    expect(evaluationRoute({ category: "INVOICE_QUERY" })).toMatchObject({ route: "NOT_APPLICABLE", selectedForExtraction: false });
  });
});
