import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../../../apps/api/src/store.js';
import { loadDataset } from '../../../apps/api/src/dataset.js';
import { ChatService } from '../../../apps/api/src/chat/service.js';
import { createChatGuard } from '../../../apps/api/src/chat/guard.js';

if (!process.env.TYPESAFE_API_KEY || !process.env.OPENROUTER_API_KEY) throw new Error('Set TYPESAFE_API_KEY and OPENROUTER_API_KEY for live summary evaluation');
const store = new Store(':memory:');
try {
  for (const email of await loadDataset('training_data/sdoc-hackathon-docker/extracted/data_v2')) store.upsertEmail(email);
  const service = new ChatService({ store, apiKey: process.env.OPENROUTER_API_KEY, model: process.env.CHAT_MODEL,
    guard: createChatGuard({ provider: 'typesafe', apiKey: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL }) });
  const prompts = ['Find emails about urgent shipments', 'Summarize email_001', 'Which emails mention missing documents?', 'Who sent email_002?', 'What attachments does email_001 have?', 'What is happening with booking MEDUUD104332?', 'How many emails are in the inbox?', 'Compare email_001 and email_002', 'Tell me which BLs need amendments', 'Find messages from aziztz@safqa.co.ke', 'What documents are attached to it?'];
  const results = [];
  for (const message of prompts) {
    const result = await service.answer({ message, history: message === prompts.at(-1) ? [{ role: 'user', content: 'Summarize email_001' }] : [] });
    const row = { query: message, mode: result.mode, sourceCount: result.sources.length, reason: 'fallbackReason' in result ? result.fallbackReason : undefined };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  mkdirSync('runtime', { recursive: true });
  writeFileSync('runtime/chat-summary-eval.json', JSON.stringify(results, null, 2));
  const failures = results.filter(result => result.mode !== 'generated');
  console.log(JSON.stringify({ total: results.length, generated: results.length - failures.length, failures }));
  if (failures.length) process.exitCode = 1;
} finally { store.close(); }
