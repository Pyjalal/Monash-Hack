# OCR evidence in operational comparison

Issue #14 now has a working path from recovered scan evidence to comparison and
the existing Gmail outbox. Native evidence is preserved; successful OCR is not
treated as proof that two documents match.

## Supported automatic path

The server enables automatic comparison after complete Gmail thread retrieval
when the current decision explicitly requests immediate document verification,
has no unresolved intent/context blockers, and is awaiting field recovery.
The comparison requires exactly two attachments, an explicit Shipping
Instructions heading, an explicit Bill of Lading heading, and the same uniquely
labelled shipment/booking reference in both documents. Filenames and organizer
labels play no role.

All seven fields require unique labelled values. OCR labels, values, document
headings and reference words must have individual Tesseract confidence of at
least 85. Native spans or OCR page/word ranges bind each result to an attachment
ID and source hash. Entity values use case and whitespace normalization only;
container counts must be positive integers, and weights require explicit kg
units in the label or value. Unsupported layouts, duplicate fields, ambiguous
units, low-confidence text and partial pages remain blocked.

Seven established matches produce `CONFIRM_MATCH`; complete comparisons with
differences produce `REQUEST_AMENDMENT`. Incomplete comparisons produce
`REQUEST_CLARIFICATION`. Deferred draft requests and unresolved thread
continuations do not enter this automatic path. Existing outbound enablement,
recipient checks, source-version guards and idempotency remain in force.

Before preparing or dispatching a reply containing recovered claims, the shared
operational validator reruns source reading, OCR, pair validation and comparison.
It requires identical sourced outcomes and blockers, and rechecks current file
hashes after asynchronous recovery. Client-provided OCR text, locators or MATCH
claims cannot bypass this check. This favors correctness over minimizing OCR
latency; it is not a sub-second scan-processing claim.

## API and retained evidence

Authenticated `POST /cases/:id/compare` accepts only `sourceVersion` and
`decisionVersion`. It rejects stale versions, unverified intent and missing
reader configuration. It computes the comparison on the server and atomically
saves the decision with its native-before, OCR-after and reader-profile evidence.
For Gmail cases, the complete eligible thread snapshot is also validated before
queueing the operational reply.

Authenticated `GET /cases/:id/comparison` returns evidence for the current source
and decision version. Older records remain in `document_comparisons` for audit,
but are not exposed as current evidence. Restart and concurrent source-change
tests cover these guarantees.

## Acceptance evidence

- Real Tesseract processes independently rendered image-only SI/BL fixtures,
  establishes seven matches, and passes fresh operational validation.
- A Gmail ingestion test uses those real raster attachments through thread
  retrieval, persistence, comparison, durable evidence, outbox preparation and
  final dispatch. The Gmail transport is mocked: one confirmation is sent across
  repeated syncs, with no real mailbox messages sent by these tests.
- Recovered mismatches produce amendment decisions. Forged values/outcomes,
  changed files, wrong shipment references, duplicate fields, low confidence and
  partial pages cannot authorize confirmation. Partial field evidence remains
  available with an explicit clarification decision.
- Missing OCR engines and timeouts retain explicit failure codes. Existing
  bounded vision-provider tests cover unavailable providers, malformed responses,
  timeouts, retry limits and unresolved-region scope.
- The full integrated suite passed 304 tests before the additional partial-evidence
  regression; the final targeted comparison and irrecoverable-source suites pass
  all 27 cases. Type checking and lint passed.

## Limits

The supported path is deliberately narrower than general semantic document
extraction: extra attachments, multi-line/table layouts without supported labels,
missing shipment references and unresolved OCR request clarification. An
85-confidence threshold is a policy gate, not a calibrated accuracy guarantee.
Vision-provider candidates are not automatically promoted into verified spans;
this change establishes the local OCR comparison/confirmation path. No new live
OpenRouter invocation or generalized vision-based confirmation is claimed.

Reproduce with `npm test`, `npm run typecheck`, `npm run lint`, and
`python -m unittest discover -s tools/ocr-sidecar -p 'test_*.py'`. Live OCR tests
require the dependencies documented in `tools/ocr-sidecar/README.md`. Raster
fixtures can be regenerated with the adjacent Pillow-based `generate.py`.
