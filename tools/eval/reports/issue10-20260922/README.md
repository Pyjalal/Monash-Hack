# Issue #10 — Jev question and concurrency benchmark, full 520-email inbox

Measured 2026-09-22 against the live `jev-1.13.0` provider. Every number here comes
from the committed artifacts in this directory; nothing is projected or estimated
except the token cost, which is labelled as an estimate.

## Result

| Concurrency | Full-inbox wall | First result | P50 | P95 | Errors | Retries | Throughput | Est. cost |
|---|---|---|---|---|---|---|---|---|
| 4  | 58.8 s | 2.15 s | 428 ms | 518 ms | 0 | 0 | 8.84 email/s | $0.0532 |
| **8**  | **31.5 s** | **0.42 s** | 463 ms | 564 ms | **0** | **0** | **16.49 email/s** | $0.0532 |
| 16 | 39.8 s | 0.42 s | 859 ms | 985 ms | 0 | 1 | 13.07 email/s | $0.0532 |

**Measured best: concurrency 8.** Selection rule: fewest errors, then measured wall
time. Held-out data is reported below but was never consulted to choose.

Raising concurrency past 8 made things *worse*, not better: 16 took 26% longer than
8, roughly doubled P50 and P95, and needed a retry. That is server-side contention,
not client pacing — the client pace (1100 rpm) was identical across all three runs.
This is the measured configuration the deployment should use, and `fly.toml` has
been changed from `JEV_CONCURRENCY = 2` to `8` accordingly.

**This is not a claim of sub-second inbox completion.** The full 520-email inbox
takes about half a minute at the best measured setting. What *is* sub-second is the
first result: 0.42 s at concurrency 8 and above, which is what the streaming UI
shows first.

## Accuracy

| Reference | macro-F1 | Accuracy |
|---|---|---|
| Official category (all 520) | 1.0000 | 1.0000 |
| Held-out split (134) | 1.0000 | 1.0000 |

Scope: category classification only. This does not establish the official composite
score, SI/BL field extraction accuracy, or the operational false-clear rate — those
are measured separately (see `issue60-20260921/`).

## Configuration selected

Tuning compared one variable at a time across four question configurations on a
64-row development sample (`selection.json`). All four reached macro-F1 1.0000, so
the tie broke on observed wall time:

| Configuration | macro-F1 | Coverage | Wall |
|---|---|---|---|
| **boundaries / full** | 1.0000 | 1.0000 | 3.9 s |
| concise / intent-only | 1.0000 | 1.0000 | 3.9 s |
| boundaries / intent-only | 1.0000 | 1.0000 | 4.0 s |
| concise / full | 1.0000 | 1.0000 | 5.2 s |

`boundaries / full` is the configuration the API actually deploys, so the sweep
measured what runs in production rather than a cheaper proxy.

## Evaluation hygiene

- **This is a new evaluation cycle.** `question-contracts.json` pins
  `cargolens-email-v4`, which added the `document_issue` and `body_document`
  questions. The v3 artifacts in `runtime/eval/classification/` were left frozen and
  untouched; the tool refused to overwrite them, which is why this cycle has its own
  directory (`EVAL_OUTPUT_DIR`).
- The official ground-truth hash and the dev/hold-out split are **identical** to the
  v3 cycle, so the two are comparable. Only the hand-built independent fixture set
  differs.
- Held-out data was scored but never used for selection.
- Disputed targets are quarantined from optimization through `EVAL_TARGETS_PATH`,
  which verifies the ground-truth hash before applying any overlay.
- No answer key, email id or filename enters inference: the request hash covers only
  the built classification state and the question set.

## Reproducing

```bash
set -a && . ./.env && set +a
export EVAL_OUTPUT_DIR=runtime/eval/classification-v4 EVAL_MAX_CALLS=2600
npx tsx tools/eval/src/classification.ts --phase tune
npx tsx tools/eval/src/classification.ts --phase concurrency
```

1,816 provider calls total (256 tuning + 3 × 520). `artifact-hashes.json` carries the
sha256 of every produced file, including the three per-row result files that are too
large to commit (1.9 MB each).
