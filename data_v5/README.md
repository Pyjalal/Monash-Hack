# CargoLens real-world scenario dataset V5

V5 is a deterministic 60-email end-to-end dataset designed around realistic
shipping-operations boundaries rather than only difficult document layouts.
It covers classification, extraction, comparison, and safe deferral.

## Composition

| Family | Count | Expected behavior |
|---|---:|---|
| Verified SI/BL matches | 12 | Mixed TXT, DOCX, and XLSX pairs normalize to `OK` |
| Single-field SI/BL defects | 12 | One sourced defect becomes `MISMATCH` |
| Evidence-quality failures | 8 | Two each of missing attachment, wrong type, unreadable, and missing value |
| Future draft requests | 4 | Classify as BL comparison but defer extraction |
| SI provision | 8 | Classify as `SI_REQUEST`, despite asking for a future draft |
| Invoice queries | 6 | Classify as `INVOICE_QUERY` despite BL references |
| Operational updates | 6 | Classify as `GENERAL` |
| Logistics-themed spam | 4 | Classify as `SPAM` |

All document-verification cases carry a booking reference in both source
documents. Ground truth includes the exact SI and BL field values where useful.

Regenerate and run:

```powershell
node data_v5/generate.mjs
npm run pipeline:full -- --dataset v5
npm run dev:extraction-dashboard
```

The generated dashboard report is `outputs/pipeline/v5/report.json`.
