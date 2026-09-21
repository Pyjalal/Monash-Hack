# Engineering the classification and SI/BL extraction pipeline

> **Branch:** `feature/integrate-jev-pipeline`
> **Audience:** engineers extending CargoLens from email classification into evidence-backed SI/BL comparison.
> **Core conclusion:** the live product path and the benchmark extraction path are currently separate. They should become one workflow, but only by moving the benchmark capabilities behind the live product’s evidence, persistence, and safety boundaries.

## 1. Why there are currently two paths

CargoLens began as a live, local inbox-classification product. It later gained a benchmark-style classification-and-extraction exporter from `feature/jev-email-classification`.

The two paths solve different problems:

| Path | Primary outcome | Source of truth | Risk tolerance |
| --- | --- | --- | --- |
| Live API | A persistent operational case with guarded next actions. | SQLite case, source version, source spans, events, and Gmail outbox state. | Low: never send or confirm from weak evidence. |
| Benchmark pipeline | A scorer-compatible JSON result for a dataset run. | Generated files under `outputs/`. | Moderate: useful for evaluation, but not sufficient to trigger an external action. |

They should not remain separate permanently. The goal is a single operational pipeline that can also export benchmark submissions. The benchmark command is the extraction prototype; the API is the production shell it must be integrated into.

## 2. The desired final architecture

```text
                       one unified case workflow

Email / Gmail thread / imported dataset
                 │
                 ▼
       validate and version the source email
                 │
                 ▼
       classify intent, urgency, and expectation
                 │
        ┌────────┴─────────┐
        │                  │
not BL comparison     BL comparison
        │                  │
        ▼                  ▼
  persist routed case   identify and validate SI/BL pair
                              │
                              ▼
                   native read → OCR → vision recovery
                              │
                              ▼
                 select seven sourced field values
                              │
                              ▼
                   normalize and compare deterministically
                              │
                              ▼
             save evidence-backed decision + durable event
                         │                    │
                         ▼                    ▼
                 dashboard/API view      guarded Gmail outbox
                         │
                         ▼
              optional organizer-submission export
```

The crucial rule is that a benchmark export becomes a *projection* of a durable, evidence-backed case. It must not be the authority that decides whether a document pair matches.

## 3. Engineering principles

### 3.1 Treat models as selectors and routers, not sources of truth

Jev is excellent for choosing an operational category and selecting one candidate from a bounded candidate set. It should not create evidence, invent a source location, or directly authorize a confirmation email.

The existing implementation follows this split:

- [packages/shared/src/questions.ts](packages/shared/src/questions.ts) defines the typed classification questions.
- [apps/api/src/ai/classify.ts](apps/api/src/ai/classify.ts) validates every returned option and probability.
- [apps/api/src/documents/candidates.ts](apps/api/src/documents/candidates.ts) produces source-backed candidate values before extraction asks Jev to choose.
- [apps/api/src/gmail/evidence-validation.ts](apps/api/src/gmail/evidence-validation.ts) verifies cited evidence before outbound mail is allowed.

### 3.2 Preserve immutable source provenance

Every read attachment needs a content hash and exact original location. A selected value should be traceable to a specific PDF page, DOCX/text line, or spreadsheet cell.

The native reader already does this in [apps/api/src/documents/index.ts](apps/api/src/documents/index.ts), producing:

```text
source bytes → SHA-256 → extracted text → source spans → label/value candidates
```

The benchmark extraction command currently persists candidate IDs in its details file, but it still needs to map the selected candidate’s spans into the live `FieldResult` contract. That is the most important missing link.

### 3.3 Make uncertainty a first-class outcome

Never turn an unclear field into a match by default.

The live contracts support `MISSING`, `AMBIGUOUS`, and `UNREADABLE` alongside `MATCH` and `MISMATCH`. The exporter maps similar situations to `NEEDS_REVIEW` reasons. A unified pipeline should retain the richer live state internally, then derive the simpler organizer status only when exporting.

