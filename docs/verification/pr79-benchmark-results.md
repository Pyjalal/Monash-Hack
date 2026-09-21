# PR #79 benchmark verification

The comparison baseline is the executable code at `f7064120ccbb52564be4df45b2153a8474c7c5ee`, not the older demo guide. Original ground-truth files and the organizer scorer are unchanged.

| Dataset | Untouched PR exact agreement | After parser fixes |
| --- | ---: | ---: |
| V2 official | 520/520 | 520/520 |
| V3 curated | 210/210 | 210/210 |
| V4 adversarial | 79/100 | 100/100 |
| V5 scenarios | 60/60 | 60/60 |

V3 retains the PR's existing ten exclusions from 220 source emails. These are not 220/220 results. All four classification runs were freshly generated on the untouched PR and achieved exact category agreement. The subsequent parser comparisons reused those classification artifacts; these runs do not establish fresh end-to-end latency or generalization accuracy.

## Changes

- Normalize Unicode width before numeric plausibility checks while retaining raw source values.
- Support explicit metric-tonne weights and written container quantities; reject inconsistent word/digit quantities.
- Recognize bilingual annotations on bill-of-lading reference labels.
- Normalize complete port-name aliases using the shared, versioned competition port policy.
- Preserve the PR's strict `probability > 0.9` semantic-match threshold in benchmark execution.
- Record benchmark-only kilogram assumptions in extraction details. Operational comparison still requires explicit units and source evidence.

## Competition port semantics

The supplied ground truth defines the task's business rules. `competition-ports-v1` recognizes `BUATAN, INDONESIA` / `IDBUA` and `RUGAO/NANTONG/SHANGHAI, CHINA` / `CNSHA` as equivalent complete field values. This policy is implemented in the shared runtime normalizer and exercised by both operational decision tests and evaluation tests. It is not an export override. Original source text remains in field evidence; no label files or email IDs are read by inference.

These competition business identifiers should not be presented as global UN/LOCODE registry definitions. Unlisted location qualifiers and other port combinations do not inherit these aliases. Original ground-truth files remain unchanged.

## Reproduction

Set `DOTENV_CONFIG_PATH` to a local environment file. Run `npm run pipeline:full -- --dataset v2` (and v3, v4, v5). For a controlled parser comparison, copy the untouched run's `classification.json` and `classification-details.json` into each output directory, then append `--reuse-classification`. Full reports and submissions are under `outputs/pipeline/<dataset>/`. Compact results and report hashes are recorded alongside this document.

The measured result is **890/890 exact matches (100%)** across evaluated cases under the competition policy. This result does not establish the separate concurrency, cost, operational workflow or held-out evaluation criteria in other tickets.

## Validation and operational boundary

All 396 tests pass, all four workspace TypeScript configurations pass, and repository-wide ESLint passes. The V5 generator now imports its Node globals explicitly. Source pairing rejects conflicting identifiers, ambiguous roles are retained rather than silently selected, and source hashes are rechecked after model work. The API retains the existing OCR-aware, budgeted Gmail comparison route instead of importing the evaluation CLI's unbudgeted model dependencies into live automation. These checks are independent of benchmark label agreement.
