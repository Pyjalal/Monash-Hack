import { randomUUID } from "node:crypto";
import type { Store, RequestUsage } from "./store.js";

export function dashboardReports(store: Store) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS dashboard_runs (id TEXT PRIMARY KEY, report_json TEXT NOT NULL)",
  );
  const requests = () =>
    (
      store.db.prepare("SELECT payload_json FROM ai_requests").all() as {
        payload_json: string;
      }[]
    ).map((row) => JSON.parse(row.payload_json) as RequestUsage);
  const all = () =>
    (
      store.db
        .prepare(
          "SELECT report_json FROM dashboard_runs ORDER BY rowid DESC LIMIT 50",
        )
        .all() as { report_json: string }[]
    ).map((row) => JSON.parse(row.report_json));
  return {
    all,
    begin(ids: string[], revision: string, mode = "operational") {
      const start = Date.now();
      const id = randomUUID();
      const before = new Set(requests().map((row) => row.requestId));
      const prior = new Map(
        ids.map((key) => [key, store.getCase(key)?.classification]),
      );
      const base = {
        id,
        mode,
        kind: "dataset_import",
        startedAt: new Date(start).toISOString(),
        classifierRevision: revision,
        total: ids.length,
        cacheCondition: "retained; not forcibly cleared",
        processWarmth: "not measured",
      };
      store.db
        .prepare("INSERT INTO dashboard_runs VALUES (?,?)")
        .run(id, JSON.stringify({ ...base, state: "running" }));
      return {
        id,
        finish(failed = false) {
          const cases = ids.map((key) => store.getCase(key));
          const calls = requests().filter((row) => !before.has(row.requestId));
          const times = calls.map((row) => row.elapsedMs).sort((a, b) => a - b);
          const q = (fraction: number) =>
            times.length
              ? times[Math.max(0, Math.ceil(times.length * fraction) - 1)]
              : null;
          const report = {
            ...base,
            state: failed ? "failed" : "completed",
            endedAt: new Date().toISOString(),
            wallMs: Date.now() - start,
            classified: cases.filter((row) => row?.status === "classified")
              .length,
            failed: cases.filter((row) => row?.status === "failed").length,
            pending: cases.filter((row) => !row || row.status === "queued")
              .length,
            cached: cases.filter((row) => row?.classification?.cached).length,
            reused: cases.filter(
              (row) =>
                row?.classification &&
                JSON.stringify(row.classification) ===
                  JSON.stringify(prior.get(row.email.id)),
            ).length,
            p50Ms: q(0.5),
            p95Ms: q(0.95),
            latencyScope: "successful provider requests, excluding queue time",
            usageScope:
              "successful provider requests created during this import; concurrent activity may be included",
            requests: calls.length,
            inputTokens: calls.reduce(
              (n, row) => n + row.usage.input_tokens,
              0,
            ),
            outputTokens: calls.reduce(
              (n, row) => n + row.usage.output_tokens,
              0,
            ),
            costUsd: null,
            costReason: "Jev billing is not reported by the provider adapter.",
            falseClears: null,
            falseClearsReason:
              "Requires an independently scored evaluation report.",
          };
          store.db
            .prepare("UPDATE dashboard_runs SET report_json=? WHERE id=?")
            .run(JSON.stringify(report), id);
          store.emit("run.completed", null, { runId: id });
          return report;
        },
      };
    },
    snapshot() {
      const count = (sql: string) =>
        Number((store.db.prepare(sql).get() as { n: number }).n);
      const counts = {
        total: count("SELECT COUNT(*) n FROM cases"),
        classified: count(
          "SELECT COUNT(*) n FROM cases WHERE status='classified'",
        ),
        failed: count("SELECT COUNT(*) n FROM cases WHERE status='failed'"),
        pending: count("SELECT COUNT(*) n FROM cases WHERE status='queued'"),
      };
      const comparisons = (
        store.db
          .prepare("SELECT evidence_json FROM document_comparisons")
          .all() as { evidence_json: string }[]
      ).flatMap(
        (row) =>
          JSON.parse(row.evidence_json) as {
            recovery?: { profile?: { reader_profile?: string } };
          }[],
      );
      return {
        generatedAt: new Date().toISOString(),
        counts,
        usage: store.usageSummary(),
        runs: all(),
        recovery: {
          textAttempts: count(
            "SELECT COUNT(*) n FROM events WHERE type='recovery.attempt'",
          ),
          comparisonAttachments: comparisons.length,
          ocrRecovered: comparisons.filter(
            (row) => row.recovery?.profile?.reader_profile === "ocr_recovered",
          ).length,
        },
        falseClears: null,
        costUsd: null,
        scope:
          "current persisted cases; recovery counts include historical comparison versions",
      };
    },
  };
}
