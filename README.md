# Monash-Hack

Private starter repository for the Monash hackathon, configured for Vercel AI Gateway.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and add your Vercel AI Gateway key.
3. Run the agent integration setup when needed:

   ```bash
   npm run gateway:setup
   ```

The required environment variable is `AI_GATEWAY_API_KEY`. The real `.env` file is ignored by Git and must never be committed.

