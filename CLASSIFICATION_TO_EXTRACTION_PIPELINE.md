# CargoLens classification-to-extraction pipeline

> **Branch:** `feature/integrate-jev-pipeline`
> **Scope:** the current implementation from an email input through classification, dataset submission generation, document extraction, and SI/BL comparison.
> **Important:** this repository currently has **two related but separate execution paths**:
>
> 1. The **live API path** classifies emails, stores cases, and supports evidence-gated decisions.
> 2. The **benchmark submission path** classifies the dataset and runs seven-field extraction/comparison to create scorer-compatible JSON files.
>
> The live API does **not** automatically invoke the benchmark extraction path yet.

## 1. End-to-end map

```text
                         LIVE PRODUCT PATH

Gmail / Outlook rows or Gmail threads or dataset import
                      │
                      ▼
         validated Email contract + normalized text state
                      │
                      ▼
       ClassificationService: cache, deduplicate, queue, pack
                      │
                      ▼
 TypeSafe Jev API OR OpenRouter Decisions API (Jev model)
                      │
                      ▼
     strict response validation + confidence/recovery signals
                      │
                      ▼
         SQLite case, request usage, and durable event records
                      │
                      └──► optional human/API decision, evidence validation,
                           and Gmail outbox safeguards


                   BENCHMARK SUBMISSION PATH

dataset inbox + attachments
        │
        ▼
submission:classify → classification submission JSON
        │
        ▼
submission:pipeline → only BL_COMPARISON rows
        │
        ▼
filename-based SI/BL pair selection → native document readers
        │
        ▼
label/value candidate generation with source hashes and spans
        │
        ▼
Jev document-type and seven-field candidate selection
        │
        ▼
deterministic normalization + SI-versus-BL comparison
        │
        ▼
full scorer-compatible submission JSON + extraction detail JSON
```

## 2. Shared contracts and vocabulary

The single source of truth for the domain data model is [packages/shared/src/index.ts](packages/shared/src/index.ts).

### Email input

An `Email` has an ID, subject, sender, optional snippet/body, a content scope, and zero or more attachments. The validation contract limits input sizes and attachment counts before model calls. The two scopes are important:

- `inbox_snippet`: only the currently visible inbox preview data; this is the public extension/API preview path.
- `full_message`: full body content from an imported dataset or Gmail message.

### Classification output

A `Classification` contains:

- one of six categories: `BL_COMPARISON`, `SI_REQUEST`, `INVOICE_QUERY`, `GENERAL`, `SPAM`, or `UNCERTAIN`;
- category confidence and probability distribution;
- urgency (`routine`, `week`, `today`, or `blocking`);
- a BL document expectation (`FUTURE_DRAFT`, `VERIFY_NOW`, `REPORTS_MISSING`, or `UNCLEAR`);
- model, prompt version, elapsed time, cache status, and request-usage correlation.

### Seven comparison fields

The target SI/BL fields are fixed by `FIELD_NAMES`:

1. `shipper`
2. `consignee`
3. `notify_party`
4. `port_of_loading`
5. `port_of_discharge`
6. `container_count`
7. `gross_weight_kg`

A live `FieldResult` must carry original SI and BL source spans. The `OperationalDecisionSchema` rejects a complete/verified decision unless all seven fields have sourced outcomes and a validated SI/BL pair. This is a stronger standard than the current benchmark exporter.

## 3. Provider selection: TypeSafe or OpenRouter

The API startup file is [apps/api/src/server.ts](apps/api/src/server.ts). Provider selection is controlled by `.env`:

```dotenv
# Default TypeSafe transport
AI_PROVIDER=typesafe
TYPESAFE_API_KEY=...
TYPESAFE_MODEL=jev-1.13.0

# Alternative OpenRouter transport for the same structured Jev model
# AI_PROVIDER=openrouter
# OPENROUTER_API_KEY=...
# OPENROUTER_MODEL=typesafe/jev-1.13
```

The server fails fast when the provider selection or its required key is missing. The selected provider and model are included in the classifier cache configuration, so switching transport invalidates prior cached classification results.

| Transport | Implementation | Behaviour |
| --- | --- | --- |
| TypeSafe | [apps/api/src/ai/jev.ts](apps/api/src/ai/jev.ts), [apps/api/src/ai/jev-batch.ts](apps/api/src/ai/jev-batch.ts) | Uses `TypeSafeClient.systemOne`, with timeout and retry configuration. |
| OpenRouter | [apps/api/src/ai/openrouter.ts](apps/api/src/ai/openrouter.ts) | Calls OpenRouter’s Jev Decisions endpoint, bounds each request with an abort timeout, retries transient HTTP errors, and normalizes OpenRouter `prompt_tokens`/`completion_tokens` to CargoLens usage fields. |

