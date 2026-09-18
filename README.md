# Monash-Hack

Private starter repository for the Monash hackathon, configured for Vercel AI Gateway and the SDOC training dataset.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and add your Vercel AI Gateway key.
3. Run the agent integration setup when needed:

   ```bash
   npm run gateway:setup
   ```

The required environment variable is `AI_GATEWAY_API_KEY`. The real `.env` file is ignored by Git and must never be committed.

## Training data

The downloaded `sdoc-hackathon-docker.zip` archive is stored at:

`training_data/sdoc-hackathon-docker/`

The extracted bundle contains:

- `data_v2/`: 520 synthetic shipping-document inbox records, attachments, sample submissions, and ground truth.
- `server/`: FastAPI serving, loading, bundle-building, and scoring utilities.
- `docker-compose.yml`: optional local scoring server configuration.

The dataset includes `data_v2/ground_truth.json`, so this repository must remain private until the answer key is intentionally released.

See [the dataset README](training_data/sdoc-hackathon-docker/extracted/data_v2/README.md) for the schema, categories, edge cases, and regeneration instructions.
