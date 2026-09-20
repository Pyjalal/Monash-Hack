# CargoLens UI competitor audit — 20 September 2026

## Scope and evidence

This audit uses the event repository index at [`research/averis-monash-hackathon-github-repos.md`](../research/averis-monash-hackathon-github-repos.md) as the competitor set. It covers the substantive public entrants and their current README/source-described product surfaces. Public benchmark scores are treated as author-reported, not as visual or performance proof.

CargoLens was inspected in the localhost browser prototype at `designs/cargolens.html`. The verified interaction path was:

1. Operations board with four workflow lanes and summary counters.
2. Search and category filtering.
3. Case opening from a board card.
4. Side-by-side seven-field SI/BL comparison.
5. Separate source-evidence view.
6. Amendment-draft preview for a mismatch.
7. Keyboard-shortcut help and command menu.
8. Simulated inbox replay with progressive counts.

The CargoLens prototype explicitly identifies itself as illustrative and does not call Jev, access a mailbox, or send mail. Competitor observations below describe exposed UI surfaces and source claims; they do not claim that every deployed path was independently executed.

## Fresh live-browser observations

The following public surfaces were opened and clicked through in the browser on 20 September 2026. These notes are observations of the deployed UI, not claims about hidden implementation quality:

| Live surface | What was visibly usable | Direct comparison with CargoLens |
|---|---|---|
| [CargoGuard](https://cargoguard-shipping-verify.xiongrunxin.chatgpt.site/) | Dashboard, Smart inbox, Verification, Human review, Reports & audit, Processing, and Upload documents. The dashboard exposes 520 messages, 220 comparison requests, 46 discrepancies, and 20 human-review cases. Verification shows all seven fields with per-field source-evidence controls; Reports exposes JSON/report exports and an audit trail. | CargoGuard currently has the stronger judge-facing route and operational breadth. CargoLens has the more distinctive visual language and better compact case story, but lacks CargoGuard's explicit navigation and run/report surfaces. |
| [ShipDoc](https://averis-sdoc-k3ce.vercel.app/) | Inbox with 520 records, status/category filters, per-email report routes, raw/normalized comparator values, reason text, exception/incomplete queues, and an Eval page with 1.0000 author-reported results. | ShipDoc is the strongest evidence/normalization benchmark for CargoLens to match. CargoLens should make raw value, normalized value, reason, and source line visible without opening several separate dialogs. |
| [Rimba](https://rimba1808-averis-sdoc.vercel.app/) | Operations triage, Discrepancies, Needs Review, Verified Clean, and Performance Metrics. A discrepancy opens a seven-field matrix and offers `Ask Gemini AI Copilot`, `Escalate to Carrier`, and `Approve Override`. | Rimba makes the operator decision explicit. CargoLens should add a clearly named next action and reviewer decision state while keeping its calmer, less dashboard-heavy presentation. |
| [Harbor Assurance](https://harbor-assurance.onrender.com/) | Public synthetic sandbox with operational-state buttons, `Try Harbor` guided scenarios, recent cases, seven-field verification, per-field evidence controls, OCR human-confirmation warning, report export, and a scanned-document review scenario. | Harbor has the clearest demo choreography. CargoLens should add a three-case guided path and explicitly separate clean, mismatch, and unresolved evidence cases. |
| [BOB](https://averis-hackathon-bobthebuilder-production.up.railway.app/app/) | Verification center with Overview, Mismatches, Review queue, Verified, Ask BOB, saved views, category/time filters, keyboard shortcut hint, selected-case tabs, Mark reviewed, Draft response, and an AI assistant panel. | BOB has the strongest operator ergonomics and saved-review workflow. CargoLens should borrow `Review next`, saved views, and explicit reviewed state before adding an assistant. |
| [Rfarihin SDOC](https://averis-sdoc.vercel.app/) | Executive Overview, Analytics, Audit Ledger, Compliance Rules, 520-record audit table, filter pills, inspect drawer, seven-field discrepancy matrix, and performance telemetry. | Rfarihin is stronger at executive reporting and audit navigation. CargoLens should borrow the compact audit drawer and linked filters, not the full analytics density. |

The remaining competitors in the repository index were reviewed through their current first-party repositories, READMEs, and deployment references. Several have no stable public UI URL, require local setup/login, or expose only source-described surfaces; they remain in the comparison table, but are not presented as fresh visual click-through results.

## Current position

CargoLens has the clearest visual product direction: a calm plum operations board, a four-stage workflow, strong case language, and a focused evidence modal. The main weakness is not visual polish. It is that the most important operational states are represented as static cards or simulated dialogs rather than as an inspectable, persistent case journey.

The strongest competitors make one or more of these visible immediately:

- where a case is in the processing pipeline;
- why it stopped or needs a person;
- the exact source line behind a field value;
- raw versus normalized values and the comparator reason;
- open versus completed review work;
- audit history and the next action;
- a live public surface that a judge can open without setup.

## Competitor surface comparison

| Competitor | Publicly exposed UI surface | Strong interaction pattern to borrow | CargoLens implication |
|---|---|---|---|
| [CargoGuard-AI](https://github.com/forlorinna/CargoGuard-AI) | React dashboard with inbox routing, discrepancy detail, source evidence, human correction, report export, upload-pair flow, and session persistence; README links a public demo. | Guided paths for clean match, discrepancy, human review, and scanned-document OCR. | Make the demo path explicit and let a judge enter a clean match, mismatch, and review case from one visible starting screen. |
| [ShipDoc / yk-chin](https://github.com/yk-chin/averis-sdoc) | Next.js console with inbox, filters/search, diff reports, raw-to-normalized toggle, exception queue, incomplete queue, and evaluation dashboard; README links a Vercel console. | Separate exception work from incomplete requests; expose normalization rather than hiding it. | Add `Needs review` versus `Awaiting documents` as first-class queue semantics and show raw → normalized values in the case view. |
| [ShipCheck AI](https://github.com/yzd767621/shipcheck-ai) | Operations console with pipeline stepper, click-to-evidence, Open/Reviewed tabs, reviewer-next navigation, insights, printable discrepancy report, and CSV export. | A field click highlights the exact SI/BL source lines; `Ctrl+Enter` moves through review work. | Add a case stepper, field-level evidence focus, a review queue, and a next-case action before adding more pages. |
| [BobTheBuilder](https://github.com/hann-png/averis-hackathon-bobthebuilder) | Railway web app plus Streamlit operator/review dashboard and API documentation. | Clear operator/review split and an immediately reachable deployed surface. | CargoLens needs a judge-safe route with no local build or extension installation dependency. |
| [SDOC / ShipSync](https://github.com/chaywen/averis-hackathon-2026) | ShipMail inbox, email detail/attachments, side panel, and ShipSync dashboard served by one backend; static Review Desk also remains part of the repo. | Shared result state across inbox, side panel, and dashboard; reading does not reprocess. | Keep one case identity and event history across extension, dashboard, and Gmail rather than making each surface look like a separate demo. |
| [Team Rimba](https://github.com/cs-mirakim/rimba1808_averis_hackathon) | Next.js/Supabase operations dashboard with a public Vercel prototype. | Productized deployment and a recognizable dashboard destination. | Publish one stable CargoLens landing/operations URL with a seeded demo workspace. |
| [Harbor Assurance](https://github.com/nicchenai-tech/harbor-assurance) | Public sandbox with Overview, guided demo paths, scanned-documents path, review state, and explicit synthetic-data boundaries. | A guided `Try Harbor` path teaches the judge what to click next. | Add a `Start the 3-minute demo` entry with one clean match, one mismatch, and one unresolved case. |
| [NovaShip Averis](https://github.com/SuYeeMyatMoe/NovaShip_Averis) | Next.js command-center dashboard with login/RBAC and seeded offline accounts. | Role-aware navigation and an explicit demo mode. | If CargoLens adds auth, keep it a visible local/demo boundary; do not make a judge discover a token or secret. |
| [Rfarihin SDOC](https://github.com/Rfarihin-dev/averis-sdoc) | Responsive SaaS-style Supabase dashboard and production URL are advertised. | Executive summary plus audit-row navigation. | Add a compact operational summary, but keep evidence and actions closer than an executive-only dashboard. |
| [VRP2206 SDOC](https://github.com/VRP2206/Averis_hackathon_2026) | React dashboard with `Process inbox`, accuracy panel, test-email flows, and an Android companion path. | One obvious primary action to populate the product with data. | Make `Process inbox`/`Replay inbox` produce a clear run receipt with timing, counts, and failures. |
| [gitenvy/averis_hackaton](https://github.com/gitenvy/averis_hackaton) | Streamlit HITL dashboard with metrics, document diff inspector, and supervisor escalation portal. | Supervisor mode gives review decisions a distinct home. | Separate operator triage from reviewer correction; do not overload the board with every control. |
| [shipdoc-ai](https://github.com/yasermusaed-eng/shipdoc-ai) | Streamlit multipage dashboard/landing/escalation queue is advertised. | A dedicated escalation page is easy to understand in a pitch. | Add a filtered escalation queue instead of relying only on the fourth board lane. |

## CargoLens strengths to preserve

- The four lanes make the end-to-end workflow legible at a glance.
- The plum palette and restrained editorial typography are more distinctive than generic Streamlit/admin styling.
- The case modal puts the seven required fields side by side and states the mismatch in plain language.
- The prototype does not overclaim: it labels the data illustrative and keeps unknown fields unresolved.
- Keyboard controls (`/`, `J/K`, `Enter`, `R`, `?`) are a real differentiator for an operations user.

## Highest-value UI changes

### P0 — Make a case journey inspectable

Add a compact stepper inside the case view:

`Received → Classified → Documents found → Extracted → Compared → Action`

Each step should show `complete`, `waiting`, `review`, or `failed`, with the reason and timestamp. This directly addresses ShipCheck's pipeline clarity and prevents CargoLens from looking like a static board with a modal attached.

### P0 — Add a real review queue surface

Add tabs or views for:

- `Open`: unresolved or review-required cases;
- `Waiting on sender`: missing documents or clarification requested;
- `Reviewed`: human decision, reviewer note, and time;
- `All`: the current board.

Include `Review next` and `Ctrl+Enter` behavior. Keep `Awaiting documents` separate from `Needs review`; those states have different operational actions.

### P0 — Connect every verdict to evidence

Turn each comparison row into an interactive control. Selecting `Container count` or `Gross weight` should highlight the corresponding source snippets in both documents. Show:

- raw extracted value;
- normalized value;
- comparison reason;
- source document/page or line;
- evidence hash/version when available.

This is the clearest way to turn CargoLens's evidence story into a visible advantage rather than a sentence in the footer.

### P1 — Add a run receipt, not only a replay animation

After `Replay inbox` or a real run, show a receipt with:

- input count and completed count;
- classification, extraction, comparison, and recovery timings separately;
- review count and unresolved count;
- retries/failures;
- model/policy revision and cache mode;
- export action.

Keep the current animation for orientation, but finish with measured state. Competitors expose metrics; CargoLens should make its numbers trustworthy and scoped.

### P1 — Add a guided judge path

Place a prominent `Start demo` control near the title. It should open three seeded cases in order:

1. clean seven-field match;
2. real mismatch with source evidence;
3. uncertain/missing evidence requiring a person.

Each case should end with one clear next action. This borrows Harbor's guided demo pattern without copying its visual style.

### P1 — Add a lightweight insight strip

Keep it subordinate to the workflow board. Show only four useful measures:

- automation rate;
- review rate;
- most common defect field;
- median time to decision.

Link each measure to the filtered case list. Avoid a large analytics page until the underlying events are real.

### P2 — Add a separate upload sandbox

An `Upload pair` path should be clearly marked as a sandbox and should never mix uploaded examples into the official inbox/export. Show the same evidence/review UI for a synthetic text pair and an image-only scan. This is a strong parity feature with CargoGuard, but it comes after the core case journey.

## Recommended implementation order

1. Case stepper + explicit action/status semantics.
2. Open / Waiting / Reviewed queue and `Review next`.
3. Click-to-evidence and raw/normalized field details.
4. Run receipt with real event/timing fields.
5. Guided three-case demo.
6. Four linked insight measures.
7. Upload sandbox.

Do not spend the next UI cycle on another color theme, a larger sidebar, or more decorative charts. The public competitors are already converging on broad dashboard polish; CargoLens can stand out by making evidence, uncertainty, and the next operational action unusually clear.

## Verification gaps

- The deployed competitor URLs in the index are public claims and should be rechecked immediately before judging; availability and content can change.
- Browser automation was used successfully for CargoLens and for the six public live surfaces listed above. Competitor UI observations for the remaining index entries combine current first-party README/source descriptions and deployment references rather than fresh click-through evidence for every hosted app.
- This audit does not treat README-reported perfect scores as proof of quality or visual superiority.
