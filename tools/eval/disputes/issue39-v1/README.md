# Pending source-backed disputes, version 1

`ledger.json` proposes three capability disputes for `email_512`, `email_513`
and `email_514`, affecting only `review_reason`. No correction is accepted or
proposed. Reviewer and review timestamp remain unset pending human adjudication.

`observations.json` is a byte-for-byte copy of the existing source-only OCR
verification artifact. Each ledger span identifies one exact observation object;
the validator checks the artifact hash and the original SI/BL attachment hashes.
Both documents for each case recovered with no unresolved pages. This supports
reviewing the meaning of `unreadable`, but does not prove accurate extraction,
equal fields, an `OK` status, or authorization to send a confirmation.

Reviewer decision: does the benchmark's `unreadable` convention refer to native
text only, or to readability after supported OCR? Reject the dispute if the
native-only convention is intentional. Keep it proposed if the contract is
unclear. An accepted replacement needs separately reviewed, exact source-text
evidence and a schema-valid corrected row; reader observations alone cannot be
accepted. Record the actual human reviewer and timestamp, never an invented one.

The seven successful-inference category disagreements were source-triaged as
semantic errors in the accompanying report. They do not create label disputes.
All five supported dispute kinds remain available; this audit does not invent
examples of kinds that the inspected evidence does not establish.
