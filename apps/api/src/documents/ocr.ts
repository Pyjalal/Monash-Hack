import { spawn } from "node:child_process";

export interface OcrWordEvidence {
  text: string;
  confidence: number | null;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface OcrPageResult {
  page: number;
  status: "ok" | "unresolved" | "error";
  text: string;
  average_confidence: number | null;
  word_count: number;
  words: OcrWordEvidence[];
  error?: string;
}

export interface OcrSuccess {
  ok: true;
  input: {
    path: string;
    type: string;
    size_bytes: number;
  };
  engine: {
    name: string;
    executable: string;
  };
  summary: {
    pages_processed: number;
    pages_with_text: number;
    unresolved_pages: number[];
  };
  pages: OcrPageResult[];
}

export interface OcrFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
  pages: [];
}

export type OcrSidecarResult = OcrSuccess | OcrFailure;

export interface RunOcrOptions {
  inputPath: string;
  pythonExecutable?: string;
  sidecarPath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runOcrSidecar(
  options: RunOcrOptions,
): Promise<OcrSidecarResult> {
  const pythonExecutable = options.pythonExecutable ?? "python";
  const sidecarPath = options.sidecarPath ?? "tools/ocr-sidecar/ocr.py";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(
      pythonExecutable,
      [sidecarPath, options.inputPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: OcrSidecarResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();

      finish({
        ok: false,
        error: {
          code: "ocr_timeout",
          message: `OCR sidecar exceeded ${timeoutMs} ms timeout.`,
        },
        pages: [],
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        error: {
          code: "ocr_spawn_error",
          message: error.message,
        },
        pages: [],
      });
    });

    child.on("close", (exitCode) => {
      if (settled) return;

      if (!stdout.trim()) {
        finish({
          ok: false,
          error: {
            code: "ocr_empty_output",
            message:
              stderr.trim() ||
              `OCR sidecar exited with code ${exitCode ?? "unknown"} without JSON output.`,
          },
          pages: [],
        });
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish({
          ok: false,
          error: {
            code: "ocr_malformed_output",
            message: "OCR sidecar returned malformed JSON.",
          },
          pages: [],
        });
        return;
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("ok" in parsed) ||
        typeof parsed.ok !== "boolean"
      ) {
        finish({
          ok: false,
          error: {
            code: "ocr_malformed_output",
            message: "OCR sidecar returned JSON with an invalid result shape.",
          },
          pages: [],
        });
        return;
      }

      finish(parsed as OcrSidecarResult);
    });
  });
}

export async function runOcrBatch(
  requests: RunOcrOptions[],
  maxConcurrency = 2,
): Promise<OcrSidecarResult[]> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("maxConcurrency must be a positive integer.");
  }

  const results = new Array<OcrSidecarResult>(requests.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= requests.length) return;

      results[index] = await runOcrSidecar(requests[index]);
    }
  }

  const workerCount = Math.min(maxConcurrency, requests.length);

  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return results;
}