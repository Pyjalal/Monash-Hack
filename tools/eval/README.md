# Reproducible evaluation

## Final publication

```sh
npm run eval:final -- --output runtime/eval/final-publication-v1 --python /path/to/python
```

The [issue #60 scorecards](reports/issue60-20260921/README.md) preserve the chosen
issue #37 final run, apply the issue #39 ledger, replay the unchanged organizer
scorer, and measure 12 independently authored document cases in two shipment
groups. This command makes no provider calls and sends no email. It validates
the frozen source, artifact, scorer and product implementation hashes before
publishing into a new directory. `freeze.json` records the exact configuration,
fixture content and evaluator hashes before document evaluation. Existing output
directories are refused. A successful publication is not a passing benchmark;
read `official.valid` and the explicit failures in `scorecards.json`.

Independent document results are component measurements with supplied intent,
using real native text reads, comparison, evidence checks and export. They do
not measure classifier, OCR or delivery performance. Related variants share a
shipment group; there is no train/test split or tuning on this challenge.
Operational workflow/blocker checks and export-level exact status/reason checks
are reported separately. Missing exports count as misses. Automation coverage
counts proof-validated confirmation/amendment decisions, not sent messages.

The default inputs are the committed issue #37 report and issue #39 ledger;
`--report`, `--dataset`, and `--ledger` can select another frozen revision.
Human adjudication remains required before accepting any proposed correction.

## Official pipeline runner

```sh
npm run eval -- --prepare
npm run eval
# No paid calls: exercise export failures and invoke the organizer scorer.
npm run eval -- --offline
```

The runner loads exactly 520 unique official IDs through the same
`ClassificationService.processCase` used by the API. It writes a separate case
database, `submission.json`, `submission-provenance.json`, `decisions.json`,
`organizer-scorer.json`, and `scorecards.json` beneath
`runtime/eval/official/runs/<run-id>`. `latest-run.json` identifies the run.
The supplied `server/score_cli.py` is invoked unchanged with the official
`ground_truth.json`. Python must be installed; use `--python /path/to/python`
or the `PYTHON` environment variable when necessary.

Live runs require `TYPESAFE_API_KEY` in `.env`; they make paid inference calls.
`--offline` makes no provider calls, records all rows as unclassified failures,
and deliberately exits nonzero. It verifies plumbing, not model performance.
The API never sends messages during evaluation.

`--dataset <directory>` and `--output <directory>` select input and artifact
roots. Dataset/scorer byte hashes, model/questions, implementation hashes,
reader/policy/export versions, and category/format-grouped membership are frozen
before inference. Source-related template siblings cannot cross partitions.
Actual split counts are recorded because preserving groups can change the
requested 23% final fraction. Changed inputs/configuration require a separately
named output directory. Reference files are created exclusively and never
silently overwritten. Keep and compare prior runs when starting another cycle.

Default `--scope final` evaluates the entire inbox, including the frozen final
partition. A live final run writes `final-consumed.json` before calling a model;
repeated final runs in that cycle are refused. `--scope development` uses only
development rows. Previously reviewed organizer data is not described as a
blind independent test. The 32 independently authored classification fixtures
are reused validation cases, not an unseen generalization claim.

The report separates:

- Official unmodified scorer output and category confusion. Headline validity
  requires all 520 rows exported and a successful scorer invocation.
- Adjudicated exact targets with accepted corrections and unresolved exclusions.
- Independent classification/expectation checks, false clears on those
  attachment-free fixtures, and observed state-based automation coverage.
- Operational false clears relative to official references, failed exports,
  cold-cache wall time, latency quantiles, provider attempts, and request usage.

Targets (macro-F1 ≥0.85, defect rate ≥0.80, review recall ≥15/20) are identified
as targets, not results. Failed exports never become fallback `OK` predictions.
The organizer scorer supplies defaults for absent rows, so its raw output for
a partial submission is **diagnostic only**, and the valid headline is `null`.
Every omitted row is included in the failure list. Runs with missing exports or
scorer errors exit nonzero after writing their report.

The runner and API dataset import/retry now call the same `processCase` path
with the attachment root. Confident immediate comparison requests run the
source-only comparator, with two document jobs at a time. Future draft requests
remain awaiting documents. Existing decisions survive unchanged-source replay.
Missing attachments become explicit review decisions; unsupported roles, layouts,
references, and uncertain classifications remain blockers, never fallback matches.
Fresh evidence checks run before export; failed proof is recorded per row.

Install the dependencies from `tools/ocr-sidecar/requirements.txt` and make both
Python and Tesseract available on PATH for OCR. `--python` selects the organizer
scorer executable; the OCR sidecar uses `python` from PATH. The manifest records
the actual Node, Python, and Tesseract versions (or `UNAVAILABLE`). A total
300-request transport budget bounds classification attempts, including retries
and the reused independent classification fixtures.

`row-diagnostics.json` records exact category/status/reason/defect-set results
and blockers for every evaluated row. `reader-profiles.json` records native/OCR
profiles and source hashes. The terminal prints observed category macro-F1,
exact end-to-end defects caught, review recall, unsafe clears, full-inbox time,
and request-level token use beside their targets. Full-inbox time includes
classification, bounded comparison, proof checks, export and organizer scoring;
independent validation timing is separate. `scorecards.json` contains the full
category confusion matrix and performance breakdown.

The comparator has independent source fixtures in the test suite. Full final
independent document scorecards and live sending measurements remain separate
from this runner's reused classification validation; those checks are explicitly
`NOT_RUN` and cannot be inferred from classifier tests.

## Source-backed dispute ledger

`--disputes path/to/ledger.json` accepts a version-1 ledger. Start with:

```json
{"version":1,"datasetSha256":"hash from manifest.json","entries":[]}
```

Each entry requires `id`, `emailId`, one `target` (`category`, `status`,
`review_reason`, `defect_fields`, or `has_defect`), `kind`, `status`, `rationale`,
and exact `evidence` spans with `path`, byte `sha256`, UTF-16 `start`/`end`
offsets, and `text`. Evidence must come from the cited email JSON or attachment
under the dataset root, never the ground truth. Text spans are verified against
UTF-8 source files. Pending `CAPABILITY_ASSUMPTION` entries may instead cite a
hash-bound source-only reader observation using `observation: {path, sha256}`.
The outer path/hash still identifies the original attachment; offsets/text then
identify an exact observation object in that artifact, relative to the ledger.
The validator checks both hashes, source ownership, recovery and unresolved pages.
These observations can quarantine a target but **cannot support an accepted
correction**: readability alone does not prove field accuracy or a match.

Kinds are `SCHEMA_CONVENTION`, `CAPABILITY_ASSUMPTION`,
`SOURCE_LABEL_CONTRADICTION`, `AMBIGUOUS_SOURCE`, and `SCORER_LIMITATION`.
Statuses are `PROPOSED`, `ACCEPTED`, and `REJECTED`. Acceptance additionally
requires a human `reviewer`, ISO `reviewedAt`, and a typed `corrected` value.
Coordinated status/defect corrections must leave the complete row schema valid.
Conflicting active targets and duplicate IDs are rejected.

Only accepted entries change the in-memory overlay. Proposed targets are
excluded individually, leaving undisputed targets on the same row usable.
`disputes-frozen.json` identifies the exact ledger for a run;
`optimization-targets.json` lists reliable development targets and corrected
categories. No code imports this evaluation-only overlay into runtime inference.
The runner does not invent disputes or human reviews from model disagreements.

To apply the reviewed category overlay/quarantine to the older tuning harness,
set `EVAL_TARGETS_PATH` to the generated `optimization-targets.json`. The harness
validates the official reference hash and records the overlay hash. Official
full/holdout scores still use original references. Without a supplied ledger,
no adjudications are claimed.

### Offline miss triage

```sh
npm run eval:triage -- --report tools/eval/reports/issue37-20260921 --ledger tools/eval/disputes/issue39-v1/ledger.json --output runtime/eval/issue39-review-v1
```

The output parent must exist and the output directory must be new. This command
makes no provider calls, does not rerun the final partition, and verifies report,
email, attachment and official-reference hashes before analysis. It writes a
versioned `reference-overlay.json`, a frozen ledger and linked observations,
`optimization-targets.json`, separate official/adjudicated/independent scorecards,
and a row-level `triage.json`. Changes in adjudication require a new output
directory. The ledger hash identifies the exact overlay revision.

Triage distinguishes inference, reader, semantic and export stages from label
conventions/disputes. Stages overlap: a refused export often follows an upstream
blocker, rather than an exporter bug. Model disagreement never creates a dispute.
Missing exports count as missed targets, not observed field mismatches. Original
official and independent scorecards retain their validity/coverage limitations.
The [issue #39 report](reports/issue39-20260921/README.md) includes the measured
accounting and human review queue. No runtime or classifier policy was tuned
using those final-run misses.

## Existing classification experiments

The older classification harness measures categories only. Use
`npm run eval:classify`, rather than `npm run eval`, to run its tuning phases.

From the repository root, with `TYPESAFE_API_KEY` set in `.env`:

```sh
node --env-file=.env --import tsx tools/eval/src/classification.ts --phase all
node --env-file=.env --import tsx tools/eval/src/packed.ts
node --env-file=.env --import tsx tools/eval/src/packed.ts --full-mode-only
```

Individual baseline phases are `prepare`, `tune`, `speed`, `full`, and `independent`. Later phases require the development selection artifact. `DATASET_PATH` can override the default `training_data/sdoc-hackathon-docker/extracted/data_v2` root.

The runner freezes grouped development/holdout membership and independent fixtures before calls. It reads reference categories only in the evaluator; inference receives allowlisted email content. Failed calls and abstentions count against classification coverage and recall. Existing frozen reference files must remain unchanged during an evaluation cycle.

Reports and individual outputs go to the ignored `runtime/eval/classification/` directory. They include model, question version, request usage, wall time, latency quantiles, coverage, confusion matrices and exact misses. Estimates use $0.042 per million input tokens. Packed usage is accounted once per batch, with no invented per-email allocation. All calls are live; provider-side caching is unknown.

The packed study first compares batches of four and eight on the frozen development subset, then checks the chosen shape on the fixed independent fixtures before a full run. The fixtures are reused validation cases, not a new unseen test set. The single-email provider is the unchanged baseline.
