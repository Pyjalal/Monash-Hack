import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOcrBatch, runOcrSidecar, validateOcrResult, type OcrSuccess, type RunOcrOptions } from './ocr.js';

export function success(sha256 = 'a'.repeat(64)): OcrSuccess {
  return {
    ok: true, input: { path: 'source.pdf', type: 'pdf', size_bytes: 10, sha256 },
    engine: { name: 'tesseract', executable: 'tesseract' },
    summary: { pages_processed: 1, pages_with_text: 1, unresolved_pages: [] },
    pages: [{ page: 1, status: 'ok', text: 'Cargo', average_confidence: 90, word_count: 1, width: 100, height: 100,
      words: [{ text: 'Cargo', confidence: 90, bbox: { x: 1, y: 1, width: 20, height: 10 } }] }],
  };
}

let directory: string;
let index = 0;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cargolens-ocr-test-')); });
afterEach(async () => { for (const file of await readdir(directory)) await unlink(join(directory, file)); await rmdir(directory); });
async function request(control: Record<string, unknown>, timeoutMs = 3000): Promise<RunOcrOptions> {
  const inputPath = join(directory, `request-${index++}.json`);
  await writeFile(inputPath, JSON.stringify(control));
  return { inputPath, timeoutMs, pythonExecutable: process.execPath, sidecarPath: fileURLToPath(new URL('./testfixtures/ocr-process.mjs', import.meta.url)) };
}

describe('OCR subprocess boundary', () => {
  it.each([{ ok: true }, { ok: false }, { ...success(), summary: { pages_processed: 2, pages_with_text: 1, unresolved_pages: [] } }])('rejects malformed result contracts', async result => {
    expect(await runOcrSidecar(await request({ result }))).toMatchObject({ ok: false, error: { code: 'ocr_malformed_output' } });
  });
  it('rejects invalid JSON and nonzero exits that claim success', async () => {
    expect(await runOcrSidecar(await request({ raw: '{' }))).toMatchObject({ ok: false, error: { code: 'ocr_malformed_output' } });
    expect(await runOcrSidecar(await request({ result: success(), exitCode: 2 }))).toMatchObject({ ok: false, error: { code: 'ocr_process_error' } });
  });
  it('preserves explicit engine failures and reports missing executables', async () => {
    const failure = { ok: false, error: { code: 'tesseract_missing', message: 'missing' }, pages: [] };
    expect(await runOcrSidecar(await request({ result: failure, exitCode: 1 }))).toEqual(failure);
    expect(await runOcrSidecar({ inputPath: 'source.pdf', pythonExecutable: join(directory, 'no-python.exe') })).toMatchObject({ ok: false, error: { code: 'ocr_spawn_error' } });
  });
  it.each(['stdoutOverflow', 'stderrOverflow'])('bounds %s', async key => {
    expect(await runOcrSidecar(await request({ [key]: true, delay: 1000, result: success() }))).toMatchObject({ ok: false, error: { code: 'ocr_output_limit' } });
  });
  it('kills descendant OCR processes on timeout', async () => {
    const marker = join(directory, 'escaped.txt');
    const started = join(directory, 'started.txt');
    const result = await runOcrSidecar(await request({ childMarker: marker, startedMarker: started, delay: 5000, result: success() }, 900));
    expect(result).toMatchObject({ ok: false, error: { code: 'ocr_timeout' } });
    expect(await readFile(started, 'utf8')).toBe('started');
    await new Promise(resolve => setTimeout(resolve, 1900));
    await expect(readFile(marker)).rejects.toThrow();
  }, 8000);
  it('bounds concurrent direct and batch callers globally and preserves input ordering', async () => {
    const log = join(directory, 'events.jsonl');
    const requests = await Promise.all(Array.from({ length: 6 }, (_, id) => request({ id, log, delay: 150, result: success(String(id).repeat(64)) })));
    const [first, rest] = await Promise.all([runOcrSidecar(requests[0]), runOcrBatch(requests.slice(1), 6)]);
    const results = [first, ...rest];
    expect(results.map(result => result.ok ? result.input.sha256[0] : result.error.code)).toEqual(['0', '1', '2', '3', '4', '5']);
    let active = 0;
    let peak = 0;
    for (const line of (await readFile(log, 'utf8')).trim().split('\n')) { active += JSON.parse(line).event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
  it('rejects inconsistent word evidence and invalid configuration', async () => {
    const result = success(); result.pages[0].words[0].bbox.x = 1000;
    expect(validateOcrResult(result).ok).toBe(false);
    expect(await runOcrSidecar({ inputPath: 'file.pdf', timeoutMs: -1 })).toMatchObject({ ok: false, error: { code: 'ocr_invalid_options' } });
  });
});
