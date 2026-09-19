import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Store } from './store.js';
import { loadDataset } from './dataset.js';

describe('durable source processing', () => {
  it('replays recorded events and preserves queued work across process restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cargolens-db-'));
    try {
      const path = join(root, 'store.sqlite'); const store = new Store(path);
      store.upsertEmail({ id: 'case', subject: 'Please verify BL', from: 'ops@example.test', body: 'Please check attached documents', attachments: [], contentScope: 'full_message' });
      const event = store.eventsAfter(0)[0]; store.close();
      const reopened = new Store(path);
      expect(reopened.getCase('case')?.status).toBe('queued');
      expect(reopened.eventsAfter(0)[0]).toEqual(event);
      expect(reopened.eventsAfter(event.sequence)).toEqual([]);
      reopened.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('imports only source messages even when the answer key is invalid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cargolens-import-'));
    try {
      await mkdir(join(root, 'inbox'));
      await writeFile(join(root, 'ground_truth.json'), 'DO NOT READ ANSWER KEYS');
      await writeFile(join(root, 'inbox', 'arbitrary-name.json'), JSON.stringify({ email_id: 'case', from: 'x', subject: 'SI', body: 'Shipping instructions are below', attachments: ['attachments/source.txt'] }));
      const emails = await loadDataset(root);
      expect(emails).toHaveLength(1); expect(emails[0].id).toBe('case');
      expect(emails[0].attachments[0].relativePath).toBe('attachments/source.txt');
      await writeFile(join(root, 'inbox', 'arbitrary-name.json'), JSON.stringify({ email_id: 'case', from: 'x', subject: 'SI', body: 'Text', attachments: ['../../outside.txt'] }));
      await expect(loadDataset(root)).rejects.toThrow('escapes');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