## 4. Phase 0 — define contracts before making model calls

The shared package in [packages/shared/src/index.ts](packages/shared/src/index.ts) defines the current contracts:

| Contract | Purpose |
| --- | --- |
| `EmailSchema` | Bounds source email content and attachment metadata. |
| `ClassificationSchema` | Requires a structured Jev category, urgency, expectation, model metadata, usage, and cache state. |
| `FieldResultSchema` | Represents one of the seven compared fields plus SI/BL source spans. |
| `OperationalDecisionSchema` | Holds workflow state, blockers, next action, pair validation, and comparison results. |
| `SubmissionSchema` | Defines the organizer/export JSON format. |

### Engineering requirement

Do not add a new extraction state only in a CLI output object. Add it to a shared contract first, write validation tests, and decide whether it is:

- immutable source evidence;
- model interpretation;
- deterministic normalization/comparison output; or
- an operational workflow state.

This prevents an untyped JSON detail file from silently becoming operational truth.

## 5. Phase 1 — ingest and version the source

### Live API ingestion

[apps/api/src/app.ts](apps/api/src/app.ts) accepts preview requests and authenticated dataset/Gmail operations. [apps/api/src/dataset.ts](apps/api/src/dataset.ts) loads the dataset while containing all source and attachment paths within the configured root.

[apps/api/src/store.ts](apps/api/src/store.ts) computes a `sourceVersion` from the email data. A source change creates a new version, which is vital because old comparison evidence must not survive an attachment or message update.

### Engineering sequence

1. Validate the email/attachment shape with `EmailSchema`.
2. Constrain all attachment paths to the expected root.
3. Persist the email and source version before classification.
4. Emit a durable ingestion event.
5. Cancel or invalidate stale work/outbound actions when the source version changes.

### Why this matters

If an operator compares a draft BL, then the sender uploads a revised BL, a stored “match” from the old document must become stale. The current Gmail outbox already handles this principle; the generic extraction pipeline needs to use the same case/source-version mechanism.

## 6. Phase 2 — classify the email

### 6.1 Normalize the message

[packages/shared/src/questions.ts](packages/shared/src/questions.ts) performs deterministic preprocessing before any provider call:

1. Normalize line endings and remove unsafe control characters.
2. Prefer the full body; use the inbox snippet only when a full body is unavailable.
3. Split active text from quoted/forwarded history.
4. Bound subject, active body, and quote sizes.

This makes classification robust to long email threads where an old BL or invoice request appears below the actual request.

### 6.2 Ask typed Jev questions

The question builder asks for:

- **intent/category** — what is the current operational request?
- **urgency** — is it routine, due this week/today, or currently blocking shipment progress?
- **document expectation** — is a future draft awaited, an existing draft to verify, a reported missing document, or is the expectation unclear?

The boundary-focused prompt specifically distinguishes SI requests, existing-BL verification, future-draft requests, portfolio-wide reminders, invoices, and spam.

### 6.3 Choose a transport

[apps/api/src/server.ts](apps/api/src/server.ts) uses `AI_PROVIDER`:

```dotenv
AI_PROVIDER=typesafe     # TYPESAFE_API_KEY + jev-1.13.0
# or
AI_PROVIDER=openrouter   # OPENROUTER_API_KEY + typesafe/jev-1.13
```

The TypeSafe implementation is [apps/api/src/ai/jev.ts](apps/api/src/ai/jev.ts). The OpenRouter Decisions implementation is [apps/api/src/ai/openrouter.ts](apps/api/src/ai/openrouter.ts). Both are required to return the same typed answer contract.

### 6.4 Validate the provider response

[apps/api/src/ai/classify.ts](apps/api/src/ai/classify.ts) rejects:

- a missing/invalid model name;
- missing usage totals;
- unknown answer keys;
- an answer outside the defined category/expectation options;
- malformed or non-normalized probability distributions;
- invalid urgency legend, score, or score/probability inconsistency.

