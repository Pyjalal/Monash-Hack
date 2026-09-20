# CargoLens Bug Report

Date: 2026-09-20  
Branch: `main`  
Commit: `4f748de` (`Merge branch 'main' of https://github.com/Pyjalal/Monash-Hack`)  
Environment: Chrome Work profile, local API at `http://127.0.0.1:3001`

## Executive summary

One reproducible functional defect was found during live Outlook testing. CargoLens badges are present in the Outlook inbox, disappear after opening and closing a message, and only return after manually toggling CargoLens off and on with `Ctrl+Shift+L`.

Gmail could not be tested live because Gmail stayed on its generic Google Workspace loading screen after a refresh. This is recorded as an environment/integration blocker, not attributed to CargoLens without further evidence. The dashboard package is also empty, so there is no dashboard UI to exercise on this commit.

## Findings

### BUG-001 — Outlook preview badges disappear after opening and closing a message

- Severity: High
- Category: Functional / UX
- Surface: Outlook Live inbox
- URL: `https://outlook.live.com/mail/`
- Status: Fixed (regression test added in `apps/extension/src/content.test.ts`)

#### Steps to reproduce

1. Start the local API and load the built CargoLens extension in Chrome Work.
2. Open the Outlook inbox.
3. Confirm that visible rows show CargoLens preview badges; examples observed included `CargoLens · Spam · Routine · Uncertain` and `CargoLens · Invoice · Routine · Uncertain`.
4. Open the visible message `RinggitGuard Demo — CLEAN Invoice INV2041`.
5. Close the reading pane to return to the inbox.

#### Expected

CargoLens should rescan the visible inbox rows after the host application returns to the list view and restore the preview badges without user intervention.

#### Actual

The inbox rows remain visible, but their CargoLens preview containers and labels are absent after closing the message. Pressing `Ctrl+Shift+L` twice (off, then on) causes the badges to reappear, which confirms that the controller can recover but does not automatically rescan after this Outlook navigation cycle.

#### Evidence

- Before opening the message, the live accessibility tree contained multiple `CargoLens preview only` containers and CargoLens labels on inbox rows.
- After closing the message, the same rows were present but the CargoLens containers were absent.
- After the keyboard toggle, the CargoLens containers and labels returned on the same rows.
- No outbound mail action was performed.

#### Suggested investigation

Review the Outlook navigation/mutation path in `apps/extension/src/content.ts`. The controller clears presentation during host-context changes, but the return-to-list mutation path appears not to schedule a successful rescan until the enable toggle forces one.

#### Root cause and fix

The rescan did run, but it was a no-op. When Outlook returns to the list view it keeps the same row element and `data-convid` but rebuilds the row's inner content, which detaches the CargoLens badge host from the subject container. `prune()` correctly dropped the disconnected host, but `scan()` then saw an unchanged row (same `rowKey`, fingerprint and element) and `continue`d without re-rendering. Toggling with `Ctrl+Shift+L` worked only because `setEnabled` wipes `current`, forcing a fresh render.

`scan()` now checks whether the badge host is still attached to the current badge target for unchanged rows and re-renders from the stored result (loading / classified / error) when it is not. No new `CLASSIFY_ROWS` request is issued for these rows.

### BLOCKER-001 — Gmail inbox never leaves the Google Workspace loading screen

- Severity: Medium
- Category: Integration / Environment
- Surface: Gmail in Chrome Work
- URL: `https://mail.google.com/mail/u/0/#inbox`
- Status: Reproduced during this test; attribution unknown

#### Steps to reproduce

1. Open Gmail in the Chrome Work profile.
2. Wait for the inbox to load.
3. Reload the tab once.

#### Expected

Gmail should reach the inbox so CargoLens badges can be verified on Gmail rows.

#### Actual

The page remained on the generic Gmail/Google Workspace loading screen and displayed `If you're having trouble loading, visit the Gmail help center.` after the reload. No Gmail inbox rows became available, so Gmail adapter behavior could not be assessed live.

#### Notes

This may be a Gmail session, browser, network, or host-page issue rather than a CargoLens defect. The Gmail adapter remains covered by repository fixtures and automated tests, but live verification is still outstanding.

#### Content-script review

The extension was reviewed for anything that could plausibly stall Gmail's boot:

- `manifest.json` requests only the `storage` permission; there is no `webRequest`, `declarativeNetRequest`, `scripting` or `webNavigation` usage, so the extension cannot intercept or block Gmail's network or script loading.
- The content script runs at `document_idle` in an isolated world. Its only startup work is registering a `MutationObserver` whose callback resets a 250 ms debounce timer, then a single `GET_SETTINGS` message to the service worker. An exception in the content script cannot break the host page.
- During Gmail's loading screen no `tr.zA` rows exist, so `scan()` is effectively free; the `getComputedStyle` visibility walk only runs against matched rows.

Conclusion: no code path in this repository can hold Gmail on its loading screen. Attribution stays with the Chrome Work profile / Gmail session. Suggested retest: disable the extension, confirm Gmail still fails to load in the same profile, then re-enable and capture a badge result.

### GAP-001 — No dashboard UI exists to test on this commit

- Severity: High for dashboard scope
- Category: Completeness
- Surface: `apps/dashboard`
- Status: Confirmed incomplete, not a newly discovered regression

`apps/dashboard` contains only `package.json`; it has no source, entry page, build script, or runnable UI. The repository README also lists the dashboard and workflow builder as remaining integration work. Any requested “Main” dashboard flows therefore cannot be exercised until that feature exists.

## Verification performed

### Automated gates

- `npm test`: 30 test files passed, 223 tests passed (includes the new BUG-001 regression test).
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build:extension`: passed.

### Live API checks

- `GET /health`: 200, service ready, valid classifier revision.
- Protected route without a bearer token: 401.
- `POST /classify` with non-JSON content: 415.
- `POST /classify` with an invalid payload: 400.
- Valid one-row `POST /classify`: 200, one classified result.
- `GET /emails`: 200.
- `GET /gmail/status`: connected, configured, two requested Gmail scopes.
- `POST /gmail/oauth/start`: returned a Google authorization URL with a ten-minute expiry.
- `POST /gmail/dispatch`: 409 because outbound automation is disabled.
- No live Gmail sync or outbound send was performed during this audit.

### Live UI checks

- Outlook inbox rendered CargoLens badges on visible rows.
- Opening a classified Outlook message and closing it exposed BUG-001.
- `Ctrl+Shift+L` successfully disabled and re-enabled previews; re-enabling restored the badges.
- Gmail live rendering was blocked by BLOCKER-001.
- Chrome's internal `chrome://extensions` page cannot be claimed by the browser automation tool, so extension installation/reload was performed manually by the user and could not be independently inspected through automation.

## Scope not fully verified

- Gmail live row extraction and badge rendering, because the host page never loaded.
- CargoLens popup controls, because the browser automation tool cannot claim Chrome internal extension pages.
- Dashboard and workflow-builder behavior, because no dashboard implementation exists in this commit.
- Gmail sync, attachment retrieval, evidence comparison, and outbound dispatch against live mail; live mail mutation and sending were intentionally avoided.

## Recommended next actions

1. ~~Fix the Outlook return-to-list rescan path and add a regression test for open-message/close-message navigation.~~ Done; re-verify live in Outlook on the next dogfood pass.
2. Re-test Gmail after the Work profile can load the inbox and capture a live Gmail badge result (see the content-script review under BLOCKER-001 for the disable/enable retest).
3. Add a runnable dashboard before treating dashboard/Main testing as complete (scope proposal pending approval).
