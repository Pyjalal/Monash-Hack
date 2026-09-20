# Issue #39: offline miss triage and dispute review

This report analyzes frozen run `2026-09-20T17-26-51.910Z-47c3f12a` from
[issue #37](../issue37-20260921/README.md). No model was called, no final run was
repeated, no inference rules were tuned, and `ground_truth.json` is unchanged.
All 520 source IDs, email/attachment hashes, reference bytes and consumed report
hashes were verified before analysis.

## Accounting

| Primary observed stage | Cases |
|---|---:|
| Agreement without a lossy convention | 284 |
| Future-draft label convention | 75 |
| Inference failure | 8 |
| Reader failure | 1 |
| Semantic/intent/document-role blocker | 152 |
| Total | 520 |

Stages overlap in `triage.json`: 161 exports failed, 153 cases have semantic
blockers/disagreements, one has a reader failure, and three have pending label
disputes. A refused export is an observed failure stage, not proof of an exporter
bug. Missing predictions count as missed targets, not observed field mismatches.

The 75 deferred-draft projections use the organizer's `OK` convention while the
product remains `AWAITING_DOCUMENTS`. These are documented schema conventions,
not corrected references or verified comparisons. The scorer's defaults for
missing rows remain a scorer limitation; its diagnostic score is not a headline.

116 failures have only `DOCUMENT_ROLES_UNVERIFIED`; 118 have that blocker in
total. Readable attachment text does not establish document roles or shipment
identity. These remain implementation/capability gaps, not automatic disputes.

## Source review of the seven classification disagreements

Eight additional classification misses (`email_097`–`email_104`) have no model
result and are inference failures. For the seven with model results, the current
email requests support the original categories:

| Source IDs (`data_v2/inbox/<id>.json`) | Source evidence | Triage |
|---|---|---|
| `email_314`, `email_422` | Missing GR for an invoice; asks to post GR to proceed with billing | Invoice/billing request; retain `INVOICE_QUERY` |
| `email_501`–`email_505` | “Kindly confirm the BL is in order.” Each explicitly identifies a non-BL second attachment | Comparison intent despite wrong document; retain `BL_COMPARISON` |

No model disagreement in this set creates a corrected reference. This is an
agent-authored triage assessment, not a human adjudication. The source hashes in
the input manifest bind these observations to the frozen emails.

## Pending human review

The [ledger](../../disputes/issue39-v1/ledger.json) contains three proposed
`CAPABILITY_ASSUMPTION` disputes: `email_512`, `email_513`, `email_514`.
The existing source-only OCR audit recovered both documents in each case with
no unresolved pages, while the official reason is `unreadable`. Each entry
cites exact spans in the copied observation artifact plus both source hashes.
The reviewer must resolve the native-only versus OCR-capable convention.

Only `review_reason` is quarantined: unresolved counts are category 0, status 0,
review_reason 3, defect_fields 0, has_defect 0. All three cases are in the frozen
development partition; their other four targets remain usable. There are zero
accepted corrections, and the version-1 overlay is identical to the official
references. OCR readability alone cannot authorize an accepted correction.

## Distinguishable scorecards

`scorecards.json` preserves the original official and reused-independent
scorecards. The official headline remains invalid (`score: null`) because only
359/520 rows exported. The reused independent classification validation is not
an unseen document test; independent document checks remain `NOT_RUN`.

The adjudicated section is explicitly evaluation-only: 359/517 correct
`review_reason` targets after three pending exclusions, and 359/520 for each
other exported target. These export-level exact-target scores differ from the
original classifier's 505/520 accuracy because classification can succeed while
export fails. The slight denominator change is not a model improvement.

`reference-overlay.json` records version, dataset/reference/ledger hashes and
accepted IDs. `optimization-targets.json` preserves development-only membership
and per-target exclusions. The original 139-case final partition stays outside
optimization; creating another run directory does not make it unseen data.

Reproduce into a new directory with the command in the
[evaluation README](../../README.md#offline-miss-triage). Review changes produce
a new ledger/output revision; existing output directories are refused.

Validation: ten focused evaluation/triage tests passed, root TypeScript checking
and targeted ESLint passed. Hash verification ran against all 520 original cases.
No runtime inference or outbound behavior was changed. Human disposition of the
three proposed disputes remains pending; no accepted label corrections are claimed.
