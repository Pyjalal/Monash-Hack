import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Email } from "@cargolens/shared";
import { buildClassificationState, type ClassificationMode, type PromptVariant } from "@cargolens/shared/questions";
import { loadDataset } from "../../../apps/api/src/dataset.js";
import { createJevBatchProvider, type BatchClassification } from "../../../apps/api/src/ai/jev-batch.js";
import { classificationMetrics, pacedMap, quantile } from "./metrics.js";
import { INDEPENDENT_CASES } from "./independent.js";

interface EvalRow { email: Email; expected: string; expectedExpectation?: string; expectedUrgency?: string }
interface Config { pack: number; mode: ClassificationMode; variant: PromptVariant; concurrency: number }
const root = resolve("runtime/eval/classification");
const output = resolve(root, "packed");
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("TYPESAFE_API_KEY required");
let calls = 0; let nextSlot = 0;

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function run(name: string, rows: EvalRow[], config: Config) {
  const before = calls; const started = performance.now();
  const batches = Array.from({ length: Math.ceil(rows.length / config.pack) }, (_, index) => rows.slice(index * config.pack, (index + 1) * config.pack));
  const provider = createJevBatchProvider({ apiKey: key!, mode: config.mode, variant: config.variant, model: "jev-1.13.0", maxRetries: 1,
    totalTimeoutMs: 20000, fetch: async (url, init) => {
      if (calls >= 200) throw new Error("Packed evaluation attempt budget exhausted");
      calls++;
      const now = performance.now(); const slot = Math.max(now, nextSlot); nextSlot = slot + 60000 / 1100;
      await sleep(Math.max(0, slot - now), undefined, { signal: init?.signal ?? undefined });
      return fetch(url, init);
    } });
  const results = await pacedMap(batches, config.concurrency, async batch => {
    const batchHash = hash({ state: batch.map(row => buildClassificationState(row.email)), config });
    try {
      const result = await provider.classifyBatch(batch.map(row => row.email));
      return { batchHash, result, rows: batch.map((row, index) => ({ id: row.email.id, expected: row.expected,
        expectedExpectation: row.expectedExpectation, expectedUrgency: row.expectedUrgency, classification: result.classifications[index] as BatchClassification | null })), error: null };
    } catch (error) {
      return { batchHash, result: null, rows: batch.map(row => ({ id: row.email.id, expected: row.expected, expectedExpectation: row.expectedExpectation,
        expectedUrgency: row.expectedUrgency, classification: null as BatchClassification | null })), error: error instanceof Error ? error.name : "UnknownError" };
    }
  });
  const flat = results.flatMap(batch => batch.rows);
  const successful = results.flatMap(batch => batch.result ? [batch.result] : []);
  const wallMs = performance.now() - started;
  const inputTokens = successful.reduce((sum, batch) => sum + batch.usage.input_tokens, 0);
  const expectations = flat.filter(row => row.expectedExpectation);
  const urgencies = flat.filter(row => row.expectedUrgency);
  const report = { name, createdAt: new Date().toISOString(), config, model: "jev-1.13.0", questionVersion: successful[0]?.questionVersion,
    live: true, localCache: false, providerCache: "unknown", rateLimitRpm: 1100,
    metrics: classificationMetrics(flat.map(row => ({ expected: row.expected, predicted: row.classification?.category ?? null }))),
    wallMs, p50BatchMs: quantile(successful.map(batch => batch.elapsedMs), 0.5), p95BatchMs: quantile(successful.map(batch => batch.elapsedMs), 0.95),
    apiAttempts: calls - before, batchCount: batches.length, uniqueBatchHashes: new Set(results.map(batch => batch.batchHash)).size,
    usage: { inputTokens, outputTokens: successful.reduce((sum, batch) => sum + batch.usage.output_tokens, 0),
      estimatedUsd: inputTokens * 0.042 / 1000000, accounting: "Provider usage counted once per packed request, never per email. Estimate excludes unknown failed-call billing." },
    expectationAccuracy: expectations.length ? expectations.filter(row => row.expectedExpectation === row.classification?.expectation).length / expectations.length : null,
    expectationCount: expectations.length,
    urgencyAccuracy: urgencies.length ? urgencies.filter(row => row.expectedUrgency === row.classification?.urgency?.level).length / urgencies.length : null,
    urgencyCount: urgencies.length,
    errors: results.filter(batch => batch.error).map(batch => ({ hash: batch.batchHash, error: batch.error })),
    misses: flat.filter(row => row.expected !== row.classification?.category).map(row => ({ id: row.id, expected: row.expected, predicted: row.classification?.category ?? null })),
  };
  await writeFile(resolve(output, `${name}.json`), JSON.stringify({ report, results }, null, 2) + "\n");
  console.log(JSON.stringify(report));
  return report;
}

