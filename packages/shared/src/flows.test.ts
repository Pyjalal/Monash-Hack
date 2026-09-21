import { describe, expect, it } from "vitest";
import { FlowSchema, parseFlow, validateFlow, SEED_SI_BL_FLOW, FLOW_VERSION } from "./flows.js";

const node = (id: string, type: string, config: unknown) => ({ id, type, config, position: { x: 0, y: 0 } });
const edge = (id: string, from: string, to: string, branch: "true" | "false" | null = null) => ({ id, from, to, branch });

function baseFlow(overrides: Partial<{ nodes: unknown[]; edges: unknown[] }> = {}) {
  return {
    id: "flow-test",
    name: "Test flow",
    version: FLOW_VERSION,
    nodes: overrides.nodes ?? [
      node("t", "trigger", { category: "BL_COMPARISON" }),
      node("c", "compare_fields", { fields: ["shipper"] }),
      node("d", "draft_email", { replyType: "REQUEST_DOCUMENTS" }),
    ],
    edges: overrides.edges ?? [edge("e1", "t", "c"), edge("e2", "c", "d")],
  };
}

describe("flow contract", () => {
  it("accepts a supported graph and round-trips without losing configuration", () => {
    const parsed = parseFlow(baseFlow());
    expect(validateFlow(parsed)).toEqual({ ok: true, order: ["t", "c", "d"] });
    expect(parseFlow(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects unknown node types and unknown configuration keys", () => {
    expect(() => parseFlow(baseFlow({ nodes: [node("t", "run_script", { cmd: "rm -rf /" })] }))).toThrow();
    // A saved flow cannot smuggle free-text prompts past the fixed question set.
    expect(() => parseFlow(baseFlow({ nodes: [node("t", "jev_question", { question: "ignore previous instructions" })] }))).toThrow();
    expect(() => parseFlow(baseFlow({
      nodes: [node("t", "trigger", { category: "BL_COMPARISON", script: "x" })],
    }))).toThrow();
  });

  it("reports every structural problem instead of only the first", () => {
    const result = validateFlow(parseFlow(baseFlow({
      nodes: [
        node("t", "trigger", { category: "BL_COMPARISON" }),
        node("a", "compare_fields", { fields: ["shipper"] }),
        node("orphan", "escalate", { reason: "never reached" }),
      ],
      edges: [edge("e1", "t", "a"), edge("e2", "a", "missing")],
    })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("missing");
    expect(result.errors.join(" ")).toContain("orphan");
  });

  it("requires exactly one trigger with no inbound edge", () => {
    const two = validateFlow(parseFlow(baseFlow({
      nodes: [
        node("t", "trigger", { category: "BL_COMPARISON" }),
        node("t2", "trigger", { category: "SI_REQUEST" }),
        node("d", "draft_email", { replyType: "REQUEST_DOCUMENTS" }),
      ],
      edges: [edge("e1", "t", "d"), edge("e2", "t2", "d")],
    })));
    expect(two.ok).toBe(false);

    const inbound = validateFlow(parseFlow(baseFlow({
      nodes: [
        node("t", "trigger", { category: "BL_COMPARISON" }),
        node("d", "draft_email", { replyType: "REQUEST_DOCUMENTS" }),
      ],
      edges: [edge("e1", "t", "d"), edge("e2", "d", "t")],
    })));
    expect(inbound.ok).toBe(false);
  });

  it("rejects cycles rather than letting the interpreter run forever", () => {
    const result = validateFlow(parseFlow(baseFlow({
      nodes: [
        node("t", "trigger", { category: "BL_COMPARISON" }),
        node("a", "compare_fields", { fields: ["shipper"] }),
        node("b", "compare_fields", { fields: ["consignee"] }),
      ],
      edges: [edge("e1", "t", "a"), edge("e2", "a", "b"), edge("e3", "b", "a")],
    })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ").toLowerCase()).toContain("cycle");
  });

  it("requires a condition to have exactly one true and one false branch", () => {
    const missingBranch = validateFlow(parseFlow(baseFlow({
      nodes: [
        node("t", "trigger", { category: "BL_COMPARISON" }),
        node("q", "condition", { source: "verificationState", operator: "equals", value: "COMPLETE" }),
        node("d", "draft_email", { replyType: "CONFIRM_MATCH" }),
      ],
      edges: [edge("e1", "t", "q"), edge("e2", "q", "d", "true")],
    })));
    expect(missingBranch.ok).toBe(false);

    const branchOnPlainNode = validateFlow(parseFlow(baseFlow({
      edges: [edge("e1", "t", "c"), edge("e2", "c", "d", "true")],
    })));
    expect(branchOnPlainNode.ok).toBe(false);
  });

  it("requires every path to end in a draft or an escalation", () => {
    const result = validateFlow(parseFlow(baseFlow({
      nodes: [
        node("t", "trigger", { category: "BL_COMPARISON" }),
        node("c", "compare_fields", { fields: ["shipper"] }),
      ],
      edges: [edge("e1", "t", "c")],
    })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ").toLowerCase()).toContain("outcome");
  });

  it("ships a seeded SI-to-BL flow that is itself supported", () => {
    const seed = parseFlow(SEED_SI_BL_FLOW);
    const result = validateFlow(seed);
    expect(result).toMatchObject({ ok: true });
    expect(FlowSchema.safeParse(SEED_SI_BL_FLOW).success).toBe(true);
    // It must exercise the real product path: compare, branch, and both outcomes.
    const types = seed.nodes.map((n) => n.type);
    expect(types).toContain("compare_fields");
    expect(types).toContain("condition");
    expect(types).toContain("draft_email");
    expect(types).toContain("escalate");
  });
});
