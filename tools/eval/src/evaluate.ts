import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { SubmissionRowSchema, type SubmissionRow } from '@cargolens/shared';
import { buildClassificationState, questionVersion } from '@cargolens/shared/questions';
import { loadDataset } from '../../../apps/api/src/dataset.js';
import { Store } from '../../../apps/api/src/store.js';
import { ClassificationService } from '../../../apps/api/src/pipeline.js';
import { createJevProvider } from '../../../apps/api/src/ai/jev.js';
import { createJevBatchProvider } from '../../../apps/api/src/ai/jev-batch.js';
import { verifyOperationalEvidence } from '../../../apps/api/src/gmail/evidence-validation.js';
import { exportCases, EXPORT_VERSION } from './export.js';
import { adjudicate, DisputeLedgerSchema, targetMetrics } from './disputes.js';
import { classificationMetrics, groupedSplit, templateGroup, quantile } from './metrics.js';
import { INDEPENDENT_CASES } from './independent.js';

const exec = promisify(execFile);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
async function json(path: string, value: unknown, exclusive = false) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', exclusive ? { flag: 'wx' } : undefined); }
async function freeze(path: string, value: unknown) {
  try { await json(path, value, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (hash(JSON.parse(await readFile(path, 'utf8'))) !== hash(value)) throw new Error(`Frozen inputs changed: ${path}. Start a separately named evaluation cycle.`);
  }
}
async function sourceBytes(root: string, path: string) {
  const actual = await realpath(resolve(root, path)); const within = relative(await realpath(root), actual);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('Evaluation source escapes dataset');
  return readFile(actual);
}

async function main() {
  const { values } = parseArgs({ options: { prepare: { type: 'boolean' }, offline: { type: 'boolean' }, output: { type: 'string' }, dataset: { type: 'string' },
    python: { type: 'string' }, disputes: { type: 'string' }, scope: { type: 'string', default: 'final' } }, strict: true });
  if (!['development', 'final'].includes(values.scope!)) throw new Error('scope must be development or final');
  const root = resolve(values.dataset ?? process.env.DATASET_ROOT ?? 'training_data/sdoc-hackathon-docker/extracted/data_v2');
  const output = resolve(values.output ?? 'runtime/eval/official'); await mkdir(output, { recursive: true });
  const emails = await loadDataset(root);
  const truthBytes = await readFile(resolve(root, 'ground_truth.json'));
  const rawTruth: Record<string, unknown> = JSON.parse(truthBytes.toString('utf8'));
  // Organizer references contain extra metadata. Only scoring targets enter the evaluator.
  const truth: Record<string, SubmissionRow> = Object.fromEntries(Object.entries(rawTruth).map(([id, value]) => {
    const row = value as SubmissionRow;
    return [id, SubmissionRowSchema.parse({ category: row.category, status: row.status, review_reason: row.review_reason ?? null, defect_fields: row.defect_fields, has_defect: row.has_defect })];
  }));
  if (emails.length !== 520 || Object.keys(truth).length !== 520 || emails.some(email => !truth[email.id])) throw new Error('Official run requires exactly 520 matching, unique source and reference IDs');
  const scorerRoot = resolve(root, '../server');
  const scorerHashes = Object.fromEntries(await Promise.all(['score_cli.py', 'scoring.py'].map(async name => [name, sha(await readFile(resolve(scorerRoot, name)))])));
  const sourceHashes = Object.fromEntries(await Promise.all(emails.map(async email => [email.id, {
    email: hash(email), attachments: await Promise.all(email.attachments.map(async attachment => ({ path: attachment.relativePath!, sha256: sha(await sourceBytes(root, attachment.relativePath!)) }))),
  }])));
  const datasetSha256 = hash({ sourceHashes, truth: sha(truthBytes) });
  const model = process.env.TYPESAFE_MODEL ?? 'jev-1.13.0';
  const variant = process.env.JEV_PROMPT_VARIANT === 'concise' ? 'concise' : 'boundaries';
  const implementationPaths = ['apps/api/src/store.ts', 'apps/api/src/pipeline.ts', 'apps/api/src/ai/classify.ts', 'apps/api/src/ai/jev.ts', 'apps/api/src/ai/jev-batch.ts',
    'apps/api/src/documents/index.ts', 'apps/api/src/documents/candidates.ts', 'apps/api/src/documents/readability.ts', 'packages/shared/src/index.ts', 'packages/shared/src/questions.ts',
    'tools/eval/src/evaluate.ts', 'tools/eval/src/export.ts', 'tools/eval/src/disputes.ts', 'tools/eval/src/metrics.ts', 'tools/eval/src/independent.ts', 'package-lock.json'];
  const implementations = Object.fromEntries(await Promise.all(implementationPaths.map(async path => [path, sha(await readFile(path))])));
  const config = { model, variant, questionVersion: questionVersion(variant, 'full'), exportVersion: EXPORT_VERSION,
    reader: 'native-v1', policy: 'initial-decision-v1', batchSize: Number(process.env.JEV_BATCH_SIZE ?? 8),
    concurrency: Number(process.env.JEV_CONCURRENCY ?? 8), requestsPerMinute: Number(process.env.JEV_REQUESTS_PER_MINUTE ?? 1100), implementations };
  const rows = emails.map(email => ({ id: email.id, group: templateGroup(buildClassificationState(email).email.body_current), category: truth[email.id].category,
    format: [...new Set(email.attachments.map(attachment => attachment.mimeType))].sort().join('+') || 'no-attachments' }));
  const split = groupedSplit(rows);
  const manifest = { version: 1, datasetSha256, truthSha256: sha(truthBytes), scorerHashes, sourceHashes,
    grouping: 'Normalized latest unquoted request templates; groups are indivisible across category/format strata.',
    requestedFinalFraction: 0.23, actualDevelopmentCount: split.dev.length, actualFinalCount: split.holdout.length,
    development: split.dev, final: split.holdout, independentSha256: hash(INDEPENDENT_CASES), config, profileSha256: hash(config),
    limitation: 'Organizer data was previously reviewed. This grouped final partition is not a blind independent holdout. Independent fixtures are reused validation cases.' };
  await freeze(resolve(output, 'manifest.json'), manifest);
  await freeze(resolve(output, 'independent-frozen.json'), INDEPENDENT_CASES);
  const ledger = values.disputes ? DisputeLedgerSchema.parse(JSON.parse(await readFile(resolve(values.disputes), 'utf8'))) : { version: 1 as const, datasetSha256, entries: [] };
  if (ledger.datasetSha256 !== datasetSha256) throw new Error('Dispute ledger belongs to a different dataset');
  for (const entry of ledger.entries) for (const span of entry.evidence) {
    const bytes = await sourceBytes(root, span.path);
    if (span.path.replaceAll('\\', '/').endsWith('ground_truth.json') || sha(bytes) !== span.sha256 || bytes.toString('utf8').slice(span.start, span.end) !== span.text) throw new Error('Dispute evidence must be an exact source span, not a model disagreement or label');
    const email = emails.find(row => row.id === entry.emailId);
    if (!email || ![`inbox/${entry.emailId}.json`, ...email.attachments.map(attachment => attachment.relativePath)].includes(span.path.replaceAll('\\', '/'))) throw new Error('Dispute evidence is not attached to the cited email');
  }
  const adjudicated = adjudicate(truth, ledger);
  await freeze(resolve(output, 'disputes-frozen.json'), ledger);
  await json(resolve(output, 'optimization-targets.json'), { datasetSha256, truthSha256: sha(truthBytes), excluded: adjudicated.excluded,
    correctedCategories: Object.fromEntries(Object.entries(adjudicated.overlay).map(([id, row]) => [id, row.category])),
    reliableDevelopment: split.dev.map(row => ({ id: row.id, targets: Object.keys(truth[row.id]).filter(target => !adjudicated.excluded[row.id]?.includes(target)) })) });
  if (values.prepare) { console.log(JSON.stringify({ prepared: true, count: emails.length, development: split.dev.length, final: split.holdout.length, datasetSha256, output })); return; }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!values.offline && (!apiKey || apiKey.startsWith('your_'))) throw new Error('TYPESAFE_API_KEY required. Use --prepare to freeze inputs or --offline for an explicit blocked-run report.');
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = resolve(output, 'runs', runId); await mkdir(runDir, { recursive: true });
  if (!values.offline && values.scope === 'final') await json(resolve(output, 'final-consumed.json'), { runId, at: new Date().toISOString(), profileSha256: hash(config), note: 'Final errors must not be used for retuning.' }, true);
  const store = new Store(resolve(runDir, 'cases.sqlite'));
  try {
    let providerAttempts = 0;
    const measuredFetch: typeof fetch = (...args) => { providerAttempts++; return fetch(...args); };
    const provider = createJevProvider({ apiKey: apiKey ?? 'unconfigured', model, variant, mode: 'full', fetch: measuredFetch });
    const batch = createJevBatchProvider({ apiKey: apiKey ?? 'unconfigured', model, variant, mode: 'full', fetch: measuredFetch });
    const service = new ClassificationService({ store, classifier: provider.classify, batchClassifier: batch.classifyBatch,
      configurationKey: `${model}:${config.questionVersion}:packed-v1`, batchSize: config.batchSize, concurrency: config.concurrency, requestsPerMinute: config.requestsPerMinute });
    const selected = values.scope === 'development' ? emails.filter(email => split.dev.some(row => row.id === email.id)) : emails;
    const timings: number[] = []; const started = performance.now(); let firstResultMs: number | null = null;
    await Promise.all(selected.map(async email => {
      const start = performance.now();
      if (values.offline) { const record = store.upsertEmail(email); store.markFailed(email.id, record.sourceVersion, 'LIVE_INFERENCE_NOT_RUN'); }
      else await service.processCase(email);
      timings.push(performance.now() - start); firstResultMs ??= performance.now() - started;
    }));
    const wallMs = performance.now() - started;
    const records = selected.map(email => store.getCase(email.id)!);
    // Any future comparison integration must pass the same source proof as API decisions.
    for (const record of records) if (record.decision && (record.decision.verificationState === 'COMPLETE' || record.decision.knownMismatches.length)) await verifyOperationalEvidence(record, record.decision, root);
    const exported = exportCases(records);
    await json(resolve(runDir, 'submission.json'), exported.submission);
    await json(resolve(runDir, 'submission-provenance.json'), { version: exported.version, datasetSha256, profileSha256: hash(config), rows: exported.provenance, failures: exported.failures });
    const selectedTruth = Object.fromEntries(selected.map(email => [email.id, truth[email.id]]));
    const selectedOverlay = Object.fromEntries(selected.map(email => [email.id, adjudicated.overlay[email.id]]));
    let scorer: unknown = null; let scorerError: string | null = null;
    try {
      const result = await exec(values.python ?? process.env.PYTHON ?? 'python', [resolve(scorerRoot, 'score_cli.py'), resolve(runDir, 'submission.json'), '--ground-truth', resolve(root, 'ground_truth.json'), '--json'], { timeout: 60000, maxBuffer: 2_000_000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      scorer = JSON.parse(result.stdout); await json(resolve(runDir, 'organizer-scorer.json'), scorer);
    } catch { scorerError = 'ORGANIZER_SCORER_FAILED'; }
    const officialUsage = store.usageSummary(); const officialAttempts = providerAttempts;
    const category = classificationMetrics(records.map(record => ({ expected: truth[record.email.id].category, predicted: record.classification?.category ?? null })));
    const independentRows = [];
    if (!values.offline) for (const fixture of INDEPENDENT_CASES) {
      await service.processCase(fixture.email); const record = store.getCase(fixture.email.id)!;
      independentRows.push({ id: fixture.email.id, expected: fixture.expectedCategory, predicted: record.classification?.category ?? null,
        expectationCorrect: fixture.expectedExpectation ? record.classification?.expectation === fixture.expectedExpectation : null,
        falseClear: record.decision?.workflowState === 'VERIFIED', automated: record.decision?.workflowState === 'VERIFIED' || record.decision?.workflowState === 'NOT_APPLICABLE' });
    }
    const operationalFalseClears = records.filter(record => record.decision?.workflowState === 'VERIFIED' && (truth[record.email.id].status !== 'OK' || record.decision.verificationState !== 'COMPLETE')).map(record => record.email.id);
    const report = { runId, scope: values.scope, mode: values.offline ? 'blocked-offline' : 'live', datasetSha256, profileSha256: hash(config), config,
      sourceCount: emails.length, evaluatedCount: selected.length, exportedCount: Object.keys(exported.submission).length, failures: exported.failures,
      official: { valid: exported.complete && selected.length === 520 && !scorerError, score: exported.complete && selected.length === 520 ? scorer : null,
        diagnosticScorer: 'organizer-scorer.json', warning: exported.complete && selected.length === 520 ? null : 'Partial submissions trigger organizer defaults. Diagnostic numbers are not a valid headline score.',
        targets: { categoryMacroF1: 0.85, endToEndDefectRate: 0.80, reviewRecallCount: '15/20' }, category, exactTargets: targetMetrics(selectedTruth, exported.submission), scorerError },
      adjudicated: { ledgerSha256: hash(ledger), accepted: adjudicated.accepted, unresolvedByTarget: adjudicated.unresolvedByTarget,
        exactTargets: targetMetrics(selectedOverlay, exported.submission, adjudicated.excluded), label: 'Evaluation-only corrected references; target-level exclusions.' },
      independent: { status: values.offline ? 'NOT_RUN' : 'REUSED_INDEPENDENT_VALIDATION', fixtureSha256: hash(INDEPENDENT_CASES), rows: independentRows,
        category: independentRows.length ? classificationMetrics(independentRows) : null,
        falseClears: independentRows.length ? independentRows.filter(row => row.falseClear).length : null,
        automationCoverage: independentRows.length ? independentRows.filter(row => row.automated).length / independentRows.length : null,
        documentStatusReasonChecks: 'NOT_RUN: independently authored document comparator fixtures are not integrated' },
      operational: { falseClearIdsAgainstOfficialReference: operationalFalseClears, automationCoverage: records.filter(record => ['VERIFIED', 'NOT_APPLICABLE'].includes(record.decision?.workflowState ?? '')).length / records.length,
        sentMessages: 0, limitation: 'No live delivery evaluated; comparison pipeline remains pending integration.' },
      performance: { wallMs, firstResultMs, p50Ms: quantile(timings, 0.5), p95Ms: quantile(timings, 0.95), coldDatabase: true,
        classificationCacheHits: records.filter(record => record.classification?.cached).length, providerCache: 'unknown', usage: officialUsage,
        providerAttempts: officialAttempts, totalUsageIncludingIndependent: store.usageSummary(), failedCallUsage: 'unknown' } };
    await json(resolve(runDir, 'scorecards.json'), report);
    await json(resolve(runDir, 'decisions.json'), records);
    await json(resolve(output, 'latest-run.json'), { runDir, runId });
    console.log(JSON.stringify({ runDir, ...report }, null, 2));
    if (!report.official.valid || values.offline) process.exitCode = 1;
  } finally { store.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1; });
