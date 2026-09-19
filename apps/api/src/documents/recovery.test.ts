import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as native from './index.js';
import * as sidecar from './ocr.js';
import { readAttachmentWithRecovery } from './recovery.js';

const attachmentsRoot = resolve('training_data/sdoc-hackathon-docker/extracted/data_v2/attachments');
const scan = { root: attachmentsRoot, relativePath: 'email_512_SI.pdf' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cargolens-recovery-test-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const file of await readdir(directory)) await unlink(join(directory, file));
  await rmdir(directory);
});

function recognized(bytes: Buffer): sidecar.OcrSuccess {
  return {
    ok: true, input: { path: 'snapshot', type: 'pdf', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    engine: { name: 'tesseract', executable: 'test-engine' },
    summary: { pages_processed: 1, pages_with_text: 1, unresolved_pages: [] },
    pages: [{ page: 1, status: 'ok', text: 'Shipping Instructions', average_confidence: 90, word_count: 2, width: 200, height: 100,
      words: [{ text: 'Shipping', confidence: 90, bbox: { x: 0, y: 0, width: 60, height: 20 } }, { text: 'Instructions', confidence: 90, bbox: { x: 61, y: 0, width: 90, height: 20 } }] }],
  };
}

describe('OCR recovery facts', () => {
  it('preserves before evidence, uses a source snapshot and removes it afterwards', async () => {
    const baseline = await native.readAttachment(scan);
    let snapshot = '';
    vi.spyOn(sidecar, 'runOcrSidecar').mockImplementation(async options => { snapshot = options.inputPath; return recognized(await readFile(snapshot)); });
    const result = await readAttachmentWithRecovery(scan);
    expect(result.before).toEqual(baseline);
    expect(result.before.status).toBe('OCR_REQUIRED');
    expect(result.before.text).toBe('');
    expect(result.profile).toMatchObject({ parser_readable: false, parser_status: 'OCR_REQUIRED', pages_needing_ocr: [1], ocr_attempted: true, ocr_ok: true, reader_profile: 'ocr_recovered' });
    expect(result.ocr?.ok && result.ocr.input.sha256).toBe(baseline.sha256);
    expect(snapshot).not.toBe(resolve(scan.root, scan.relativePath));
    await expect(readFile(snapshot)).rejects.toThrow();
  });
  it('provides an explicit native-only baseline without starting OCR', async () => {
    const runner = vi.spyOn(sidecar, 'runOcrSidecar');
    const baseline = await native.readAttachment(scan);
    const result = await readAttachmentWithRecovery(scan, { enabled: false });
    expect(result.before).toEqual(baseline);
    expect(result.ocr).toBeNull();
    expect(result.profile).toMatchObject({ ocr_attempted: false, reader_profile: 'native_blocked' });
    expect(runner).not.toHaveBeenCalled();
  });
  it('routes image attachments to OCR and keeps their native unsupported result', async () => {
    await writeFile(join(directory, 'scan.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    vi.spyOn(sidecar, 'runOcrSidecar').mockImplementation(async options => recognized(await readFile(options.inputPath)));
    const result = await readAttachmentWithRecovery({ root: directory, relativePath: 'scan.png' });
    expect(result.before.status).toBe('UNSUPPORTED');
    expect(result.profile.reader_profile).toBe('ocr_recovered');
  });
  it('uses the declared MIME type for attachments without a PDF extension', async () => {
    await writeFile(join(directory, 'attachment.bin'), await readFile(resolve(scan.root, scan.relativePath)));
    vi.spyOn(sidecar, 'runOcrSidecar').mockImplementation(async options => {
      expect(options.inputPath.endsWith('.pdf')).toBe(true);
      return recognized(await readFile(options.inputPath));
    });
    const result = await readAttachmentWithRecovery({ root: directory, relativePath: 'attachment.bin', mimeType: 'application/pdf' });
    expect(result.profile.reader_profile).toBe('ocr_recovered');
  });
  it.each(['ocr_timeout', 'ocr_malformed_output', 'tesseract_missing'])('retains an explicit %s blocker', async code => {
    vi.spyOn(sidecar, 'runOcrSidecar').mockResolvedValue(sidecar.ocrFailure(code, 'fixture failure'));
    const result = await readAttachmentWithRecovery(scan);
    expect(result.profile.reader_profile).toBe('ocr_blocked');
    expect(result.ocr).toMatchObject({ ok: false, error: { code } });
    expect(result.before.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects wrong-source evidence instead of reporting recovery', async () => {
    vi.spyOn(sidecar, 'runOcrSidecar').mockResolvedValue(recognized(Buffer.from('different source')));
    expect((await readAttachmentWithRecovery(scan)).ocr).toMatchObject({ ok: false, error: { code: 'ocr_source_mismatch' } });
  });
  it('blocks source changes between native parsing and snapshot creation', async () => {
    const input = join(directory, 'scan.png');
    await writeFile(input, 'original');
    const originalReader = native.readAttachment;
    vi.spyOn(native, 'readAttachment').mockImplementation(async options => {
      const result = await originalReader(options);
      await writeFile(input, 'replacement');
      return result;
    });
    const runner = vi.spyOn(sidecar, 'runOcrSidecar');
    expect((await readAttachmentWithRecovery({ root: directory, relativePath: 'scan.png' })).ocr).toMatchObject({ ok: false, error: { code: 'ocr_source_changed' } });
    expect(runner).not.toHaveBeenCalled();
  });
  it('does not treat blank OCR output as recovered evidence', async () => {
    vi.spyOn(sidecar, 'runOcrSidecar').mockImplementation(async options => {
      const result = recognized(await readFile(options.inputPath));
      result.pages = [{ page: 1, status: 'unresolved', text: '', average_confidence: null, word_count: 0, words: [] }];
      result.summary = { pages_processed: 1, pages_with_text: 0, unresolved_pages: [1] };
      return result;
    });
    expect((await readAttachmentWithRecovery(scan)).profile).toMatchObject({ ocr_ok: true, reader_profile: 'ocr_blocked', ocr_unresolved_pages: [1] });
  });
  it('preserves unresolved pages in partial OCR and rejects omitted pages', async () => {
    const originalReader = native.readAttachment;
    vi.spyOn(native, 'readAttachment').mockImplementation(async options => ({ ...await originalReader(options), pagesNeedingOcr: [1, 2] }));
    const runner = vi.spyOn(sidecar, 'runOcrSidecar').mockImplementation(async options => recognized(await readFile(options.inputPath)));
    expect((await readAttachmentWithRecovery(scan)).ocr).toMatchObject({ ok: false, error: { code: 'ocr_incomplete_output' } });
    runner.mockImplementation(async options => {
      const result = recognized(await readFile(options.inputPath));
      result.pages.push({ page: 2, status: 'error', text: '', average_confidence: null, word_count: 0, words: [], error: 'unreadable page' });
      result.summary = { pages_processed: 2, pages_with_text: 1, unresolved_pages: [2] };
      return result;
    });
    expect((await readAttachmentWithRecovery(scan)).profile).toMatchObject({ reader_profile: 'ocr_partial', ocr_unresolved_pages: [2], pages_needing_ocr: [1, 2] });
  });
  it('never sends out-of-root attachments to OCR', async () => {
    const runner = vi.spyOn(sidecar, 'runOcrSidecar');
    const result = await readAttachmentWithRecovery({ root: directory, relativePath: '../private.png' });
    expect(result.before.status).toBe('INVALID_PATH');
    expect(result.profile.reader_profile).toBe('native_blocked');
    expect(runner).not.toHaveBeenCalled();
  });
});
