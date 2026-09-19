import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const confidence = z.number().finite().min(0).max(100).nullable();
const wordSchema = z.object({
  text: z.string().trim().min(1), confidence,
  bbox: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }),
});
const pageSchema = z.object({
  page: z.number().int().min(1).max(20), status: z.enum(['ok', 'unresolved', 'error']),
  text: z.string(), average_confidence: confidence, word_count: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  words: z.array(wordSchema), error: z.string().optional(),
}).superRefine((page, ctx) => {
  if (page.word_count !== page.words.length || page.text !== page.words.map(word => word.text).join(' ')) ctx.addIssue({ code: 'custom', message: 'Text/word evidence is inconsistent.' });
  if ((page.status === 'ok') !== (page.text.trim().length > 0)) ctx.addIssue({ code: 'custom', message: 'Page status disagrees with text.' });
  if (page.status === 'ok' && (!page.width || !page.height)) ctx.addIssue({ code: 'custom', message: 'Readable pages require coordinate dimensions.' });
  if (page.words.some(word => word.bbox.x + word.bbox.width > (page.width ?? 0) || word.bbox.y + word.bbox.height > (page.height ?? 0))) ctx.addIssue({ code: 'custom', message: 'Word box falls outside the rendered page.' });
});
const successSchema = z.object({
  ok: z.literal(true),
  input: z.object({ path: z.string().min(1), type: z.string().min(1), size_bytes: z.number().int().nonnegative().max(25 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  engine: z.object({ name: z.literal('tesseract'), executable: z.string().min(1) }),
  limits: z.object({ dpi: z.number().int().min(72).max(400), max_pages: z.number().int().min(1).max(20), max_file_size_bytes: z.number().int().positive(), max_page_pixels: z.number().int().positive(), page_timeout_seconds: z.number().positive() }).optional(),
  summary: z.object({ pages_processed: z.number().int().min(1).max(20), pages_with_text: z.number().int().nonnegative(), unresolved_pages: z.array(z.number().int().positive()) }),
  pages: z.array(pageSchema).min(1).max(20),
}).superRefine((result, ctx) => {
  const unresolved = result.pages.filter(page => page.status !== 'ok').map(page => page.page);
  if (result.pages.some((page, index) => page.page !== index + 1)
    || result.summary.pages_processed !== result.pages.length
    || result.summary.pages_with_text !== result.pages.length - unresolved.length
    || JSON.stringify(result.summary.unresolved_pages) !== JSON.stringify(unresolved)) {
    ctx.addIssue({ code: 'custom', message: 'Page coverage/summary is inconsistent.' });
  }
});
const failureSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string().min(1), message: z.string().min(1) }), pages: z.array(z.never()).length(0) });
export type OcrWordEvidence = z.infer<typeof wordSchema>;
export type OcrPageResult = z.infer<typeof pageSchema>;
export type OcrSuccess = z.infer<typeof successSchema>;
export type OcrFailure = z.infer<typeof failureSchema>;
export type OcrSidecarResult = OcrSuccess | OcrFailure;

export function ocrFailure(code: string, message: string): OcrFailure {
  return { ok: false, error: { code, message }, pages: [] };
}

export function validateOcrResult(value: unknown): OcrSidecarResult {
  const parsed = z.union([successSchema, failureSchema]).safeParse(value);
  return parsed.success ? parsed.data : ocrFailure('ocr_malformed_output', 'OCR sidecar returned an invalid evidence contract.');
}

export interface RunOcrOptions {
  inputPath: string;
  pythonExecutable?: string;
  sidecarPath?: string;
  timeoutMs?: number;
}

const DEFAULT_SIDECAR = fileURLToPath(new URL('../../../../tools/ocr-sidecar/ocr.py', import.meta.url));
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_WORKERS = 2;
const MAX_QUEUED = 128;
let activeWorkers = 0;
const waiting: Array<() => void> = [];

async function acquire(timeoutMs: number): Promise<boolean> {
  if (activeWorkers < MAX_WORKERS) { activeWorkers += 1; return true; }
  return new Promise(resolve => {
    const grant = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { const index = waiting.indexOf(grant); if (index >= 0) waiting.splice(index, 1); resolve(false); }, timeoutMs);
    waiting.push(grant);
  });
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else activeWorkers -= 1;
}

function execute(options: RunOcrOptions, timeoutMs: number): Promise<OcrSidecarResult> {
  return new Promise(resolve => {
    const child = spawn(options.pythonExecutable ?? 'python', [options.sidecarPath ?? DEFAULT_SIDECAR, options.inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedFailure: OcrFailure | undefined;
    const finish = (result: OcrSidecarResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (failure: OcrFailure) => {
      if (settled || forcedFailure) return;
      forcedFailure = failure;
      if (!child.pid) { finish(failure); return; }
      // Kill the OCR process tree, including Tesseract, before releasing its worker slot.
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('close', code => { if (code !== 0) child.kill('SIGKILL'); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop(ocrFailure('ocr_timeout', `OCR sidecar exceeded ${timeoutMs} ms timeout.`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) stop(ocrFailure('ocr_output_limit', 'OCR stdout exceeded the 8 MiB limit.'));
      else if (!forcedFailure) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) stop(ocrFailure('ocr_output_limit', 'OCR stderr exceeded the 64 KiB limit.'));
      else if (!forcedFailure) stderr += chunk;
    });
    child.on('error', error => finish(forcedFailure ?? ocrFailure('ocr_spawn_error', error.message)));
    child.on('close', (code, signal) => {
      if (forcedFailure) { finish(forcedFailure); return; }
      if (!stdout.trim()) { finish(ocrFailure('ocr_empty_output', stderr.trim() || `OCR process exited ${code ?? signal} without JSON.`)); return; }
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { finish(ocrFailure('ocr_malformed_output', 'OCR sidecar returned malformed JSON.')); return; }
      const result = validateOcrResult(value);
      if (result.ok && (code !== 0 || signal !== null)) { finish(ocrFailure('ocr_process_error', `OCR process exited ${code ?? signal} despite claiming success.`)); return; }
      finish(result);
    });
  });
}

export async function runOcrSidecar(options: RunOcrOptions): Promise<OcrSidecarResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!options.inputPath || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return ocrFailure('ocr_invalid_options', 'OCR requires an input path and timeout between 1 and 120000 ms.');
  if (waiting.length >= MAX_QUEUED) return ocrFailure('ocr_queue_full', 'OCR queue is full.');
  if (!await acquire(timeoutMs)) return ocrFailure('ocr_queue_timeout', 'OCR queue wait exceeded its timeout.');
  try { return await execute(options, timeoutMs); }
  catch (error) { return ocrFailure('ocr_spawn_error', error instanceof Error ? error.message : 'OCR process could not start.'); }
  finally { release(); }
}

export async function runOcrBatch(requests: RunOcrOptions[], maxConcurrency = MAX_WORKERS): Promise<OcrSidecarResult[]> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('maxConcurrency must be a positive integer.');
  const results = new Array<OcrSidecarResult>(requests.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < requests.length) { const index = nextIndex++; results[index] = await runOcrSidecar(requests[index]); }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, MAX_WORKERS, requests.length) }, worker));
  return results;
}
