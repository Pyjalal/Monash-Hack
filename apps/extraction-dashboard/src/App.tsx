import { useEffect, useMemo, useState, type ReactNode } from "react";

const fieldNames = ["shipper", "consignee", "notify_party", "port_of_loading", "port_of_discharge", "container_count", "gross_weight_kg"] as const;
type Role = "si" | "bl";
type FieldName = typeof fieldNames[number];
type Span = { kind: string; line?: number; page?: number; sheet?: string; cell?: string; text: string };
type Candidate = { id: string; label: string; value: string; pairing: string; source: { labelSpans: Span[]; valueSpans: Span[] } };
type Reading = { status: string; sha256: string; text: string; spans: Span[]; candidates?: Candidate[]; readability?: Record<string, unknown>; pagesNeedingOcr?: number[] };
type DocumentTrace = { attachment: { name?: string; relativePath?: string; mimeType?: string }; reading: Reading; role: Role };
type FieldOutput = { value: string; candidateId: string; confidence: number; method: string };
type Selection = { detectedRole: string; fields: Partial<Record<FieldName, { candidateId: string; confidence: number | null }>> };
type Extraction = { status: string; method: string | null; assessment: { matchesExpectedFormat: boolean; reasons: string[]; detectedRole: string }; fallbackSelection?: Selection; fallbackError?: string; fields: Partial<Record<FieldName, FieldOutput>>; unresolvedFields: FieldName[] };
type Comparison = { si: string; bl: string; siNormalized: string | null; blNormalized: string | null; matches: boolean };
type CaseTrace = { email_id: string; review_reason: string | null; documents: Partial<Record<Role, DocumentTrace>>; extraction?: Partial<Record<Role, Extraction>>; comparison?: Partial<Record<FieldName, Comparison>>; defect_fields: FieldName[] };
type Trace = { createdAt: string; provider: string; extractionModel: string; extractionProvider?: string | null; selection: string; selected: number; extractions: CaseTrace[] };

