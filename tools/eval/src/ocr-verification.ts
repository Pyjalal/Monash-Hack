/** Source-only evaluation. No inbox text, labels or corrected references are read. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readAttachmentWithRecovery, type AttachmentRecoveryResult } from '../../../apps/api/src/documents/recovery.js';

const suppliedRoot = 'training_data/sdoc-hackathon-docker/extracted/data_v2/attachments';
const independentRoot = 'apps/api/src/documents/testfixtures/ocr-verification';

// IDs and roles are evaluation bookkeeping only. They are joined after recovery.
export const sources = [511, 512, 513, 514, 515].flatMap(number => ['SI', 'BL'].map(role => ({
  key: `email_${number}_${role}`,
  path: `${suppliedRoot}/email_${number}_${role}.${role === 'SI' && [511, 515].includes(number) ? 'txt' : 'pdf'}`,
}))).concat([
  { key: 'independent_empty', path: `${independentRoot}/a.txt` },
  { key: 'independent_corrupt', path: `${independentRoot}/b.pdf` },
  { key: 'independent_blank_image', path: `${independentRoot}/c.png` },
  { key: 'independent_readable_image', path: `${independentRoot}/d.png` },
  { key: 'independent_garbled', path: `${independentRoot}/e.txt` },
]);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Remove only the ephemeral snapshot path; preserve all text/boxes/confidence. */
function stableEvidence(result: AttachmentRecoveryResult): AttachmentRecoveryResult {
  return result.ocr?.ok
    ? { ...result, ocr: { ...result.ocr, input: { ...result.ocr.input, path: `source.${result.ocr.input.type}` } } }
    : result;
}

/** Only source bytes and format enter recovery. No expected outcome argument. */
async function recoverBytes(bytes: Buffer, extension: string, name = `source${extension}`): Promise<AttachmentRecoveryResult> {
  const mimeType = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.png': 'image/png' }[extension];
  if (!mimeType) throw new Error(`Unsupported evaluation format: ${extension}`);
  const directory = await mkdtemp(join(tmpdir(), 'cargolens-source-eval-'));
  const path = join(directory, name);
  try {
    await writeFile(path, bytes);
    return stableEvidence(await readAttachmentWithRecovery({ root: directory, relativePath: name, mimeType }));
  } finally {
    await unlink(path).catch(() => undefined);
    await rmdir(directory);
  }
}

export async function observe(source: typeof sources[number]) {
  const bytes = await readFile(source.path);
  const hash = sha256(bytes);
  const extension = extname(source.path);
  const evidence = await recoverBytes(bytes, extension);
  // Deliberately misleading basename and extension; explicit MIME stays constant.
  // All fixtures use the same alternate name, unrelated to their true identity.
  const renamed = await recoverBytes(bytes, extension, 'email_511_BL_unreadable.bin');
  if (!isDeepStrictEqual(evidence, renamed)) throw new Error(`Filename changed recovery: ${source.key}`);
  if (sha256(await readFile(source.path)) !== hash) throw new Error('Source changed during evaluation');
  if (evidence.before.sha256 !== hash) throw new Error('Native evidence hash mismatch');
  if (evidence.ocr?.ok && evidence.ocr.input.sha256 !== hash) throw new Error('OCR evidence hash mismatch');
  // Missing engines must not masquerade as irrecoverable source evidence.
  if (evidence.ocr && !evidence.ocr.ok && ['ocr_spawn_error', 'tesseract_missing', 'ocr_empty_output', 'ocr_timeout'].includes(evidence.ocr.error.code)) {
    throw new Error(`OCR environment failure: ${evidence.ocr.error.code}`);
  }
  return { key: source.key, source: source.path, sha256: hash,
    filenameInvariant: true, evidence };
}

// Full evidence is compared/tested in memory, not duplicated in the artifact.
function summarize({ evidence, ...source }: Awaited<ReturnType<typeof observe>>) {
  return { ...source, nativeStatus: evidence.before.status,
    readerProfile: evidence.profile.reader_profile,
    unresolvedPages: evidence.profile.ocr_unresolved_pages,
    averageConfidence: evidence.profile.ocr_average_confidence,
    ocrError: evidence.ocr && !evidence.ocr.ok ? evidence.ocr.error.code : null };
}

export type SourceObservation = ReturnType<typeof summarize>;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: tsx tools/eval/src/ocr-verification.ts <observations.json>');
  const observations: SourceObservation[] = [];
  for (const source of sources) observations.push(summarize(await observe(source)));
  await writeFile(output, JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(),
    scope: 'Source readability only; no field comparison, vision call, or outbound authorization.',
    observations }, null, 2) + '\n');
}
