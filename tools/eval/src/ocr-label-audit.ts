/** Evaluation-only second phase: never imported by runtime or recovery tests. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { SubmissionRowSchema } from '@cargolens/shared';
import type { SourceObservation } from './ocr-verification.js';

const outputRoot = 'tools/eval/ocr-verification';
const observationsPath = `${outputRoot}/observations.json`;
const labelsPath = 'training_data/sdoc-hackathon-docker/extracted/data_v2/ground_truth.json';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Read the completed, source-only artifact before opening any answer keys.
const observedBytes = await readFile(observationsPath);
const report = JSON.parse(observedBytes.toString('utf8')) as { observations: SourceObservation[] };
for (const observation of report.observations) {
  if (digest(await readFile(observation.source)) !== observation.sha256) throw new Error(`Source hash changed: ${observation.key}`);
}
const labelBytes = await readFile(labelsPath);
const labels = JSON.parse(labelBytes.toString('utf8')) as Record<string, unknown>;
const cases = [511, 512, 513, 514, 515].map(number => {
  const id = `email_${number}`;
  const official = SubmissionRowSchema.parse(labels[id]);
  const sourceOutcomes = ['SI', 'BL'].map(role => {
    const found = report.observations.filter(row => row.key === `${id}_${role}`);
    if (found.length !== 1) throw new Error(`Expected exactly one observation for ${id}_${role}`);
    return found[0];
  });
  const bothReadable = sourceOutcomes.every(row => ['native', 'ocr_recovered'].includes(row.readerProfile));
  return { id, official: { status: official.status, review_reason: official.review_reason },
    observationKeys: sourceOutcomes.map(row => row.key),
    readabilityDisagreement: official.review_reason === 'unreadable' && bothReadable };
});
if (!labelBytes.equals(await readFile(labelsPath))) throw new Error('Ground truth changed during audit');
await writeFile(`${outputRoot}/official-label-audit.json`, JSON.stringify({
  schemaVersion: 2, scope: 'Evaluation-only disagreement with the unreadable reason; no corrected status or match authorization.',
  observations: { path: observationsPath, sha256: digest(observedBytes) },
  officialLabels: { path: labelsPath, sha256: digest(labelBytes), unchanged: true }, cases,
}, null, 2) + '\n');
