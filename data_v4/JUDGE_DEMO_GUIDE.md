# Judge demo: prove robustness without overclaiming

## The headline

Use two clearly separated claims:

1. **Official benchmark:** “Observed exact accuracy: X/Y on the untouched
   organizer ground truth.” Show the frozen dataset hash and run artifact.
2. **Authored adversarial stress test:** “The same frozen pipeline passed X/100
   deliberately difficult cases, with N false clears.” Do not call this a blind
   or independent benchmark.

Only say “100%” when all expected targets match: category, final status, review
reason, exact defect-field set, and `has_defect`. A category-only score should be
labelled “classification accuracy,” not “system accuracy.”

For a perfect 520/520 observed result, the two-sided 95% Wilson interval is
approximately 99.3%–100%. For 100/100 on this pack, it is approximately
96.3%–100%. This communicates both the strong result and the finite sample size.

## Recommended 90-second sequence

1. Show one scorecard with the numerator and denominator, not only a large
   percentage: `520/520` official and `X/100` adversarial.
2. Show a three-by-three **status confusion matrix** for `OK`, `MISMATCH`, and
   `NEEDS_REVIEW`. Highlight **false clears** because incorrectly approving a
   bad or unreadable document is the highest-risk error.
3. Open four cases from `spotlight_cases.json`:
   - a semantic match expressed in KG versus metric tonnes;
   - a one-container difference that must be caught;
   - a commercial invoice masquerading as a draft B/L;
   - a blank required value that must be escalated rather than guessed.
4. For each case, show the source excerpt, expected result, pipeline result, and
   evidence location. End with “the model proposes; deterministic evidence and
   safety gates decide.”

## Best charts

- **KPI row:** exact rows passed, false clears, mismatch-field recall, safe
  escalation recall, and p95 latency.
- **Status confusion matrix:** reveals whether 100% hides class imbalance.
- **Challenge-family heatmap:** one row per family from
  `challenge_manifest.json`; green only when every case in that family passes.
- **Four-case evidence gallery:** more persuasive than scrolling through 100
  emails.

Keep latency and accuracy on separate axes. Include the model/version, prompt or
rules revision, dataset hash, seed, and run timestamp in a small reproducibility
footer.