Never treat a malformed provider response as a low-confidence success. It is a provider failure.

## 7. Phase 3 — schedule and persist classification

[apps/api/src/pipeline.ts](apps/api/src/pipeline.ts) is the live scheduler.

### Required controls

| Control | Current behaviour |
| --- | --- |
| Content cache | Hashes provider/model/question/packing configuration plus normalized email state. |
| In-flight sharing | Equivalent simultaneous requests await the same promise. |
| Batch size | At most eight emails per packed Jev request. |
| Context protection | Falls back to individual requests when packed context exceeds a conservative byte budget. |
| Concurrency | Bounded, defaulting to eight packed requests. |
| Rate | Starts are paced; the default is 1,100 per minute. |
| Queue | Bounded; overflow is a retryable `QueueFullError`. |
| Usage | One durable usage record per provider request, not fabricated per-email usage. |

On success, the store saves the classification, emits `case.classified`, creates an initial cautious decision, and emits recovery signals when confidence or answer consistency is concerning.

## 8. Phase 4 — decide whether extraction is appropriate

After classification, use a deterministic gate:

```text
category != BL_COMPARISON
  → NOT_APPLICABLE; do not extract documents

category == BL_COMPARISON AND expectation == FUTURE_DRAFT
  → AWAITING_DOCUMENTS; do not pretend a pair exists

category == BL_COMPARISON AND documents expected now
  → discover/validate a candidate SI/BL pair

UNCERTAIN, low confidence, or contradictory answers
  → BLOCKED/RECOVER_FIELDS/REQUEST_CLARIFICATION
```

The existing live initialization logic is [apps/api/src/store.ts](apps/api/src/store.ts). The current batch prototype performs the simpler `category == BL_COMPARISON` check in [tools/eval/src/submission.ts](tools/eval/src/submission.ts).

### Gap to close

The batch tool must not treat every BL-category email as a document-comparison case. A request for a future draft is a correct `BL_COMPARISON` classification but has no BL to validate yet.

## 9. Phase 5 — discover and validate SI/BL pairs

### Current benchmark approach

The benchmark extractor finds the first filenames ending in `_SI` and `_BL`. This is acceptable only because the synthetic dataset deliberately uses that naming convention.

### Production approach to build

Implement a separate pair-discovery stage that:

1. Collects all current-thread attachments and their source message IDs.
2. Uses document content/metadata to classify each attachment as SI, BL, or other.
3. Detects multiple plausible candidates and marks the pair `AMBIGUOUS` rather than choosing arbitrarily.
4. Confirms that each candidate comes from the current source version.
5. Stores pair identity/hash metadata before field extraction.

The live decision contract already has `pairValidated`; populate it only after this stage succeeds.

## 10. Phase 6 — extract source-backed candidates

[apps/api/src/documents/index.ts](apps/api/src/documents/index.ts) is the native reader layer.

### Reader process

```text
attachment path
  → root confinement / size limit
  → bytes + SHA-256
  → format-specific parsing
  → readability assessment
  → exact source spans
  → label/value candidates
```

Supported paths:

| Source type | Parser | Typical source span |
| --- | --- | --- |
| TXT, CSV, TSV | native decode | line number |
| PDF text layer | PDF.js | page number |
| DOCX | Mammoth | serialized text/paragraph line |
| XLSX | ExcelJS | sheet + cell |

[apps/api/src/documents/candidates.ts](apps/api/src/documents/candidates.ts) creates candidates from delimiters, multiline continuations, adjacent paragraphs, adjacent spreadsheet cells, and vertically paired spreadsheet rows. It preserves the literal label/value; it does not decide what field the candidate represents.

## 11. Phase 7 — recovery for unreadable sources

### OCR first

[apps/api/src/documents/recovery.ts](apps/api/src/documents/recovery.ts) is the correct first recovery layer for scan/image-only PDFs or other unreadable material. It protects the process by:

