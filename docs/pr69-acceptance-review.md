# PR #69 acceptance review

Reviewed against the current main branch and the extension work committed as 4e083a1 and 2ff4ccd on 2026-09-20.

## Corrections made during review

- The live OpenRouter catalog includes structured pricing metadata on unrelated models. Recovery now validates only the selected model, ignores charges for modalities not sent by this text-only request, and still rejects request fees or cache/reasoning prices above its reserved limits. Before this fix, the default model could not complete the catalog check.
- Recovery rechecks attachment bytes after the provider responds. Changed evidence returns `SOURCE_EVIDENCE_CHANGED` instead of a stale candidate.
- Repeated Gmail polling preserves an existing classified case and its validated decision when the source is unchanged. Previously it replaced an explicit decision with the initial classification decision. Changed sources still trigger classification.
- Additional outbox tests cover rate-limit backoff and exhaustion, plus an actual SQLite close/reopen after an interrupted send.

## Acceptance evidence

### #44: bounded text recovery

Live recovery of a synthetic shipper returned the exact source value with semantic validation still required. Observed model: `google/gemini-2.5-flash-lite`; 91 prompt tokens, 22 completion tokens, reported cost $0.0000179 and approximately 3.4 seconds. These are one-request observations, not latency guarantees. Fixture coverage includes absent credentials, unavailable models, unsupported candidates, persistent case budgets, concurrent reservation, failures, retries and price limits.

### #45: operational drafting

All four template paths are exercised. Drafts preserve source and decision versions, retain unresolved-field qualifications, do not invent attachments, and reject stale or unsupported confirmations. Source validation runs before amendment or confirmation drafts are persisted. These tests cover the drafting component; semantic comparison remains the separate #33–#35 dependency.

### #46: durable outbound delivery

The user authorized synthetic traffic between their Gmail and Outlook mailboxes. Outlook sent a clearly labelled missing-document test. Gmail initially placed it in spam, and the connector correctly excluded it. After the test message was restored to Inbox, live Jev classified it as BL_COMPARISON but returned uncertain action/expectation. No automatic reply was produced from that uncertainty.

For the isolated delivery test, an explicit synthetic missing-document decision was validated against the retrieved, attachment-free thread. The real Gmail client sent one request through the durable outbox and recorded its Gmail message ID. Subsequent separate-process synchronization and dispatch runs retained `SENT`, one attempt, and the validated decision. No duplicate send occurred. This demonstrates delivery and replay protection, not unattended end-to-end intent resolution. Testing used a separate SQLite database and a query restricted to the synthetic subject; general mailbox automation was not enabled.

### #38 and #39: reproducibility and dispute isolation

Grouped split regressions keep template siblings together. Frozen manifests include source, reference, scorer and implementation hashes and explicitly identify the organizer data as previously reviewed. The final runner records a one-use final evaluation marker. Source disputes require exact source spans and human-reviewed corrections; proposed targets are excluded individually. Runtime inference receives neither official labels nor corrected references.

### #37 and #60: incomplete

Offline execution accounted for all 520 official rows, invoked the organizer scorer successfully, made zero model calls and recorded 520 explicit export failures. It correctly emitted no valid headline score. Complete document-comparison integration and actual final official/adjudicated/independent scorecards remain outstanding. These issues must stay open; the offline diagnostic is not a successful benchmark.

## Test scope

The combined backend/extension tree passed 258 tests across 36 suites, root/extension TypeScript checks, ESLint and the extension build. A fresh 520-row manifest produced 381 development and 139 final rows. A pre-existing final-consumed marker rejected a repeated final run before model calls and remained unchanged. Synthetic mailbox content, credentials, runtime databases and provider payloads are excluded from Git. Provider catalog contract reference: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
