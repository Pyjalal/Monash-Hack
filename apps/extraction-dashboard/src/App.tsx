import { useEffect, useMemo, useState, type ReactNode } from "react";

const fieldNames = ["shipper", "consignee", "notify_party", "port_of_loading", "port_of_discharge", "container_count", "gross_weight_kg"] as const;
type FieldName = typeof fieldNames[number];
type Role = "si" | "bl";
type Answer = { category?: string; status?: string; review_reason?: string | null; defect_fields?: string[] };
type Classification = { category?: string; confidence?: number; expectation?: string; expectationConfidence?: number;
  documentIssue?: string; documentIssueConfidence?: number; bodyDocument?: string; bodyDocumentConfidence?: number;
  urgency?: { score?: number; level?: string; confidence?: number }; model?: string; elapsedMs?: number };
type Span = { kind?: string; line?: number; page?: number; sheet?: string; cell?: string; text?: string };
type Candidate = { id?: string; label?: string; value?: string; pairing?: string; source?: { labelSpans?: Span[]; valueSpans?: Span[] } };
type CurrentDocument = { attachment?: { name?: string; relativePath?: string; mimeType?: string }; reading?: { status?: string; sha256?: string; text?: string; spans?: Span[]; candidates?: Candidate[] } };
type LegacyField = { value?: string; normalized_value?: string; confidence?: number; candidates?: string[] };
type LegacyDocument = { filename?: string; readable?: boolean; format?: string; document_type?: string; document_type_confidence?: number; fields?: Partial<Record<FieldName, LegacyField>> };
type FieldOutput = { value?: string; candidateId?: string; confidence?: number; method?: string };
type ExtractionResult = { status?: string; method?: string | null; assessment?: { matchesExpectedFormat?: boolean; reasons?: string[]; detectedRole?: string }; fallbackSelection?: { detectedRole?: string; fields?: Partial<Record<FieldName, { candidateId?: string; confidence?: number | null }>> }; fallbackError?: string; fields?: Partial<Record<FieldName, FieldOutput>>; unresolvedFields?: FieldName[] };
type Comparison = { si?: string; bl?: string; siNormalized?: string | null; blNormalized?: string | null; matches?: boolean; method?: string; comparisonConfidence?: number | null };
type ExtractionTrace = { email_id?: string; attachment_status?: string; review_reason?: string | null; skipped?: boolean; skipped_reason?: string; documents?: Partial<Record<Role, CurrentDocument | LegacyDocument>>; extraction?: Partial<Record<Role, ExtractionResult>>; comparison?: Partial<Record<FieldName, Comparison>>; defect_fields?: FieldName[] };
type RouteDecision = { route: string; selectedForExtraction: boolean; requestedAction: string; documentExpectation: string; workflowState: string; reason: string };
type PipelineCase = { id: string; email: { subject?: string; from?: string; attachments?: Array<{ name?: string; mimeType?: string }> }; classification: Classification | null; routeDecision: RouteDecision; extraction: ExtractionTrace | null; prediction: Answer | null; groundTruth: Answer | null; stages: { classification: string; extraction: string; comparison: string }; exactMatch: boolean };
type PipelineReport = { createdAt: string; dataset: { id: string; label: string; includedRows: number; excludedRows: number; exclusions?: Record<string, string> }; run: { provider?: string; classificationModel?: string | null; extractionModel?: string | null; comparisonModel?: string | null; selection?: string }; summary: { total: number; classified: number; classificationCorrect: number; waitingForFutureDraft: number; extracted: number; compared: number; exactMatches: number; comparable: number }; score?: unknown; cases: PipelineCase[] };

