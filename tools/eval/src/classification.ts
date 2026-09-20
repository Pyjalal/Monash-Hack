import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { APIError } from "@typesafe-ai/sdk";
import { CategorySchema, type Classification, type Email } from "@cargolens/shared";
import { buildClassificationState, buildQuestions, questionVersion, type ClassificationMode, type PromptVariant } from "@cargolens/shared/questions";
import { createJevProvider } from "../../../apps/api/src/ai/jev.js";
import { loadDataset } from "../../../apps/api/src/dataset.js";
import { INDEPENDENT_CASES } from "./independent.js";
import { BENCHMARK_CATEGORIES, classificationMetrics, groupedSplit, pacedMap, quantile, templateGroup } from "./metrics.js";

interface BenchmarkRow { id: string; group: string; category: string; email: Email; expectedExpectation?: string; expectedUrgency?: string }
interface RunConfig { variant: PromptVariant; mode: ClassificationMode; concurrency: number }
interface RowResult { id: string; sourceHash: string; requestHash: string; expected: string; expectedExpectation?: string; expectedUrgency?: string; classification?: Classification; error?: { type: string; status?: number }; elapsedMs: number }
const datasetRoot = resolve(process.env.DATASET_PATH ?? "training_data/sdoc-hackathon-docker/extracted/data_v2");
const output = resolve("runtime/eval/classification");
const model = "jev-1.13.0";
const maxCalls = 1500;
const rpm = 1100;
let transportCalls = 0;
let nextSlot = 0;
const seenRequestHashes = new Set<string>();

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function jsonFile(name: string, data: unknown) { await writeFile(resolve(output, name), JSON.stringify(data, null, 2) + "\n"); }

async function loadRows(): Promise<BenchmarkRow[]> {
  const emails = await loadDataset(datasetRoot);
  const labels: Record<string, { category: unknown }> = JSON.parse(await readFile(resolve(datasetRoot, "ground_truth.json"), "utf8"));
  return emails.map(email => ({ id: email.id, email, category: CategorySchema.parse(labels[email.id]?.category),
    group: templateGroup(buildClassificationState(email).email.body_current) }));
}

function sample(rows: BenchmarkRow[], count: number) {
  const byCategory = BENCHMARK_CATEGORIES.map(category => rows.filter(row => row.category === category)
    .sort((a, b) => hash(buildClassificationState(a.email)).localeCompare(hash(buildClassificationState(b.email)))));
  const selected: BenchmarkRow[] = [];
  const seen = new Set<string>();
  for (let index = 0; selected.length < count; index++) {
    let found = false;
    for (const bucket of byCategory) {
      const row = bucket[index];
      if (!row) continue;
      found = true;
      const key = hash(buildClassificationState(row.email));
      if (!seen.has(key) && selected.length < count) { seen.add(key); selected.push(row); }
    }
    if (!found) break;
  }
  return selected;
}

async function prepare(rows: BenchmarkRow[]) {
  const split = groupedSplit(rows);
  const independent = INDEPENDENT_CASES.map(row => ({ ...row, sourceHash: hash(buildClassificationState(row.email)) }));
  const manifest = { createdAt: new Date().toISOString(), datasetRoot, inputCount: rows.length,
    groundTruthSha256: createHash("sha256").update(await readFile(resolve(datasetRoot, "ground_truth.json"))).digest("hex"),
    grouping: "Latest unquoted request; greetings/signatures removed; email/URL/reference/numeric variations normalized; no labels in group fingerprint.",
    dev: split.dev.map(({ id, group, category }) => ({ id, group, category })),
    holdout: split.holdout.map(({ id, group, category }) => ({ id, group, category })),
    independentSha256: hash(independent), independentCount: independent.length,
    claim: "Classification only. No SI/BL field extraction, official composite score, operational false-clear rate or measured Gmail automation score.",
  };
  let existing: typeof manifest | null = null;
  try { existing = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && (existing.groundTruthSha256 !== manifest.groundTruthSha256 || existing.independentSha256 !== manifest.independentSha256 ||
      hash(existing.dev) !== hash(manifest.dev) || hash(existing.holdout) !== hash(manifest.holdout)))
    throw new Error("Frozen evaluation inputs changed; use a new artifact directory and evaluation cycle");
  if (!existing) {
    await jsonFile("manifest.json", manifest);
    await jsonFile("independent-frozen.json", independent);
  }
  await jsonFile("question-contracts.json", { model, concise: buildQuestions("concise"), boundaries: buildQuestions("boundaries") });
  return split;
}

