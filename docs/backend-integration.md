# Backend implementation and issue handoff

The existing Hono API remains the application backend. This change adds the
work assigned to `ivanhoma` without replacing the persistence or Gmail connector.

## Drafting — #45

`POST /cases/:id/draft` requires the dashboard bearer token and:

```json
{"sourceVersion":"current source hash","decisionVersion":2}
```

The response is `{ "draft": { ... } }` with a stable ID, recipient, subject,
text, action, evidence references, template version, and both input versions.
Identical retries reuse the persisted draft. Changed versions return 409,
unavailable source readers return 503, and unsupported actions/evidence return
422. Drafting does not send or enqueue mail. The Gmail automation uses the same
four templates and its existing durable outbox.

Templates cover missing documents, amendments, verified matches, and
clarification. A future draft request routes to `GMAIL_DOCUMENTATION_CONTACT`
when configured, or asks who is responsible. Amendment text contains only
established differences and explicitly says when other fields are unresolved.
Match confirmations require the existing seven-field complete decision contract
and fresh source-proof validation. No attachment is created or claimed.

The source validator currently checks hashes, exact excerpts, locations, and
consistent attachment pairs. **It does not implement the still-assigned semantic
document-role/field comparator (#33–#35).** Human decisions remain trusted for
field meaning; a matching excerpt alone is not independent proof of a correct
field assignment. Automatic recovery never promotes its output to a decision.

## Bounded text recovery — #44

`POST /cases/:id/recover` uses the same bearer authentication:

```json
{
  "sourceVersion":"current source hash",
  "decisionVersion":2,
  "attachmentId":"case:attachment:0",
  "fields":["shipper"],
  "locators":["line:3"]
}
```

Locators are `line:N`, `page:N`, or `cell:Sheet!A1`. The server reads the selected
attachment itself. Client-supplied source text is rejected. Only requested,
unresolved fields and selected regions go to OpenRouter; neither the opposite
document nor reference labels are included. Already resolved fields are rejected.
Candidate values must be exact substrings of their cited region. They return
`requiresSemanticValidation: true` and do not clear blockers or alter decisions.
Native unreadable/OCR-required documents must first pass the separate reader
recovery integration; this endpoint does not silently turn unreadable bytes into
text evidence.

The configurable default is `google/gemini-2.5-flash-lite`, listed by
[OpenRouter](https://openrouter.ai/google/gemini-2.5-flash-lite) at verification on
2026-09-20. Each provider instance checks the current model catalog before use.
Unavailable models, absent credentials, unsupported structured output, and
prices above the allowed ceiling produce explicit failures. Requests use
[provider price limits](https://openrouter.ai/docs/guides/routing/provider-selection)
of $0.10/M prompt and $0.40/M completion tokens. Changing the model does not raise
these limits.

Defaults: four concurrent calls, 15-second attempt timeout, 1,024 output tokens,
one retry for 429/5xx, and a durable lifetime budget per case of three attempts,
30,000 reserved tokens, and $0.02 reserved spend. Conservative UTF-8 input bounds
and the full output allowance are reserved **before** each request. Failed or
interrupted attempts keep their reservations. New source versions and server
restarts do not reset the case budget. Actual provider usage, when available,
is logged separately in SQLite and `recovery.attempt` events; reservations are
ceilings, not invoices. The existing `/usage` endpoint remains Jev-only.

## Evaluation — #37, #38, #39, #60

See [the evaluation guide](../tools/eval/README.md). The new runner executes the
same `ClassificationService.processCase` as the API, uses a separate SQLite
database, and never calls Gmail delivery. It supports safe projection for
completed decisions, explicit review blockers, and the lossy deferred-draft
benchmark convention. It cannot produce missing comparison decisions.

The code and fixtures support #37–#39, but live score acceptance is pending
credentials and the comparison integration owned by #35/#36. #60 cannot be
claimed complete without actual official, human-adjudicated, and independent
document evaluations. No corrected labels or successful live scores were
invented, and no GitHub issue was closed by this local implementation.

## Validation on 2026-09-20

- 241 tests passed across 34 suites, including new draft, recovery, endpoint,
  projection, split, and adjudication regressions.
- Root and extension TypeScript checks and repository ESLint passed.
- All 520 official sources and attachment bytes were hashed. The frozen
  [baseline manifest](../tools/eval/manifests/backend-v1.json) contains 381
  development and 139 final rows.
- Offline evaluation invoked the unmodified organizer scorer successfully,
  accounted for all 520 rows as unclassified/export failures, emitted no valid
  headline score, and made zero model calls. Its nonzero exit is intentional.
- Live OpenRouter/Jev recovery, complete document comparison, human-adjudicated
  scores, and final independent document scores were not run in this checkout.
