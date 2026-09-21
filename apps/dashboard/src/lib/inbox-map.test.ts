import { describe, expect, it } from "vitest";
import type { InboxRow } from "./api";
import { buildInboxMapDrilldown, buildInboxMapModel } from "./inbox-map";

type Category = NonNullable<InboxRow["classification"]>["category"];

const row = (
  id: string,
  status: InboxRow["status"],
  category: Category | null,
  workflowState: InboxRow["workflowState"],
): InboxRow => ({
  id,
  subject: `Shipment ${id}`,
  from: "operations@example.test",
  status,
  classification:
    category === null
      ? null
      : {
          id,
          category,
          confidence: 1,
          probabilities: { [category]: 1 },
          urgency: null,
          expectation: "VERIFY_NOW",
          expectationConfidence: 1,
          model: "fixture",
          questionVersion: "fixture",
          cached: false,
          usage: null,
          usageRequestId: null,
          elapsedMs: 10,
        },
  workflowState,
  sourceVersion: "v1",
});

describe("inbox map model", () => {
  it("derives honest category, workflow and attention counts from inbox rows", () => {
    const model = buildInboxMapModel([
      row("1", "classified", "BL_COMPARISON", "MISMATCH"),
      row("2", "classified", "BL_COMPARISON", "VERIFIED"),
      row("3", "classified", "SI_REQUEST", "BLOCKED"),
      row("4", "queued", null, "AWAITING_DOCUMENTS"),
      row("5", "failed", null, "FAILED"),
    ]);

    expect(model.summary).toEqual({
      total: 5,
      classified: 3,
      pending: 1,
      failed: 1,
      attention: 3,
      resolved: 1,
    });
    expect(model.nodes.find((node) => node.id === "category-BL_COMPARISON")).toMatchObject({
      count: 2,
      filter: { category: "BL_COMPARISON" },
    });
    expect(model.nodes.find((node) => node.id === "category-SI_REQUEST")).toMatchObject({
      count: 1,
      filter: { category: "SI_REQUEST" },
    });
    expect(model.nodes.find((node) => node.id === "workflow-MISMATCH")).toMatchObject({
      count: 1,
      filter: { workflow: "MISMATCH" },
    });
    expect(model.nodes.find((node) => node.id === "status-pending")).toMatchObject({
      count: 1,
      filter: { status: "queued" },
    });
    expect(model.edges).toContainEqual({ from: "root", to: "status-classified" });
    expect(new Set(model.nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(
      model.nodes.length,
    );
  });

  it("keeps every supported branch discoverable when the inbox is empty", () => {
    const model = buildInboxMapModel([]);

    expect(model.summary.total).toBe(0);
    expect(model.nodes).toHaveLength(17);
    expect(model.nodes.every((node) => node.count === 0)).toBe(true);
    expect(model.edges).toHaveLength(16);
  });

  it("opens an aggregate branch into connected correspondence nodes", () => {
    const rows = [
      row("1", "classified", "BL_COMPARISON", "MISMATCH"),
      row("2", "classified", "BL_COMPARISON", "VERIFIED"),
      row("3", "classified", "SI_REQUEST", "BLOCKED"),
    ];
    const overview = buildInboxMapModel(rows);
    const group = overview.nodes.find(
      (node) => node.id === "category-BL_COMPARISON",
    )!;
    const drilldown = buildInboxMapDrilldown(rows, overview, group);

    expect(drilldown.nodes.map((node) => node.id)).toEqual([
      "root",
      "category-BL_COMPARISON",
      "message-1",
      "message-2",
    ]);
    expect(drilldown.edges).toContainEqual({
      from: "category-BL_COMPARISON",
      to: "message-1",
    });
    expect(drilldown.hiddenCount).toBe(0);
  });
});
