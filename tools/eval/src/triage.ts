/** Offline analysis of a frozen run. Never invokes inference or changes product decisions. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { SubmissionRowSchema, type SubmissionRow } from '@cargolens/shared';
import { loadDataset } from '../../../apps/api/src/dataset.js';
import { adjudicate, DisputeLedgerSchema, targetMetrics, validateDisputeEvidence, type DisputeLedger } from './disputes.js';
import type { evaluationDiagnostics } from './diagnostics.js';

type Row = Omit<ReturnType<typeof evaluationDiagnostics>['rows'][number], 'predicted'> & { predicted: SubmissionRow | null };
type Provenance = { rows: Record<string, { rule: string; lossy: boolean }>; failures: { id: string; code: string }[] };
const targets = ['category', 'status', 'review_reason', 'defect_fields', 'has_defect'] as const;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function triageRows(rows: Row[], provenance: Provenance, ledger: DisputeLedger) {
  return rows.map(row => {
    const exportFailure = provenance.failures.find(item => item.id === row.id)?.code ?? null;
    const disputes = ledger.entries.filter(entry => entry.emailId === row.id && entry.status !== 'REJECTED');
    const stages: string[] = [];
    if (row.disposition === 'INFERENCE_FAILED') stages.push('INFERENCE');
    if (row.blockers.some(code => /^(ocr_failed|UNREADABLE|OCR_REQUIRED)$/.test(code))) stages.push('READER');
    if ((!row.categoryCorrect && row.disposition !== 'INFERENCE_FAILED') || row.blockers.some(code => !/^(ocr_failed|UNREADABLE|OCR_REQUIRED)$/.test(code))) stages.push('SEMANTIC');
    if (exportFailure) stages.push('EXPORT');
    if (disputes.length) stages.push('LABEL_DISPUTE');
    if (provenance.rows[row.id]?.lossy) stages.push('LABEL_CONVENTION');
    const mismatchedTargets = targets.filter(target => !row.predicted || !isDeepStrictEqual(
      Array.isArray(row.expected[target]) ? [...row.expected.defect_fields].sort() : row.expected[target],
      Array.isArray(row.predicted[target]) ? [...row.predicted.defect_fields].sort() : row.predicted[target]));
    if (mismatchedTargets.length && !stages.length) stages.push('UNRESOLVED_SOURCE_REVIEW');
    return { id: row.id, primary: stages[0] ?? 'AGREES', stages, categoryCorrect: row.categoryCorrect,
      mismatchedTargets, exportFailure, blockers: row.blockers, projection: provenance.rows[row.id]?.rule ?? null,
      disputes: disputes.map(entry => ({ id: entry.id, target: entry.target, kind: entry.kind, status: entry.status })),
      attribution: 'Observed stages, not an assertion that the reference is wrong. Export failure may be a consequence of an upstream blocker.' };
  });
}

export async function triageRun(reportRoot: string, datasetRoot: string, ledgerPath: string, output: string) {
  const inputHashes: Record<string, string> = {};
  async function read<T>(name: string): Promise<T> {
    const bytes = await readFile(resolve(reportRoot, name)); inputHashes[name] = sha(bytes);
    return JSON.parse(bytes.toString('utf8')) as T;
  }
  const manifest = await read<{ datasetSha256: string; truthSha256: string; sourceHashes: Record<string, { email: string; attachments: { path: string; sha256: string }[] }>; development: { id: string }[]; final: { id: string }[] }>('manifest.json');
  const cards = await read<{ runId: string; datasetSha256: string; official: unknown; independent: unknown }>('scorecards.json');
  const diagnostics = await read<ReturnType<typeof evaluationDiagnostics>>('row-diagnostics.json');
  const provenance = await read<Provenance>('submission-provenance.json');
  const submission = await read<Record<string, SubmissionRow>>('submission.json');
  const expectedHashes = await read<Record<string, string>>('artifact-hashes.json');
  for (const [name, digest] of Object.entries(inputHashes)) if (name !== 'artifact-hashes.json' && expectedHashes[name] !== digest) throw new Error(`Frozen report changed: ${name}`);
  const truthBytes = await readFile(resolve(datasetRoot, 'ground_truth.json'));
  if (sha(truthBytes) !== manifest.truthSha256 || cards.datasetSha256 !== manifest.datasetSha256) throw new Error('Reference/dataset mismatch');
  const rawTruth = JSON.parse(truthBytes.toString('utf8')) as Record<string, SubmissionRow>;
  const truth = Object.fromEntries(Object.entries(rawTruth).map(([id, row]) => [id, SubmissionRowSchema.parse({ category: row.category, status: row.status, review_reason: row.review_reason ?? null, defect_fields: row.defect_fields, has_defect: row.has_defect })]));
  const emails = await loadDataset(datasetRoot);
  if (emails.length !== Object.keys(manifest.sourceHashes).length) throw new Error('Dataset membership changed');
  for (const email of emails) {
    const frozen = manifest.sourceHashes[email.id];
    if (!frozen || sha(JSON.stringify(email)) !== frozen.email) throw new Error(`Email changed: ${email.id}`);
    for (const attachment of frozen.attachments) {
      const actual = await realpath(resolve(datasetRoot, attachment.path));
      const within = relative(await realpath(datasetRoot), actual);
      if (within.startsWith('..') || isAbsolute(within) || sha(await readFile(actual)) !== attachment.sha256) throw new Error(`Attachment changed: ${attachment.path}`);
    }
  }
  if (sha(JSON.stringify({ sourceHashes: manifest.sourceHashes, truth: manifest.truthSha256 })) !== manifest.datasetSha256) throw new Error('Invalid dataset digest');
  const ids = diagnostics.rows.map(row => row.id);
  if (new Set(ids).size !== ids.length || ids.length !== Object.keys(truth).length || ids.some(id => !truth[id])) throw new Error('Diagnostics must account for every reference exactly once');
  const accounted = [...Object.keys(submission), ...provenance.failures.map(item => item.id)];
  if (new Set(accounted).size !== ids.length || accounted.length !== ids.length || accounted.some(id => !truth[id])) throw new Error('Export accounting mismatch');
  for (const row of diagnostics.rows) if (!isDeepStrictEqual(row.expected, truth[row.id]) || !isDeepStrictEqual(row.predicted, submission[row.id] ?? null)) throw new Error('Diagnostics do not match frozen targets');
  const ledger = DisputeLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, 'utf8')));
  if (ledger.datasetSha256 !== manifest.datasetSha256) throw new Error('Dispute ledger belongs to a different dataset');
  await validateDisputeEvidence(ledger, datasetRoot, emails, dirname(ledgerPath));
  const reviewed = adjudicate(truth, ledger);
  const ledgerSha256 = sha(JSON.stringify(ledger));
  const rows = triageRows(diagnostics.rows, provenance, ledger);
  const count = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
  // Immutable output directory: a subsequent adjudication needs a new version/directory.
  await mkdir(output, { recursive: false });
  async function save(name: string, value: unknown) { await writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
  await save('triage.json', { version: 1, runId: cards.runId, datasetSha256: manifest.datasetSha256, inputHashes, ledgerSha256,
    total: rows.length, primaryCounts: count(rows.map(row => row.primary)), stageCounts: count(rows.flatMap(row => row.stages)),
    limitation: 'Retrospective analysis of reviewed final data; no inference rerun or tuning. Stage counts overlap. Missing exports count as missed targets, not observed field mismatches.', rows });
  await save('reference-overlay.json', { version: 1, datasetSha256: manifest.datasetSha256, truthSha256: manifest.truthSha256, ledgerSha256, accepted: reviewed.accepted, references: reviewed.overlay });
  await save('disputes-frozen.json', ledger);
  for (const path of new Set(ledger.entries.flatMap(entry => entry.evidence.flatMap(span => span.observation ? [span.observation.path] : [])))) {
    const destination = resolve(output, path);
    const within = relative(output, destination);
    if (within.startsWith('..') || isAbsolute(within)) throw new Error('Observation path escapes output');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(resolve(dirname(ledgerPath), path)), { flag: 'wx' });
  }
  await save('optimization-targets.json', { datasetSha256: manifest.datasetSha256, truthSha256: manifest.truthSha256, ledgerSha256,
    excluded: reviewed.excluded, correctedCategories: Object.fromEntries(Object.entries(reviewed.overlay).map(([id, row]) => [id, row.category])),
    reliableDevelopment: manifest.development.map(row => ({ id: row.id, targets: targets.filter(target => !reviewed.excluded[row.id]?.includes(target)) })) });
  await save('scorecards.json', { version: 1, runId: cards.runId, datasetSha256: manifest.datasetSha256,
    official: cards.official, adjudicated: { label: 'Evaluation-only target scores; pending disputes excluded, no inferred corrections.', ledgerSha256,
      accepted: reviewed.accepted, unresolvedByTarget: reviewed.unresolvedByTarget, exactTargets: targetMetrics(reviewed.overlay, submission, reviewed.excluded) }, independent: cards.independent });
  if (sha(await readFile(resolve(datasetRoot, 'ground_truth.json'))) !== manifest.truthSha256) throw new Error('Ground truth changed during triage');
  return { total: rows.length, primaryCounts: count(rows.map(row => row.primary)), unresolvedByTarget: reviewed.unresolvedByTarget, accepted: reviewed.accepted, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { report: { type: 'string' }, dataset: { type: 'string' }, ledger: { type: 'string' }, output: { type: 'string' } }, strict: true });
  if (!values.report || !values.ledger || !values.output) throw new Error('Required: --report <frozen-report> --ledger <ledger.json> --output <new-directory>');
  triageRun(resolve(values.report), resolve(values.dataset ?? 'training_data/sdoc-hackathon-docker/extracted/data_v2'), resolve(values.ledger), resolve(values.output))
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
