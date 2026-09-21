import { useEffect, useRef, useState } from "react";
import { FIELD_NAMES, type Case } from "@cargolens/shared";
import {
  FileText,
  Check,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
  Paperclip,
  ScanLine,
  Clock3,
} from "lucide-react";
import type {
  ApiClient,
  Activity,
  Delivery,
  DraftResponse,
  SourceReading,
} from "../lib/api";
import { describeError, WORKFLOW_LABEL } from "../lib/api";
import { canCompare, canDraft, human } from "../lib/view-model";
import { Button } from "./ui/button";
import { Modal } from "../App";

export function CaseView({
  api,
  id,
  revision,
  delivery,
  sendingEnabled,
  refresh,
}: {
  api: ApiClient;
  id: string;
  revision: number;
  delivery: Delivery[];
  sendingEnabled: boolean;
  refresh: () => Promise<void>;
}) {
  const [record, setRecord] = useState<Case>();
  const [stale, setStale] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("check");
  const [draft, setDraft] = useState<DraftResponse["draft"]>();
  const [sources, setSources] = useState<SourceReading[]>();
  const [recovery, setRecovery] = useState(false);
  const [comparison, setComparison] = useState<unknown>();
  const mounted = useRef(true);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const [value, history] = await Promise.all([
        api.getCase(id),
        api.activity(id),
      ]);
      if (mounted.current) {
        setRecord(value);
        setActivity(history.events);
        setStale(false);
        setDraft(undefined);
        setSources(undefined);
      }
    } catch (failure) {
      if (mounted.current) setError(describeError(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [id, api]);
  useEffect(() => {
    if (!record) return;
    let current = true;
    void api
      .getCase(id)
      .then((latest) => {
        if (current)
          setStale(
            latest.sourceVersion !== record.sourceVersion ||
              latest.decision?.decisionVersion !==
                record.decision?.decisionVersion ||
              latest.status !== record.status,
          );
      })
      .catch(() => {
        if (current) setStale(true);
      });
    return () => {
      current = false;
    };
  }, [revision, record, api, id]);
  async function operate(
    kind: "compare" | "draft" | "retry" | "sources" | "recover",
  ) {
    if (!record) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "sources" || kind === "recover") {
        const result = await api.sources(id);
        if (result.sourceVersion !== record.sourceVersion)
          throw new Error("Evidence changed. Reload this case.");
        setSources(result.sources);
        setRecovery(kind === "recover");
        if (kind === "sources") setComparison(await api.comparison(id));
      } else if (kind === "retry") {
        await api.retry(id);
        await load();
        await refresh();
      } else if (record.decision) {
        const version = {
          sourceVersion: record.sourceVersion,
          decisionVersion: record.decision.decisionVersion,
        };
        if (kind === "draft") setDraft((await api.draft(id, version)).draft);
        else {
          await api.compare(id, version);
          await load();
          await refresh();
        }
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }
  if (!record)
    return (
      <div className="empty">
        <p>{error || "Loading case evidence…"}</p>
        {error && <Button onClick={() => void load()}>Retry case</Button>}
      </div>
    );
  const d = record.decision;
  const fields = FIELD_NAMES.map((field) => ({
    field,
    result: d?.fieldResults.find((row) => row.field === field),
  }));
  const disabled = stale || busy;
  const draftLabel =
    d?.nextAction === "CONFIRM_MATCH"
      ? "Preview confirmation"
      : d?.nextAction === "REQUEST_AMENDMENT"
        ? "Preview amendment"
        : d?.nextAction === "REQUEST_DOCUMENTS"
          ? "Preview document request"
          : "Preview clarification";
  return (
    <div className="case-content" aria-busy={busy}>
      <header className="case-header">
        <div className="case-heading">
          <FileText size={22} />
          <h2>{record.email.subject || "(No subject)"}</h2>
        </div>
        <p className="small muted source-sender">{record.email.from}</p>
        <div className="case-meta">
          <span
            className={`status-pill ${(d?.workflowState ?? "PROCESSING").toLowerCase()}`}
          >
            {d ? WORKFLOW_LABEL[d.workflowState] : "Awaiting classification"}
          </span>
          <span className="small muted">
            {record.email.attachments.length} attachments
          </span>
          <span className="small muted">
            Decision {d?.decisionVersion ?? "pending"}
          </span>
        </div>
      </header>
      <nav className="case-tabs" aria-label="Case sections">
        {["check", "message", "activity"].map((name) => (
          <button
            aria-pressed={tab === name}
            key={name}
            onClick={() => setTab(name)}
          >
            {name === "check"
              ? "Document check"
              : name === "message"
                ? "Message & intent"
                : "Activity"}
          </button>
        ))}
      </nav>
      {stale && (
        <div className="warning-box" role="status">
          This case changed. Reload before taking action.
          <Button variant="outline" size="small" onClick={() => void load()}>
            <RefreshCw size={14} />
            Reload case
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      {tab === "check" ? (
        <>
          <div className="section-heading">
            <div>
              <h3>SI versus BL comparison</h3>
              <p className="small muted">
                Seven fields, each grounded in its own source.
              </p>
            </div>
            <span className="small muted">
              {d?.fieldResults.filter((row) => row.outcome === "MATCH")
                .length ?? 0}{" "}
              / 7 matched
            </span>
          </div>
          {d?.blockers.length ? (
            <div className="warning-box">
              <AlertTriangle size={17} />
              <div>
                <strong>Evidence still needed</strong>
                <ul>
                  {d.blockers.map((code) => (
                    <li key={code}>{human(code)}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          {d?.requestedAction === "REQUEST_DRAFT" && (
            <div className="info-box">
              Draft requested. Documents are expected later; verification is not
              complete.
            </div>
          )}
          <div className="table-scroll">
            <table className="comparison-table">
              <caption className="sr-only">
                Seven-field shipping instruction and bill of lading evidence
              </caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Shipping instruction</th>
                  <th scope="col">Draft BL</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {fields.map(({ field, result }) => (
                  <tr
                    key={field}
                    className={
                      result?.outcome === "MISMATCH" ? "mismatch-row" : ""
                    }
                  >
                    <th scope="row">{human(field)}</th>
                    {(["si", "bl"] as const).map((side) => (
                      <td key={side}>
                        {result?.[side] ? (
                          <details>
                            <summary>
                              <mark>{result[side]!.text}</mark>
                            </summary>
                            <small className="source-ref">
                              {result[side]!.attachmentId}
                              <br />
                              {result[side]!.locator}
                              <br />
                              SHA {result[side]!.sha256}
                            </small>
                          </details>
                        ) : (
                          <span className="muted">Not established</span>
                        )}
                      </td>
                    ))}
                    <td>
                      <span
                        className={`field-status ${result?.outcome.toLowerCase() ?? ""}`}
                      >
                        {result?.outcome === "MATCH" ? (
                          <Check size={13} />
                        ) : result?.outcome === "MISMATCH" ? (
                          <AlertTriangle size={13} />
                        ) : (
                          <Clock3 size={13} />
                        )}{" "}
                        {result ? human(result.outcome) : "Pending"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="source-strip">
            <div>
              <strong>Source documents</strong>
              <p className="small muted">
                Inspect excerpts, hashes and recovery evidence.
              </p>
            </div>
            <Button
              variant="outline"
              size="small"
              disabled={busy || !record.email.attachments.length}
              onClick={() => void operate("sources")}
            >
              <Paperclip size={15} />
              View sources
            </Button>
          </div>
          <div className="next-action">
            <div>
              <p className="overline">Next action</p>
              <h3>{d ? human(d.nextAction) : "Classify this email"}</h3>
              <p className="small muted">
                {d?.requestedAction === "REQUEST_DRAFT"
                  ? "Documentation responsibility must be established before requesting a draft."
                  : "Only validated source facts can enter operational replies."}
              </p>
            </div>
            <div className="action-buttons">
              {record.status === "failed" && (
                <Button disabled={busy} onClick={() => void operate("retry")}>
                  Retry classification
                </Button>
              )}
              {canCompare(record) && (
                <Button
                  disabled={disabled}
                  onClick={() => void operate("compare")}
                >
                  <ScanLine size={16} />
                  {busy ? "Working…" : "Compare documents"}
                </Button>
              )}
              {canDraft(record) && (
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void operate("draft")}
                >
                  {draftLabel}
                  <ArrowRight size={15} />
                </Button>
              )}
              {d &&
                d.verificationState !== "COMPLETE" &&
                record.email.attachments.length > 0 && (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void operate("recover")}
                  >
                    Recover unresolved fields
                  </Button>
                )}
            </div>
          </div>
          {id.startsWith("gmail:") && (
            <p className="small muted">
              {sendingEnabled
                ? "Comparing can queue and send the validated next reply through unattended Gmail automation."
                : "Gmail sending is disabled. Validated replies remain in the outbox."}{" "}
              Draft previews never send.
            </p>
          )}
        </>
      ) : tab === "message" ? (
        <>
          <div className="section-heading">
            <h3>Current request</h3>
          </div>
          <p className="message-body">
            {record.email.body ??
              record.email.snippet ??
              "Message body unavailable."}
          </p>
          <dl className="facts">
            <dt>Requested action</dt>
            <dd>{d ? human(d.requestedAction) : "Pending"}</dd>
            <dt>Document expectation</dt>
            <dd>{d ? human(d.documentExpectation) : "Pending"}</dd>
            <dt>Responsibility</dt>
            <dd>
              {d?.requestedAction === "REQUEST_DRAFT"
                ? "Documentation team or clarification of ownership required."
                : "Sender supplies missing or corrected evidence; current policy determines the reply."}
            </dd>
            <dt>Thread</dt>
            <dd>
              {record.email.threadId ?? "Dataset message, no live thread"}
            </dd>
            <dt>Source version</dt>
            <dd className="hash">{record.sourceVersion}</dd>
            <dt>Source scope</dt>
            <dd>{human(record.email.contentScope)}</dd>
          </dl>
        </>
      ) : (
        <>
          <div className="section-heading">
            <h3>Case activity</h3>
            <Button variant="ghost" size="small" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
          {activity.length ? (
            <ol className="timeline">
              {activity.map((event) => (
                <li key={event.sequence}>
                  <span className="timeline-dot" />
                  <strong>{human(event.type.replaceAll(".", "_"))}</strong>
                  <time>{new Date(event.at).toLocaleString()}</time>
                  <details>
                    <summary>Event evidence</summary>
                    <pre>{JSON.stringify(event.data, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No recorded activity.</p>
          )}
        </>
      )}
      <section className="case-delivery">
        <h3>Operational replies</h3>
        {delivery.length ? (
          delivery.map((item) => (
            <div className="delivery-row" key={item.id}>
              <span className="status-pill">{human(item.status)}</span>
              <div>
                <strong>{human(item.action)}</strong>
                <small>
                  {item.reply.to} · {item.attempts} delivery attempts
                </small>
                {item.error && (
                  <small className="error-text">{item.error}</small>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="small muted">
            No outbound message recorded for this case.
          </p>
        )}
      </section>
      <p className="source-version small muted">
        Source {record.sourceVersion.slice(0, 12)} · Updated{" "}
        {new Date(record.updatedAt).toLocaleString()}
      </p>
      {draft && (
        <Modal title={human(draft.action)} close={() => setDraft(undefined)}>
          <div className="info-box">
            Draft preview only. No email is sent by this action.
          </div>
          <p className="small muted">To: {draft.to}</p>
          <h3>{draft.subject}</h3>
          <pre className="draft-text">{draft.text}</pre>
          <p className="small muted">
            Decision {draft.decisionVersion} · Source{" "}
            {draft.sourceVersion.slice(0, 12)}
          </p>
          {stale && (
            <p role="alert" className="warning-box">
              This preview is stale. Close and reload the case.
            </p>
          )}
        </Modal>
      )}
      {sources && (
        <Modal
          title={recovery ? "Recover unresolved fields" : "Source evidence"}
          close={() => setSources(undefined)}
        >
          {recovery ? (
            <RecoveryForm
              api={api}
              record={record}
              sources={sources}
              stale={stale}
            />
          ) : (
            <>
              <p className="small muted">Source {record.sourceVersion}</p>
              {sources.map((source) => (
                <section className="source-document" key={source.id}>
                  <h3>{source.name}</h3>
                  <span className="status-pill">{human(source.status)}</span>
                  {!source.hashMatches && (
                    <p className="error-box">
                      Source hash changed. This evidence cannot authorize
                      confirmation.
                    </p>
                  )}
                  <small className="hash">
                    SHA {source.sha256 || "Unavailable"}
                  </small>
                  <pre>
                    {source.text ||
                      "No native text. See recovery evidence below."}
                  </pre>
                </section>
              ))}
              {comparison && (
                <details>
                  <summary>Persisted before/after OCR recovery</summary>
                  <pre>{JSON.stringify(comparison, null, 2)}</pre>
                </details>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function RecoveryForm({
  api,
  record,
  sources,
  stale,
}: {
  api: ApiClient;
  record: Case;
  sources: SourceReading[];
  stale: boolean;
}) {
  const [attachment, setAttachment] = useState(
    sources.find((source) => source.status === "READABLE")?.id ?? "",
  );
  const [fields, setFields] = useState<string[]>([]);
  const [locators, setLocators] = useState<string[]>([]);
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const available = sources.find((source) => source.id === attachment);
  const toggle = (values: string[], value: string) =>
    values.includes(value)
      ? values.filter((x) => x !== value)
      : [...values, value];
  async function submit() {
    if (!record.decision) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        (
          await api.recover(record.email.id, {
            sourceVersion: record.sourceVersion,
            decisionVersion: record.decision.decisionVersion,
            attachmentId: attachment,
            fields,
            locators,
          })
        ).recovery,
      );
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="recovery-form">
      <p className="muted">
        Select unresolved fields and up to eight source regions. Recovery
        returns proposals, not verified facts.
      </p>
      <label>
        Source document
        <select
          value={attachment}
          onChange={(e) => {
            setAttachment(e.target.value);
            setLocators([]);
          }}
        >
          <option value="">Choose readable source</option>
          {sources
            .filter(
              (source) => source.status === "READABLE" && source.hashMatches,
            )
            .map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset>
        <legend>Unresolved fields</legend>
        {FIELD_NAMES.filter(
          (field) =>
            !record.decision?.fieldResults.some(
              (row) =>
                row.field === field &&
                ["MATCH", "MISMATCH"].includes(row.outcome),
            ),
        ).map((field) => (
          <label key={field}>
            <input
              type="checkbox"
              checked={fields.includes(field)}
              onChange={() => setFields(toggle(fields, field))}
            />
            {human(field)}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Source regions</legend>
        {available?.spans.map((span, index) => {
          const locator =
            span.kind === "line"
              ? `line:${span.line}`
              : span.kind === "page"
                ? `page:${span.page}`
                : `cell:${span.sheet}!${span.cell}`;
          return (
            <label key={index}>
              <input
                type="checkbox"
                checked={locators.includes(locator)}
                onChange={() => setLocators(toggle(locators, locator))}
              />
              <span>
                {locator}: {span.text}
              </span>
            </label>
          );
        })}
      </fieldset>
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      <Button
        disabled={
          stale ||
          busy ||
          !attachment ||
          !fields.length ||
          !locators.length ||
          locators.length > 8
        }
        onClick={() => void submit()}
      >
        {busy ? "Recovering…" : "Recover selected regions"}
      </Button>
      {result != null && (
        <>
          <p className="info-box">
            Recovery proposal. Requires source validation before any
            confirmation.
          </p>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