async function main() {
  await mkdir(output, { recursive: true });
  const emails = await loadDataset(resolve(process.env.DATASET_PATH ?? "training_data/sdoc-hackathon-docker/extracted/data_v2"));
  const labels: Record<string, { category: string }> = JSON.parse(await readFile(resolve(process.env.DATASET_PATH ?? "training_data/sdoc-hackathon-docker/extracted/data_v2", "ground_truth.json"), "utf8"));
  if (process.argv.includes("--full-mode-only")) {
    await run("full-inbox-full-mode", emails.map(email => ({ email, expected: labels[email.id].category })),
      { pack: 8, mode: "full", variant: "boundaries", concurrency: 8 });
    return;
  }
  const selection = JSON.parse(await readFile(resolve(root, "selection.json"), "utf8"));
  const byId = new Map(emails.map(email => [email.id, email]));
  const dev: EvalRow[] = selection.tuningIds.map((id: string) => ({ email: byId.get(id)!, expected: labels[id].category }));
  const variants = [];
  for (const pack of [4, 8]) variants.push(await run(`dev-pack-${pack}`, dev, { pack, mode: "intent-only", variant: "concise", concurrency: 8 }));
  variants.sort((a, b) => b.metrics.macroF1 - a.metrics.macroF1 || a.wallMs - b.wallMs);
  const candidate = variants[0];
  const baselineDev = selection.reports.find((row: { config: { variant: string; mode: string } }) => row.config.variant === "concise" && row.config.mode === "intent-only");
  if (candidate.metrics.macroF1 < baselineDev.metrics.macroF1 || candidate.metrics.providerCoverage < 1) {
    await writeFile(resolve(output, "decision.json"), JSON.stringify({ promoted: false, reason: "Packed development accuracy or coverage regressed", candidate }, null, 2)); return;
  }
  const independent = INDEPENDENT_CASES.map(row => ({ email: row.email, expected: row.expectedCategory, expectedExpectation: row.expectedExpectation, expectedUrgency: row.expectedUrgency }));
  const validation = await run("independent-candidate", independent, { ...candidate.config, mode: "full", variant: "boundaries" });
  const baselineIndependent = JSON.parse(await readFile(resolve(root, "independent.json"), "utf8")).report;
  const promoted = validation.metrics.macroF1 >= baselineIndependent.metrics.macroF1 && validation.metrics.providerCoverage === 1 &&
    validation.expectationAccuracy! >= baselineIndependent.expectationAccuracy && validation.urgencyAccuracy! >= baselineIndependent.urgencyAccuracy;
  await writeFile(resolve(output, "decision.json"), JSON.stringify({ promoted, candidate: candidate.config,
    reason: "Development-selected packing; frozen fixtures must not regress against single-email baseline. This is packaging validation, not a new unseen test set.", validation }, null, 2));
  if (!promoted) return;
  await run("full-inbox", emails.map(email => ({ email, expected: labels[email.id].category })), candidate.config);
  await run("dev-full-mode", dev, { ...candidate.config, mode: "full", variant: "boundaries" });
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Packed evaluation failed"); process.exitCode = 1; });
