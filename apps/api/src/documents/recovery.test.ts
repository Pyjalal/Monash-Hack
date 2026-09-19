import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readAttachmentWithRecovery } from "./recovery.js";
import { runOcrSidecar } from "./ocr.js";

const attachmentsRoot = resolve(
  "training_data/sdoc-hackathon-docker/extracted/data_v2/attachments",
);

describe("OCR recovery", () => {
  it("preserves native readability facts when OCR recovers a scanned PDF", async () => {
    const result = await readAttachmentWithRecovery({
      root: attachmentsRoot,
      relativePath: "email_512_SI.pdf",
    });

    // Preserve the native parser evidence from before OCR.
    expect(result.before.status).toBe("OCR_REQUIRED");
    expect(result.before.text).toBe("");
    expect(result.before.pagesNeedingOcr).toEqual([1]);
    expect(result.before.sha256).toMatch(/^[a-f0-9]{64}$/);

    // OCR evidence must be stored separately from native evidence.
    expect(result.profile.ocr_attempted).toBe(true);
    expect(result.ocr).not.toBeNull();

    if (result.ocr?.ok) {
      expect(result.profile.ocr_ok).toBe(true);
      expect(["ocr_recovered", "ocr_partial"]).toContain(
        result.profile.reader_profile,
      );

      // Successful OCR must not overwrite the original parser facts.
      expect(result.profile.parser_status).toBe("OCR_REQUIRED");
      expect(result.profile.pages_needing_ocr).toEqual([1]);

      // The immutable source hash must remain available.
      expect(result.before.sha256).toMatch(/^[a-f0-9]{64}$/);
    } else {
      // OCR failures must remain explicit rather than silently succeeding.
      expect(result.profile.ocr_ok).toBe(false);
      expect(result.profile.reader_profile).toBe("ocr_blocked");
    }
  });

  it("returns an explicit blocker when the OCR sidecar times out", async () => {
    const result = await runOcrSidecar({
      inputPath: resolve(attachmentsRoot, "email_512_SI.pdf"),
      timeoutMs: 1,
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("ocr_timeout");
      expect(result.error.message).toContain("timeout");
    }
  });

  it("returns an explicit blocker for malformed sidecar output", async () => {
    const result = await runOcrSidecar({
      inputPath: resolve(attachmentsRoot, "email_512_SI.pdf"),
      sidecarPath: "apps/api/src/documents/test-malformed-ocr.py",
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("ocr_malformed_output");
      expect(result.error.message).toContain("malformed JSON");
    }
  });
});