# PR #79 benchmark verification

The comparison baseline is the executable code at `f7064120ccbb52564be4df45b2153a8474c7c5ee`, not the older demo guide. Original ground-truth files and the organizer scorer are unchanged.

| Dataset | Untouched PR exact agreement | After parser fixes |
| --- | ---: | ---: |
| V2 official | 520/520 | 520/520 |
| V3 curated | 210/210 | 210/210 |
| V4 adversarial | 79/100 | 96/100 |
| V5 scenarios | 60/60 | 60/60 |

V3 retains the PR's existing ten exclusions from 220 source emails. These are not 220/220 results. All four classification runs were freshly generated on the untouched PR and achieved exact category agreement. The subsequent parser comparisons reused those classification artifacts; these runs do not establish fresh end-to-end latency or generalization accuracy.

## Changes

- Normalize Unicode width before numeric plausibility checks while retaining raw source values.
- Support explicit metric-tonne weights and written container quantities; reject inconsistent word/digit quantities.
- Recognize bilingual annotations on bill-of-lading reference labels.
- Normalize complete, verified port-name aliases to UN/LOCODE without collapsing location lists or qualifiers.
- Preserve the PR's strict `probability > 0.9` semantic-match threshold in benchmark execution.
- Record benchmark-only kilogram assumptions in extraction details. Operational comparison still requires explicit units and source evidence.

## Remaining original-label disagreements

`adv_email_016`, `adv_email_019`, and `adv_email_020` expect an OK result for Buatan versus `IDBUA`. UNECE lists Buatan as `IDBUN`; `IDBUA` denotes Bula. `adv_email_017` expects the three-location expression `RUGAO/NANTONG/SHANGHAI, CHINA` to equal the single-location code `CNSHA`. The current comparison preserves these differences. No email-ID exceptions, answer lookup, new exclusions, or ground-truth edits were introduced.

Sources: [UNECE Indonesia](https://service.unece.org/trade/locode/id.htm), [UNECE Lithuania](https://service.unece.org/trade/locode/lt.htm), [UNECE Türkiye](https://service.unece.org/trade/locode/tr.htm), [UNECE Peru](https://service.unece.org/trade/locode/pe.htm), [UNECE Chile](https://service.unece.org/trade/locode/cl.htm), [UNECE South Korea](https://service.unece.org/trade/locode/kr.htm), and [JNPA port codes](https://www.jnport.gov.in/page/ports-connected-with-jnpa/ZlN1YUJoTCt4cUNKcWJKRWZoVHFJZz09).

## Reproduction

Set `DOTENV_CONFIG_PATH` to a local environment file. Run `npm run pipeline:full -- --dataset v2` (and v3, v4, v5). For a controlled parser comparison, copy the untouched run's `classification.json` and `classification-details.json` into each output directory, then append `--reuse-classification`. Full reports and submissions are under `outputs/pipeline/<dataset>/`. Compact results and report hashes are recorded alongside this document.

The measured result is 886/890 exact matches across evaluated cases, not 100%. Do not close an acceptance criterion requiring 100% original-label agreement based on this report.

## Validation and operational boundary

All 392 tests pass, all four workspace TypeScript configurations pass, and repository-wide ESLint passes. The V5 generator now imports its Node globals explicitly. Source pairing rejects conflicting identifiers, ambiguous roles are retained rather than silently selected, and source hashes are rechecked after model work. The API retains the existing OCR-aware, budgeted Gmail comparison route instead of importing the evaluation CLI's unbudgeted model dependencies into live automation. These checks are independent of benchmark label agreement.
