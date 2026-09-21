# Workspace email assistant

The floating **Ask CargoLens** button belongs to the operations workspace, after sign-in. Search all imported emails or the selected email, ask follow-ups, and open numbered source buttons to inspect the matching case. The landing page has no chatbot. Both pages use the CargoLens favicon.

Workspace walkthrough version 5 spotlights the chat launcher, search scope and evidence checks, then opens the Workflow Builder graph in context. Workflow Builder also has its own five-step overlay, shown on first visit and replayable through **Builder guide**. Tours do not save or execute flows.

## Retrieval and Jev checks

1. Read current email bodies, subjects, senders, attachment names, classification metadata and saved field evidence from the workspace store. Chunk bodies into 1200 characters with 150-character overlap. Rank candidates with BM25-style lexical retrieval and retain up to eight chunks, with per-email limits. No evaluation answer keys or arbitrary filesystem documents enter retrieval. Raw attachments are not newly parsed by chat; saved field evidence is searchable.
2. Jev checks the user question for explicit attempts to subvert the assistant. Ordinary email instructions, security-related search terms and discussions of suspicious content are not attacks. Questions and source screening use separate contexts.
3. Jev screens candidate chunks for AI-directed prompt injection and relevance. Only allowed chunks reach the generation model. Source text never grants tools or permissions.
4. The answer model returns a strict JSON schema with up to four factual claims and citation numbers. Each email summary names its email ID and reports requests in third person. Code validates the shape and binds citations to server-selected sources; citations never go inside model-generated claim text.
5. Jev checks each claim independently against only its cited evidence, then checks answer relevance. Unsupported answers are withheld; the UI shows screened source excerpts instead. A missing or failed initial Jev check fails closed with no generation request.

Thresholds: query attack probability at least 0.8 blocks generation; source attack probability at least 0.5 excludes that chunk; source relevance must be at least 0.3. Answer support must be at least 0.8 for every claim and topical relevance at least 0.65. These are classifier thresholds tested on the included suite, not guarantees of perfect security or zero future errors. No chat request can send mail, change a case or authorize a shipment.

## Run and configure

Use the existing API and dashboard workflow: `npm run build:dashboard`, then `npm run dev` or `npm start`. Chat uses the dashboard API URL and bearer token through the existing client; `/api/chat` is not a public auth exception. It follows the deployment's existing `AUTH_REQUIRED` setting.

Jev uses `AI_PROVIDER` and its existing selected provider key/model. Answer generation uses server-side `OPENROUTER_API_KEY` and optional `CHAT_MODEL` (default `google/gemini-2.5-flash-lite`). No key is bundled into the browser. No new dependency or vector service is required. Imported dataset emails are immediately searchable, even before classification completes; classification counts and saved verification evidence reflect only actual stored state.

Chat history stays in React memory and clears on reload or reset. Relevant email excerpts and questions go to the configured Jev and answer providers. Authentication, input limits (1000-character question, eight history messages, 40 KB body), a process-wide request budget and four concurrent answers bound access and cost. A network failure or HTTP 429/502/503/504 gets one generation retry within the same 18-second timeout. Rate limits should be shared at the edge for multi-process deployments.

Summary fallbacks return a specific reason: configuration, provider failure, timeout, invalid response, verification outage, or unsupported answer. Server diagnostics contain only that reason and HTTP status when available, never questions, email contents, keys, or raw provider errors. Every fallback still shows only previously screened evidence; it does not bypass answer verification.

## Verification

Offline regression: `npx vitest run apps/api/src/chat/chat.test.ts`.

Live summary regression: `node --import tsx tools/eval/src/chat-summary.ts`. Uses the isolated test inbox and both provider keys, exercises eleven questions through retrieval, generation and Jev verification, and exits nonzero if any answer falls back instead of generating a checked summary. The report contains modes and counts, not email content.

Live query regression: `node --import tsx tools/eval/src/chat-guard.ts`. This reads the supplied 520-email test dataset into an isolated memory store and uses `TYPESAFE_API_KEY`; it does not modify the real mailbox database. It exercises 40 normal queries and five hostile requests, saves `runtime/chat-query-eval.json`, and exits nonzero on false positives, missed attacks or provider errors. Run only when live model calls are intended.

The normal set covers summaries, senders, references, urgency, missing documents, invoice questions, comparisons, counts, security-related searches and casual wording. Separate unit tests cover injected chunks, invalid citations, unsupported claims, guard outages, auth, body limits, updated records and selected-email scope.
