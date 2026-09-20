# Issue #43 verification

[`observations.json`](observations.json) records source paths/hashes, native status,
recovery profile, unresolved pages, confidence, OCR errors and filename invariance.
Full native/OCR evidence is compared in memory, including text and bounding boxes;
only the ephemeral OCR snapshot path is normalized. No raw contents are duplicated
in the report. An empty unresolved-page list on a failed PDF is not recovery:
check `readerProfile` and `ocrError`.

[`official-label-audit.json`](official-label-audit.json) separately compares frozen
case-level unreadable labels with those observations. It links both input artifacts
by hash. 512–514 recover on both SI and BL despite their unreadable labels; 511 and
515 have readable native SIs and corrupt BLs. This is a readability disagreement,
not a corrected benchmark status or proof of a match.

## Reproduce from the repository root

Install the [sidecar dependencies](../../ocr-sidecar/README.md), including Tesseract.
Missing OCR fails the live tests; it does not count as unreadable source evidence.

```powershell
node node_modules/tsx/dist/cli.mjs tools/eval/src/ocr-verification.ts tools/eval/ocr-verification/observations.json
node node_modules/tsx/dist/cli.mjs tools/eval/src/ocr-label-audit.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
```

The first script/tests read attachment bytes only, not inbox text, labels or
corrected references. IDs are evaluation bookkeeping. All 15 inputs are recovered
under neutral and misleading filenames with fixed MIME types; OCR receives only
a neutral, hash-checked snapshot. The second script reads labels after recovery
and verifies source hashes. Neither script changes supplied inputs or ground truth.

Independent fixtures in `apps/api/src/documents/testfixtures/ocr-verification/`:
`a.txt` = zero bytes; `b.pdf` = corrupt PDF; `c.png` = valid blank image;
`d.png` = readable raster text; `e.txt` = garbled bytes. All are used by tests.
To regenerate them with Pillow 12.3.0, run
`python apps/api/src/documents/testfixtures/ocr-verification/generate.py`.
The generator reads no supplied data. The six supplied scans and independent
readable PNG were visually inspected during initial verification.

`ocr-evidence.test.ts` tests six irrecoverable inputs in both SI/BL roles against
the real operational validator and final outbound guard. Even a schema-valid
forged MATCH already queued must fail with zero send attempts. A readable control
passes with a mocked sender. Production validation is unchanged.

Scope: native parsing and local OCR readability only. OCR errors are not corrected;
confidence is not field accuracy. No live vision or OCR-aware match authorization
is tested or added. The existing native-source confirmation validator stays closed
to unverified OCR evidence.

## Integration review, 2026-09-20

The review against current main passed 290 tests across 38 suites, including all
28 new OCR and confirmation tests. Type checking, lint and six Python sidecar
tests passed. No real outbound messages were sent by the verification tests.

A fresh Windows checkout initially broke audit reproduction: automatic CRLF
conversion changed the synthetic corrupt PDF and the hashed observations report.
The repository now preserves fixture bytes and checks JSON reports out with LF.
After the correction, the label audit reproduced exactly, and a fresh
`core.autocrlf=true` checkout preserved both linked hashes. Supplied data and
official labels were not modified. PDF parser warnings on corrupt fixtures are
expected and do not indicate successful recovery.
