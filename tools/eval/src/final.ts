/** Publish frozen results without repeating inference or tuning final errors. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { parseArgs, promisify, isDeepStrictEqual } from 'node:util';
import { triageRun } from './triage.js';
import { DOCUMENT_CASES, evaluateDocuments } from './independent-documents.js';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export async function publishFinal(report: string, dataset: string, ledger: string, output: string, python: string) {
  const hashes = await read(resolve(report, 'artifact-hashes.json'));
  for (const [name, digest] of Object.entries(hashes)) {
    if (sha(await readFile(resolve(report, name))) !== digest) throw new Error(`Frozen artifact changed: ${name}`);
  }
  const original = await read(resolve(report, 'scorecards.json'));
  const manifest = await read(resolve(report, 'manifest.json'));
  if (original.scope !== 'final' || original.mode !== 'live' || original.sourceCount !== 520 || original.evaluatedCount !== 520) throw new Error('Requires a measured 520-row final run');
  if (sha(JSON.stringify(original.config)) !== original.profileSha256 || original.profileSha256 !== manifest.profileSha256) throw new Error('Profile hash mismatch');
  const componentPaths = Object.keys(manifest.config.implementations).filter(path =>
    path.startsWith('apps/') || path.startsWith('packages/') || path === 'package-lock.json' || path === 'tools/eval/src/export.ts');
  const componentImplementationHashes = Object.fromEntries(await Promise.all(componentPaths.map(async path => [path, sha(await readFile(path))])));
  for (const [name, digest] of Object.entries(manifest.scorerHashes)) {
    if (sha(await readFile(resolve(dataset, '../server', name))) !== digest) throw new Error(`Organizer scorer changed: ${name}`);
  }
  await mkdir(output, { recursive: false });
  await save(resolve(output, 'freeze.json'), { version: 1, originalRunId: original.runId, profileSha256: original.profileSha256,
    config: original.config, datasetSha256: original.datasetSha256, inputArtifactHashes: hashes,
    officialImplementationHashes: manifest.config.implementations,
    componentImplementationHashes,
    fixtureSha256: sha(JSON.stringify(DOCUMENT_CASES)), fixtures: DOCUMENT_CASES,
    evaluatorHashes: Object.fromEntries(await Promise.all(['final.ts', 'independent-documents.ts', 'triage.ts', 'disputes.ts'].map(async name => [name, sha(await readFile(resolve('tools/eval/src', name)))]))),
    policy: 'Preserve final outcomes; no model calls or product retuning. New component fixtures are implementation-informed and not a blind holdout.' });
  await triageRun(report, dataset, ledger, resolve(output, 'adjudication'));
  const adjudication = await read(resolve(output, 'adjudication/scorecards.json'));
  let scorer = null; let scorerError: string | null = null;
  try {
    const result = await promisify(execFile)(python, [resolve(dataset, '../server/score_cli.py'), resolve(report, 'submission.json'), '--ground-truth', resolve(dataset, 'ground_truth.json'), '--json'],
      { timeout: 60000, windowsHide: true, maxBuffer: 2_000_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    scorer = JSON.parse(result.stdout);
    if (!isDeepStrictEqual(scorer, await read(resolve(report, 'organizer-scorer.json')))) throw new Error('Scorer replay differs from frozen result');
  } catch (error) { scorerError = error instanceof Error ? error.message : 'ORGANIZER_SCORER_FAILED'; }
  await save(resolve(output, 'organizer-replay.json'), { scorer, scorerError });
  const independent = await evaluateDocuments(resolve(output, 'independent-sources'));
  const complete = original.exportedCount === 520 && original.failures.length === 0 && !scorerError;
  const cards = { version: 1, originalRunId: original.runId, profileSha256: original.profileSha256, datasetSha256: original.datasetSha256,
    accounting: { total: 520, exported: original.exportedCount, failures: original.failures },
    official: { ...original.official, valid: complete, score: complete ? scorer : null, scorerReplayError: scorerError },
    adjudicated: adjudication.adjudicated,
    independent: { documents: independent, reusedClassification: original.independent },
    reliability: { endToEndDefects: original.diagnostics.endToEndDefects, reviewRecall: original.diagnostics.reviewRecall },
    operational: original.operational, performance: original.performance,
    limitations: ['Official headline is invalid when any export is missing; organizer defaults are diagnostic only.', 'No accepted corrections are invented; proposed disputes exclude individual targets only.', 'Zero false clears with limited automation is not proof of general safety.', 'Training/reused or implementation-informed fixture performance does not establish 100% generalization.', 'No live send or reply-driven automation measured.'] };
  await save(resolve(output, 'scorecards.json'), cards);
  const artifacts: Record<string, string> = {};
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else artifacts[relative(output, path).replaceAll('\\', '/')] = sha(await readFile(path));
    }
  }
  await collect(output); await save(resolve(output, 'artifact-hashes.json'), artifacts);
  return { output, officialValid: complete, scorerError, independent: { count: independent.count, exactTargets: independent.exactTargets, operationalStatusReasonChecks: independent.operationalStatusReasonChecks, falseClears: independent.falseClears, automationCoverage: independent.automationCoverage } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { report: { type: 'string', default: 'tools/eval/reports/issue37-20260921' }, dataset: { type: 'string', default: 'training_data/sdoc-hackathon-docker/extracted/data_v2' }, ledger: { type: 'string', default: 'tools/eval/disputes/issue39-v1/ledger.json' }, output: { type: 'string' }, python: { type: 'string', default: 'python' } }, strict: true });
  if (!values.output) throw new Error('Required: --output <new-directory>');
  publishFinal(resolve(values.report!), resolve(values.dataset!), resolve(values.ledger!), resolve(values.output), values.python!)
    .then(result => { console.log(JSON.stringify(result, null, 2)); if (result.scorerError) process.exitCode = 1; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
