# CargoLens premium blue workspace

The dashboard completes the operations presentation in #51, #52, #53 and #54. It uses the existing Vite/React workspace, Tailwind v4, a shadcn-style Radix/CVA button primitive, Lucide icons, and original document/lens SVG artwork. The generated [refined reference](design/premium-blue-reference.png) is an illustrative design asset, not application data.

## Run

From the repository root:

```sh
npm ci
npm run dev
npm run dev:dashboard
```

Open `http://127.0.0.1:5173`, use API address `http://127.0.0.1:3001`, and enter the `DASHBOARD_TOKEN` from the server environment. Never put provider keys, Gmail credentials or the dashboard token in a `VITE_` variable. `VITE_API_URL` may contain only the non-secret API address.

`npm run build:dashboard` produces `apps/dashboard/dist`. The API remains a separate service. For a hosted deployment, serve the dashboard over HTTPS, use an HTTPS API URL, and add the exact dashboard origin to `ALLOWED_ORIGINS`. The current authentication scheme is an MVP shared operator credential, not multi-tenant identity.

## Session and actions

The entered workspace credential is held in tab-scoped sessionStorage. The application signs out after eight hours, on explicit sign-out, or when the API or event stream returns 401. Reload preserves only an unexpired session. Sign-out removes it and clears the rendered workspace. Remote HTTP API addresses are rejected; loopback HTTP remains available for development. Server token rotation revokes access independently of the browser timer.

The dashboard calls authenticated inbox, case, comparison, recovery, draft, measurement and Gmail routes. The extension's public classification endpoint does not grant operational access. Draft previews never send email. When Gmail automation is enabled, comparison and Gmail sync can invoke the existing unattended delivery policy; the interface states that consequence. The delivery log exposes pending, sent, failed, cancelled and unknown outcomes. Unknown delivery is not an invitation to resend blindly.

Source excerpts include attachment identities, exact locators and SHA-256 hashes. The seven-field table retains mismatches alongside unresolved blockers. A future draft request remains awaiting documents. A changed case disables version-sensitive actions until reloaded; the server also rejects stale versions and revalidates evidence before confirmation. Recovery requests send only selected unresolved fields and source regions, and display the result as an unverified proposal.

## Measurements and limits

`GET /dashboard` returns persisted operational counts, successful-request usage, recovery counts and the latest 50 import reports. `GET /runs/:id` downloads the exact report. Import reports are stored in SQLite `dashboard_runs` and include total/completed/failed/pending counts, wall time, successful-provider P50/P95, tokens, retained-cache conditions and unchanged classifications reused from previous work.

The latency distribution excludes queue time; wall time includes the import's processing phase. Usage during an import can include concurrent API activity, which is explicitly stated. OCR counts include historical comparison versions. Missing billing and false-clear evaluation are shown as unavailable or not evaluated, never zero. Process cold/warm state is not measured, so the UI says so. Event replay is labelled separately from live delivery and cached classification.

This is the measurement presentation, not the final official/adjudicated/independent scorecard work in #37, #39 and #60. It does not claim model accuracy, real inbox speed, production Core Web Vitals, or calibrated OCR accuracy. The inbox fetches up to 1,000 records and virtualizes rendered rows; its primary acceptance dataset is 520 messages.

## Verification

- Full regression suite: **313 tests passed across 41 suites**.
- Repository type checking, lint and production dashboard build passed.
- Build output: approximately 392 KB JavaScript (119 KB gzip), 23.5 KB CSS (6.2 KB gzip). These are bundle measurements, not field performance scores.
- Compared compiled assets against locally configured key/token/secret values: none were embedded.
- Real configured API: authenticated dashboard request returned 200 in operational mode. No live mailbox send was performed for this dashboard verification.
- Browser: imported 520 synthetic messages, observed counts move from 8 classified/512 pending to 520 classified/0 pending, and retained the selected future-draft case throughout streaming. The generated report records the synthetic mode and is not a Jev benchmark.
- Browser: searched subjects, used J/K navigation and the command dialog, checked amendment preview with exact container evidence (3 versus 4), verified future-draft status, and advanced a decision externally to confirm stale actions became disabled until reload.
- Browser: checked desktop, 900px tablet and 390px mobile layouts. No document-level horizontal overflow; the evidence table can scroll horizontally on narrow screens. Sign-out survived reload; a wrong token was rejected. Browser console had no application warnings or errors during the successful flow.
- Session expiry and fragmented SSE framing have regression tests. Representative contrast ratios: primary button 6.33:1, muted body text 5.93:1, amber status 5.84:1, navigation text 11.46:1. A full screen-reader audit and field performance collection remain outside this verification.

### Reproduce isolated browser QA

```sh
npx tsx tools/dashboard/preview.ts
npm run dev:dashboard
```

Use API `http://127.0.0.1:3003` and token `cargolens-qa-only`. The fixture server creates a separate temporary SQLite database and 520 clearly labelled synthetic messages, uses no provider keys, and has no outbound transport. Import timing here measures fixture processing only.

### Design review

Direction: restrained premium operations workspace. Design variance 3/10, motion intensity 1/10, visual density 7/10. User-requested original SVG art and Lucide take precedence over generic skill defaults.

| Before | After | Why |
| --- | --- | --- |
| Plum static prototype with simulated actions | Navy/cobalt workspace calling the real authenticated API | Implements the requested business theme and operational workflow |
| Generated reference included a commodity field | Actual seven-field contract includes gross weight in kg | Keeps the visual reference subordinate to source contracts |
| Large header occupied evidence space | Reduced heading/summary spacing | Brings the work surface higher in the viewport |
| Replayed events could mark an unchanged case stale | Compare fetched source/decision versions before showing stale state | Preserves safety without unnecessary operator reloads |
| Split CRLF chunks could lose SSE event IDs | Incremental framing preserves cross-chunk CRLF | Keeps reconnect cursors intact |
| Starter React plugin required a different Vite major | Plugin pinned to 5.1.4 for the existing Vite 7 stack | Production build succeeds without an unrelated toolchain migration |
