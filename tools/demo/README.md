# CargoLens demo fixtures

Six cases that exercise the behaviours a reviewer is most likely to doubt, each with
its expected behaviour written down before the run and checked against what the
pipeline actually does.

```bash
set -a && . ./.env && set +a
npx tsx tools/demo/src/rehearse.ts
```

The rehearsal exits non-zero if any case disagrees with its documented expectation,
so it is a test as much as a demo.

## What each case proves

| Case | Situation | Labelled | Expected behaviour |
|---|---|---|---|
| `demo_001` | Subject says an invoice is overdue; the body asks for a BL check | live classification + fixture documents | Reads the current request, not the subject → `VERIFIED`, confirmation |
| `demo_002` | SI says 3 containers, draft BL says 4 | live classification + fixture documents | `MISMATCH` naming `container_count` → amendment request |
| `demo_003` | Both documents are image-only PDFs with no text layer | live classification + fixture documents | Recovery reads the scan; unverifiable fields would block rather than guess |
| `demo_004` | Body promises attachments; none are present | live classification + no documents | `MISSING_ATTACHMENT` → explicit document request, never a comparison of nothing |
| `demo_005` | The sender asks **us** to prepare and send the draft BL | live classification + no documents | `REQUEST_DRAFT`, nothing verified, and no reply asking the sender for the BL they requested |
| `demo_006` | Subject asks for an SI, body asks for a draft BL | live classification + no documents | `UNCERTAIN_INTENT`, blocked — no defensible single action exists |

Last measured run: **6/6 agree**, 7.7 s wall for six cases.

## Honesty properties

**Every classification is a live provider call.** Nothing is scripted or replayed.
The label in the table says exactly which part of each case is fixture: the document
*bytes* are fixed files on disk, read through the same reader the product uses; the
*judgement* is always live.

**No label or fixture id reaches inference.** Expected behaviour lives in
`src/expectations.ts`, which is imported only by the reporting code.
`buildClassificationState` passes subject, current body, quoted history, content
scope and attachment count — never an email id, filename or expectation. The
fixture inbox and the expectations are separate modules so that boundary is visible
rather than merely true.

**`demo_006` exists because of an honest failure.** The first version of `demo_005`
carried a subject reading "SI NEEDED" while the body asked for a draft BL, and the
pipeline correctly refused to pick one, reporting `LOW_CATEGORY_CONFIDENCE` and
`UNCERTAIN_INTENT`. Rather than reword the fixture until it produced the answer the
demo wanted, the contradiction was split into its own case and kept. `demo_005` now
states one thing consistently; `demo_006` is deliberately contradictory and expects
uncertainty.

## The automated request → reply → reverify cycle

The full unattended cycle — send a request, receive a reply carrying the missing
document, retrieve it, reverify, and confirm exactly once — runs against a fake
Gmail transport in `apps/api/src/gmail/automation.test.ts` and
`apps/api/src/gmail/outbox.test.ts`, because it needs a mailbox that can be driven
deterministically. The relevant cases are:

- *automatically compares real image-only thread evidence and sends one verified confirmation*
- *sends a logical reply once across repeated syncs*
- *invalidates an older queued reply when a new inbound source arrives*
- *persists an interrupted send across an actual database reopen without replaying it*

Duplicate-delivery protection is keyed on a content hash per logical reply, so a
repeated sync, a revised decision that changes nothing observable, or a process
restart mid-send all resolve to the same single outbound action.

## Full-inbox timing

The demo measures its own six cases. Full 520-email inbox timing is measured
separately and reported in `tools/eval/reports/issue10-20260922/`: **31.5 s** at the
best measured concurrency, first result at 0.42 s, zero errors.
