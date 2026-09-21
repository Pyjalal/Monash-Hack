#!/usr/bin/env python3
"""Create a transparent robustness scorecard for this adversarial pack."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TARGET_KEYS = ("category", "status", "review_reason", "defect_fields", "has_defect")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical(row: dict) -> dict:
    value = {key: row.get(key) for key in TARGET_KEYS}
    value["defect_fields"] = sorted(value.get("defect_fields") or [])
    return value


def wilson(successes: int, total: int, z: float = 1.959963984540054) -> list[float] | None:
    if total == 0:
        return None
    proportion = successes / total
    denominator = 1 + z * z / total
    centre = (proportion + z * z / (2 * total)) / denominator
    margin = z * math.sqrt((proportion * (1 - proportion) + z * z / (4 * total)) / total) / denominator
    return [round(max(0.0, centre - margin), 6), round(min(1.0, centre + margin), 6)]


def rate(successes: int, total: int) -> dict:
    return {
        "passed": successes,
        "total": total,
        "rate": round(successes / total, 6) if total else None,
        "wilson_95": wilson(successes, total),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("predictions", type=Path, help="Pipeline submission JSON")
    parser.add_argument("--output", type=Path, help="Optional scorecard JSON path")
    args = parser.parse_args()

    truth = load(ROOT / "ground_truth.json")
    manifest = load(ROOT / "challenge_manifest.json")
    predictions = load(args.predictions.resolve())
    ids = sorted(truth)
    missing = [eid for eid in ids if eid not in predictions]
    unexpected = sorted(set(predictions) - set(truth))

    exact_ids: list[str] = []
    category_hits = status_hits = 0
    false_clears: list[str] = []
    status_confusion: dict[str, Counter] = defaultdict(Counter)
    family_rows: dict[str, list[bool]] = defaultdict(list)
    family_by_id = {case["email_id"]: case["family"] for case in manifest["cases"]}

    for eid in ids:
        expected = canonical(truth[eid])
        actual = canonical(predictions[eid]) if eid in predictions else {}
        exact = actual == expected
        if exact:
            exact_ids.append(eid)
        category_hits += actual.get("category") == expected["category"]
        status_hits += actual.get("status") == expected["status"]
        status_confusion[expected["status"]][actual.get("status", "MISSING")] += 1
        family_rows[family_by_id[eid]].append(exact)
        if actual.get("status") == "OK" and expected["status"] != "OK":
            false_clears.append(eid)

    review_ids = [eid for eid in ids if truth[eid]["status"] == "NEEDS_REVIEW"]
    mismatch_ids = [eid for eid in ids if truth[eid]["status"] == "MISMATCH"]
    review_hits = sum(predictions.get(eid, {}).get("status") == "NEEDS_REVIEW" for eid in review_ids)
    mismatch_hits = sum(predictions.get(eid, {}).get("status") == "MISMATCH" for eid in mismatch_ids)
    field_exact = sum(
        sorted(predictions.get(eid, {}).get("defect_fields") or []) == sorted(truth[eid]["defect_fields"])
        for eid in mismatch_ids
    )

    scorecard = {
        "dataset": manifest["name"],
        "authored_stress_suite": True,
        "coverage": {"expected": len(ids), "submitted": len(set(ids) & set(predictions)), "missing_ids": missing, "unexpected_ids": unexpected},
        "exact_row_accuracy": rate(len(exact_ids), len(ids)),
        "category_accuracy": rate(category_hits, len(ids)),
        "status_accuracy": rate(status_hits, len(ids)),
        "mismatch_detection": rate(mismatch_hits, len(mismatch_ids)),
        "mismatch_field_exactness": rate(field_exact, len(mismatch_ids)),
        "safe_escalation_recall": rate(review_hits, len(review_ids)),
        "false_clear_count": len(false_clears),
        "false_clear_ids": false_clears,
        "status_confusion": {expected: dict(counts) for expected, counts in status_confusion.items()},
        "by_challenge_family": {family: rate(sum(values), len(values)) for family, values in sorted(family_rows.items())},
        "failed_exact_ids": [eid for eid in ids if eid not in exact_ids],
        "claim_guidance": "Report this separately as authored adversarial robustness, not as an independent or blind benchmark.",
    }
    rendered = json.dumps(scorecard, indent=2) + "\n"
    print(rendered, end="")
    if args.output:
        args.output.resolve().write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
