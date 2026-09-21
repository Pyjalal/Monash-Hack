import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CONDITION_SOURCES,
  FLOW_NODE_TYPES,
  FLOW_QUESTIONS,
  FLOW_REPLY_TYPES,
  FLOW_VERSION,
  NUMERIC_CONDITION_SOURCES,
  REQUESTED_ACTIONS,
  SEED_SI_BL_FLOW,
  validateFlow,
  type Flow,
  type FlowNode,
  type FlowNodeType,
} from "@cargolens/shared/flows";
import { FIELD_NAMES, type Category } from "@cargolens/shared";
import { AlertTriangle, Check, Plus, Save, Trash2 } from "lucide-react";
import type { ApiClient } from "../lib/api";
import { describeError, CATEGORY_LABEL } from "../lib/api";
import { Button } from "./ui/button";
import { human } from "../lib/view-model";

const NODE_LABEL: Record<FlowNodeType, string> = {
  trigger: "Trigger",
  jev_question: "Ask a question",
  compare_fields: "Compare fields",
  condition: "Condition",
  draft_email: "Draft a reply",
  escalate: "Escalate",
};

const NODE_HELP: Record<FlowNodeType, string> = {
  trigger: "Which cases this flow runs on.",
  jev_question: "Reads an answer the classifier already produced.",
  compare_fields: "Runs the seven-field check over the real documents.",
  condition: "Splits the path on the current decision.",
  draft_email: "Composes the reply the decision authorises.",
  escalate: "Hands the case to a person and stops.",
};

/** A new node of each type, with configuration that already validates. */
function blankConfig(type: FlowNodeType): FlowNode["config"] {
  switch (type) {
    case "trigger":
      return { category: "BL_COMPARISON" };
    case "jev_question":
      return { question: "expectation" };
    case "compare_fields":
      return { fields: [...FIELD_NAMES] };
    case "condition":
      return { source: "verificationState", operator: "equals", value: "COMPLETE" };
    case "draft_email":
      return { replyType: "REQUEST_DOCUMENTS" };
    case "escalate":
      return { reason: "Needs an operator" };
  }
}

type FlowNodeData = { flowType: FlowNodeType; config: FlowNode["config"] };

function CargoNode({ data, selected }: NodeProps) {
  const { flowType, config } = data as unknown as FlowNodeData;
  const summary = describeConfig(flowType, config);
  return (
    <div className={`flow-node flow-node--${flowType}${selected ? " is-selected" : ""}`}>
      {flowType !== "trigger" && <Handle type="target" position={Position.Left} />}
      <p className="flow-node__type">{NODE_LABEL[flowType]}</p>
      <p className="flow-node__summary">{summary}</p>
      {flowType === "condition" ? (
        <>
          <Handle type="source" position={Position.Right} id="true" style={{ top: "35%" }} />
          <Handle type="source" position={Position.Right} id="false" style={{ top: "70%" }} />
          <span className="flow-node__branch flow-node__branch--true">true</span>
          <span className="flow-node__branch flow-node__branch--false">false</span>
        </>
      ) : flowType === "draft_email" || flowType === "escalate" ? null : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

function describeConfig(type: FlowNodeType, config: FlowNode["config"]): string {
  const c = config as Record<string, unknown>;
  switch (type) {
    case "trigger":
      return `${CATEGORY_LABEL[c.category as Category]}${c.requestedAction ? ` · ${human(String(c.requestedAction))}` : ""}`;
    case "jev_question":
      return human(String(c.question));
    case "compare_fields":
      return `${(c.fields as string[]).length} of 7 fields`;
    case "condition":
      return `${String(c.source)} ${c.operator === "at_least" ? "≥" : c.operator === "equals" ? "=" : "≠"} ${String(c.value)}`;
    case "draft_email":
      return human(String(c.replyType));
    case "escalate":
      return String(c.reason);
  }
}

const nodeTypes = { cargolens: CargoNode };

function toReactFlow(flow: Flow): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: flow.nodes.map((node, index) => ({
      id: node.id,
      type: "cargolens",
      position: node.position ?? { x: index * 220, y: 0 },
      data: { flowType: node.type, config: node.config } as unknown as Record<string, unknown>,
    })),
    edges: flow.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.branch,
      label: edge.branch ?? undefined,
      className: edge.branch ? `flow-edge--${edge.branch}` : undefined,
    })),
  };
}

