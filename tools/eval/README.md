# Classification evaluation

This harness measures email category classification. It does not yet create the organizer's document-comparison submission or compute its composite score.

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

```sh
npm run submission:classify
npm run submission:pipeline
```

The first command writes `outputs/jev-classification-submission.json` and its detailed model output. The second command reads that classification submission, processes only `BL_COMPARISON` records, selects the seven fields from the native-reader's sourced candidates, and writes `outputs/jev-full-pipeline-submission.json` plus source-aware details.

Both commands use `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, and the current TypeSafe Jev integration. Use `--data-dir <dataset-root>`, `--classification <submission.json>`, `--output <submission.json>`, `--details <details.json>`, `--batch-size <1-8>`, or `--concurrency <n>` as needed. `submission:pipeline` is a benchmark/export tool: it does not save operational decisions, send Gmail replies, or bypass the API's source-evidence gate.
