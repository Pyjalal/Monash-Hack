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

Badges classify visible subject/snippet text; the urgent tray provides shortcuts to native rows. No mailbox OAuth token is needed for these previews. Full-thread retrieval and outbound automation use the separate Gmail API connector below. Gmail and Outlook Live were checked in signed-in Chrome on 2026-09-20. See [connector and adapter verification](docs/connector-verification.md) for tested layouts and remaining limitations.

Successful previews are cached for five minutes in browser session storage, up to 200 entries. Cache keys include the mailbox context, local API endpoint, classifier revision and content fingerprint, and are stored as hashes. The cache stores classification metadata, not email subjects, senders or snippets. Changed content or classifier configuration triggers a new classification; **Retry** bypasses the cached result. API failures remain visible and are not cached as successful classifications.

## Implemented and remaining

- Typed Jev category, urgency and document-expectation questions; batches of eight, bounded concurrency/retries, content caching and durable events.
- TXT/CSV/TSV, XLSX, DOCX and native PDF [readers and label/value candidates](apps/api/src/documents/README.md) with byte hashes and exact source locations. Candidate pairings are structural hypotheses for the field selector. Scanned pages are explicitly marked for OCR.
- An optional Python/Tesseract OCR sidecar and Node recovery reader preserve native evidence separately, validate source hashes, and bound process concurrency, output size and timeouts. See the [recovery reader contract](apps/api/src/documents/README.md#optional-ocr-recovery).
- Gmail OAuth client, thread/reference lookup, durable outbound queue, four reply templates, stale-source checks and resume fixtures.
- Source proof validation before saving a comparison claim or queueing a confirmation. This checks bytes, excerpts and source pairs; the trusted role classifier and field comparator must establish their meaning.

The document-role/field comparator, OCR-aware field integration and vision escalation, cheap-LLM recovery, organizer export/scorer integration, dashboard and workflow builder remain assigned integration work. Low-confidence or conflicting classifications emit recovery signals; a recovery model is not yet connected. A request for a future draft remains awaiting documents, never verified solely because the benchmark labels it `OK`.

## Gmail configuration

Add `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_MAILBOX_ADDRESS` and `GMAIL_OAUTH_REDIRECT_URI` to `.env`. Register the exact callback URI in Google Cloud; the local default is `http://127.0.0.1:3001/gmail/oauth/callback`. The connector requests only `gmail.readonly` and `gmail.send`.

With the server running, call authenticated `POST /gmail/oauth/start` using `Authorization: Bearer <DASHBOARD_TOKEN>`, then open the returned URL and consent with the configured mailbox. The server checks one-use state, PKCE, required scopes and mailbox identity before saving the refresh token encrypted in SQLite. Alternatively, an existing `GMAIL_REFRESH_TOKEN` seeds the encrypted store once. A disconnected or revoked connection is not silently re-enabled by that environment variable: reconnect through OAuth. Encryption is bound to the client secret and mailbox; rotating either requires reconnection. Keep both the environment file and runtime database private.

Authenticated routes include `GET /gmail/status`, `POST /gmail/sync` with `{"maxMessages":1}`, `GET /gmail/outbox`, `POST /gmail/dispatch`, and `POST /gmail/disconnect`. The callback and generic connection-result page are public; administrative routes require the dashboard token. Sync returns a job ID; follow its completion or failure through `/events`.

`GMAIL_POLL_ENABLED=true` enables bounded polling independently of sending. `GMAIL_SYNC_QUERY` defaults to inbox excluding spam and trash. The mailbox/query cursor survives restarts; failed pages are retried, invalid cursors restart the scan, and full rounds rescan for new replies. This is polling, not Gmail push/history synchronization.

`GMAIL_AUTOMATION_ENABLED=false` permits ingestion and queued-reply inspection without sending. Setting it to true enables eligible dispatch during sync and through the dispatch route. Set `GMAIL_DOCUMENTATION_CONTACT` only to the responsible documentation contact: requests for a draft from us are routed there, or ask for clarification when responsibility is unknown. No BL is fabricated.

Live read, full-thread ingestion, attachment bytes and classification were verified on 2026-09-20 with outbound sending disabled. Delivery remains covered by fixtures; no live email was sent during this verification.

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
