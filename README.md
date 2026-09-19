# Monash-Hack

Private starter repository for the Monash hackathon, configured for OpenRouter and the SDOC training dataset.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and add your OpenRouter key.
3. Run `npm install`.

The required environment variable is `OPENROUTER_API_KEY`. The real `.env`
file is ignored by Git and must never be committed.

## Training data

The downloaded `sdoc-hackathon-docker.zip` archive is stored at:

`training_data/sdoc-hackathon-docker/`

The extracted bundle contains:

- `data_v2/`: 520 synthetic shipping-document inbox records, attachments, sample submissions, and ground truth.
- `server/`: FastAPI serving, loading, bundle-building, and scoring utilities.
- `docker-compose.yml`: optional local scoring server configuration.

The dataset includes `data_v2/ground_truth.json`, so this repository must remain private until the answer key is intentionally released.

See [the dataset README](training_data/sdoc-hackathon-docker/extracted/data_v2/README.md) for the schema, categories, edge cases, and regeneration instructions.

## Stage 1: Jev email classification

The first pipeline stage classifies every email into `BL_COMPARISON`,
`SI_REQUEST`, `INVOICE_QUERY`, `GENERAL`, or `SPAM` with TypeSafe AI's Jev
evaluation model through OpenRouter. The pinned model is `typesafe/jev-1.13`.

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY in .env, then:
npm install
npm run classify
```

The run writes a scorer-compatible submission to
`outputs/jev-classification-submission.json` and confidence details to
`outputs/jev-classification-details.json`. To smoke-test a smaller run first:

```bash
npm run classify -- --limit 10 --batch-size 5 --concurrency 1
```

Evaluate Stage 1 against the organizer-only answer key:

```bash
npm run classify:evaluate
```

Review predictions against the ground truth in the local dashboard:

```bash
npm run viewer
# open http://127.0.0.1:4173
```

The dashboard can filter correct and incorrect predictions, search by email,
show category-level accuracy, inspect complete message bodies, and preview or
download TXT, PDF, DOCX, and XLSX attachments. When `data_v3` predictions are
available, the dashboard combines both datasets and provides a dataset filter
and dataset badge for every email.

Classify and evaluate the synthetic v3 dataset separately:

```bash
npm run classify -- --data-dir data_v3 \
  --output outputs/jev-v3-submission.json \
  --details outputs/jev-v3-details.json
npm run classify:evaluate -- outputs/jev-v3-submission.json data_v3/ground_truth.json
```
