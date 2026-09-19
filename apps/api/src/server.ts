import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { questionVersion } from '@cargolens/shared/questions';
import { createJevProvider } from './ai/jev.js';
import { createJevBatchProvider } from './ai/jev-batch.js';
import { createApp } from './app.js';
import { ClassificationService } from './pipeline.js';
import { Store } from './store.js';
import { GmailAutomation, GmailClient } from './gmail/index.js';

if (!process.env.TYPESAFE_API_KEY || !process.env.DASHBOARD_TOKEN) throw new Error('Set TYPESAFE_API_KEY and DASHBOARD_TOKEN in the local .env file');
const dbPath = resolve(process.env.DATABASE_PATH ?? 'runtime/cargolens.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
const model = process.env.TYPESAFE_MODEL ?? 'jev-1.13.0';
const variant = process.env.JEV_PROMPT_VARIANT === 'concise' ? 'concise' : 'boundaries';
const provider = createJevProvider({ apiKey: process.env.TYPESAFE_API_KEY, model, variant, mode: 'full' });
const batch = createJevBatchProvider({ apiKey: process.env.TYPESAFE_API_KEY, model, variant, mode: 'full' });
const service = new ClassificationService({ store, classifier: provider.classify, batchClassifier: batch.classifyBatch,
  configurationKey: `${model}:${questionVersion(variant, 'full')}:packed-v1`, batchSize: Number(process.env.JEV_BATCH_SIZE ?? 8),
  concurrency: Number(process.env.JEV_CONCURRENCY ?? 8), requestsPerMinute: Number(process.env.JEV_REQUESTS_PER_MINUTE ?? 1100) });
const gmailEnabled = process.env.GMAIL_AUTOMATION_ENABLED === 'true';
const gmailConfigured = [process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REFRESH_TOKEN, process.env.GMAIL_MAILBOX_ADDRESS].every(Boolean);
if (gmailEnabled && !gmailConfigured) throw new Error('Gmail automation is enabled but OAuth configuration is incomplete');
const gmail = gmailConfigured ? new GmailAutomation({ store, service,
  client: new GmailClient({ clientId: process.env.GMAIL_CLIENT_ID!, clientSecret: process.env.GMAIL_CLIENT_SECRET!, refreshToken: process.env.GMAIL_REFRESH_TOKEN!, mailboxAddress: process.env.GMAIL_MAILBOX_ADDRESS!,
    authorizedAdditionalRecipients: process.env.GMAIL_DOCUMENTATION_CONTACT ? [process.env.GMAIL_DOCUMENTATION_CONTACT] : [] }),
  attachmentRoot: resolve(process.env.GMAIL_ATTACHMENT_ROOT ?? 'runtime/gmail-attachments'), enabled: gmailEnabled,
  documentationContact: process.env.GMAIL_DOCUMENTATION_CONTACT }) : undefined;
const app = createApp({ store, service, dashboardToken: process.env.DASHBOARD_TOKEN,
  datasetRoot: resolve(process.env.DATASET_ROOT ?? 'training_data/sdoc-hackathon-docker/extracted/data_v2'),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(','), gmail });
let poll: NodeJS.Timeout | undefined;
if (gmail && gmailEnabled) {
  store.db.exec('CREATE TABLE IF NOT EXISTS gmail_sync_cursor (mailbox TEXT PRIMARY KEY, token TEXT)');
  const mailbox = process.env.GMAIL_MAILBOX_ADDRESS!;
  const synchronize = async () => {
    if (gmail.status().busy) return;
    const saved = store.db.prepare('SELECT token FROM gmail_sync_cursor WHERE mailbox=?').get(mailbox) as {token:string|null} | undefined;
    try {
      const result = await gmail.sync({ pageToken: saved?.token ?? undefined });
      store.db.prepare('INSERT OR REPLACE INTO gmail_sync_cursor VALUES (?,?)').run(mailbox, result.nextPageToken ?? null);
      store.emit('gmail.sync.completed', null, result);
    } catch { store.emit('gmail.sync.failed', null, {}); }
  };
  const pollMs = Number(process.env.GMAIL_POLL_INTERVAL_MS ?? 30000);
  if (!Number.isFinite(pollMs) || pollMs < 5000) throw new Error('GMAIL_POLL_INTERVAL_MS must be at least 5000');
  poll = setInterval(() => { void synchronize(); }, pollMs); poll.unref();
  void synchronize();
}
void Promise.all(store.listCases(1000).filter(record => !record.email.id.startsWith('gmail:') && record.status === 'queued').map(record => service.processCase(record.email)));
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3001), hostname: process.env.HOST ?? '127.0.0.1' }, info => {
  console.log(`CargoLens API listening on http://${info.address}:${info.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { if (poll) clearInterval(poll); server.close(() => { store.close(); process.exit(0); }); });
