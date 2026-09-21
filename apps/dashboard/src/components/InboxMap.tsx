import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, Minus, Plus } from "lucide-react";
import type { InboxRow } from "../lib/api";
import {
  buildInboxMapModel,
  buildInboxMapDrilldown,
  type InboxMapIcon,
  type InboxMapNode,
  type InboxStatus,
} from "../lib/inbox-map";

interface InboxMapProps {
  rows: InboxRow[];
  loaded: boolean;
  category: string;
  workflow: string;
  status: string;
  onCategoryChange: (value: string) => void;
  onWorkflowChange: (value: string) => void;
  onStatusChange: (value: InboxStatus | "") => void;
  onMessageSelect: (id: string) => void;
  onClearFilters: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function InboxMapGlyph({ icon }: { icon: InboxMapIcon }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const paths: Record<InboxMapIcon, ReactNode> = {
    inbox: (
      <>
        <path {...common} d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5Z" />
        <path {...common} d="M7.5 10.5h9v6h-9zM8.5 8.2h7" />
        <circle cx="16.8" cy="8.2" r="2.3" {...common} />
      </>
    ),
    classified: (
      <>
        <path {...common} d="M5 4h14v16H5zM8 8h4M8 12h8M8 16h5" />
        <path {...common} d="m14.5 7.8 1.2 1.2 2.3-2.4" />
      </>
    ),
    pending: (
      <>
        <path {...common} d="M6 3.5h9l3 3V20H6zM15 3.5v3h3" />
        <circle cx="10.5" cy="13.8" r="3.2" {...common} />
        <path {...common} d="M10.5 12v2.1l1.5.9" />
      </>
    ),
    failed: (
      <>
        <path {...common} d="m12 3 9 16H3Z" />
        <path {...common} d="M12 8v5m0 3.2v.1" />
      </>
    ),
    comparison: (
      <>
        <path {...common} d="M3.5 5h7v13h-7zM13.5 5h7v13h-7z" />
        <path {...common} d="M6 9h2m-2 3h2m8-3h2m-2 3h2" />
        <path {...common} d="m8.2 16 1.4 1.4 3.2-3.4" />
      </>
    ),
    instruction: (
      <>
        <path {...common} d="M5 3.5h10l4 4V20.5H5zM15 3.5v4h4" />
        <path {...common} d="M8 11h8m-8 3h8m-8 3h5" />
      </>
    ),
    invoice: (
      <>
        <path {...common} d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" />
        <path {...common} d="M9 8h6m-6 4h6m-6 4h3" />
      </>
    ),
    general: (
      <>
        <path {...common} d="M4 5.5h16v11H9l-5 4z" />
        <path {...common} d="M8 9h8m-8 3.5h5" />
      </>
    ),
    spam: (
      <>
        <path {...common} d="M12 3.5 19 6v5.2c0 4.1-2.8 7.7-7 9.3-4.2-1.6-7-5.2-7-9.3V6z" />
        <path {...common} d="m9.5 9.5 5 5m0-5-5 5" />
      </>
    ),
    uncertain: (
      <>
        <circle cx="10.5" cy="10.5" r="6" {...common} />
        <path {...common} d="m15 15 5 5M9 8.8a2 2 0 0 1 3.8.8c0 1.5-1.8 1.7-1.8 3m0 2.2v.1" />
      </>
    ),
    documents: (
      <>
        <path {...common} d="M4 6h10v14H4zM8 3h10v14" />
        <path {...common} d="M7 10h4m-4 3h4m-4 3h3" />
      </>
    ),
    processing: (
      <>
        <circle cx="12" cy="12" r="7" {...common} strokeDasharray="3 3" />
        <path {...common} d="M12 5v3m7 4h-3m-4 7v-3m-7-4h3" />
      </>
    ),
    review: (
      <>
        <path {...common} d="M3.5 12s3-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3 5.5-8.5 5.5S3.5 12 3.5 12Z" />
        <circle cx="12" cy="12" r="2.5" {...common} />
        <path {...common} d="M18.5 5.5 20 4m-14.5 1.5L4 4" />
      </>
    ),
    verified: (
      <>
        <path {...common} d="M12 3.5 19 6v5.2c0 4.1-2.8 7.7-7 9.3-4.2-1.6-7-5.2-7-9.3V6z" />
        <path {...common} d="m8.5 12 2.2 2.2 4.8-5" />
      </>
    ),
    mismatch: (
      <>
        <path {...common} d="M4 6h6v12H4zM14 6h6v12h-6z" />
        <path {...common} d="m9.5 10 5 4m0-4-5 4" />
      </>
    ),
    "not-applicable": (
      <>
        <path {...common} d="M5 3.5h10l4 4V20H5zM15 3.5v4h4" />
        <path {...common} d="M8 13h8" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[icon]}
    </svg>
  );
}

function nodeIsSelected(
  node: InboxMapNode,
  category: string,
  workflow: string,
  status: string,
) {
  return (
    (!!node.filter?.category && node.filter.category === category) ||
    (!!node.filter?.workflow && node.filter.workflow === workflow) ||
    (!!node.filter?.status && node.filter.status === status)
  );
}

export function InboxMap({
  rows,
  loaded,
  category,
  workflow,
  status,
  onCategoryChange,
  onWorkflowChange,
  onStatusChange,
  onMessageSelect,
  onClearFilters,
}: InboxMapProps) {
  const model = useMemo(() => buildInboxMapModel(rows), [rows]);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const expandedNode = model.nodes.find((node) => node.id === expandedNodeId);
  const displayModel = useMemo(
    () =>
      expandedNode
        ? buildInboxMapDrilldown(rows, model, expandedNode)
        : { ...model, hiddenCount: 0 },
    [expandedNode, model, rows],
  );
  const nodeById = useMemo(
    () => new Map(displayModel.nodes.map((node) => [node.id, node])),
    [displayModel.nodes],
  );
  const [open, setOpen] = useState(true);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const activeLabel = category
    ? model.nodes.find((node) => node.filter?.category === category)?.label
    : workflow
      ? model.nodes.find((node) => node.filter?.workflow === workflow)?.label
      : status
        ? model.nodes.find((node) => node.filter?.status === status)?.label
        : "All correspondence";
  const activeCount = category
    ? model.nodes.find((node) => node.filter?.category === category)?.count
    : workflow
      ? model.nodes.find((node) => node.filter?.workflow === workflow)?.count
      : status
        ? model.nodes.find((node) => node.filter?.status === status)?.count
        : model.summary.total;

  useEffect(() => {
    if (!expandedNode) return;
    const stillSelected =
      expandedNode.filter?.category === category ||
      expandedNode.filter?.workflow === workflow ||
      expandedNode.filter?.status === status;
    if (!stillSelected) setExpandedNodeId(null);
  }, [category, expandedNode, status, workflow]);

  const setScale = (next: number) =>
    setViewport((value) => ({ ...value, scale: clamp(next, 0.78, 1.5) }));
  const resetViewport = () => setViewport({ x: 0, y: 0, scale: 1 });
  const showOverview = () => {
    setExpandedNodeId(null);
    onClearFilters();
    resetViewport();
  };
  const selectNode = (node: InboxMapNode) => {
    if (node.messageId) {
      onMessageSelect(node.messageId);
      return;
    }
    if (node.id === "root") {
      showOverview();
      return;
    }
    if (node.filter) setExpandedNodeId(node.id);
    if (node.filter?.category) onCategoryChange(node.filter.category);
    if (node.filter?.workflow) onWorkflowChange(node.filter.workflow);
    if (node.filter?.status) onStatusChange(node.filter.status);
  };
  const panByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const distance = event.shiftKey ? 48 : 24;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [distance, 0],
      ArrowRight: [-distance, 0],
      ArrowUp: [0, distance],
      ArrowDown: [0, -distance],
    };
    if (delta[event.key]) {
      event.preventDefault();
      setViewport((value) => ({
        ...value,
        x: value.x + delta[event.key][0],
        y: value.y + delta[event.key][1],
      }));
    }
    if (event.key === "Home") {
      event.preventDefault();
      resetViewport();
    }
  };
  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    drag.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setViewport((value) => ({
      ...value,
      x: drag.current!.originX + event.clientX - drag.current!.clientX,
      y: drag.current!.originY + event.clientY - drag.current!.clientY,
    }));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const zoomWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setScale(viewport.scale + (event.deltaY < 0 ? 0.08 : -0.08));
  };

  return (
    <section className="inbox-map-card" aria-labelledby="inbox-map-title">
      <header className="inbox-map-header">
        <div>
          <p className="inbox-map-kicker">Live queue topology</p>
          <h2 id="inbox-map-title">Inbox map</h2>
          <p>
            See every classified intent and operational state before opening a
            case.
          </p>
        </div>
        <div className="inbox-map-header-actions">
          <span className="inbox-map-total">
            <strong>{model.summary.total.toLocaleString()}</strong>
            messages
          </span>
          <button
            className="inbox-map-collapse"
            aria-expanded={open}
            aria-controls="inbox-map-body"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
            {open ? "Collapse map" : "Open map"}
          </button>
        </div>
      </header>
      {open && (
        <div id="inbox-map-body" className="inbox-map-body">
          {!loaded ? (
            <div className="inbox-map-empty" role="status">
              <span className="map-loading-orbit" />
              Reading the current inbox topology…
            </div>
          ) : !rows.length ? (
            <div className="inbox-map-empty">
              <InboxMapGlyph icon="inbox" />
              <strong>No correspondence to map yet</strong>
              <span>Import the dataset or sync a connected mailbox.</span>
            </div>
          ) : (
            <>
              <div
                className="inbox-map-viewport"
                role="region"
                aria-label="Interactive inbox map. Use arrow keys to pan, Home to reset, and the labeled controls to zoom."
                tabIndex={0}
                onKeyDown={panByKeyboard}
                onPointerDown={beginDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onWheel={zoomWheel}
              >
                <div
                  id="inbox-map-branch"
                  className="inbox-map-plane"
                  style={{
                    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
                  }}
                >
                  <svg
                    className="inbox-map-links"
                    viewBox="0 0 800 500"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <defs>
                      <linearGradient id="map-line" x1="0" y1="1" x2="1" y2="0">
                        <stop offset="0" stopColor="#2b5f83" />
                        <stop offset="0.55" stopColor="#56b2bf" />
                        <stop offset="1" stopColor="#d7af5e" />
                      </linearGradient>
                      <radialGradient id="map-halo">
                        <stop offset="0" stopColor="#41b7c8" stopOpacity="0.18" />
                        <stop offset="1" stopColor="#41b7c8" stopOpacity="0" />
                      </radialGradient>
                    </defs>
                    <circle cx="400" cy="395" r="178" fill="none" stroke="#8fb6cc" strokeOpacity="0.09" strokeDasharray="3 12" />
                    <circle cx="400" cy="395" r="116" fill="url(#map-halo)" />
                    {displayModel.edges.map((edge) => {
                      const from = nodeById.get(edge.from)!;
                      const to = nodeById.get(edge.to)!;
                      const middleY = (from.y + to.y) / 2;
                      return (
                        <path
                          key={`${edge.from}-${edge.to}`}
                          d={`M ${from.x} ${from.y} C ${from.x} ${middleY}, ${to.x} ${middleY}, ${to.x} ${to.y}`}
                          fill="none"
                          stroke="url(#map-line)"
                          strokeWidth={edge.from === "root" ? 1.8 : 1.2}
                          strokeOpacity={edge.from === "root" ? 0.72 : 0.42}
                        />
                      );
                    })}
                  </svg>
                  {displayModel.nodes.map((node) => {
                    const selected = nodeIsSelected(
                      node,
                      category,
                      workflow,
                      status,
                    );
                    const content = (
                      <>
                        <span className="inbox-map-node-orb">
                          <InboxMapGlyph icon={node.icon} />
                          <strong>{node.count.toLocaleString()}</strong>
                        </span>
                        <span className="inbox-map-node-label">{node.label}</span>
                      </>
                    );
                    const style = {
                      left: `${(node.x / 800) * 100}%`,
                      top: `${(node.y / 500) * 100}%`,
                    };
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`inbox-map-node ${node.size} tone-${node.tone}${node.count === 0 ? " is-empty" : ""}`}
                        style={style}
                        data-selected={selected || undefined}
                        aria-expanded={node.filter ? expandedNode?.id === node.id : undefined}
                        aria-controls={node.filter ? "inbox-map-branch" : undefined}
                        aria-label={node.messageId ? `Open correspondence: ${node.label}` : `${node.label}: ${node.count.toLocaleString()} messages. ${node.id === "root" ? "Return to full map" : "Open group"}`}
                        onClick={() => selectNode(node)}
                      >
                        {content}
                      </button>
                    );
                  })}
                </div>
                <div className="inbox-map-controls" aria-label="Map controls">
                  <button
                    type="button"
                    aria-label="Zoom in"
                    onClick={() => setScale(viewport.scale + 0.12)}
                  >
                    <Plus size={17} />
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom out"
                    onClick={() => setScale(viewport.scale - 0.12)}
                  >
                    <Minus size={17} />
                  </button>
                  <button
                    type="button"
                    aria-label="Fit map"
                    onClick={resetViewport}
                  >
                    <Maximize2 size={16} />
                  </button>
                  <output aria-label="Map zoom level">
                    {Math.round(viewport.scale * 100)}%
                  </output>
                </div>
                {expandedNode && (
                  <div className="inbox-map-breadcrumb">
                    <button
                      type="button"
                      className="inbox-map-back"
                      onClick={showOverview}
                    >
                      <ArrowLeft size={15} />
                      Full map
                    </button>
                    <span>/ {expandedNode.label}</span>
                  </div>
                )}
              </div>
              <aside className="inbox-map-readout" aria-label="Inbox map summary">
                <p className="inbox-map-kicker">Current focus</p>
                <strong className="inbox-map-focus">{activeLabel}</strong>
                <span className="inbox-map-focus-count">
                  {(activeCount ?? 0).toLocaleString()} visible in this group
                </span>
                {(category || workflow || status) && (
                  <button
                    type="button"
                    className="map-clear-filter"
                    onClick={showOverview}
                  >
                    Clear map filters
                  </button>
                )}
                <dl className="inbox-map-metrics">
                  <div>
                    <dt>Needs attention</dt>
                    <dd>{model.summary.attention.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Resolved</dt>
                    <dd>{model.summary.resolved.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Awaiting triage</dt>
                    <dd>{model.summary.pending.toLocaleString()}</dd>
                  </div>
                </dl>
                <div className="inbox-map-legend" aria-label="Map legend">
                  <span><i className="legend-classified" /> Classified intent</span>
                  <span><i className="legend-attention" /> Attention state</span>
                  <span><i className="legend-resolved" /> Resolved state</span>
                </div>
                <p className="inbox-map-hint">
                  {expandedNode
                    ? `Showing ${displayModel.nodes.length - 2} message nodes${displayModel.hiddenCount ? `, with ${displayModel.hiddenCount} more in the filtered list` : ""}. Select one to focus its case.`
                    : "Drag to pan, scroll to zoom, or use the controls. Select a labeled node to open that branch."}
                </p>
                <span className="sr-only" aria-live="polite">
                  {expandedNode
                    ? `${expandedNode.label} branch opened with ${expandedNode.count} messages.`
                    : "Full inbox map shown."}
                </span>
              </aside>
            </>
          )}
        </div>
      )}
    </section>
  );
}