- making a private bounded snapshot of the original file;
- checking source hash before and after recovery;
- capping workers, waiting queue, subprocess time, stdout/stderr, input size, page count, and image resolution;
- keeping OCR evidence separate from native parser evidence.

### Vision only for unresolved fields

[apps/api/src/ai/vision.ts](apps/api/src/ai/vision.ts) is the final recovery layer. It receives only unresolved field names and images from one source document; it never sees the opposite-side expected value. A blind second pass must agree exactly before a vision candidate survives.

### Required recovery rule

```text
native readable candidate available → use it
otherwise → OCR if applicable
otherwise → vision for explicitly unresolved field/page only
otherwise → UNREADABLE / NEEDS_REVIEW
```

No recovery stage should overwrite native evidence or silently turn an unreadable source into a matching result.

## 12. Phase 8 — select the seven fields with Jev

The current prototype is [tools/eval/src/submission.ts](tools/eval/src/submission.ts).

For each readable preliminary pair, it creates 16 typed questions:

- two document-role questions: SI, BL, or other;
- seven fields for the SI;
- seven fields for the BL.

The model sees a bounded list of source-backed candidate IDs plus their literal label/value text, and a `missing` choice. It is told to select exactly one directly supported candidate rather than infer or combine values.

### Required output shape for a unified pipeline

Convert a model selection into a live field result immediately:

```ts
{
  field: "shipper",
  outcome: "MATCH" | "MISMATCH" | "MISSING" | "AMBIGUOUS" | "UNREADABLE",
  si: {
    attachmentId,
    sha256,
    locator,
    text
  },
  bl: {
    attachmentId,
    sha256,
    locator,
    text
  }
}
```

Candidate IDs alone are insufficient for production. The selected candidate must be dereferenced into its spans, checked against the current attachment hash, and converted into a canonical locator/text excerpt.

## 13. Phase 9 — normalize and compare deterministically

The prototype’s normalizer in [tools/eval/src/submission.ts](tools/eval/src/submission.ts) currently:

- uppercases and compacts whitespace for text;
- removes punctuation and trailing UN/LOCODE-like suffixes for selected text values;
- extracts a container count number; and
- extracts a gross-weight number.

Then it compares normalized SI and BL values with exact equality.

### Engineering improvements needed

Move normalization into a dedicated shared module and test it against real carrier variations:

- party-name legal suffixes and address formatting;
- `POD`, `Port of Discharge`, and UN/LOCODE aliases;
- `1 x 40HC`, `1×40'HC`, and container tables;
- weight units, decimals, total vs per-container values;
- multi-container/line-item cargo.

Keep both values:

```text
raw source value      → for evidence and user display
normalized comparison → for deterministic match/mismatch calculation
```

Never expose only a normalized value in an operator UI; the user must be able to see what the source actually said.

## 14. Phase 10 — save a live operational decision

After a pair and seven field results are available:

1. Re-read or validate the source hashes/spans.
2. Ensure the pair is from the current source version.
3. Set `pairValidated: true` only if exactly one SI and BL pair is validated.
4. Populate all seven `FieldResult` records.
5. Derive `knownMismatches`, verification state, workflow state, blockers, and next action.
6. Submit it through `POST /cases/:id/decision` in [apps/api/src/app.ts](apps/api/src/app.ts).
7. Let the API’s evidence validator reject stale or forged claims.
8. Emit case events for the dashboard and optional Gmail automation.

The existing schema does not allow `VERIFIED`/`CONFIRM_MATCH` until all seven fields are sourced, matching, complete, pair-validated, and unblocked.

## 15. Phase 11 — make an export a projection, not a separate decision

Once a durable live decision exists, produce organizer output by mapping it to `SubmissionSchema`:

| Live state | Export status |
| --- | --- |
| All seven fields match, complete evidence | `OK` |
| One or more sourced mismatches | `MISMATCH` + exact `defect_fields` |
| Missing/ambiguous/unreadable/wrong role | `NEEDS_REVIEW` + review reason |
| Non-BL category | organizer-compatible non-defect row |

