# Extension epic acceptance — issue #16

Verified on 2026-09-20 against the current extension and merged backend.

## Acceptance evidence

- The unpacked extension renders category and urgency previews without a CargoLens dashboard account. After rebuilding and refreshing the mailbox, Chrome Work showed 50 badges for 50 Gmail rows with no duplicates, and 10 badges for 10 Outlook Live conversation rows.
- Native Gmail selection was checked and restored. Outlook selection was checked and restored to “No items selected.” Previous pagination, sorting and keyboard checks are recorded in `connector-verification.md`.
- Urgent highlighting, optional pinning, spam hiding and restoration of original row order are covered by content-controller tests. Both disabling the extension and losing its runtime context restore hidden/pinned rows and remove injected presentation.
- Classification remains server-side. The built extension was scanned against configured key, secret, token and password values from the local environment; zero matches were found. No secret values or mailbox contents are included in this report.
- All four child issues (#47, #48, #49, #50) are closed.

## Reload failure and correction

Chrome can invalidate an old content script when the extension is reloaded while a mailbox tab remains open. Runtime messaging can then throw synchronously, bypassing the previous Promise `.catch()` handlers. Three regression cases failed before the correction: synchronous polling failure, asynchronous context loss, and startup failure with invalid listener cleanup.

All content-controller messaging now crosses an asynchronous error boundary. Context loss permanently stops that controller, cancels its timers, disconnects observation, removes event listeners and restores the inbox presentation. Delayed settings and messages cannot restart it. Listener removal after context invalidation cannot prevent DOM cleanup.

After the mailbox refresh, no new context-invalidated errors were captured in Gmail or Outlook. Gmail's log retained one historical error from before refresh. A real second extension-reload cycle was not automated; synchronous and asynchronous context invalidation are reproduced deterministically in tests. Already-injected older code requires one mailbox refresh after installing this correction.

## Validation and limits

- Full suite: 261 tests across 36 files passed before adding one further layout-restoration scenario; the final content suite passes all 15 cases.
- Type checking, lint and the extension build passed.
- Existing PDF fixture tests emit font-data warnings unrelated to this extension change.
- Live checks cover Gmail standard desktop and Outlook Live in English. Organizational Outlook hosts remain fixture-tested, as documented in `connector-verification.md`.
- Badges classify rendered previews, not full shipping-document evidence. Uncertainty and backend failures remain visible and retryable.
