import { basename, extname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observe, sources } from '../../../../tools/eval/src/ocr-verification.js';
import * as sidecar from './ocr.js';

afterEach(() => vi.restoreAllMocks());

// Source-derived expectations are assertions AFTER recovery, never its inputs.
// Frozen organizer labels are deliberately absent from this test and helper.
const expected = [
  ['READABLE', 'native'], ['PARSE_ERROR', 'ocr_blocked'],
  ['OCR_REQUIRED', 'ocr_recovered'], ['OCR_REQUIRED', 'ocr_recovered'],
  ['OCR_REQUIRED', 'ocr_recovered'], ['OCR_REQUIRED', 'ocr_recovered'],
  ['OCR_REQUIRED', 'ocr_recovered'], ['OCR_REQUIRED', 'ocr_recovered'],
  ['READABLE', 'native'], ['PARSE_ERROR', 'ocr_blocked'],
  ['EMPTY', 'native_blocked'], ['PARSE_ERROR', 'ocr_blocked'],
  ['UNSUPPORTED', 'ocr_blocked'], ['UNSUPPORTED', 'ocr_recovered'],
  ['GARBLED', 'native_partial'],
];

describe('live source-only OCR verification (#43; requires Python and Tesseract)', () => {
  it.each(sources.map((source, index) => ({ ...source, expected: expected[index] })))(
    '$key follows source bytes under neutral and misleading filenames',
    async ({ expected: [nativeStatus, profile], ...source }) => {
      const runner = vi.spyOn(sidecar, 'runOcrSidecar'); // Calls the real engine.
      const observed = await observe(source);
      const { before, ocr, profile: facts } = observed.evidence;
      expect(observed.filenameInvariant).toBe(true);
      expect(before.status).toBe(nativeStatus);
      expect(facts.reader_profile).toBe(profile);
      expect(before.sha256).toBe(observed.sha256);
      for (const [options] of runner.mock.calls) {
        expect(Object.keys(options)).toEqual(['inputPath']);
        expect(basename(options.inputPath)).toBe(`source${extname(source.path)}`);
        expect(options.inputPath).not.toMatch(/email_|unreadable/);
      }
      if (profile === 'native' || nativeStatus === 'EMPTY' || nativeStatus === 'GARBLED') {
        expect(ocr).toBeNull();
        expect(facts.ocr_attempted).toBe(false);
        expect(runner).not.toHaveBeenCalled();
      } else {
        expect(facts.ocr_attempted).toBe(true);
        expect(ocr).not.toBeNull();
        expect(runner).toHaveBeenCalledTimes(2);
      }
      if (profile === 'ocr_recovered') {
        expect(ocr?.ok).toBe(true);
        expect(facts.ocr_unresolved_pages).toEqual([]);
        if (!ocr?.ok) throw new Error('Live OCR did not recover source evidence');
        expect(ocr.input.sha256).toBe(observed.sha256);
        expect(ocr.pages.every(page => page.status === 'ok' && page.words.length > 0)).toBe(true);
        // Each word's text, confidence and in-bounds coordinates have also passed
        // the production OCR evidence schema. No uncertain values are corrected.
        expect(ocr.pages.map(page => page.text).join(' ')).toMatch(/SHIPPING\s+INSTRUCTION|BILL\s*OF\s+LADING/i);
      }
      if (source.key === 'independent_readable_image') {
        if (!ocr?.ok) throw new Error('Independent image must recover');
        const text = ocr.pages.map(page => page.text).join(' ');
        expect(text).toContain('Independent Orchard Exporters');
        expect(text).toContain('Cedar Harbour');
      }
      if (source.key === 'independent_blank_image') {
        expect(ocr?.ok).toBe(true);
        if (!ocr?.ok) throw new Error('Blank image must be processed, not fail to decode');
        expect(ocr.pages[0]).toMatchObject({ status: 'unresolved', text: '', words: [] });
        expect(facts.ocr_unresolved_pages).toEqual([1]);
      }
      if (nativeStatus === 'PARSE_ERROR') {
        expect(ocr).toMatchObject({ ok: false, error: { code: 'ocr_failed' } });
      }
    }, 120_000,
  );
});
