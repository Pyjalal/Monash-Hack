import type { AttachmentReadResult } from "./index.js";
import type { OcrSidecarResult } from "./ocr.js";

export interface ReaderProfile {
  parser_readable: boolean;
  parser_status: AttachmentReadResult["status"];
  parser_readability: AttachmentReadResult["readability"];
  pages_needing_ocr: number[];

  ocr_attempted: boolean;
  ocr_ok: boolean | null;
  ocr_average_confidence: number | null;
  ocr_unresolved_pages: number[];

  reader_profile:
    | "native"
    | "native_partial"
    | "ocr_recovered"
    | "ocr_partial"
    | "ocr_blocked";
}

export interface AttachmentRecoveryResult {
  /**
   * Immutable result produced by the native reader before OCR.
   * OCR recovery must never overwrite this evidence.
   */
  before: AttachmentReadResult;

  /**
   * Sidecar result kept separately from the native parser result.
   */
  ocr: OcrSidecarResult | null;

  /**
   * Summary of what was readable before and after recovery.
   */
  profile: ReaderProfile;
}

import { resolve } from "node:path";
import { readAttachment, type ReadAttachmentOptions } from "./index.js";
import { runOcrSidecar } from "./ocr.js";

export async function readAttachmentWithRecovery(
  options: ReadAttachmentOptions,
): Promise<AttachmentRecoveryResult> {
  // Always run and preserve the native parser first.
  const before = await readAttachment(options);

  const needsOcr =
    before.status === "OCR_REQUIRED" ||
    before.status === "EMPTY" ||
    before.status === "GARBLED";

  if (!needsOcr) {
    return {
      before,
      ocr: null,
      profile: {
        parser_readable: before.status === "READABLE",
        parser_status: before.status,
        parser_readability: before.readability,
        pages_needing_ocr: before.pagesNeedingOcr ?? [],
        ocr_attempted: false,
        ocr_ok: null,
        ocr_average_confidence: null,
        ocr_unresolved_pages: [],
        reader_profile: "native",
      },
    };
  }

  const inputPath = resolve(options.root, options.relativePath);

  const ocr = await runOcrSidecar({
    inputPath,
  });

  if (!ocr.ok) {
    return {
      before,
      ocr,
      profile: {
        parser_readable: before.status === "READABLE",
        parser_status: before.status,
        parser_readability: before.readability,
        pages_needing_ocr: before.pagesNeedingOcr ?? [],
        ocr_attempted: true,
        ocr_ok: false,
        ocr_average_confidence: null,
        ocr_unresolved_pages: before.pagesNeedingOcr ?? [],
        reader_profile: "ocr_blocked",
      },
    };
  }

  const confidences = ocr.pages
    .map((page) => page.average_confidence)
    .filter((confidence): confidence is number => confidence !== null);

  const averageConfidence =
    confidences.length > 0
      ? confidences.reduce((sum, confidence) => sum + confidence, 0) /
        confidences.length
      : null;

  const unresolvedPages = ocr.summary.unresolved_pages;

  const recoveredText = ocr.pages.some(
    (page) => page.status === "ok" && page.text.trim().length > 0,
  );

  const readerProfile =
    unresolvedPages.length === 0 && recoveredText
      ? "ocr_recovered"
      : "ocr_partial";

  return {
    before,
    ocr,
    profile: {
      parser_readable: before.status === "READABLE",
      parser_status: before.status,
      parser_readability: before.readability,
      pages_needing_ocr: before.pagesNeedingOcr ?? [],
      ocr_attempted: true,
      ocr_ok: true,
      ocr_average_confidence: averageConfidence,
      ocr_unresolved_pages: unresolvedPages,
      reader_profile: readerProfile,
    },
  };
}