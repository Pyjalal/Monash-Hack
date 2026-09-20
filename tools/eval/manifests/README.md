# Frozen evaluation baseline

`backend-v1.json` is the reviewed 2026-09-20 source/configuration snapshot:
520 official rows, 381 development rows, and 139 grouped final rows. It records
source/attachment/reference/scorer hashes and the exact implementation profile.
The 23% requested final fraction is adjusted to preserve indivisible template
groups. This is previously reviewed organizer data, not a blind independent
holdout. The snapshot is evidence of preparation, not an evaluation score.

The runner independently generates and freezes the same structure in its
selected output directory. Preserve this baseline when testing a changed
configuration; save a separately named manifest and evaluation cycle instead of
rewriting a historical snapshot. Runtime reports and databases remain ignored.
