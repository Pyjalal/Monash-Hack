import {
  CATEGORY_LABEL,
  WORKFLOW_LABEL,
  type InboxRow,
  type WorkflowState,
} from "./api";

export type InboxCategory = NonNullable<
  InboxRow["classification"]
>["category"];
export type InboxStatus = InboxRow["status"];

export type InboxMapIcon =
  | "inbox"
  | "classified"
  | "pending"
  | "failed"
  | "comparison"
  | "instruction"
  | "invoice"
  | "general"
  | "spam"
  | "uncertain"
  | "documents"
  | "processing"
  | "review"
  | "verified"
  | "mismatch"
  | "not-applicable";

export interface InboxMapNode {
  id: string;
  label: string;
  count: number;
  x: number;
  y: number;
  size: "root" | "hub" | "leaf";
  tone: string;
  icon: InboxMapIcon;
  messageId?: string;
  filter?: {
    category?: InboxCategory;
    workflow?: WorkflowState;
    status?: InboxStatus;
  };
}

function rowMatchesNode(row: InboxRow, node: InboxMapNode) {
  return (
    (!node.filter?.category ||
      row.classification?.category === node.filter.category) &&
    (!node.filter?.workflow || row.workflowState === node.filter.workflow) &&
    (!node.filter?.status || row.status === node.filter.status)
  );
}

function messagePosition(index: number, total: number) {
  const rows = total > 6 ? 2 : 1;
  const columns = Math.ceil(total / rows);
  const row = Math.floor(index / columns);
  const column = index % columns;
  const itemsInRow = Math.min(columns, total - row * columns);
  const start = 150;
  const end = 650;
  const step = (end - start) / Math.max(1, itemsInRow - 1);

  return {
    x: itemsInRow === 1 ? 400 : start + column * step,
    y: rows === 1 ? 150 : 85 + row * 112,
  };
}

export function buildInboxMapDrilldown(
  rows: InboxRow[],
  overview: InboxMapModel,
  group: InboxMapNode,
) {
  const matchingRows = rows.filter((row) => rowMatchesNode(row, group));
  const visibleRows = matchingRows.slice(0, 12);
  const root = overview.nodes.find((node) => node.id === "root")!;
  const focusedGroup: InboxMapNode = {
    ...group,
    x: 400,
    y: 315,
    size: "hub",
  };
  const messageNodes = visibleRows.map<InboxMapNode>((row, index) => ({
    id: `message-${row.id}`,
    label: row.subject,
    count: 1,
    ...messagePosition(index, visibleRows.length),
    size: "leaf",
    tone: row.status === "failed" ? "red" : "aqua",
    icon: row.status === "failed" ? "failed" : "general",
    messageId: row.id,
  }));

  return {
    summary: overview.summary,
    nodes: [
      { ...root, x: 400, y: 450 },
      focusedGroup,
      ...messageNodes,
    ],
    edges: [
      { from: "root", to: focusedGroup.id },
      ...messageNodes.map((node) => ({ from: focusedGroup.id, to: node.id })),
    ],
    hiddenCount: Math.max(0, matchingRows.length - visibleRows.length),
  };
}

export interface InboxMapModel {
  summary: {
    total: number;
    classified: number;
    pending: number;
    failed: number;
    attention: number;
    resolved: number;
  };
  nodes: InboxMapNode[];
  edges: { from: string; to: string }[];
}

const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL) as InboxCategory[];
const WORKFLOW_ORDER = Object.keys(WORKFLOW_LABEL) as WorkflowState[];

const CATEGORY_VISUAL: Record<
  InboxCategory,
  Pick<InboxMapNode, "tone" | "icon">
> = {
  BL_COMPARISON: { tone: "cyan", icon: "comparison" },
  SI_REQUEST: { tone: "violet", icon: "instruction" },
  INVOICE_QUERY: { tone: "aqua", icon: "invoice" },
  GENERAL: { tone: "slate", icon: "general" },
  SPAM: { tone: "muted", icon: "spam" },
  UNCERTAIN: { tone: "amber", icon: "uncertain" },
};

const WORKFLOW_VISUAL: Record<
  WorkflowState,
  Pick<InboxMapNode, "tone" | "icon">
