# CargoLens synthetic dataset v4 (`data_v4`)

This is a deterministic, independently runnable stress-test pack containing
100 synthetic emails. It is deliberately separate from `data_v2`, so results
from this pack cannot silently alter or inflate the official 520-row benchmark.

The dataset was recovered from the `adversarial accuracy evaluation pack`
stash and promoted to the stable V4 dataset slot. Its generator remains fully
deterministic and validates the checked-in artifacts.

## Composition

| Expected result | Count | What it tests |
|---|---:|---|
| `OK` | 40 | Semantic matches hidden behind formatting, Unicode, unit, port-code, container-notation, bilingual-label, amendment-history, and binary-format variation |
| `MISMATCH` | 40 | Exactly one subtle defect across shipper, consignee, notify party, POL, POD, container count, or gross weight |
| `NEEDS_REVIEW` | 20 | Five each of wrong document type, missing attachment, unreadable file, and missing required value |

All 100 emails are `BL_COMPARISON` cases. Their subjects and bodies also contain
quoted-thread noise, corrected intent, multilingual text, misleading historical
requests, automated footers, and an untrusted prompt-injection-style quote.

## Files

- `inbox/`: 100 pipeline-compatible email JSON records.
- `attachments/`: paired TXT/PDF/DOCX/XLSX documents and deliberate failures.
- `ground_truth.json`: exact expected category, status, review reason, and defect field.
- `sample_submission.json`: blank/default submission scaffold.
- `challenge_manifest.json`: per-case family, explanation, expected result, and attachment list.
- `spotlight_cases.json`: 16 high-value examples for a judge-facing demo.
- `summarize.py`: transparent exact-match, safety, Wilson-interval, confusion-matrix, and per-family scorecard.
- `JUDGE_DEMO_GUIDE.md`: a concise presentation structure and claim wording.

## Regenerate and validate

From this directory:

```powershell
python generate.py
python generate.py --validate-only
```

The fixed default seed is `20260921`. A different seed changes shipment values
but preserves the 40/40/20 target distribution and challenge families.

## Run through the pipeline

From the repository root, first classify the 100 emails:

```powershell
npm run pipeline:full -- --dataset v4
```

Then run document extraction and comparison:

```powershell
npm run dev:extraction-dashboard
```

Score the result with the supplied organizer scorer:

```powershell
python training_data/sdoc-hackathon-docker/extracted/server/score_cli.py outputs/pipeline/v4/submission.json --ground-truth outputs/pipeline/v4/ground-truth.curated.json --json
```

The organizer's combined `final_score` is not a suitable headline for this
pack: its category macro-F1 assigns zero to the four intentionally absent email
categories. Use its document/reliability sections, and use `summarize.py` for
the pack's exact system pass rate.

Create a judge-facing robustness scorecard (including false clears and
per-challenge-family pass rates):

```powershell
python data_v4/summarize.py outputs/pipeline/v4/submission.json --output outputs/pipeline/v4/robustness-scorecard.json
```

Do not describe the generated pack as a blind test: it is an authored stress
suite. Report it separately as **adversarial robustness**, alongside the
official unmodified benchmark result.