function fromReactFlow(id: string, name: string, nodes: Node[], edges: Edge[]): Flow {
  return {
    id,
    name,
    version: FLOW_VERSION,
    nodes: nodes.map((node) => {
      const data = node.data as unknown as FlowNodeData;
      return {
        id: node.id,
        type: data.flowType,
        config: data.config,
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      } as FlowNode;
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      branch: (edge.sourceHandle as "true" | "false" | null) ?? null,
    })),
  };
}

export function FlowBuilder({ api }: { api: ApiClient }) {
  const [flow, setFlow] = useState<Flow>(SEED_SI_BL_FLOW);
  const initial = useMemo(() => toReactFlow(SEED_SI_BL_FLOW), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .flows()
      .then((result) => {
        const saved = result.flows.find((row) => row.id === SEED_SI_BL_FLOW.id) ?? result.flows[0];
        if (!live || !saved) return;
        setFlow(saved);
        const mapped = toReactFlow(saved);
        setNodes(mapped.nodes);
        setEdges(mapped.edges);
      })
      .catch(() => {
        /* An unreachable API leaves the seeded flow on the canvas. */
      });
    return () => {
      live = false;
    };
  }, [api, setNodes, setEdges]);

  // Validation runs on the same contract the server enforces, so the canvas
  // reports the identical problem rather than a looser client-side guess.
  const draft = useMemo(() => fromReactFlow(flow.id, flow.name, nodes, edges), [flow.id, flow.name, nodes, edges]);
  const validation = useMemo(() => validateFlow(draft), [draft]);

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `e${Date.now().toString(36)}`,
            label: connection.sourceHandle ?? undefined,
            className: connection.sourceHandle ? `flow-edge--${connection.sourceHandle}` : undefined,
          },
          current,
        ),
      ),
    [setEdges],
  );

  function addNode(type: FlowNodeType) {
    const id = `${type}-${Date.now().toString(36)}`;
    setNodes((current) => [
      ...current,
      {
        id,
        type: "cargolens",
        position: { x: 80 + current.length * 40, y: 180 + (current.length % 4) * 90 },
        data: { flowType: type, config: blankConfig(type) } as unknown as Record<string, unknown>,
      },
    ]);
    setSelected(id);
  }

  function updateConfig(patch: Record<string, unknown>) {
    setNodes((current) =>
      current.map((node) =>
        node.id === selected
          ? { ...node, data: { ...node.data, config: { ...(node.data as unknown as FlowNodeData).config, ...patch } } }
          : node,
      ),
    );
  }

  function removeSelected() {
    if (!selected) return;
    setNodes((current) => current.filter((node) => node.id !== selected));
    setEdges((current) => current.filter((edge) => edge.source !== selected && edge.target !== selected));
    setSelected(null);
  }

  async function save() {
    setBusy(true);
    setStatus("");
    setServerErrors([]);
    try {
      const result = await api.saveFlow(draft);
      setFlow(result.flow);
      setStatus("Saved. The interpreter will use this version on the next run.");
    } catch (error) {
      const detail = error as { details?: unknown; code?: string };
      setServerErrors(
        Array.isArray((detail as { errors?: string[] }).errors)
          ? (detail as { errors: string[] }).errors
          : [describeError(error)],
      );
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  const current = nodes.find((node) => node.id === selected);
  const currentData = current ? (current.data as unknown as FlowNodeData) : null;

  return (
    <div className="flow-builder">
      <div className="section-heading">
        <div>
          <h2>Workflow builder</h2>
          <p className="small muted">
            Six node types that run through the same functions as the pipeline. A graph that will
            not execute is refused rather than saved as a drawing.
          </p>
        </div>
        <Button disabled={busy || !validation.ok} onClick={() => void save()}>
          <Save size={16} />
          {busy ? "Saving…" : "Save flow"}
        </Button>
      </div>

      {!validation.ok && (
        <div className="warning-box" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>This graph will not execute</strong>
            <ul>
              {validation.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {serverErrors.length > 0 && (
        <p role="alert" className="error-box">
          {serverErrors.join(" ")}
        </p>
      )}
      {status && (
        <p role="status" className="info-box">
          <Check size={15} /> {status}
        </p>
      )}

      <div className="flow-layout">
        <div className="flow-palette">
          <p className="panel-label">Add a node</p>
          {FLOW_NODE_TYPES.map((type) => (
            <button key={type} type="button" onClick={() => addNode(type)}>
              <Plus size={14} />
              <span>
                <strong>{NODE_LABEL[type]}</strong>
                <small>{NODE_HELP[type]}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="flow-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, node) => setSelected(node.id)}
            onPaneClick={() => setSelected(null)}
            fitView
            proOptions={{ hideAttribution: false }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        <div className="flow-inspector">
          <p className="panel-label">Configuration</p>
          {!currentData ? (
            <p className="muted small">
              Select a node to configure it. Drag from a node's right edge to connect it to the next
              one; a condition has a true and a false outlet.
            </p>
          ) : (
            <>
              <h3>{NODE_LABEL[currentData.flowType]}</h3>
              <NodeConfig data={currentData} update={updateConfig} />
              <Button variant="ghost" size="small" onClick={removeSelected}>
                <Trash2 size={14} />
                Remove this node
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NodeConfig({
  data,
  update,
}: {
  data: FlowNodeData;
  update: (patch: Record<string, unknown>) => void;
}) {
  const config = data.config as Record<string, unknown>;
  if (data.flowType === "trigger") {
    return (
      <>
        <label>
          Category
          <select value={String(config.category)} onChange={(e) => update({ category: e.target.value })}>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Requested action
          <select
            value={String(config.requestedAction ?? "")}
            onChange={(e) => update({ requestedAction: e.target.value || undefined })}
          >
            <option value="">Any</option>
            {REQUESTED_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {human(value)}
              </option>
            ))}
          </select>
        </label>
      </>
    );
  }
  if (data.flowType === "jev_question") {
    return (
      <label>
        Question
        <select value={String(config.question)} onChange={(e) => update({ question: e.target.value })}>
          {FLOW_QUESTIONS.map((value) => (
            <option key={value} value={value}>
              {human(value)}
            </option>
          ))}
        </select>
        <small className="muted">
          Only questions the pipeline already asks. A flow cannot introduce new prompt text.
        </small>
      </label>
    );
  }
  if (data.flowType === "compare_fields") {
    const fields = config.fields as string[];
    return (
      <fieldset className="flow-fields">
        <legend>Fields to compare</legend>
        {FIELD_NAMES.map((field) => (
          <label key={field}>
            <input
              type="checkbox"
              checked={fields.includes(field)}
              onChange={(e) =>
                update({
                  fields: e.target.checked
                    ? [...fields, field]
                    : fields.filter((row) => row !== field),
                })
              }
            />
            {human(field)}
          </label>
        ))}
      </fieldset>
    );
  }
  if (data.flowType === "condition") {
    const numeric = NUMERIC_CONDITION_SOURCES.includes(config.source as never);
    return (
      <>
        <label>
          Compare
          <select
            value={String(config.source)}
            onChange={(e) => {
              const next = e.target.value;
              const nowNumeric = NUMERIC_CONDITION_SOURCES.includes(next as never);
              update({
                source: next,
                value: nowNumeric ? 0 : "COMPLETE",
                operator: nowNumeric ? "at_least" : "equals",
              });
            }}
          >
            {CONDITION_SOURCES.map((value) => (
              <option key={value} value={value}>
                {human(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Operator
          <select value={String(config.operator)} onChange={(e) => update({ operator: e.target.value })}>
            <option value="equals">equals</option>
            <option value="not_equals">does not equal</option>
            {numeric && <option value="at_least">is at least</option>}
          </select>
        </label>
        <label>
          Value
          {numeric ? (
            <input
              type="number"
              min={0}
              max={7}
              value={Number(config.value)}
              onChange={(e) => update({ value: Number(e.target.value) })}
            />
          ) : (
            <input value={String(config.value)} onChange={(e) => update({ value: e.target.value })} />
          )}
        </label>
      </>
    );
  }
  if (data.flowType === "draft_email") {
    return (
      <label>
        Reply type
        <select value={String(config.replyType)} onChange={(e) => update({ replyType: e.target.value })}>
          {FLOW_REPLY_TYPES.map((value) => (
            <option key={value} value={value}>
              {human(value)}
            </option>
          ))}
        </select>
        <small className="muted">
          The decision still has to ask for this reply. A mismatch is refused at run time.
        </small>
      </label>
    );
  }
  return (
    <label>
      Reason
      <input value={String(config.reason)} onChange={(e) => update({ reason: e.target.value })} />
    </label>
  );
}
