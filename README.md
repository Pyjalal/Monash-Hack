# CargoLens

Shipping email classification and an evidence-based SI/BL workflow built on TypeSafe Jev. Work is assigned in [GitHub issues](https://github.com/Pyjalal/Monash-Hack/issues).

## Run the API

Use Node.js 20.19+ and npm. From the repository root:

```sh
npm ci
cp .env.example .env
```

Set `TYPESAFE_API_KEY` and replace `DASHBOARD_TOKEN` with a long random token in `.env`, then run:

```sh
npm run dev
```

The API binds to `http://127.0.0.1:3001`. `GET /health` and `POST /classify` are public local endpoints. Health includes a `classifierRevision` hash so preview clients can invalidate cached results when the model, questions or packing configuration changes. Other routes require `Authorization: Bearer <DASHBOARD_TOKEN>`. The extension never receives API keys or this token. Local environment files, SQLite databases, and evaluation outputs are ignored by Git.

`POST /import` imports the configured dataset and returns a job immediately. Follow `GET /events` for results or use `GET /emails`; `GET /cases/:id` includes the full operational state. SSE reconnects accept `Last-Event-ID`. `GET /usage` is the authoritative request-level token total; packed classifications have `usage: null` and reference their shared `usageRequestId`. Response-level request usage can overlap across concurrent preview calls, so do not sum it for billing.

`POST /classify` accepts up to 20 unique-ID preview rows:

```json
{"emails":[{"id":"visible-row-1","subject":"Please check the draft BL","from":"sender@example.com","snippet":"Compare the attached draft with our SI."}]}
```

Preview results use only the visible subject/snippet and cannot establish document verification. Public previews do not overwrite imported cases.

## Load the extension

With the local API running:

```sh
npm run build:extension
```

In Chrome's extension manager, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`. Open the CargoLens popup to check the local API and enable previews. The supported inbox hosts are Gmail, Outlook Live and Outlook Office. `Ctrl+Shift+L` toggles previews. Reload existing mailbox tabs after loading or updating the extension.

Badges classify visible subject/snippet text; the urgent tray provides shortcuts to native rows. No mailbox OAuth token is needed for these previews. Full-thread retrieval and outbound automation use the separate Gmail API connector below. Gmail and Outlook selectors still need checking against the team's actual mailbox layouts.

## Implemented and remaining

- Typed Jev category, urgency and document-expectation questions; batches of eight, bounded concurrency/retries, content caching and durable events.
- TXT/CSV/TSV, XLSX, DOCX and native PDF [readers and label/value candidates](apps/api/src/documents/README.md) with byte hashes and exact source locations. Candidate pairings are structural hypotheses for the field selector. Scanned pages are explicitly marked for OCR.
- Gmail OAuth client, thread/reference lookup, durable outbound queue, four reply templates, stale-source checks and resume fixtures.
- Source proof validation before saving a comparison claim or queueing a confirmation. This checks bytes, excerpts and source pairs; the trusted role classifier and field comparator must establish their meaning.

The document-role/field comparator, OCR recovery, cheap-LLM recovery, organizer export/scorer integration, dashboard and workflow builder remain assigned integration work. Low-confidence or conflicting classifications emit recovery signals; a recovery model is not yet connected. A request for a future draft remains awaiting documents, never verified solely because the benchmark labels it `OK`.

## Gmail configuration

Add `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` and `GMAIL_MAILBOX_ADDRESS` to `.env`. Obtain offline OAuth access with `gmail.readonly` and `gmail.send` scopes using Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

`GMAIL_AUTOMATION_ENABLED=false` permits manual ingestion and queued-reply inspection without sending. Authenticated routes are `GET /gmail/status`, `POST /gmail/sync` with `{}`, `GET /gmail/outbox` and `POST /gmail/dispatch`. Enabling automation starts polling and dispatches eligible replies. Set `GMAIL_DOCUMENTATION_CONTACT` only to the responsible documentation contact: requests for a draft from us are routed there, or ask for clarification when responsibility is unknown. No BL is fabricated.

Live Gmail has not been exercised yet; connector and delivery behavior have been verified with fixtures. Four configured OAuth values are required before enabling automation.

## Verification and benchmarks

```sh
npm test
npm run typecheck
npm run lint
```

The [classification harness](tools/eval/README.md) measures categories only. `npm run eval` does **not yet** produce the organizer's seven-field submission or final composite score. It makes paid model calls when a live phase is selected; keep reference manifests frozen during an evaluation cycle.

On 19 September 2026, the cold HTTP API import classified and saved 520 emails in 7.80 seconds using 64 Jev requests (505 distinct content states). Category agreement was 513/520 (98.65%); macro-F1 was 0.9878. All seven misses carried an uncertainty/recovery signal in this run. This does not establish perfect recovery. Estimated input cost was $0.0351 at the supplied $0.042/M rate, excluding any output charge. A persisted re-import took 0.56 seconds with no new provider calls. These are individual measured runs, not latency guarantees, and exclude attachment extraction/comparison.

## Training data

The downloaded `sdoc-hackathon-docker.zip` archive is stored at:

`training_data/sdoc-hackathon-docker/`

The extracted bundle contains:

- `data_v2/`: 520 synthetic shipping-document inbox records, attachments, sample submissions, and ground truth.
- `server/`: FastAPI serving, loading, bundle-building, and scoring utilities.
- `docker-compose.yml`: optional local scoring server configuration.

The dataset includes `data_v2/ground_truth.json`, so this repository must remain private until the answer key is intentionally released.

See [the dataset README](training_data/sdoc-hackathon-docker/extracted/data_v2/README.md) for the schema, categories, edge cases, and regeneration instructions.