> = {
  AWAITING_DOCUMENTS: { tone: "gold", icon: "documents" },
  PROCESSING: { tone: "cyan", icon: "processing" },
  BLOCKED: { tone: "amber", icon: "review" },
  VERIFIED: { tone: "green", icon: "verified" },
  MISMATCH: { tone: "red", icon: "mismatch" },
  NOT_APPLICABLE: { tone: "slate", icon: "not-applicable" },
  FAILED: { tone: "red", icon: "failed" },
};

function fanPosition(
  index: number,
  total: number,
  side: "left" | "right",
) {
  const rows = total > 4 ? 2 : 1;
  const columns = Math.ceil(total / rows);
  const row = Math.floor(index / columns);
  const column = index % columns;
  const itemsInRow = Math.min(columns, total - row * columns);
  const regionStart = side === "left" ? 72 : 478;
  const regionEnd = side === "left" ? 322 : 728;
  const step = (regionEnd - regionStart) / Math.max(1, itemsInRow - 1);

  return {
    x:
      itemsInRow === 1
        ? (regionStart + regionEnd) / 2
        : regionStart + column * step,
    y: rows === 1 ? 135 : 82 + row * 112,
  };
}

export function buildInboxMapModel(rows: InboxRow[]): InboxMapModel {
  const classifiedRows = rows.filter((row) => row.status === "classified");
  const pending = rows.filter((row) => row.status === "queued").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const attention = rows.filter(
    (row) =>
      row.status === "failed" ||
      (row.status === "classified" &&
        ["BLOCKED", "MISMATCH", "FAILED"].includes(row.workflowState)),
  ).length;
  const resolved = classifiedRows.filter((row) =>
    ["VERIFIED", "NOT_APPLICABLE"].includes(row.workflowState),
  ).length;

  const nodes: InboxMapNode[] = [
    {
      id: "root",
      label: "Inbox",
      count: rows.length,
      x: 400,
      y: 440,
      size: "root",
      tone: "root",
      icon: "inbox",
    },
  ];
  const edges: InboxMapModel["edges"] = [];

  nodes.push(
    {
      id: "status-classified",
      label: "Classified",
      count: classifiedRows.length,
      x: 400,
      y: 300,
      size: "hub",
      tone: "classified",
      icon: "classified",
      filter: { status: "classified" },
    },
    {
      id: "status-pending",
      label: "Awaiting triage",
      count: pending,
      x: 150,
      y: 370,
      size: "hub",
      tone: "pending",
      icon: "pending",
      filter: { status: "queued" },
    },
    {
      id: "status-failed",
      label: "Classification errors",
      count: failed,
      x: 650,
      y: 400,
      size: "hub",
      tone: "red",
      icon: "failed",
      filter: { status: "failed" },
    },
  );
  edges.push(
    { from: "root", to: "status-classified" },
    { from: "root", to: "status-pending" },
    { from: "root", to: "status-failed" },
  );

  for (const [index, category] of CATEGORY_ORDER.entries()) {
    const count = classifiedRows.filter(
      (row) => row.classification?.category === category,
    ).length;
    nodes.push({
      id: `category-${category}`,
      label: CATEGORY_LABEL[category],
      count,
      ...fanPosition(index, CATEGORY_ORDER.length, "left"),
      size: "leaf",
      filter: { category },
      ...CATEGORY_VISUAL[category],
    });
    edges.push({ from: "status-classified", to: `category-${category}` });
  }

  for (const [index, workflow] of WORKFLOW_ORDER.entries()) {
    const count = classifiedRows.filter(
      (row) => row.workflowState === workflow,
    ).length;
    nodes.push({
      id: `workflow-${workflow}`,
      label: WORKFLOW_LABEL[workflow],
      count,
      ...fanPosition(index, WORKFLOW_ORDER.length, "right"),
      size: "leaf",
      filter: { workflow },
      ...WORKFLOW_VISUAL[workflow],
    });
    edges.push({ from: "status-classified", to: `workflow-${workflow}` });
  }

  return {
    summary: {
      total: rows.length,
      classified: classifiedRows.length,
      pending,
      failed,
      attention,
      resolved,
    },
    nodes,
    edges,
  };
}
