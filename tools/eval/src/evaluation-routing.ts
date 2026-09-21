export type EvaluationRouteName =
  | "MISSING_CLASSIFICATION"
  | "NOT_APPLICABLE"
  | "WAITING_FOR_FUTURE_DRAFT"
  | "VERIFY_DOCUMENTS_NOW"
  | "WRONG_DOCUMENTS"
  | "EXPECTATION_UNCERTAIN";

export interface EvaluationRoute {
  route: EvaluationRouteName;
  selectedForExtraction: boolean;
  requestedAction: "REQUEST_DRAFT" | "VERIFY_DOCUMENTS" | "OTHER" | "UNCERTAIN";
  documentExpectation: "DEFERRED" | "EXPECTED_NOW" | "UNCERTAIN";
  workflowState: "AWAITING_DOCUMENTS" | "READY_FOR_EXTRACTION" | "NOT_APPLICABLE" | "BLOCKED";
  reason: string;
}

interface RoutingClassification {
  category?: unknown;
  expectation?: unknown;
  expectationConfidence?: unknown;
  documentIssue?: unknown;
  documentIssueConfidence?: unknown;
}

/** Mirrors the operational initial-decision boundary for evaluation runs. */
export function evaluationRoute(classification: RoutingClassification | null | undefined): EvaluationRoute {
  if (!classification || typeof classification.category !== "string") return {
    route: "MISSING_CLASSIFICATION", selectedForExtraction: false, requestedAction: "UNCERTAIN",
    documentExpectation: "UNCERTAIN", workflowState: "BLOCKED", reason: "Classification details are unavailable.",
  };
  if (classification.category !== "BL_COMPARISON") return {
    route: "NOT_APPLICABLE", selectedForExtraction: false, requestedAction: "OTHER",
    documentExpectation: "UNCERTAIN", workflowState: "NOT_APPLICABLE", reason: `${classification.category} does not require SI/BL verification.`,
  };
  const issueConfidence = typeof classification.documentIssueConfidence === "number" && Number.isFinite(classification.documentIssueConfidence)
    ? classification.documentIssueConfidence : 0;
  if (classification.documentIssue === "WRONG_DOCS" && issueConfidence >= 0.8) return {
    route: "WRONG_DOCUMENTS", selectedForExtraction: true, requestedAction: "VERIFY_DOCUMENTS",
    documentExpectation: "EXPECTED_NOW", workflowState: "READY_FOR_EXTRACTION",
    reason: "The BL comparison reports that the supplied document is not an SI or BL.",
  };
  if (classification.expectation === "FUTURE_DRAFT") return {
    route: "WAITING_FOR_FUTURE_DRAFT", selectedForExtraction: false, requestedAction: "REQUEST_DRAFT",
    documentExpectation: "DEFERRED", workflowState: "AWAITING_DOCUMENTS", reason: "The sender is waiting for a future draft; there is nothing current to verify.",
  };
  if (classification.expectation === "VERIFY_NOW") return {
    route: "VERIFY_DOCUMENTS_NOW", selectedForExtraction: true, requestedAction: "VERIFY_DOCUMENTS",
    documentExpectation: "EXPECTED_NOW", workflowState: "READY_FOR_EXTRACTION",
    reason: "Current SI/BL documents should be verified now.",
  };
  return {
    route: "EXPECTATION_UNCERTAIN", selectedForExtraction: false, requestedAction: "UNCERTAIN",
    documentExpectation: "UNCERTAIN", workflowState: "BLOCKED", reason: "The timing expectation is missing or uncertain.",
  };
}