async function run(name: string, rows: BenchmarkRow[], config: RunConfig) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is required for live classification evaluation");
  const started = performance.now(); const beforeCalls = transportCalls; let reusedRequests = 0;
  const provider = createJevProvider({ apiKey: key, model, ...config, timeoutMs: 10000, totalTimeoutMs: 20000, maxRetries: 1,
    fetch: async (url, init) => {
      if (transportCalls >= maxCalls) throw new Error("Evaluation API attempt budget exhausted");
      transportCalls++;
      const now = performance.now(); const slot = Math.max(now, nextSlot); nextSlot = slot + 60000 / rpm;
      await sleep(Math.max(0, slot - now), undefined, { signal: init?.signal ?? undefined });
      return fetch(url, init);
    },
  });
  const results = await pacedMap(rows, config.concurrency, async (row): Promise<RowResult> => {
    const state = buildClassificationState(row.email); const sourceHash = hash(state);
    const requestHash = hash({ state, questions: buildQuestions(config.variant, config.mode), model });
    if (seenRequestHashes.has(requestHash)) reusedRequests++;
    seenRequestHashes.add(requestHash);
    const base = { id: row.id, sourceHash, requestHash, expected: row.category,
      expectedExpectation: row.expectedExpectation, expectedUrgency: row.expectedUrgency };
    const start = performance.now();
    try { return { ...base, classification: await provider.classify(row.email), elapsedMs: performance.now() - start }; }
    catch (error) { return { ...base, error: { type: error instanceof Error ? error.name : "UnknownError", status: error instanceof APIError ? error.status : undefined }, elapsedMs: performance.now() - start }; }
  });
  const wallMs = performance.now() - started;
  const successful = results.flatMap(row => row.classification ? [row.classification] : []);
  const usage = successful.reduce((sum, row) => {
    if (!row.usage) throw new Error("Direct provider benchmark returned no request usage");
    return { input_tokens: sum.input_tokens + row.usage.input_tokens, output_tokens: sum.output_tokens + row.usage.output_tokens };
  }, { input_tokens: 0, output_tokens: 0 });
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const metrics = classificationMetrics(results.map(row => ({ expected: row.expected, predicted: row.classification?.category ?? null })));
  const expectations = results.filter(row => row.expectedExpectation);
  const urgencies = results.filter(row => row.expectedUrgency);
  const report = { name, createdAt: new Date().toISOString(), config, questionVersion: questionVersion(config.variant, config.mode),
    modelRequested: model, modelsReturned: [...new Set(successful.map(row => row.model))], live: true, localCache: false, providerCache: "unknown",
    metrics, wallMs, throughputEmailsPerSecond: rows.length / (wallMs / 1000), p50Ms: quantile(results.map(row => row.elapsedMs), 0.5), p95Ms: quantile(results.map(row => row.elapsedMs), 0.95),
    usage: { inputTokens, outputTokens, usageUnavailableForFailedCalls: results.length - successful.length,
      estimatedUsd: inputTokens * 0.042 / 1000000, estimateBasis: "$0.042/M input tokens; output free. Estimate, not invoice; failed-call billing unknown." },
    apiAttempts: transportCalls - beforeCalls, reusedRequestHashesInThisProcess: reusedRequests,
    uniqueInputHashes: new Set(results.map(row => row.sourceHash)).size, rateLimitRpm: rpm,
    expectationAccuracy: expectations.length ? expectations.filter(row => row.expectedExpectation === row.classification?.expectation).length / expectations.length : null,
    expectationCount: expectations.length,
    urgencyAccuracy: urgencies.length ? urgencies.filter(row => row.expectedUrgency === row.classification?.urgency?.level).length / urgencies.length : null,
    urgencyCount: urgencies.length,
    errors: results.filter(row => row.error).map(row => ({ id: row.id, ...row.error })),
    misses: results.filter(row => row.expected !== row.classification?.category).map(row => ({ id: row.id, expected: row.expected, predicted: row.classification?.category ?? null })),
  };
  await jsonFile(`${name}.json`, { report, results });
  console.log(JSON.stringify(report));
  return report;
}