Both transports must produce the same structured Jev answer shape. [apps/api/src/ai/classify.ts](apps/api/src/ai/classify.ts) rejects malformed models, invalid option keys, malformed probabilities, invalid urgency scores, missing usage, or a response that does not answer every expected question.

## 4. Step A — prepare the message for classification

The question definitions and preprocessing logic live in [packages/shared/src/questions.ts](packages/shared/src/questions.ts).

### 4.1 Text cleanup and current-message isolation

`buildClassificationState`:

1. Normalizes line endings and removes unsafe control characters.
2. Uses `body` if it exists, otherwise uses the visible `snippet`.
3. Finds common reply/forward delimiters, such as `On ... wrote:`, quoted `>` lines, and forwarded-message headers.
4. Splits the message into `body_current` and a bounded `quoted` section.
5. Truncates subject, active body, and quoted content to model-safe limits.

This is crucial: an old invoice or BL request inside quoted history should not override the active sender’s current request.

### 4.2 The Jev questions

`buildQuestions` constructs typed questions, rather than asking a free-text prompt:

- **Intent:** identifies the primary operational category and includes explicit boundary rules, for example the difference between an SI-only request and an existing draft BL that needs checking.
- **Urgency:** scores operational urgency from 0 to 3 based on actual deadlines or shipment blockage.
- **Expectation:** separates “send a future draft” from “verify the existing draft now” and “a document is reported missing.”

There are `concise` and `boundaries` prompt variants, plus an `intent-only` mode for certain evaluation runs. Every variant/mode receives a stable `questionVersion` string.

## 5. Step B — classify through the live API

The public preview endpoint is implemented in [apps/api/src/app.ts](apps/api/src/app.ts).

### 5.1 Extension/preview requests

`POST /classify`:

1. Requires JSON and validates the body against `ClassifyRequestSchema`.
2. Accepts at most 20 unique email IDs per request.
3. Enforces a process-local preview budget that refills gradually.
4. Rebuilds each received row as `inbox_snippet` content with **no attachments**, even if a caller supplied them.
5. Calls `ClassificationService.classify` once per row.
6. Returns row-level successes/errors, total elapsed time, and usage for distinct non-cached provider requests.

This endpoint is intentionally unauthenticated for the local browser extension. All other operational routes require `Authorization: Bearer <DASHBOARD_TOKEN>`.

### 5.2 Dataset import or Gmail ingestion

Dataset loading is implemented in [apps/api/src/dataset.ts](apps/api/src/dataset.ts). It reads each inbox JSON file, constrains paths to the dataset root, maps attachment extensions to MIME types, and creates `full_message` emails.

`POST /import` loads the configured dataset, upserts each email, emits `import.started`, and starts `ClassificationService.processCase` asynchronously. Gmail ingestion follows the same classification service after it has retrieved and persisted source attachments; its entry point is [apps/api/src/gmail/automation.ts](apps/api/src/gmail/automation.ts).

## 6. Step C — scheduler, caching, and persistence

The live classification scheduler is [apps/api/src/pipeline.ts](apps/api/src/pipeline.ts).

### 6.1 Cache key and in-flight deduplication

For every email, the service hashes:

```text
provider + model + prompt version + packing policy + normalized email state
```

It first checks SQLite for a cached result. If an identical request is already running, later callers await the same promise instead of buying another provider request. Cached results are rewritten with the caller’s email ID and `cached: true`.

### 6.2 Queue controls

The scheduler has bounded operational behaviour:

- default packed batch size: 8 (hard maximum: 8);
- default concurrency: 8 when a batch provider exists;
- default request limit: 1,100 starts per minute (hard maximum: 1,200);
- default maximum pending work: 600;
- default partial-batch flush: 8 ms.

If a packed request exceeds the conservative context budget, the scheduler classifies the rows individually instead. A full queue becomes `QueueFullError`, which the preview API converts to a retryable row error.

### 6.3 Durable records

[apps/api/src/store.ts](apps/api/src/store.ts) uses SQLite for:

- cases and source versions;
- classifications and their initial operational decisions;
- classification-result cache entries;
- one record per successful provider request and its usage;
- append-only durable case events; and
- Gmail outbox/state tables created by the Gmail package.

On successful classification, the store emits `case.classified`. If confidence is low or category/expectation answers conflict, it also emits `classification.recovery.required`.

## 7. Step D — safe initial operational decision

`initialDecision` in [apps/api/src/store.ts](apps/api/src/store.ts) converts a classification into a cautious workflow state.