function Badge({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function sourceLabel(candidate: Candidate): string {
  const span = candidate.source.valueSpans[0] ?? candidate.source.labelSpans[0];
  if (!span) return "—";
  if (span.kind === "line") return `line ${span.line ?? "?"}`;
  if (span.kind === "page") return `page ${span.page ?? "?"}`;
  if (span.kind === "cell") return `${span.sheet ?? "sheet"}!${span.cell ?? "?"}`;
  return span.kind;
}

function Stage({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <section className="stage"><h3><span>{number}</span>{title}</h3>{children}</section>;
}

function DocumentPanel({ role, document, extraction }: { role: Role; document?: DocumentTrace; extraction?: Extraction }) {
  if (!document) return <article className="document"><header><h2>{role.toUpperCase()}</h2><Badge tone="bad">missing attachment</Badge></header></article>;
  const candidates = document.reading.candidates ?? [];
  return <article className="document">
    <header>
      <div><p className="eyebrow">{role === "si" ? "Shipping instructions" : "Bill of lading"}</p><h2>{document.attachment.name ?? document.attachment.relativePath}</h2></div>
      <Badge tone={document.reading.status === "READABLE" ? "good" : "bad"}>{document.reading.status}</Badge>
    </header>
    <Stage number={1} title="Document reader">
      <dl className="facts"><div><dt>Type</dt><dd>{document.attachment.mimeType ?? "from extension"}</dd></div><div><dt>Text</dt><dd>{document.reading.text.length.toLocaleString()} chars</dd></div><div><dt>Spans</dt><dd>{document.reading.spans.length}</dd></div><div><dt>SHA-256</dt><dd title={document.reading.sha256}>{document.reading.sha256.slice(0, 12)}…</dd></div></dl>
      <details><summary>Raw extracted text</summary><pre>{document.reading.text || "No text extracted"}</pre></details>
    </Stage>
    <Stage number={2} title={`Candidate generation · ${candidates.length}`}>
      {candidates.length ? <div className="table-wrap"><table><thead><tr><th>Label</th><th>Value</th><th>Pairing</th><th>Source</th><th>ID</th></tr></thead><tbody>{candidates.map(candidate => <tr key={candidate.id}><td>{candidate.label}</td><td>{candidate.value}</td><td>{candidate.pairing}</td><td>{sourceLabel(candidate)}</td><td className="mono" title={candidate.id}>{candidate.id.slice(-8)}</td></tr>)}</tbody></table></div> : <p className="empty">No source-backed label/value candidates.</p>}
    </Stage>
    <Stage number={3} title="Expected-format gate">
      {extraction ? <><div className="route"><Badge tone={extraction.assessment.matchesExpectedFormat ? "good" : "warn"}>{extraction.assessment.matchesExpectedFormat ? "PASS" : "DRIFT"}</Badge><span>Detected role: <strong>{extraction.assessment.detectedRole}</strong></span></div>{extraction.assessment.reasons.length ? <ul>{extraction.assessment.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p className="empty">Role marker, labels, cardinality, and value shapes all passed.</p>}</> : <p className="empty">Gate was not reached.</p>}
    </Stage>
    <Stage number={4} title="Route decision">
      {extraction ? <div className="route"><Badge tone={extraction.method === "deterministic" ? "good" : extraction.method === "llm_fallback" ? "warn" : "neutral"}>{extraction.method ?? "none"}</Badge><span>Status: <strong>{extraction.status}</strong></span></div> : <p className="empty">No extraction route.</p>}
    </Stage>
    <Stage number={5} title="LLM structured selection">
      {extraction?.fallbackSelection ? <><p>Detected document type: <strong>{extraction.fallbackSelection.detectedRole}</strong></p><div className="selection-grid">{fieldNames.map(field => { const selected = extraction.fallbackSelection?.fields[field]; return <div key={field}><span>{field}</span><strong>{selected?.candidateId?.slice(-8) ?? "missing"}</strong><small>{selected?.confidence == null ? "no confidence" : `${Math.round(selected.confidence * 100)}%`}</small></div>; })}</div></> : extraction?.fallbackError ? <p className="provider-error">{extraction.fallbackError}</p> : <p className="empty">Not called — the deterministic path handled this document.</p>}
    </Stage>
    <Stage number={6} title="Validated field output">
      <div className="table-wrap"><table><thead><tr><th>Field</th><th>Accepted value</th><th>Confidence</th><th>Candidate</th></tr></thead><tbody>{fieldNames.map(field => { const output = extraction?.fields[field]; return <tr key={field} className={output ? "" : "missing"}><td>{field}</td><td>{output?.value ?? "Unresolved"}</td><td>{output ? `${Math.round(output.confidence * 100)}%` : "—"}</td><td className="mono">{output?.candidateId.slice(-8) ?? "—"}</td></tr>; })}</tbody></table></div>
    </Stage>
  </article>;
}

export function App() {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  useEffect(() => { fetch("/extraction-details.json", { cache: "no-store" }).then(async response => { if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`); return response.json() as Promise<Trace>; }).then(value => { setTrace(value); setSelectedId(value.extractions[0]?.email_id ?? ""); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }, []);
  const cases = useMemo(() => (trace?.extractions ?? []).filter(item => item.email_id.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "review" ? !!item.review_reason : filter === "mismatch" ? item.defect_fields.length > 0 : Object.values(item.extraction ?? {}).some(extraction => extraction?.method === "llm_fallback")))), [trace, query, filter]);
  const selected = cases.find(item => item.email_id === selectedId) ?? cases[0];
  const summary = useMemo(() => { const list = trace?.extractions ?? []; const docs = list.flatMap(item => Object.values(item.extraction ?? {})); return { cases: list.length, documents: list.reduce((total, item) => total + Object.keys(item.documents ?? {}).length, 0), deterministic: docs.filter(item => item?.method === "deterministic").length, llm: docs.filter(item => item?.method === "llm_fallback").length, review: list.filter(item => item.review_reason).length }; }, [trace]);
  if (error) return <main className="center"><h1>Extraction trace unavailable</h1><p>{error}</p><code>npm run submission:extract-all</code></main>;
  if (!trace) return <main className="center"><div className="spinner"/><p>Loading extraction trace…</p></main>;
  return <div className="app">
    <header className="topbar"><div><p className="eyebrow">CargoLens · audit workspace</p><h1>SI / BL Extraction Trace</h1><p>Every intermediate result, from file reader to seven-field comparison.</p></div><div className="run-meta"><Badge tone="neutral">{trace.provider}</Badge><strong>{trace.extractionModel}</strong>{trace.extractionProvider && <span>route: {trace.extractionProvider}</span>}<span>{new Date(trace.createdAt).toLocaleString()}</span></div></header>
    <section className="summary">{Object.entries(summary).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
    <div className="workspace">
      <aside><div className="controls"><input aria-label="Search cases" placeholder="Search email ID" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="Filter cases" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All cases</option><option value="fallback">LLM fallback</option><option value="mismatch">Mismatches</option><option value="review">Needs review</option></select></div><nav>{cases.map(item => <button key={item.email_id} className={item.email_id === selected?.email_id ? "active" : ""} onClick={() => setSelectedId(item.email_id)}><span><strong>{item.email_id}</strong><small>{item.review_reason ?? `${item.defect_fields.length} mismatch${item.defect_fields.length === 1 ? "" : "es"}`}</small></span><i className={item.review_reason ? "bad-dot" : item.defect_fields.length ? "warn-dot" : "good-dot"}/></button>)}</nav></aside>
      <main className="case-view">{selected && <><div className="case-heading"><div><p className="eyebrow">Extraction case</p><h2>{selected.email_id}</h2></div><div className="route">{selected.review_reason ? <Badge tone="bad">{selected.review_reason}</Badge> : <Badge tone={selected.defect_fields.length ? "warn" : "good"}>{selected.defect_fields.length ? "MISMATCH" : "MATCH"}</Badge>}</div></div><div className="documents"><DocumentPanel role="si" document={selected.documents.si} extraction={selected.extraction?.si}/><DocumentPanel role="bl" document={selected.documents.bl} extraction={selected.extraction?.bl}/></div><section className="comparison"><h2><span>7</span>Normalized SI ↔ BL comparison</h2>{selected.comparison ? <div className="table-wrap"><table><thead><tr><th>Field</th><th>SI output</th><th>BL output</th><th>Normalized check</th></tr></thead><tbody>{fieldNames.map(field => { const row = selected.comparison?.[field]; return <tr key={field} className={row?.matches ? "" : "mismatch"}><td>{field}</td><td>{row?.si ?? "—"}</td><td>{row?.bl ?? "—"}</td><td>{row ? <Badge tone={row.matches ? "good" : "bad"}>{row.matches ? "MATCH" : "DIFFERENT"}</Badge> : "—"}</td></tr>; })}</tbody></table></div> : <p className="empty">Comparison was not reached because one or both documents did not produce seven validated fields.</p>}</section></>}</main>
    </div>
  </div>;
}
