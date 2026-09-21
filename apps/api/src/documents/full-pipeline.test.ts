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
  const compareFallback = async () => ({ shipper: { equivalent: false, confidence: 0.99 } });
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

it('blocks pairs without an explicit shared shipment reference', async () => {
  const { root, email } = await fixture();
  await writeFile(join(root, 'si.txt'), `SHIPPING INSTRUCTIONS\n${fields}`);
  await writeFile(join(root, 'bl.txt'), `BILL OF LADING\n${fields}`);
  const result = await extractWithFullPipeline(email, root, vi.fn(), async () => ({}), null);
  expect(result.review_reason).toBe('missing_value');
  expect(result.documents.blockers).toContain('SHIPMENT_REFERENCE_UNVERIFIED');
});

it.each([0.4, NaN, Infinity, 1.1])('rejects unsupported semantic match confidence %s', async confidence => {
  const { root, email } = await fixture(fields.replace('Shipper: Acme', 'Shipper: Ac me'));
  const result = await extractWithFullPipeline(email, root, vi.fn(), async () => ({shipper: {equivalent: true, confidence}}), null);
  expect(result.review_reason).toBe('missing_value');
  expect(result.defect_fields).not.toContain('shipper');
});

it('cannot erase different source facts with a confident model match', async () => {
  const { root, email } = await fixture(fields.replace('Shipper: Acme', 'Shipper: Other'));
  const result = await extractWithFullPipeline(email, root, vi.fn(), async () => ({shipper: {equivalent: true, confidence: 0.99}}), null);
  expect(result.review_reason).toBe('missing_value');
  expect(result.comparison?.shipper.matches).toBe(false);
});

it('rejects source changes during model recovery', async () => {
  const { root, email } = await fixture(fields.replace('Shipper: Acme', 'Shipper: Ac me'));
  const result = await extractWithFullPipeline(email, root, vi.fn(), async () => {
    await writeFile(join(root, 'bl.txt'), 'BILL OF LADING\nChanged source');
    return {shipper: {equivalent: true, confidence: 0.99}};
  }, null);
  expect(result.review_reason).toBe('missing_value');
  expect(result.documents.blockers).toContain('SOURCE_HASH_CHANGED');
});

it('records the benchmark kilogram convention without allowing it in operations', async () => {
  const { root, email } = await fixture(fields.replace('100 KG', '100'));
  const live = await extractWithFullPipeline(email, root, vi.fn(), async () => ({}), null);
  const benchmark = await extractWithFullPipeline(email, root, vi.fn(), async () => ({}), null, { assumeKilograms: true });
  expect(live.review_reason).toBe('missing_value');
  expect(benchmark.review_reason).toBeNull();
  expect(benchmark.assumptions).toContain('bl:gross_weight_kg:benchmark_assumed_kg');
});

it.each([
  ['BUATAN, INDONESIA', 'IDBUA'],
  ['RUGAO/NANTONG/SHANGHAI, CHINA', 'CNSHA'],
])('uses the competition port rule in live decisions for %s', async (siPort, blPort) => {
  const { root, email } = await fixture(fields.replace('North Port', blPort));
  await writeFile(join(root, 'si.txt'), `SHIPPING INSTRUCTIONS\nShipment reference: SHIP-1000\n${fields.replace('North Port', siPort)}`);
  const result = await compareCaseWithFullPipeline({ email, sourceVersion: 'ports-v1', classification: null, decision: null, status: 'classified', updatedAt: new Date().toISOString() }, root, { fallback: vi.fn(), compareFallback: vi.fn(), vision: null });
  expect(result.decision.workflowState).toBe('VERIFIED');
  expect(result.decision.fieldResults.find(field => field.field === 'port_of_loading')).toMatchObject({ outcome: 'MATCH', si: { text: siPort }, bl: { text: blPort } });
});
