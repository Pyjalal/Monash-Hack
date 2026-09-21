import { Hono } from 'hono';
import type { Store } from '../store.js';
import { bodyLimit } from 'hono/body-limit';
import { ChatRequest, ChatService, type ChatOptions } from './service.js';

export function chatRoutes(options: ChatOptions & { store: Store }) {
  const app = new Hono();
  const service = new ChatService(options);
  let budget = 30;
  let updated = Date.now();
  let active = 0;
  app.use('*', bodyLimit({ maxSize: 40000, onError: c => c.json({ error: 'Message is too large.' }, 413) }));
  app.post('/', async c => {
    c.header('Cache-Control', 'no-store');
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: 'Send a JSON message.' }, 415);
    const parsed = ChatRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Enter a message of 1–1000 characters.' }, 400);
    budget = Math.min(30, budget + (Date.now() - updated) / 2000); updated = Date.now();
    if (budget < 1 || active >= 4) {
      c.header('Retry-After', '10');
      return c.json({ error: 'The assistant is busy. Try again in a moment.' }, 429);
    }
    budget--; active++;
    try { return c.json(await service.answer(parsed.data)); }
    finally { active--; }
  });
  return app;
}
