import { createHash } from 'node:crypto';
import { mkdtemp, open, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readAttachment, type AttachmentReadResult, type ReadAttachmentOptions } from './index.js';
import { ocrFailure, runOcrSidecar, validateOcrResult, type OcrSidecarResult, type RunOcrOptions } from './ocr.js';
import { assessReadability } from './readability.js';

export interface ReaderProfile {
  parser_readable: boolean;
  parser_status: AttachmentReadResult['status'];
  parser_readability: AttachmentReadResult['readability'];
  pages_needing_ocr: number[];
  ocr_attempted: boolean;
  ocr_ok: boolean | null;
  ocr_average_confidence: number | null;
  ocr_unresolved_pages: number[];
  reader_profile: 'native' | 'native_partial' | 'native_blocked' | 'ocr_recovered' | 'ocr_partial' | 'ocr_blocked';
}

export interface AttachmentRecoveryResult {
  /** Native parser evidence is retained unchanged and independently reproducible. */
  before: AttachmentReadResult;
  ocr: OcrSidecarResult | null;
  profile: ReaderProfile;
}

export interface RecoveryOptions extends Omit<RunOcrOptions, 'inputPath'> {
  enabled?: boolean;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);
const MIME_EXTENSIONS: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/tiff': '.tiff', 'image/bmp': '.bmp', 'image/webp': '.webp' };
const MAX_BYTES = 20 * 1024 * 1024;

async function recoverSnapshot(options: ReadAttachmentOptions, before: AttachmentReadResult, recovery: RecoveryOptions, extension: string): Promise<OcrSidecarResult> {
  let snapshot: string | undefined;
  let directory: string | undefined;
  try {
    const root = await realpath(options.root);
    const input = await realpath(resolve(root, options.relativePath));
    const relativeInput = relative(root, input);
    if (relativeInput === '..' || relativeInput.startsWith(`..${sep}`) || isAbsolute(relativeInput)) return ocrFailure('ocr_invalid_path', 'Source path is no longer inside the attachment root.');
    const handle = await open(input, 'r');
    let bytes: Buffer;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_BYTES) return ocrFailure('ocr_source_changed', 'Source file changed or exceeds the reader limit.');
      const buffer = Buffer.alloc(Math.min(metadata.size + 1, MAX_BYTES + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      bytes = buffer.subarray(0, offset);
    } finally { await handle.close(); }
    if (bytes.length > MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== before.sha256) return ocrFailure('ocr_source_changed', 'Source bytes changed after the native reader ran.');
    directory = await mkdtemp(join(tmpdir(), 'cargolens-ocr-'));
    snapshot = join(directory, `source${extension}`);
    await writeFile(snapshot, bytes, { mode: 0o600 });
    const ocr = validateOcrResult(await runOcrSidecar({ ...recovery, inputPath: snapshot }));
    if (ocr.ok && ocr.input.sha256 !== before.sha256) return ocrFailure('ocr_source_mismatch', 'OCR evidence does not match the native source hash.');
    const expectedPages = Math.max(0, ...(before.pagesNeedingOcr ?? []), ...before.spans.filter(span => span.kind === 'page').map(span => span.kind === 'page' ? span.page : 0));
    if (ocr.ok && ocr.pages.length < expectedPages) return ocrFailure('ocr_incomplete_output', 'OCR omitted pages present in the native evidence.');
    return ocr;
  } catch {
    return ocrFailure('ocr_source_unavailable', 'Could not preserve a confined source snapshot for OCR.');
  } finally {
    if (snapshot) await unlink(snapshot).catch(() => undefined);
    if (directory) await rmdir(directory).catch(() => undefined);
  }
}

export async function readAttachmentWithRecovery(options: ReadAttachmentOptions, recovery: RecoveryOptions = {}): Promise<AttachmentRecoveryResult> {
  const before = await readAttachment(options);
  const mime = options.mimeType?.split(';', 1)[0].trim().toLowerCase() ?? '';
  const extension = MIME_EXTENSIONS[mime] ?? extname(options.relativePath).toLowerCase();
  const supported = extension === '.pdf' || IMAGE_EXTENSIONS.has(extension);
  const eligible = supported && !!before.sha256 && ['OCR_REQUIRED', 'EMPTY', 'GARBLED', 'PARSE_ERROR', 'UNSUPPORTED'].includes(before.status);
  const profile: ReaderProfile = {
    parser_readable: before.status === 'READABLE', parser_status: before.status,
    parser_readability: before.readability, pages_needing_ocr: [...(before.pagesNeedingOcr ?? [])],
    ocr_attempted: false, ocr_ok: null, ocr_average_confidence: null, ocr_unresolved_pages: [],
    reader_profile: before.status === 'READABLE' ? 'native' : before.text.trim() ? 'native_partial' : 'native_blocked',
  };
  if (recovery.enabled === false || !eligible) return { before, ocr: null, profile };
  const ocr = await recoverSnapshot(options, before, recovery, extension);
  profile.ocr_attempted = true;
  profile.ocr_ok = ocr.ok;
  if (!ocr.ok) {
    profile.ocr_unresolved_pages = [...(before.pagesNeedingOcr ?? [])];
    profile.reader_profile = 'ocr_blocked';
  } else {
    const readable = ocr.pages.filter(page => page.status === 'ok' && assessReadability(page.text).status === 'READABLE');
    profile.ocr_unresolved_pages = ocr.pages.filter(page => !readable.includes(page)).map(page => page.page);
    const confidences = readable.map(page => page.average_confidence).filter((value): value is number => value !== null);
    profile.ocr_average_confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null;
    profile.reader_profile = !readable.length ? 'ocr_blocked' : profile.ocr_unresolved_pages.length ? 'ocr_partial' : 'ocr_recovered';
  }
  return { before, ocr, profile };
}