Examples:

- A confident `BL_COMPARISON` with `FUTURE_DRAFT` becomes `AWAITING_DOCUMENTS`; it does not claim that an attachment exists.
- A confident `VERIFY_NOW` or `REPORTS_MISSING` request starts processing/blocked work, depending on evidence.
- `UNCERTAIN`, low-confidence, or contradictory results acquire blockers and route to `RECOVER_FIELDS` or `REQUEST_CLARIFICATION`.

At this point, no document field has been compared. The `fieldResults` list is empty and `pairValidated` is false.

## 8. Step E — native document reading

The reader implementation is [apps/api/src/documents/index.ts](apps/api/src/documents/index.ts), and its design contract is [apps/api/src/documents/README.md](apps/api/src/documents/README.md).

### 8.1 Input protection

`readAttachment`:

1. Rejects absolute, escaping, missing, non-file, oversized, and unsupported paths.
2. Resolves the configured attachment root with `realpath` before reading.
3. Limits source files to 20 MiB.
4. Hashes the immutable source bytes with SHA-256.

### 8.2 Supported native formats

| Format | Reader | Evidence location |
| --- | --- | --- |
| TXT / CSV / TSV | Native text decode | One-based line spans |
| PDF with a text layer | PDF.js | One-based page spans |
| DOCX | Mammoth | Serialized text/paragraph-line spans |
| XLSX | ExcelJS | Sheet and cell spans |

The reader returns text, `READABLE`/failure status, source hash, source spans, readability facts, and zero or more candidates. PDFs with no usable text are marked `OCR_REQUIRED`; they are not silently treated as blank matching documents.

### 8.3 Candidate generation

[apps/api/src/documents/candidates.ts](apps/api/src/documents/candidates.ts) derives literal label/value hypotheses from source spans. It supports:

- label/value delimiters such as `Shipper: ...`;
- multiline continuation values;
- DOCX adjacent paragraphs;
- adjacent spreadsheet cells; and
- label/value rows stacked vertically in spreadsheets.

Every `LabelValueCandidate` has a deterministic ID, literal label/value strings, pairing method, SHA-256, and original label/value spans. Candidates do **not** mean that a field has been semantically identified or validated.

## 9. Step F — optional OCR and vision components

### OCR

[apps/api/src/documents/recovery.ts](apps/api/src/documents/recovery.ts) wraps the optional Python/Tesseract sidecar. It is designed for scans, garbled documents, and image-only PDFs:

- it creates a confined private source snapshot;
- validates that the OCR input hash is identical to the native reader’s hash;
- bounds workers, queue size, process time, output size, and file size; and
- retains native and OCR evidence separately.

The current benchmark `submission:pipeline` command calls the native reader only. It does **not** call OCR automatically.

### Vision

[apps/api/src/ai/vision.ts](apps/api/src/ai/vision.ts) is a source-only OpenRouter vision-recovery component for unresolved fields. It accepts bounded page images from one source document, requires high-confidence values and a blind second-pass agreement, and returns recovery candidates rather than a verified comparison. It also is **not** automatically invoked by the live API or submission command.

## 10. Step G — benchmark classification submission

The selectively integrated command lives in [tools/eval/src/submission.ts](tools/eval/src/submission.ts).

Run:

```sh
npm run submission:classify
```

It performs the following:

1. Loads emails from `DATASET_PATH` or the default `data_v2` root.
2. Chooses the TypeSafe or OpenRouter Jev batch provider through `AI_PROVIDER`.
3. Splits emails into batches of 1–8 and runs up to the configured concurrency.
4. Writes `outputs/jev-classification-submission.json` using `SubmissionSchema`.
5. Writes `outputs/jev-classification-details.json` with provider/model, prompt version, aggregated request usage, and every structured classification result.

The benchmark submission schema permits only the organizer’s five categories. Therefore this command **fails** if Jev returns `UNCERTAIN`; it refuses to silently coerce uncertainty to `GENERAL` or another benchmark category.

At this stage each output row has `status: OK`, no review reason, and no defects. This is a category-only result, not a document-comparison result.

## 11. Step H — SI/BL extraction and comparison submission

Run:

```sh
npm run submission:pipeline
```

### 11.1 Select records

The command loads the classification submission and selects only records categorized as `BL_COMPARISON`. All other categories are copied into the final submission as `OK`/not applicable to document comparison.

### 11.2 Select a preliminary pair

`roleFor` currently identifies the first eligible pair from attachment names ending in `_SI` and `_BL`. This is a **benchmark convention**, not a production-safe role classifier. If either role cannot be found, the command yields:

```json
{
  "status": "NEEDS_REVIEW",
  "review_reason": "missing_attachment"
}
```

### 11.3 Read documents

The command calls the native reader for both pair members. Any non-`READABLE` source produces `NEEDS_REVIEW` with `unreadable` as the review reason. It does not use potentially partial text as if it were a complete source.

### 11.4 Ask Jev to select fields

For each readable SI/BL pair, the command:

1. Limits each document to its first 40 source-backed candidates.
2. Builds a typed Jev document-type question for each document: SI, BL, or other.
3. Builds seven typed field questions for each document.
4. Gives each question only candidate IDs plus literal label/value text, and a `missing` option.
5. Sends a bounded document-text excerpt, filename, and candidate list as model state.
6. Rejects malformed/unrecognized choices while parsing the response.

This has 16 typed questions per pair: 2 document-type questions plus 14 field-selection questions.

If Jev does not identify the pair as SI + BL, the row becomes `NEEDS_REVIEW/wrong_doc_type`. If any selected field is absent, it becomes `NEEDS_REVIEW/missing_value`.

### 11.5 Normalize and compare

`normalise` performs deterministic transformations:

- text fields: uppercase, whitespace compaction, punctuation normalization, and trailing UN/LOCODE removal;
- `container_count`: first numeric count, with commas removed;
- `gross_weight_kg`: last numeric weight-like value, with commas removed.

For every field, normalized SI and BL values are compared exactly:

```text
equal     → no defect
different → add field to defect_fields
```

The final status is:

| Condition | Output |
| --- | --- |
| Pair missing | `NEEDS_REVIEW / missing_attachment` |
| Either native read fails | `NEEDS_REVIEW / unreadable` |
| Pair is not SI + BL | `NEEDS_REVIEW / wrong_doc_type` |
| Any target field missing | `NEEDS_REVIEW / missing_value` |
| One or more normalized differences | `MISMATCH`, `has_defect: true` |
| Seven normalized values agree | `OK` |

The command writes:

- `outputs/jev-full-pipeline-submission.json`: strict organizer-compatible rows;
- `outputs/jev-extraction-details.json`: provider/model metadata, native-reader results, document-type choices, field values/candidate IDs/confidences, and defects.

## 12. What is authoritative today

| Question | Current answer |
| --- | --- |
| Can the browser/API classify operational email? | Yes. |
| Can it use TypeSafe or OpenRouter for Jev? | Yes, selected by `AI_PROVIDER`. |
| Does it cache and persist classifications? | Yes, in the live API path. |
| Can it read SI/BL documents with source spans? | Yes, through native readers. |
| Can it generate a full organizer-style extraction/comparison submission? | Yes, through `submission:pipeline`. |
| Does live `/import` automatically call extraction/comparison? | No. |
| Does the benchmark pipeline automatically OCR unreadable/scanned PDFs? | No. |
| Does the benchmark pipeline infer SI/BL roles without filename conventions? | No. |
| Does a benchmark `OK` automatically permit a Gmail confirmation? | No. |

## 13. The critical safety boundary

The live API’s decision endpoint, [apps/api/src/app.ts](apps/api/src/app.ts), verifies exact attachment hashes, locators, excerpts, and SI/BL pair relationships before accepting a decision containing a match or mismatch claim. Gmail automation revalidates those sources immediately before it sends a confirmation or amendment reply.

The benchmark pipeline uses sourced candidates and saves their IDs in detail output, but it does not currently turn those selections into the stricter live `FieldResult` span contract or save them as operational decisions. Treat its JSON as an evaluation/submission artifact, not as authorization to message a customer.

## 14. Useful commands and outputs

```sh
# Live API
npm run dev

# Benchmark category submission
npm run submission:classify

# Benchmark extraction/comparison submission
npm run submission:pipeline

# Tests and static checks
npm run typecheck
npm test
npm run lint
```

More command options and boundaries are documented in [tools/eval/README.md](tools/eval/README.md). The API endpoints and configuration are documented in [README.md](README.md).

## 15. Recommended next integration work

To consolidate the two paths safely:

1. Replace `_SI`/`_BL` filename role selection with content-based pair discovery.
2. Route unreadable documents through the existing OCR wrapper, then vision recovery only for remaining unresolved fields.
3. Convert selected candidates into `FieldResult` objects with source spans and validate the SI/BL pair.
4. Save the result through the live decision API rather than only writing submission JSON.
5. Build the dashboard on top of persisted API cases and evidence, instead of directly trusting output files.

This sequence would make the benchmark extraction capability available to operational cases without weakening the repository’s evidence and Gmail-send safeguards.
