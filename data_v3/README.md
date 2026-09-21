# SDOC Synthetic Dataset v3 (`data_v3`)

## Overview

`data_v3` is a high-realism, high-difficulty synthetic shipping-document inbox designed specifically to stress-test machine learning and LLM systems on:
1. **Email Classification**: Accurately routing emails to `BL_COMPARISON` (and distinguishing from boundary cases like `SI_REQUEST`, `INVOICE_QUERY`, `GENERAL`, `SPAM`) in the presence of real-world noise (deep forwarded threads, conflicting historical topics, cryptic desk codes, mobile abbreviations, and multi-lingual snippets).
2. **Document Data Extraction**: Extracting the 7 core comparison fields (`shipper`, `consignee`, `notify_party`, `port_of_loading`, `port_of_discharge`, `container_count`, `gross_weight_kg`) from multi-format attachments (`.txt`, `.pdf`, `.docx`, `.xlsx`) despite extreme label synonymy, complex multi-line addresses, and tabular container layouts.
3. **Discrepancy Detection & Reliability Review**: Detecting planted defects (subtle weight shifts, container changes, address mutations) and escalating uncertain cases to `NEEDS_REVIEW` (`wrong_doc_type`, `missing_attachment`, `unreadable`, `missing_value`).

---

## Key Metrics & Difficulty Distribution

- **Total Emails**: 220
- **Average Difficulty**: 80.00 / 100
- **Emails with Difficulty $\ge$ 70**: **179 (81.4%)** (exceeding the majority requirement)
- **Attachment Files**: 347 files spanning `.txt`, `.pdf`, `.docx`, and `.xlsx`

| Difficulty Tier | Score Range | Count | Percentage | Key Characteristics |
|---|---|---|---|---|
| **Easy** | 0 – 45 | 15 | 6.8% | Clean benchmark emails with standard plain-text attachments, zero thread noise, and no conflicting text. Perfect for pipeline sanity tests. |
| **Medium** | 46 – 69 | 26 | 11.8% | Standard business logistics emails, mild thread depth (1 level), plain text attachments, subtle defects. |
| **Hard** | 70 – 84 | 73 | 33.2% | Dense desk codes, multi-level forwarded threads, binary attachments (`pdf+pdf`, `xlsx+docx`, `xlsx+xlsx`), label synonyms, subtle defects ($\pm 500$ kg weight, $\pm 1$ container). |
| **Adversarial** | 85 – 100 | 106 | 48.2% | Edge cases (`unreadable` scanned PDFs, `wrong_doc_type`, `missing_value` blank fields, `missing_attachment`), deep conflicting threads (invoice/berthing history), external warning banners, bilingual Chinese/Arabic text, mobile typos, boundary collision cases. |

---

## Category & Status Mix

### Category Distribution (n = 220)
- **`BL_COMPARISON`**: 190 emails (86.4%)
  - Clean `OK`: 50 emails
  - Mismatch `MISMATCH` (1, 2, or 3 injected field defects): 90 emails
  - Human Escalation `NEEDS_REVIEW` (10 each of the 4 review reasons): 40 emails
  - Draft Request (No attachments yet): 10 emails
- **Boundary Distractor Categories**: 30 emails (13.6%)
  - **`SI_REQUEST`**: 12 emails (mentions draft BL in thread to test boundary discrimination)
  - **`INVOICE_QUERY`**: 8 emails (mentions bill of lading numbers and shipping refs in subject)
  - **`GENERAL`**: 6 emails (berthing updates, delivery planning, RPA bot summaries)
  - **`SPAM`**: 4 emails (logistics phishing mimicking carrier notifications)

---

## File Structure

```
data_v3/
├── inbox/                  220 × email_XXX.json
├── attachments/            347 attachment files (txt, pdf, docx, xlsx)
├── ground_truth.json       Complete evaluation key (classification, defects, extraction, difficulty)
├── difficulty_scores.json  Dedicated difficulty breakdown and distribution statistics
├── sample_submission.json  Ready-to-use template matching the required evaluation format
└── README.md               Dataset documentation
```

---

## Record Schemas

