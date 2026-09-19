#!/usr/bin/env python3
"""Verification test suite for data_v3 synthetic dataset."""

import json
from pathlib import Path

def test_dataset():
    data_dir = Path("data_v3")
    inbox = sorted((data_dir / "inbox").glob("email_*.json"))
    attachments = sorted((data_dir / "attachments").iterdir())
    gt = json.loads((data_dir / "ground_truth.json").read_text(encoding="utf-8"))
    diff = json.loads((data_dir / "difficulty_scores.json").read_text(encoding="utf-8"))
    sub = json.loads((data_dir / "sample_submission.json").read_text(encoding="utf-8"))

    print(f"Total emails in inbox: {len(inbox)}")
    print(f"Total attachment files: {len(attachments)}")
    print(f"Ground truth records: {len(gt)}")
    print(f"Difficulty records: {len(diff['scores'])}")
    print(f"Sample submission records: {len(sub)}")

    assert len(inbox) == 220, f"Expected 220 emails, found {len(inbox)}"
    assert len(gt) == 220, f"Expected 220 ground truth entries, found {len(gt)}"
    assert len(diff["scores"]) == 220, f"Expected 220 difficulty scores, found {len(diff['scores'])}"
    assert len(sub) == 220, f"Expected 220 submission entries, found {len(sub)}"

    # Check difficulty statistics
    summary = diff["summary"]
    print("\nDifficulty Summary:")
    print(f"  Average Difficulty: {summary['average_difficulty']}")
    print(f"  Emails >= 70: {summary['count_difficulty_ge_70']} ({summary['percentage_ge_70']}%)")
    print("  Tier Breakdown:")
    for tier, count in summary["tier_distribution"].items():
        print(f"    {tier}: {count}")

    assert summary["count_difficulty_ge_70"] >= 150, "Expected at least 150 emails with difficulty >= 70"
    assert summary["percentage_ge_70"] >= 70.0, "Expected >= 70% of emails to have difficulty >= 70"

    # Validate attachment references
    missing_attachments = []
    category_counts = {}
    status_counts = {}
    formats_found = set()

    for p in inbox:
        rec = json.loads(p.read_text(encoding="utf-8"))
        eid = rec["email_id"]
        assert eid in gt, f"Missing ground truth for {eid}"
        cat = gt[eid]["category"]
        stat = gt[eid]["status"]
        category_counts[cat] = category_counts.get(cat, 0) + 1
        status_counts[stat] = status_counts.get(stat, 0) + 1

        for att in rec["attachments"]:
            att_path = data_dir / att
            if not att_path.exists():
                missing_attachments.append((eid, att))
            formats_found.add(att_path.suffix.lower())

    assert len(missing_attachments) == 0, f"Missing attachments: {missing_attachments}"
    print("\nAttachment File Types Found:", sorted(formats_found))
    print("Categories in data_v3:", category_counts)
    print("Status in data_v3:", status_counts)

    # Check extraction ground truth
    extraction_count = sum(1 for v in gt.values() if v.get("extraction_ground_truth") is not None)
    print(f"Emails with extraction ground truth: {extraction_count}")

    # Test scoring.py compatibility
    import sys
    sys.path.insert(0, str(Path("training_data/sdoc-hackathon-docker/extracted/server").resolve()))
    import scoring
    score_result = scoring.score_all(gt, sub)
    print("\nScorer Compatibility Test:")
    print(f"  Successfully graded against scoring.py! n_emails = {score_result['n_emails']}")
    print(f"  Stage 1 accuracy with default dummy submission = {score_result['stage1']['accuracy']:.3f}")

    print("\nALL VERIFICATIONS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_dataset()