function Badge({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function toneForStatus(status?: string): "good" | "warn" | "bad" | "neutral" {
  return status === "OK" ? "good" : status === "MISMATCH" ? "warn" : status === "NEEDS_REVIEW" ? "bad" : "neutral";
}

function stageTone(status: string): "good" | "warn" | "bad" | "neutral" {
  return status === "evaluated" ? "good" : status === "missing" || status === "blocked" || status === "not_selected" ? "bad" : "neutral";
}

function percent(value?: number): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function currentDocument(document: CurrentDocument | LegacyDocument): document is CurrentDocument {
  return "reading" in document || "attachment" in document;
}

function sourceLabel(candidate: Candidate): string {
  const span = candidate.source?.valueSpans?.[0] ?? candidate.source?.labelSpans?.[0];
  if (!span) return "—";
  if (span.kind === "line") return `line ${span.line ?? "?"}`;
  if (span.kind === "page") return `page ${span.page ?? "?"}`;
  if (span.kind === "cell") return `${span.sheet ?? "sheet"}!${span.cell ?? "?"}`;
  return span.kind ?? "source";
}

function Stage({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <section className="stage"><h3><span>{number}</span>{title}</h3>{children}</section>;
}

function LegacyDocumentPanel({ role, document }: { role: Role; document: LegacyDocument }) {
  return <article className="document">
    <header><div><p className="eyebrow">{role === "si" ? "Shipping instructions" : "Bill of lading"}</p><h2>{document.filename ?? role.toUpperCase()}</h2></div><Badge tone={document.readable ? "good" : "bad"}>{document.readable ? "READABLE" : "UNREADABLE"}</Badge></header>
    <Stage number={1} title="Legacy document reader"><dl className="facts"><div><dt>Format</dt><dd>{document.format ?? "—"}</dd></div><div><dt>Detected type</dt><dd>{document.document_type ?? "—"}</dd></div><div><dt>Confidence</dt><dd>{percent(document.document_type_confidence)}</dd></div><div><dt>Path</dt><dd title={document.filename}>{document.filename ?? "—"}</dd></div></dl></Stage>
    <Stage number={2} title="Legacy field extraction"><div className="table-wrap"><table><thead><tr><th>Field</th><th>Accepted value</th><th>Normalized</th><th>Confidence</th><th>Candidates</th></tr></thead><tbody>{fieldNames.map(field => { const output = document.fields?.[field]; return <tr key={field} className={output ? "" : "missing"}><td>{field}</td><td>{output?.value ?? "Unresolved"}</td><td>{output?.normalized_value ?? "—"}</td><td>{percent(output?.confidence)}</td><td>{output?.candidates?.length ?? 0}</td></tr>; })}</tbody></table></div></Stage>
    <Stage number={3} title="Routing detail"><p className="empty">This V2 trace predates candidate IDs and explicit deterministic/LLM route telemetry. Accepted fields and comparison results remain available.</p></Stage>
  </article>;
}

function CurrentDocumentPanel({ role, document, extraction }: { role: Role; document: CurrentDocument; extraction?: ExtractionResult }) {
  const reading = document.reading;
  const candidates = reading?.candidates ?? [];
  return <article className="document">
    <header><div><p className="eyebrow">{role === "si" ? "Shipping instructions" : "Bill of lading"}</p><h2>{document.attachment?.name ?? document.attachment?.relativePath ?? role.toUpperCase()}</h2></div><Badge tone={reading?.status === "READABLE" ? "good" : "bad"}>{reading?.status ?? "UNKNOWN"}</Badge></header>
    <Stage number={1} title="Document reader"><dl className="facts"><div><dt>Type</dt><dd>{document.attachment?.mimeType ?? "—"}</dd></div><div><dt>Text</dt><dd>{(reading?.text?.length ?? 0).toLocaleString()} chars</dd></div><div><dt>Spans</dt><dd>{reading?.spans?.length ?? 0}</dd></div><div><dt>SHA-256</dt><dd title={reading?.sha256}>{reading?.sha256 ? `${reading.sha256.slice(0, 12)}…` : "—"}</dd></div></dl>{reading?.text && <details><summary>Raw extracted text</summary><pre>{reading.text}</pre></details>}</Stage>
    <Stage number={2} title={`Candidate generation · ${candidates.length}`}>{candidates.length ? <div className="table-wrap"><table><thead><tr><th>Label</th><th>Value</th><th>Pairing</th><th>Source</th><th>ID</th></tr></thead><tbody>{candidates.map((candidate, index) => <tr key={candidate.id ?? index}><td>{candidate.label ?? "—"}</td><td>{candidate.value ?? "—"}</td><td>{candidate.pairing ?? "—"}</td><td>{sourceLabel(candidate)}</td><td className="mono">{candidate.id?.slice(-8) ?? "—"}</td></tr>)}</tbody></table></div> : <p className="empty">No source-backed label/value candidates.</p>}</Stage>
    <Stage number={3} title="Expected-format gate">{extraction?.assessment ? <><div className="route"><Badge tone={extraction.assessment.matchesExpectedFormat ? "good" : "warn"}>{extraction.assessment.matchesExpectedFormat ? "PASS" : "DRIFT"}</Badge><span>Detected role: <strong>{extraction.assessment.detectedRole ?? "unknown"}</strong></span></div>{extraction.assessment.reasons?.length ? <ul>{extraction.assessment.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p className="empty">Role marker, labels, cardinality, and value shapes passed.</p>}</> : <p className="empty">Gate was not reached.</p>}</Stage>
    <Stage number={4} title="Route decision">{extraction ? <div className="route"><Badge tone={extraction.method === "deterministic" ? "good" : extraction.method === "llm_fallback" ? "warn" : "neutral"}>{extraction.method ?? "none"}</Badge><span>Status: <strong>{extraction.status ?? "unknown"}</strong></span></div> : <p className="empty">No extraction route.</p>}</Stage>
    <Stage number={5} title="LLM structured selection">{extraction?.fallbackSelection ? <><p>Detected document type: <strong>{extraction.fallbackSelection.detectedRole ?? "unknown"}</strong></p><div className="selection-grid">{fieldNames.map(field => { const selected = extraction.fallbackSelection?.fields?.[field]; return <div key={field}><span>{field}</span><strong>{selected?.candidateId?.slice(-8) ?? "missing"}</strong><small>{percent(selected?.confidence ?? undefined)}</small></div>; })}</div></> : extraction?.fallbackError ? <p className="provider-error">{extraction.fallbackError}</p> : <p className="empty">Not called — deterministic extraction handled this document, or extraction stopped before fallback.</p>}</Stage>
    <Stage number={6} title="Validated field output">{extraction ? <div className="table-wrap"><table><thead><tr><th>Field</th><th>Accepted value</th><th>Confidence</th><th>Candidate</th></tr></thead><tbody>{fieldNames.map(field => { const output = extraction.fields?.[field]; return <tr key={field} className={output ? "" : "missing"}><td>{field}</td><td>{output?.value ?? "Unresolved"}</td><td>{percent(output?.confidence)}</td><td className="mono">{output?.candidateId?.slice(-8) ?? "—"}</td></tr>; })}</tbody></table></div> : <p className="empty">Not evaluated — the values above are raw candidates only. The document pair was blocked before semantic field extraction, so none have been accepted or marked unresolved.</p>}</Stage>
  </article>;
}

function DocumentPanel({ role, document, extraction }: { role: Role; document?: CurrentDocument | LegacyDocument; extraction?: ExtractionResult }) {
  if (!document) return <article className="document"><header><h2>{role.toUpperCase()}</h2><Badge tone="bad">missing attachment</Badge></header><Stage number={1} title="Document unavailable"><p className="empty">No readable {role.toUpperCase()} document reached extraction.</p></Stage></article>;
  return currentDocument(document) ? <CurrentDocumentPanel role={role} document={document} extraction={extraction}/> : <LegacyDocumentPanel role={role} document={document}/>;
}

function comparisonFor(item: ExtractionTrace, field: FieldName): Comparison | undefined {
  if (item.comparison?.[field]) return item.comparison[field];
  const si = item.documents?.si; const bl = item.documents?.bl;
  if (!si || !bl || currentDocument(si) || currentDocument(bl)) return undefined;
  const siField = si.fields?.[field]; const blField = bl.fields?.[field];
  if (!siField || !blField) return undefined;
  return { si: siField.value, bl: blField.value, siNormalized: siField.normalized_value, blNormalized: blField.normalized_value, matches: siField.normalized_value === blField.normalized_value };
}

function ClassificationPanel({ item }: { item: PipelineCase }) {
  const value = item.classification;
  return <section className="phase-card classification-card"><div className="phase-title"><span>1</span><div><p className="eyebrow">Phase one</p><h2>Email classification and route decision</h2></div><Badge tone={value ? "good" : "bad"}>{item.stages.classification}</Badge></div>{value ? <><div className="classification-grid"><div><span>Predicted category</span><strong>{value.category ?? "—"}</strong><small>{percent(value.confidence)} confidence</small></div><div><span>Ground truth</span><strong>{item.groundTruth?.category ?? "—"}</strong><small>{value.category === item.groundTruth?.category ? "category agrees" : "category differs"}</small></div><div><span>Timing expectation</span><strong>{value.expectation ?? "legacy / unavailable"}</strong><small>{percent(value.expectationConfidence)} confidence</small></div><div><span>Document issue</span><strong>{value.documentIssue ?? "legacy / unavailable"}</strong><small>{percent(value.documentIssueConfidence)} confidence</small></div><div><span>SI/BL content in body</span><strong>{value.bodyDocument ?? "legacy / unavailable"}</strong><small>{percent(value.bodyDocumentConfidence)} confidence</small></div><div><span>Urgency</span><strong>{value.urgency?.level ?? "legacy / unavailable"}</strong><small>{value.urgency?.score == null ? "—" : `score ${value.urgency.score} · ${percent(value.urgency.confidence)}`}</small></div></div><p className="phase-note"><strong>Route: {item.routeDecision.route.replaceAll("_", " ")}</strong> · {item.routeDecision.reason} Action: {item.routeDecision.requestedAction}; document expectation: {item.routeDecision.documentExpectation}.</p></> : <p className="empty">Classification telemetry was not found for this case.</p>}</section>;
}

export function App() {
  const [dataset, setDataset] = useState("v2");
  const [report, setReport] = useState<PipelineReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    setReport(null); setError(null);
    fetch(`/pipeline-report.json?dataset=${dataset}`, { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `HTTP ${response.status}`);
      return response.json() as Promise<PipelineReport>;
    }).then(value => { setReport(value); setSelectedId(value.cases[0]?.id ?? ""); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [dataset]);

  const cases = useMemo(() => (report?.cases ?? []).filter(item => {
    const searchable = `${item.id} ${item.email.subject ?? ""} ${item.classification?.category ?? ""}`.toLowerCase();
    if (!searchable.includes(query.toLowerCase())) return false;
    if (filter === "classification-diff") return !!item.classification && item.classification.category !== item.groundTruth?.category;
    if (filter === "future-draft") return item.routeDecision.route === "WAITING_FOR_FUTURE_DRAFT";
    if (filter === "review") return item.prediction?.status === "NEEDS_REVIEW";
    if (filter === "mismatch") return item.prediction?.status === "MISMATCH";
    if (filter === "exact-diff") return !item.exactMatch;
    if (filter === "fallback") return Object.values(item.extraction?.extraction ?? {}).some(result => result?.method === "llm_fallback");
    return true;
  }), [report, query, filter]);
  const selected = cases.find(item => item.id === selectedId) ?? cases[0];

  if (error) return <main className="center"><h1>Pipeline report unavailable</h1><p>{error}</p><code>npm run pipeline:full -- --dataset {dataset}</code></main>;
  if (!report) return <main className="center"><div className="spinner"/><p>Loading pipeline report…</p></main>;

  const summary = report.summary;
  return <div className="app">
    <header className="topbar"><div><p className="eyebrow">CargoLens · audit workspace</p><h1>Classification → Extraction → Comparison</h1><p>One trace for every decision, document route, and final answer.</p></div><div className="run-meta"><label className="dataset-picker"><span>Dataset</span><select value={dataset} onChange={event => setDataset(event.target.value)}><option value="v2">V2 · baseline</option><option value="v3">V3 · curated</option><option value="v4">V4 · adversarial</option><option value="v5">V5 · realistic mixed formats</option></select></label><Badge tone="neutral">{report.run.provider ?? "unknown provider"}</Badge><strong>{report.run.classificationModel ?? "legacy model"}</strong><span>{new Date(report.createdAt).toLocaleString()}</span></div></header>
    <section className="summary"><div><span>included</span><strong>{summary.total}</strong></div><div><span>classified</span><strong>{summary.classified}</strong></div><div><span>class correct</span><strong>{summary.classificationCorrect}</strong></div><div><span>future drafts</span><strong>{summary.waitingForFutureDraft}</strong></div><div><span>extracted</span><strong>{summary.extracted}</strong></div><div><span>compared</span><strong>{summary.compared}</strong></div><div><span>exact</span><strong>{summary.exactMatches}/{summary.comparable}</strong></div><div><span>excluded</span><strong>{report.dataset.excludedRows}</strong></div></section>
    <div className="workspace"><aside><div className="controls"><input aria-label="Search cases" placeholder="Search ID, subject, category" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Filter cases" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All cases</option><option value="future-draft">Waiting for future draft</option><option value="classification-diff">Classification differs</option><option value="fallback">LLM extraction fallback</option><option value="mismatch">Mismatches</option><option value="review">Needs review</option><option value="exact-diff">Any final difference</option></select></div><nav>{cases.map(item => <button key={item.id} className={item.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(item.id)}><span><strong>{item.id}</strong><small>{item.routeDecision.route.replaceAll("_", " ")} · {item.prediction?.status ?? item.stages.extraction}</small></span><i className={item.exactMatch ? "good-dot" : item.prediction?.status === "MISMATCH" ? "warn-dot" : "bad-dot"}/></button>)}</nav></aside>
      <main className="case-view">{selected && (() => { const trace = selected.extraction; return <><div className="case-heading"><div><p className="eyebrow">{selected.email.from ?? "unknown sender"}</p><h2>{selected.id}</h2><p className="case-subject">{selected.email.subject ?? "No subject"}</p></div><div className="status-pair"><div><small>Predicted</small><Badge tone={toneForStatus(selected.prediction?.status)}>{selected.prediction?.status ?? "no final answer"}</Badge></div><span className="versus">vs</span><div><small>Ground truth</small><Badge tone={toneForStatus(selected.groundTruth?.status)}>{selected.groundTruth?.status ?? "unavailable"}</Badge></div></div></div>
        <section className="pipeline-strip">{(["classification", "extraction", "comparison"] as const).map((stage, index) => <div key={stage}><span>{index + 1}</span><strong>{stage}</strong><Badge tone={stageTone(selected.stages[stage])}>{selected.stages[stage]}</Badge></div>)}</section>
        <ClassificationPanel item={selected}/>
        <section className="phase-card"><div className="phase-title"><span>2</span><div><p className="eyebrow">Phase two</p><h2>Attachment extraction</h2></div><Badge tone={stageTone(selected.stages.extraction)}>{selected.stages.extraction}</Badge></div>{trace?.skipped_reason && <p className="phase-note">{trace.skipped_reason}</p>}{trace && (selected.stages.extraction === "evaluated" || selected.stages.extraction === "blocked") ? <div className="documents"><DocumentPanel role="si" document={trace.documents?.si} extraction={trace.extraction?.si}/><DocumentPanel role="bl" document={trace.documents?.bl} extraction={trace.extraction?.bl}/></div> : <p className="empty">{selected.routeDecision.reason}</p>}</section>
        <section className="comparison phase-card"><div className="phase-title"><span>3</span><div><p className="eyebrow">Phase three</p><h2>Normalized SI ↔ BL comparison</h2></div><Badge tone={stageTone(selected.stages.comparison)}>{selected.stages.comparison}</Badge></div>{selected.stages.comparison === "evaluated" && trace && fieldNames.some(field => comparisonFor(trace, field)) ? <div className="table-wrap"><table><thead><tr><th>Field</th><th>SI output</th><th>BL output</th><th>Normalized check</th><th>Predicted defect</th><th>GT defect</th></tr></thead><tbody>{fieldNames.map(field => { const row = comparisonFor(trace, field); const predicted = selected.prediction?.defect_fields?.includes(field); const truth = selected.groundTruth?.defect_fields?.includes(field); const unresolved = row?.method === "unresolved_semantics"; return <tr key={field} className={row?.matches === false ? "mismatch" : ""}><td>{field}</td><td>{row?.si ?? "—"}</td><td>{row?.bl ?? "—"}</td><td>{row ? <Badge tone={row.matches ? "good" : unresolved ? "warn" : "bad"}>{row.matches ? "MATCH" : unresolved ? "UNCERTAIN" : "DIFFERENT"}</Badge> : "—"}</td><td>{predicted ? <Badge tone="bad">YES</Badge> : "—"}</td><td>{truth ? <Badge tone="bad">YES</Badge> : "—"}</td></tr>; })}</tbody></table></div> : <p className="empty">Comparison did not run because this was not a current SI/BL verification, or a document could not produce the required fields.</p>}
          <div className={`evaluation-card ${selected.exactMatch ? "matched" : "different"}`}><div><p className="eyebrow">Final evaluation</p><h2>{selected.exactMatch ? "Prediction agrees with ground truth" : "Prediction differs from ground truth"}</h2></div><div className="evaluation-columns"><div><span>Predicted answer</span><strong>{selected.prediction?.status ?? "Unavailable"}</strong><small>{selected.prediction?.review_reason ? `Reason: ${selected.prediction.review_reason}` : selected.prediction?.defect_fields?.length ? `Fields: ${selected.prediction.defect_fields.join(", ")}` : "No review reason or defect fields"}</small></div><div><span>Ground-truth answer</span><strong>{selected.groundTruth?.status ?? "Unavailable"}</strong><small>{selected.groundTruth?.review_reason ? `Reason: ${selected.groundTruth.review_reason}` : selected.groundTruth?.defect_fields?.length ? `Fields: ${selected.groundTruth.defect_fields.join(", ")}` : "No review reason or defect fields"}</small></div></div></div>
        </section></>; })()}</main></div>
  </div>;
}
