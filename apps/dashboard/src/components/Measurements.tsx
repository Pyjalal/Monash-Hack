import { useState } from "react";
import { Download, RefreshCw, Send, BarChart3 } from "lucide-react";
import type {
  ApiClient,
  DashboardReport,
  Delivery,
  GmailStatus,
} from "../lib/api";
import { describeError } from "../lib/api";
import { duration, human } from "../lib/view-model";
import { Button } from "./ui/button";

export function Measurements({
  report,
  api,
}: {
  report?: DashboardReport;
  api: ApiClient;
}) {
  const [error, setError] = useState("");
  async function download(id: string) {
    try {
      const value = await api.run(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `cargolens-run-${id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(describeError(failure));
    }
  }
  if (!report) return <div className="empty">Loading saved measurements…</div>;
  const latest = report.runs[0];
  return (
    <section className="measurements">
      <div className="section-heading">
        <div>
          <h2>Pipeline measurements</h2>
          <p className="muted small">{report.scope}</p>
        </div>
        <BarChart3 size={22} />
      </div>
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      <div className="measurement-grid">
        {[
          {
            label: "Latest import wall time",
            value: duration(latest?.wallMs),
            note: latest
              ? `${latest.total} messages · ${latest.state}`
              : "Import an inbox to record a run",
          },
          {
            label: "Provider P50 / P95",
            value: `${duration(latest?.p50Ms)} / ${duration(latest?.p95Ms)}`,
            note: "Successful requests; excludes queue time",
          },
          {
            label: "Input / output tokens",
            value: `${report.usage.input_tokens.toLocaleString()} / ${report.usage.output_tokens.toLocaleString()}`,
            note: `${report.usage.requests} persisted successful requests`,
          },
          {
            label: "Billed cost",
            value: "Unavailable",
            note: "Provider adapter does not report Jev billing",
          },
          {
            label: "OCR recovered",
            value: String(report.recovery.ocrRecovered),
            note: `${report.recovery.comparisonAttachments} attachment comparison records`,
          },
          {
            label: "Text recovery attempts",
            value: String(report.recovery.textAttempts),
            note: "Recorded attempts, including failures",
          },
          {
            label: "False clears",
            value: "Not evaluated",
            note: "Requires independently scored reference evidence",
          },
          {
            label: "Current pending / errors",
            value: `${report.counts.pending} / ${report.counts.failed}`,
            note: "Classification state, not verification outcomes",
          },
        ].map((item) => (
          <div key={item.label} className="measurement">
            <p className="small muted">{item.label}</p>
            <strong>{item.value}</strong>
            <small>{item.note}</small>
          </div>
        ))}
      </div>
      <div className="section-heading">
        <h3>Saved import runs</h3>
        <span className="small muted">Download exact displayed artifacts</span>
      </div>
      {report.runs.length ? (
        <div className="table-scroll">
          <table className="runs-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>State</th>
                <th>Messages</th>
                <th>Wall time</th>
                <th>Cached / reused</th>
                <th>Conditions</th>
                <th>Artifact</th>
              </tr>
            </thead>
            <tbody>
              {report.runs.map((run) => (
                <tr key={run.id}>
                  <td>{new Date(run.startedAt).toLocaleString()}</td>
                  <td>{human(run.state)}</td>
                  <td>{run.total}</td>
                  <td>{duration(run.wallMs)}</td>
                  <td>
                    {run.cached ?? "Pending"} / {run.reused ?? "Pending"}
                  </td>
                  <td>
                    <span>{run.cacheCondition}</span>
                    <small>Process warmth: {run.processWarmth}</small>
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label={`Download run ${run.id}`}
                      onClick={() => void download(run.id)}
                    >
                      <Download size={16} />
                      JSON
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <h3>No measured imports yet</h3>
          <p>
            Import the configured inbox to persist timing and cache conditions.
            Existing case results do not establish a full-inbox benchmark.
          </p>
        </div>
      )}
      <p className="small muted metric-note">
        Live events update saved state. Replaying the event stream is not a new
        inference run. Cold-start conditions are never inferred from a fast
        result. Request usage recorded during an import may include concurrent
        activity.
      </p>
    </section>
  );
}

export function DeliveryLog({
  items,
  gmail,
  busy,
  sync,
  dispatch,
}: {
  items: Delivery[];
  gmail?: GmailStatus;
  busy: boolean;
  sync: () => void;
  dispatch: () => void;
}) {
  return (
    <section className="deliveries">
      <div className="section-heading">
        <div>
          <h2>Gmail delivery log</h2>
          <p className="small muted">
            {gmail?.configured
              ? "Server-held mailbox authorization. Durable, versioned replies."
              : "Connect Gmail on the API to ingest threads and deliver operational replies."}
          </p>
        </div>
        <div className="action-buttons">
          <Button
            variant="outline"
            disabled={busy || !gmail?.configured}
            onClick={sync}
          >
            <RefreshCw size={16} />
            Sync Gmail
          </Button>
          <Button disabled={busy || !gmail?.enabled} onClick={dispatch}>
            <Send size={16} />
            Send pending replies
          </Button>
        </div>
      </div>
      <div className="info-box">
        {gmail?.enabled
          ? "Unattended sending is enabled. Syncing Gmail can produce and send operational replies."
          : "Sending is disabled. No reply will be delivered until server-side automation is enabled."}{" "}
        Unknown delivery means reconciliation is required, not blind retry.
      </div>
      {items.length ? (
        <div className="table-scroll">
          <table className="runs-table">
            <thead>
              <tr>
                <th>Reply</th>
                <th>Recipient</th>
                <th>State</th>
                <th>Attempts</th>
                <th>Evidence version</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{human(item.action)}</strong>
                    <small>{item.reply.subject}</small>
                    <details>
                      <summary>Message and delivery details</summary>
                      <pre>{item.reply.text}</pre>
                      <p>{item.error ?? "No delivery error recorded."}</p>
                      <p>
                        Provider message:{" "}
                        {item.sentMessageId ?? "Not confirmed"}
                      </p>
                    </details>
                  </td>
                  <td>{item.reply.to}</td>
                  <td>
                    <span className="status-pill">{human(item.status)}</span>
                  </td>
                  <td>{item.attempts}</td>
                  <td className="hash">{item.sourceVersion.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <Send size={28} />
          <h3>No replies queued</h3>
          <p>
            Operational replies appear here when the connected workflow produces
            a validated next action.
          </p>
        </div>
      )}
    </section>
  );
}
