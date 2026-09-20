# Reproducible evaluation

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

The document comparator has not yet been integrated into `processCase`.
Immediate comparison cases remain unsupported until it supplies validated
seven-field decisions. Full independent document status/reason and live sending
checks are explicitly `NOT_RUN`; they cannot be inferred from classifier tests.

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
UTF-8 source files; binary-document disputes must first provide a reviewed
source-text representation through a future extraction-ledger extension.

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

## Benchmark submission pipeline

The feature branch's useful end-to-end submission workflow is available here without replacing CargoLens's operational pipeline:

## OpenRouter smoke test

Use the smoke test to separate API-key/model/provider problems from extraction-prompt problems. It sends one ordinary `Hi` chat request to OpenRouter and never prints the API key:

```powershell
$env:DOTENV_CONFIG_PATH="..\\Monash-Hack\\.env"
npm run test:openrouter
npm run test:openrouter -- --model nex-agi/nex-n2.5-pro:free
npm run test:openrouter -- --model google/gemma-3-27b-it --message "Hi from CargoLens"
```

Configuration precedence is CLI flag, then environment variable, then the default: `--model` / `OPENROUTER_SMOKE_MODEL`, `--endpoint` / `OPENROUTER_CHAT_URL`, and `--timeout-ms` / `OPENROUTER_SMOKE_TIMEOUT_MS`. The request uses the standard `/api/v1/chat/completions` endpoint, so it also works for models that are not available on the alpha Decisions endpoint.

```sh
npm run submission:classify
npm run submission:pipeline
```

The first command writes `outputs/jev-classification-submission.json` and its detailed model output. The second command reads that classification submission, processes only `BL_COMPARISON` records, selects the seven fields from the native-reader's sourced candidates, and writes `outputs/jev-full-pipeline-submission.json` plus source-aware details.

Both commands use the selected TypeSafe/OpenRouter Jev transport. Classification uses `TYPESAFE_MODEL` or `OPENROUTER_MODEL`; out-of-template document extraction can use a separate low-cost `TYPESAFE_EXTRACTION_MODEL` or `OPENROUTER_EXTRACTION_MODEL`. The extraction model is called only when the deterministic seven-field format contract fails for a document. Use `--data-dir <dataset-root>`, `--classification <submission.json>`, `--output <submission.json>`, `--details <details.json>`, `--batch-size <1-8>`, or `--concurrency <n>` as needed. `submission:pipeline` is a benchmark/export tool: it does not save operational decisions, send Gmail replies, or bypass the API's source-evidence gate.