### 1. Inbox Record (`inbox/email_XXX.json`)
```json
{
  "email_id": "email_004",
  "from": "faraz_ali@aprilasia.com",
  "subject": "URGENT AMENDMENT // Draft BL Check - MSC(MEDUUD192831) - Cut-off 17:00",
  "body": "Dear Eileen,\n\nCarrier has issued the revised draft Bill of Lading...",
  "attachments": [
    "attachments/email_004_SI.pdf",
    "attachments/email_004_BL.pdf"
  ]
}
```

### 2. Ground Truth (`ground_truth.json`)
Fully compatible with existing competition evaluation scripts (`scoring.py`, `evaluate.js`), while enriched with extraction ground truth and difficulty metrics:

```json
{
  "email_004": {
    "category": "BL_COMPARISON",
    "status": "MISMATCH",
    "review_reason": null,
    "defect_fields": ["gross_weight_kg"],
    "has_defect": true,
    "difficulty_score": 87,
    "difficulty_tier": "adversarial",
    "difficulty_factors": [
      "binary_format_pdf_table_parsing",
      "deep_forwarded_thread_with_distractor_topics",
      "urgent_amendment_pressure_and_noise",
      "label_synonym_normalization_differing_headers",
      "subtle_weight_delta_500kg"
    ],
    "extraction_ground_truth": {
      "si": {
        "shipper": "APRIL FINE PAPER TRADING (MIDDLE EAST) FZE",
        "consignee": "AL GURG STATIONERY LLC",
        "notify_party": "AL GURG STATIONERY LLC",
        "port_of_loading": "SINGAPORE, SINGAPORE",
        "port_of_discharge": "JEBEL ALI, UAE",
        "container_count": 3,
        "gross_weight_kg": 68500
      },
      "bl": {
        "shipper": "APRIL FINE PAPER TRADING (MIDDLE EAST) FZE",
        "consignee": "AL GURG STATIONERY LLC",
        "notify_party": "AL GURG STATIONERY LLC",
        "port_of_loading": "SINGAPORE, SINGAPORE",
        "port_of_discharge": "JEBEL ALI, UAE",
        "container_count": 3,
        "gross_weight_kg": 68000
      }
    }
  }
}
```

### 3. Difficulty Scores (`difficulty_scores.json`)
Includes full dataset summary and per-email factor attribution:
```json
{
  "metadata": {
    "dataset_version": "data_v3",
    "total_emails": 220,
    "created_for": "BL_COMPARISON classification & extraction benchmark"
  },
  "summary": {
    "total_emails": 220,
    "average_difficulty": 80.0,
    "count_difficulty_ge_70": 179,
    "percentage_ge_70": 81.36,
    "tier_distribution": {
      "easy (0-45)": 15,
      "medium (46-69)": 26,
      "hard (70-84)": 73,
      "adversarial (85-100)": 106
    }
  },
  "scores": {
    "email_001": {
      "score": 85,
      "tier": "adversarial",
      "category": "BL_COMPARISON",
      "status": "MISMATCH",
      "attachment_formats": ["pdf", "pdf"],
      "factors": [...]
    }
  }
}
```

---

## The 7 Extracted & Compared Fields

1. `shipper` (e.g. `APRIL FINE PAPER TRADING (MIDDLE EAST) FZE`)
2. `consignee` (e.g. `AL GURG STATIONERY LLC`)
3. `notify_party` (e.g. `AL GURG STATIONERY LLC` or separate party)
4. `port_of_loading` (e.g. `SINGAPORE, SINGAPORE (SGSIN)`)
5. `port_of_discharge` (e.g. `JEBEL ALI, UAE (AEJEA)`)
6. `container_count` (e.g. `3` or `3 x 40'HC`)
7. `gross_weight_kg` (e.g. `68500`)

---

## How to Test and Evaluate

### 1. Run Classification with Jev Classifier
```bash
node src/classification/cli.js --data-dir data_v3 --output outputs/v3-submission.json --details outputs/v3-details.json
```

### 2. Evaluate Classification Metrics
```bash
node src/classification/evaluate.js outputs/v3-submission.json data_v3/ground_truth.json
```

### 3. Run End-to-End Scorer
```bash
python training_data/sdoc-hackathon-docker/extracted/server/score_cli.py outputs/v3-submission.json --ground-truth data_v3/ground_truth.json
```

### 4. Inspect Predictions in the Viewer Dashboard
You can point the viewer to `data_v3`:
```bash
npm run viewer
```
