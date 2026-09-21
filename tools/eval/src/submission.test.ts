import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmailSchema } from '@cargolens/shared';
import { extract } from './submission.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fields = 'Shipper: Acme\nConsignee: Buyer\nNotify Party: Agent\nPort of loading: North Port\nPort of discharge: South Port\nContainer count: 2\nGross weight: 100 KG';
async function fixture(bl = fields, header = 'BILL OF LADING', reference = 'SHIP-1000') {
  const root = await mkdtemp(join(tmpdir(), 'cargolens-submission-')); roots.push(root);
  await writeFile(join(root, 'misleading_BL.txt'), `SHIPPING INSTRUCTIONS\nShipment reference: SHIP-1000\n${fields}`);
  await writeFile(join(root, 'misleading_SI.txt'), `${header}\nShipment reference: ${reference}\n${bl}`);
  const email = EmailSchema.parse({ id: 'neutral', subject: 'Verify shipment', from: 'ops@example.test', attachments: [
    { id: 'first', name: 'misleading_BL.txt', relativePath: 'misleading_BL.txt', mimeType: 'text/plain' },
    { id: 'second', name: 'misleading_SI.txt', relativePath: 'misleading_SI.txt', mimeType: 'text/plain' },
  ] });
  return { root, email };
}
it('derives roles from content despite swapped filenames', async () => {
  const { root, email } = await fixture();
  const result = await extract(email, root, vi.fn(), vi.fn(), null);
  expect(result.review_reason).toBeNull(); expect(result.defect_fields).toEqual([]);
  expect(result.documents.si?.attachment.id).toBe('first');
});
it('retains known mismatches alongside a missing field', async () => {
  const { root, email } = await fixture(fields.replace('Container count: 2', 'Container count: 3').replace('100 KG', 'TBA'));
  const result = await extract(email, root, async () => { throw new Error('unavailable'); }, async () => ({}), null);
  expect(result.review_reason).toBe('missing_value'); expect(result.defect_fields).toContain('container_count');
});
it('rejects unrelated shipment references', async () => {
  const { root, email } = await fixture(fields, 'BILL OF LADING', 'OTHER-2000');
  const result = await extract(email, root, vi.fn(), vi.fn(), null);
  expect(result.documents.blockers).toContain('SHIPMENT_REFERENCE_UNVERIFIED');
  expect(result.review_reason).not.toBeNull();
});
it('distinguishes positively wrong documents from unreadable evidence', async () => {
  const { root, email } = await fixture(fields, 'PACKING LIST');
  expect((await extract(email, root, vi.fn(), vi.fn(), null)).review_reason).toBe('wrong_doc_type');
  await writeFile(join(root, 'misleading_SI.txt'), '');
  expect((await extract(email, root, vi.fn(), vi.fn(), null)).review_reason).toBe('unreadable');
});
it('never treats two unknown numeric values as a match', async () => {
  const { root, email } = await fixture(fields.replace('100 KG', '100 LB'));
  expect((await extract(email, root, vi.fn(), vi.fn(), null)).review_reason).toBe('missing_value');
});

it('asserts a defect when field comparison does not confirm equivalence', async () => {
  const { root, email } = await fixture(fields.replace('Shipper: Acme', 'Shipper: Other'));
  const result = await extract(email, root, vi.fn(), async () => ({}), null);
  expect(result.review_reason).toBeNull();
  expect(result.defect_fields).toEqual(['shipper']);
});
