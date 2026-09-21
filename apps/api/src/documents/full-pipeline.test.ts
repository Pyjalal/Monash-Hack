import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EmailSchema } from '@cargolens/shared';
import { compareCaseWithFullPipeline, extractWithFullPipeline } from './full-pipeline.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const fields = 'Shipper: Acme\nConsignee: Buyer\nNotify Party: Agent\nPort of loading: North Port\nPort of discharge: South Port\nContainer count: 2\nGross weight: 100 KG';

async function fixture(blFields = fields) {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-full-pipeline-')); roots.push(root);
  await writeFile(join(root, 'si.txt'), `SHIPPING INSTRUCTIONS\nShipment reference: SHIP-1000\n${fields}`);
  await writeFile(join(root, 'bl.txt'), `BILL OF LADING\nShipment reference: SHIP-1000\n${blFields}`);
  const email = EmailSchema.parse({ id: 'operational', subject: 'Verify shipment', from: 'ops@example.test', attachments: [
    { id: 'si', name: 'si.txt', relativePath: 'si.txt', mimeType: 'text/plain' },
    { id: 'bl', name: 'bl.txt', relativePath: 'bl.txt', mimeType: 'text/plain' },
  ] });
  return { root, email };
}

it('uses the same full-pipeline result for evaluation and operational decisions', async () => {
  const { root, email } = await fixture(fields.replace('Shipper: Acme', 'Shipper: Other'));
  const fallback = vi.fn();
  const compareFallback = async () => ({});
  const evaluated = await extractWithFullPipeline(email, root, fallback, compareFallback, null);
  const operational = await compareCaseWithFullPipeline({
    email, sourceVersion: 'source-v1', classification: null, decision: null,
    status: 'classified', updatedAt: new Date().toISOString(),
  }, root, { fallback, compareFallback, vision: null });

  expect(evaluated.defect_fields).toEqual(['shipper']);
  expect(operational.decision).toMatchObject({
    workflowState: 'MISMATCH', verificationState: 'COMPLETE', knownMismatches: ['shipper'],
    pairValidated: true, nextAction: 'REQUEST_AMENDMENT',
  });
  expect(operational.decision.fieldResults).toHaveLength(7);
  expect(operational.decision.fieldResults.every(result => result.si?.locator.startsWith('chars:') && result.bl?.locator.startsWith('chars:'))).toBe(true);
});

it('keeps placeholder handling blocked in operational state exactly as in the full pipeline', async () => {
  const { root, email } = await fixture(fields.replace('Consignee: Buyer', 'Consignee: TBC'));
  const compareFallback = async () => ({ consignee: { equivalent: false, confidence: 0.99, placeholder: true } });
  const operational = await compareCaseWithFullPipeline({
    email, sourceVersion: 'source-v1', classification: null, decision: null,
    status: 'classified', updatedAt: new Date().toISOString(),
  }, root, { fallback: vi.fn(), compareFallback, vision: null });

  expect(operational.decision.workflowState).toBe('BLOCKED');
  expect(operational.decision.knownMismatches).not.toContain('consignee');
  expect(operational.decision.fieldResults.find(result => result.field === 'consignee')?.outcome).toBe('MISSING');
});
