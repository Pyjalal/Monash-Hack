# Issue #60: final official, adjudicated and independent scorecards

Published 21 September 2026 from frozen live run
`2026-09-20T17-26-51.910Z-47c3f12a`. The chosen profile is
`93355c33d331571f12e11d44d1c78d0e4bbc4ff2c61ecd833e3f175d5160ba86`.
No classifier or comparator was retuned, no official inference was repeated,
and no official source or label was edited. The unchanged organizer scorer was
executed again against the frozen submission and exactly reproduced its result.

## Official headline and reliability

| Measurement | Result |
|---|---:|
| Official rows accounted for | 520/520 |
| Exported / explicit failures | 359 / 161 |
| Valid official headline | **Unavailable** |
| Raw organizer diagnostic score | 0.230045 |
| Classifier macro-F1 (before export) | 0.979378 |
| End-to-end defects caught | 0/46 |
| Review recall | 0/20 |

The raw score includes organizer defaults for absent rows and must not be used
as a headline. `scorecards.json` preserves `official.valid: false` and
`official.score: null`. All 161 failure IDs and codes are explicit. Classifier
accuracy is not submission accuracy. The original 381/139 grouped partition
remains frozen; the final data was previously reviewed and is not blind.

## Adjudicated references

There are **zero accepted corrections** and three pending reason disputes.
The source-validated ledger excludes only those three `review_reason` targets.
Exact reason accuracy is 359/517; each other exported target is 359/520.
This denominator change is not a product improvement. Human disposition is
still pending; neither model disagreement nor OCR recovery invents acceptance.
The ledger, evidence, overlay and exact target scores are in `adjudication/`.

## Independent grouped document challenge

Twelve new agent-authored native-text cases form two shipment groups, each
containing a match, weight mismatch, missing value, missing document, wrong
document and wrong shipment. Fixture text and expectations were frozen before
execution. No organizer examples were copied. The author inspected the
implementation, so this is an implementation-informed challenge, not an unseen
or statistically representative generalization test.

| Measurement | Result |
|---|---:|
| Exact operational workflow and blocker-set checks | 12/12 |
| Exact exported status | 6/12 |
| Exact exported review reason | 6/12 |
| Explicit independent export failures | 6/12 |
| False match confirmations | 0/12 |
| Proof-validated confirmation/amendment decisions | 4/12 (33.33%) |
| Messages sent | 0 |

Both matches, both weight mismatches and both missing-value reviews exported.
Missing-document, wrong-document and wrong-shipment cases blocked safely but
could not be projected by the frozen exporter. These six failures remain misses.
Wrong-shipment fixtures use the challenge's `wrong_doc_type` reference convention;
their actual product reason is recorded as `SHIPMENT_REFERENCE_UNVERIFIED`.
No product change was made to improve these results.

The real comparator, native reader, proof validator and exporter were used;
comparison intent was supplied at the component boundary. No model, OCR engine,
Gmail send, reply resumption or network delivery was tested in this challenge.
The historical 32-case reused classifier scorecard is retained separately.
Passing 12 operational checks does not establish 100% generalization.

## Operational safety and reproducibility

On the official run there were zero unsafe clears and zero verified document
comparisons. State-based automation coverage was 284/520 (54.62%), entirely
non-comparison cases. This differs from the independent challenge's 4/12
confirmation/amendment decision coverage. Neither measures delivered messages.
Zero false clears at low comparison coverage does not establish broad safety.

`freeze.json` binds the historical configuration, source artifacts, new fixture
content and evaluator implementation. `artifact-hashes.json` covers generated
JSON and the independent source files. `organizer-replay.json` records the
unchanged scorer replay; `scorecards.json` separates all three evaluation views,
reliability, safety and historical performance. Original per-row diagnostics and
reader profiles remain in the hash-bound [issue #37 report](../issue37-20260921/README.md).

Reproduce using `npm run eval:final -- --output runtime/eval/final-publication-v1`
(add `--python` if required). Existing output directories are refused.
Validation: 11 focused tests across four suites passed, root TypeScript checking
and targeted ESLint passed. The publication is complete; a valid 520-row
submission and the defect/review performance targets remain unmet.
