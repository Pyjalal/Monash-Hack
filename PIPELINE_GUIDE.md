# CargoLens: run and understand the complete system

CargoLens has two related paths:

1. The browser extension classifies visible Gmail/Outlook rows for inbox triage.
2. The full pipeline classifies an email, extracts SI/BL attachments, compares seven fields, and produces an auditable result.

Both use the root `.env`. There is no second environment file or external configuration folder.

## First-time setup

From the repository root in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
```

Open `.env` and set one provider configuration:

- TypeSafe: `AI_PROVIDER=typesafe` and `TYPESAFE_API_KEY=...`
- OpenRouter: `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY=...`

Also replace `DASHBOARD_TOKEN` with a long local secret. Never put either API key in the extension.

## Run the system in a browser

Terminal 1 — API:

```powershell
npm run dev
```

Check [http://127.0.0.1:3001/health](http://127.0.0.1:3001/health).

Terminal 2 — operations dashboard:

```powershell
npm run dev:dashboard
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and enter the `DASHBOARD_TOKEN` when prompted.

For the evaluation/audit dashboard, first run a dataset and then start its UI:

```powershell
npm run pipeline:full -- --dataset v5
npm run dev:extraction-dashboard
```

Open [http://127.0.0.1:5174](http://127.0.0.1:5174). Use the dataset selector for V2–V5. The page shows classification, extraction, and comparison in order.

## Run the Chrome extension

Keep the API running, then build the extension:

```powershell
npm run build:extension
```

In Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `apps/extension/dist`.
5. Reload an existing Gmail or Outlook tab.
6. Open the CargoLens popup and enable previews. `Ctrl+Shift+L` toggles them.

The extension does not contain provider credentials. Its content script reads only visible row metadata, sends it to its background service worker, and the worker calls the local API at `127.0.0.1:3001`. The API routes the text to Jev and returns typed category/urgency/expectation data. The content script then renders badges, urgent pinning, spam hiding, and smart-filter actions.

The extension's inbox badge is a preview, not document verification. A visible row normally has only a subject, sender, and snippet; it does not give the classifier trusted attachment bytes. Full extraction/comparison happens on the server after the full email and attachments have been imported.

## The three-stage pipeline

```text
email text ──> 1. classification ──> route decision
                                           │
                         current SI/BL check only
                                           ▼
attachments ──> 2. read + extract ──> 3. normalize + compare ──> final answer
```

### 1. Classification: LLM judgment

Classification routes to Jev through TypeSafe or OpenRouter. Up to eight emails are packed into one bounded request. Each email receives:

- category: `BL_COMPARISON`, `SI_REQUEST`, `INVOICE_QUERY`, `GENERAL`, or `SPAM`;
- urgency score and level;
- document expectation: for example `VERIFY_NOW`, `REPORTS_MISSING`, or `FUTURE_DRAFT`;
- confidence and model metadata.

Only `BL_COMPARISON` cases confidently expected now continue to extraction. The evaluation route mirrors the operational 80% expectation-confidence boundary. A request asking somebody to prepare a future draft becomes `WAITING_FOR_FUTURE_DRAFT` / `REQUEST_DRAFT` / `DEFERRED`, remains in `AWAITING_DOCUMENTS`, and deliberately skips extraction and comparison. A transient classification request is retried up to three times.

### 2. Extraction: deterministic first, LLM only when needed

Each attachment is read independently. Supported native readers include TXT/CSV/TSV, XLSX, DOCX, and PDF. The reader records a SHA-256 hash, literal text, and exact line/page/cell spans.

The candidate generator finds label/value pairs such as:

```text
Gross Weight (KG): 18,500
```

It creates a candidate containing the literal value, the label, a stable candidate ID, and its source span. No model is needed for a document with one plausible candidate for every required field and a clear SI/BL role.

The format gate checks:

- the document role is SI or BL as expected;
- each of the seven labels exists exactly once;
- candidate values have plausible shapes;
- the document is readable.

If the gate passes, extraction is deterministic. If the layout drifts or a field is ambiguous, the fallback extraction LLM receives only the bounded document text and source-backed candidates. It may select candidate IDs; it may not invent or rewrite values. Code rejects unknown candidate IDs, low confidence, wrong document roles, and incomplete selections.

For difficult PDFs, bounded vision recovery can inspect selected rendered pages. Its output is still a proposal and must map back to acceptable evidence. Missing, unreadable, or wrong documents become `NEEDS_REVIEW` rather than a guessed answer.

### 3. Comparison: code first, narrow LLM fallback

The seven fields are:

```text
shipper, consignee, notify_party, port_of_loading,
port_of_discharge, container_count, gross_weight_kg
```

Code normalizes safe formatting differences first. Examples:

- `APRIL (M) SDN. BHD.` and `APRIL M SDN BHD` normalize to the same party name.
- `18,500 KG` and a value `18500` whose source label explicitly says `(KG)` normalize to the same weight.
- `1 MT` and `1,000 KG` normalize to the same weight.

Numeric fields do not use an LLM equivalence judgment. Missing units, ranges, zero/decimal container counts, and ambiguous values remain unresolved.

For non-numeric text fields that differ after normalization, Jev may make one narrow formatting-equivalence judgment. It sees the field name and both extracted values. Code accepts `equivalent=false` as a defect only at at least 95% confidence; uncertain semantics become `NEEDS_REVIEW`.

Final outcomes are:

- `OK`: all seven fields have complete evidence and match;
- `MISMATCH`: comparison completed and one or more fields confidently differ;
- `NEEDS_REVIEW`: evidence is incomplete, unreadable, the document type is wrong, or semantics remain unresolved.

When a case contains both a known partial mismatch and an unresolved field, the organizer format cannot represent both. The exported row conservatively uses `NEEDS_REVIEW`; the detailed trace retains the known defect and records an export warning.

## Examples

Clean match:

```text
SI: Gross Weight (KG): 18,500
BL: Gross Weight: 18.5 MT
result: OK
```

Confident mismatch:

```text
SI: Port of Discharge: Rotterdam
BL: Port of Discharge: Hamburg
result: MISMATCH, defect_fields = [port_of_discharge]
```

Fail-closed review:

```text
SI: Gross Weight: 18,500       # unit not stated anywhere
BL: Gross Weight: 18,500 KG
result: NEEDS_REVIEW, review_reason = missing_value
```

Deferred request:

```text
"Please prepare a draft BL after tomorrow's final SI."
classification: BL_COMPARISON + FUTURE_DRAFT
extraction/comparison: deferred
```

## Evaluation datasets and current runs

- V2: official 520-row baseline; legacy extraction traces are supported in the dashboard.
- V3: difficult synthetic data. Ten rows with emails claiming attachments but empty attachment arrays are listed in `data_v3/exclusions.json` and excluded, leaving 210 valid rows.
- V4: 100 adversarial cases restored from the stash. It is intentionally hostile to attachment and evidence handling.
- V5: 60 reproducible real-world scenarios covering TXT, DOCX, XLSX, valid matches, single-field mismatches, missing/wrong/unreadable documents, future drafts, and non-comparison categories.

Latest verified runs:

| Dataset | Classification | Exact end-to-end |
|---|---:|---:|
| V2 official | 514/520 | 505/520 |
| V3 curated | 210/210 | 93/210 |
| V4 adversarial | 98/100 | 73/100 |
| V5 realistic | 60/60 | 60/60 |

V4 runs all 100 cases as an extraction robustness set regardless of its two classification misses: 80 valid SI/BL pairs reach extraction and comparison, while 20 intentionally broken cases stop as reviews. The classification errors remain visible in the end-to-end score. Use the dashboard filters to inspect failures case by case.

## Useful commands

```powershell
# Rebuild a deterministic V5 dataset
node data_v5/generate.mjs

# Run any registered dataset end to end
npm run pipeline:full -- --dataset v2
npm run pipeline:full -- --dataset v3
npm run pipeline:full -- --dataset v4
npm run pipeline:full -- --dataset v5

# Reuse an already completed classification stage
npm run pipeline:full -- --dataset v5 --reuse-classification

# Validate code
npm run typecheck
npm test
```

Each run writes classification output, extraction details, final submission, organizer score, and one unified report under `outputs/pipeline/<dataset>/`.