This exporter should be a pure function with tests. It should never call a model, read a document, or make a business decision.

## 16. Implementation roadmap to merge the paths

### Milestone A — extract service and contracts

- Create an extraction service under `apps/api/src/`.
- Move the batch tool’s pair/field orchestration from [tools/eval/src/submission.ts](tools/eval/src/submission.ts) into that service.
- Add shared extraction-result and normalization contracts.
- Keep `submission:pipeline` as a thin CLI adapter to the service.

### Milestone B — pair discovery and source-backed selections

- Replace filename role detection with content-based SI/BL classification.
- Handle multiple candidates explicitly.
- Convert selected candidates to `FieldResult` source spans.
- Add tests with TXT, PDF, DOCX, XLSX, wrong-document, and ambiguous-pair fixtures.

### Milestone C — recovery orchestration

- Invoke OCR only for the reader statuses that require it.
- Carry OCR spans/provenance forward without replacing native evidence.
- Use vision only for fields/pages still unresolved after OCR.
- Add cost, timeout, and failure metrics to case events.

### Milestone D — live workflow integration

- Call the extraction service from `ClassificationService.processCase` only after the deterministic BL/document-expectation gate passes.
- Persist extraction state (`NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `COMPLETE`, `FAILED`) through the existing decision model.
- Implement reliable retry/idempotency using source versions and attachment hashes.
- Add authenticated API endpoints for extraction progress/evidence inspection.

### Milestone E — dashboard and export

- Build a dashboard from `GET /emails`, `GET /cases/:id`, and SSE events.
- Show source excerpts/page/cell locations beside every selected field.
- Add an explicit human approve/reject flow for low-confidence or ambiguous cases.
- Export organizer submissions from persisted cases.

## 17. Test strategy

Test each layer independently and then as an integrated case flow.

| Layer | Required tests |
| --- | --- |
| Contracts | invalid categories, stale source versions, incomplete verification, duplicate fields, bad review/status combinations. |
| Classification | quoted history, boundaries between SI and BL work, low confidence, malformed provider output, cache revision changes. |
| Readers | path escape, size limit, TXT/PDF/DOCX/XLSX spans, garbled content, scan/OCR-required pages. |
| Candidate selection | synonyms, multiline address fields, spreadsheet row/cell layouts, missing values, label collisions. |
| Pair discovery | filename-free documents, multiple SIs/BLs, wrong type, old thread attachment versus newest attachment. |
| Comparison | weight/unit variations, container representation, party and port aliases, genuine mismatches. |
| Operational integration | source changes invalidate prior result; no Gmail confirmation without seven validated matches. |
| Export | deterministic mapping from a durable case decision to organizer submission JSON. |

The current repository already has tests for many foundations. Start from [apps/api/src/pipeline.test.ts](apps/api/src/pipeline.test.ts), [apps/api/src/documents/index.test.ts](apps/api/src/documents/index.test.ts), [apps/api/src/documents/recovery.test.ts](apps/api/src/documents/recovery.test.ts), [apps/api/src/gmail/automation.test.ts](apps/api/src/gmail/automation.test.ts), and [tools/eval/src/submission.ts](tools/eval/src/submission.ts).

## 18. Definition of done for a merged pipeline

The paths are truly merged only when all of these are true:

- A live imported/Gmail case automatically enters extraction only when classification and document expectation allow it.
- SI/BL role assignment does not rely solely on filenames.
- Every selected value maps to a source hash and exact span.
- OCR/vision recovery is orchestrated only when necessary and retains evidence provenance.
- Every complete match/mismatch is saved through the live decision/evidence validator.
- The dashboard can show the exact source proof for every field.
- Gmail automation cannot send a confirmation from a batch JSON file alone.
- The benchmark submission is derived from persisted decisions, with reproducible evaluation reports.

Until then, `submission:pipeline` remains a valuable experiment and competition-export tool—not the final operational comparison engine.
