# Issue #37: measured full-inbox evaluation

Run on 21 September 2026, Asia/Singapore (20 September 17:26 UTC).
Run ID: `2026-09-20T17-26-51.910Z-47c3f12a`.

The runner classified all 520 official emails through the API's shared case
pipeline, attempted conservative source-only comparisons, rechecked source
claims, exported supported decisions, and invoked the unchanged organizer
scorer. Labels never entered inference. No email was sent. The final
configuration was frozen before this run and not retuned after seeing results.

| Measurement | Observed | Target |
|---|---:|---:|
| Official source IDs accounted for | 520/520 | 520/520 |
| Category macro-F1, including inference failures | 0.979378 | ≥0.85 |
| Category accuracy | 505/520 (97.12%) | — |
| Exact end-to-end defect detection | 0/46 (0%) | ≥80% |
| Review recall | 0/20 (0%) | ≥15/20 |
| Exported rows | 359 | 520 for a valid headline |
| Explicit export failures | 161 | 0 for a valid headline |
| Unsafe match confirmations | 0 | 0 |
| Verified document comparisons | 0 | — |
| Full-inbox processing + export + scorer | 12.578 seconds | measured |
| First completed case | 2.264 seconds | measured |
| Per-case P50 / P95 including queue time | 4.545 / 6.221 seconds | measured |
| Successful official provider requests / attempts | 63 / 64 | bounded |
| Recorded official input / output tokens | 822,294 / 74,073 | measured |

**This is not a successful complete benchmark submission.** There are no
verified document comparisons, so zero false clears is not proof that the
comparator can safely automate the official dataset. The raw organizer score
(0.230045) is diagnostic only: missing rows trigger organizer defaults.
`scorecards.json` has `official.valid: false` and `official.score: null`.
The CLI exits 1 after preserving the artifacts instead of hiding the failure.

## Failure accounting

All 520 IDs appear exactly once in either the submission or export failures:

- 8 `CASE_NOT_CLASSIFIED`: one unsuccessful packed request left eight cases
  unclassified. Failed-call billing is unknown, not assumed zero.
- 15 `UNRESOLVED_NON_COMPARISON`: classifications retain confidence/intent
  blockers and cannot be exported as clean decisions.
- 138 `UNSUPPORTED_UNRESOLVED_STATE`: unresolved comparison or intent states
  cannot be mapped honestly to an organizer row.

Across these failures, 116 cases have the sole blocker
`DOCUMENT_ROLES_UNVERIFIED`. Others have intent/confidence conflicts, an OCR
failure, or an ambiguous attachment pair. The comparator requires explicit
document headings and a verified shipment reference; its current supported
layouts do not cover the official comparisons. No role, value or reason was
inferred from an ID, filename or label to improve the score. Improving these
capabilities requires separate development work; this final run remains frozen.

## Reproducibility and checks

`manifest.json` records input/reference/scorer hashes, the 381/139 grouped split,
the exact implementation profile, and Node 24.19.0, Python 3.12.14 and Tesseract
5.5.3.20260724. The database/cache was cold; provider caching is unknown.
Official usage excludes the independent classification run, which reused 32
existing fixtures and achieved macro-F1 0.966434. It is not a blind independent
document test.

The earlier 381-row development run used an incomplete local OCR environment
and is retained in `runtime/eval/issue37-development-20260921`. After installing
OCR prerequisites, all 315 tests across 43 suites passed, including real
Tesseract fixtures. Root, extension and dashboard type checks and ESLint passed.
Regression tests detect synthetic false clears separately from headline scores.
No classification questions or comparator rules were tuned to final outcomes.

The seven JSON artifacts are accompanied by `artifact-hashes.json`. Raw email
contents, credentials, provider responses and databases are not included here.
Reader profiles and source hashes are in `reader-profiles.json`; per-row targets
and blockers are in `row-diagnostics.json`.

## Running an evaluation

Configure `.env`, Node, Python OCR requirements and Tesseract, then run:

```sh
npm run eval -- --prepare --output runtime/eval/your-new-cycle
npm run eval -- --scope development --output runtime/eval/your-new-cycle
npm run eval -- --scope final --output runtime/eval/your-new-cycle
```

A cycle refuses changed inputs/configuration and repeated final execution.
Preserve historical cycles; creating a new directory does not make previously
inspected final cases an unseen test set. Organizer data was already reviewed.

The evaluation/reporting work for #37 now has a real 520-row measurement.
Defect/review targets and a complete submission remain unmet. #60's final
official/adjudicated/independent scorecards are not completed by this run.