async function main() {
  await mkdir(output, { recursive: true });
  const phase = process.argv[process.argv.indexOf("--phase") + 1] || "all";
  const validPhase = ["all", "prepare", "tune", "speed", "full", "independent"].includes(phase) ? phase : "all";
  const rows = await loadRows();
  const split = await prepare(rows);
  if (validPhase === "prepare") { console.log(JSON.stringify({ count: rows.length, dev: split.dev.length, holdout: split.holdout.length, independent: INDEPENDENT_CASES.length })); return; }
  // Evaluation-only quarantine/overlay produced from a source-validated dispute ledger.
  // Official full and holdout references below remain unchanged.
  let reliableDevelopment = split.dev;
  if (process.env.EVAL_TARGETS_PATH) {
    const targets = JSON.parse(await readFile(resolve(process.env.EVAL_TARGETS_PATH), 'utf8')) as {
      truthSha256: string; excluded: Record<string, string[]>; correctedCategories: Record<string, unknown>;
    };
    if (targets.truthSha256 !== createHash('sha256').update(await readFile(resolve(datasetRoot, 'ground_truth.json'))).digest('hex')) throw new Error('Optimization targets belong to different official references');
    reliableDevelopment = split.dev.filter(row => !targets.excluded[row.id]?.includes('category'))
      .map(row => ({ ...row, category: CategorySchema.parse(targets.correctedCategories[row.id]) }));
    await jsonFile('optimization-reference.json', { path: resolve(process.env.EVAL_TARGETS_PATH), sha256: hash(targets), excludedDevelopmentCount: split.dev.length - reliableDevelopment.length });
  }
  const tuningRows = sample(reliableDevelopment, 64);
  let best: RunConfig;
  let bestFull: RunConfig;
  if (["all", "tune"].includes(validPhase)) {
    const runs = [];
    for (const variant of ["concise", "boundaries"] as const)
      for (const mode of ["full", "intent-only"] as const)
        runs.push(await run(`tune-${variant}-${mode}`, tuningRows, { variant, mode, concurrency: 16 }));
    runs.sort((a, b) => b.metrics.macroF1 - a.metrics.macroF1 || b.metrics.decisionCoverage - a.metrics.decisionCoverage || a.wallMs - b.wallMs);
    best = runs[0].config; bestFull = runs.find(row => row.config.mode === "full")!.config;
    await jsonFile("selection.json", { selectedAt: new Date().toISOString(), selectionRule: "Development macro-F1, decision coverage, then observed full-run wall time; independent and holdout not consulted.", best, bestFull,
      tuningIds: tuningRows.map(row => row.id), reports: runs });
    if (validPhase === "tune") return;
  } else {
    const selection = JSON.parse(await readFile(resolve(output, "selection.json"), "utf8"));
    best = selection.best; bestFull = selection.bestFull;
  }
  if (["all", "speed"].includes(validPhase)) {
    const excluded = new Set(tuningRows.map(row => hash(buildClassificationState(row.email))));
    const speedRows = sample(reliableDevelopment.filter(row => !excluded.has(hash(buildClassificationState(row.email)))), 96);
    for (const [index, concurrency] of [4, 16, 32].entries())
      await run(`speed-${concurrency}`, speedRows.slice(index * 32, (index + 1) * 32), { ...best, concurrency });
    if (validPhase === "speed") return;
  }
  if (["all", "full"].includes(validPhase)) {
    const report = await run("full-inbox", rows, { ...best, concurrency: 32 });
    const artifact = JSON.parse(await readFile(resolve(output, "full-inbox.json"), "utf8")) as { results: RowResult[] };
    const held = new Set(split.holdout.map(row => row.id));
    const holdoutMetrics = classificationMetrics(artifact.results.filter(row => held.has(row.id)).map(row => ({ expected: row.expected, predicted: row.classification?.category ?? null })));
    await jsonFile("scorecards.json", { scope: "Category classification only; official composite/defect scores not computed", officialCategory: report.metrics, holdoutCategory: holdoutMetrics,
      adjudicatedCategory: null, adjudicationStatus: "No independently adjudicated category overlay supplied." });
    if (validPhase === "full") return;
  }
  if (["all", "independent"].includes(validPhase))
    await run("independent", INDEPENDENT_CASES.map(row => ({ id: row.email.id, email: row.email, category: row.expectedCategory,
      group: hash(row.email.body), expectedExpectation: row.expectedExpectation, expectedUrgency: row.expectedUrgency })), { ...bestFull, concurrency: 16 });
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Evaluation failed"); process.exitCode = 1; });
