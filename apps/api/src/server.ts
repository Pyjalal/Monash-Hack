import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { questionVersion } from '@cargolens/shared/questions';
import { createJevProvider } from './ai/jev.js';
import { createApp } from './app.js';
import { ClassificationService } from './pipeline.js';
import { Store } from './store.js';

if (!process.env.TYPESAFE_API_KEY || !process.env.DASHBOARD_TOKEN) throw new Error('Set TYPESAFE_API_KEY and DASHBOARD_TOKEN in the local .env file');
const dbPath = resolve(process.env.DATABASE_PATH ?? 'runtime/cargolens.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
const model = process.env.TYPESAFE_MODEL ?? 'jev-1.13.0';
const variant = process.env.JEV_PROMPT_VARIANT === 'boundaries' ? 'boundaries' : 'concise';
const provider = createJevProvider({ apiKey: process.env.TYPESAFE_API_KEY, model, variant, mode: 'full' });
const service = new ClassificationService({ store, classifier: provider.classify, configurationKey: `${model}:${questionVersion(variant, 'full')}`,
  concurrency: Number(process.env.JEV_CONCURRENCY ?? 24), requestsPerMinute: Number(process.env.JEV_REQUESTS_PER_MINUTE ?? 1100) });
const app = createApp({ store, service, dashboardToken: process.env.DASHBOARD_TOKEN,
  datasetRoot: resolve(process.env.DATASET_ROOT ?? 'training_data/sdoc-hackathon-docker/extracted/data_v2'),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') });
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3001), hostname: process.env.HOST ?? '127.0.0.1' }, info => {
  console.log(`CargoLens API listening on http://${info.address}:${info.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { store.close(); process.exit(0); }));
