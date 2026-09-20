# Gmail connector and inbox adapter verification

Verified 2026-09-20 for issues #61, #48 and #49.

## Live evidence

- Chrome Work profile, Gmail standard desktop inbox (`mail.google.com`): 50 rendered rows classified, category/urgency/uncertainty labels visible, zero duplicate badges. Older/Newer pagination annotated replacement rows without duplication. Native selection toggled on/off successfully.
- Outlook Live desktop inbox (`outlook.live.com`), English, Focused list: seven initial rendered conversation rows classified with zero duplicate badges. Newest/Oldest sort toggled and was restored. Native checkbox selection toggled on/off; Tab moved focus from Subject to Received header. Re-rendered layouts retained one badge per supported row.
- Gmail OAuth refresh succeeded. A bounded one-thread sync completed with one processed case and zero errors. Six real attachments were persisted (12,535,204 bytes total), and all six file hashes matched recorded SHA-256 provenance. The shared pipeline stored classification. No mailbox content, identifiers, tokens or attachment files are included in this report or Git.
- Outbound automation remained disabled; no real send/revocation was performed. Revocation, invalid grant, expired state, wrong mailbox, partial scopes, token encryption and restart behavior are tested with fixtures.

## Automated coverage

All 222 tests across 30 files passed. Type checking, lint and the extension build passed. The built extension was checked against configured credential values and contained none. A repeated live sync processed the thread again and retained one case without duplication or errors. Coverage includes nested Gmail thread IDs, row replacement/reordering, unsupported/hidden Outlook rows, stale asynchronous results, visible errors and uncertainty, retry isolation, native row clicks, disabled settings, account changes, cache revisions, OAuth state/PKCE, expired authorization and durable polling cursors.

## Layout limits

Selectors are centralized in `apps/extension/src/adapters.ts`. Gmail identity can live on a nested subject span. Outlook Live currently uses `data-convid` plus observed subject/sender/preview classes; these classes may change upstream. Semantic subject selectors remain supported. Unrecognized rows are skipped instead of classifying arbitrary navigation text. No Gmail OAuth or Microsoft Graph authorization is needed for DOM previews; the local classifier API must be reachable.

`outlook.office.com` and `outlook.office365.com` are allowed hosts with fixture coverage, but were not tested in a live organizational tenant. Mobile/basic HTML layouts, translated layouts and future provider DOM changes are not guaranteed. Only rendered inbox previews are classified; badges do not establish SI/BL evidence or constitute full-thread verification.

## Reproduce

1. Configure `.env` and run `npm run dev`.
2. Run `npm run build:extension`; load `apps/extension/dist` unpacked in Chrome, then reload mailbox tabs.
3. Check badges, native selection, keyboard focus and pagination/sorting. Confirm a maximum of one badge per supported row.
4. Configure OAuth as described in README. With sending disabled, submit one bounded `/gmail/sync` request and inspect its event and persisted evidence.
5. Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build:extension`.
