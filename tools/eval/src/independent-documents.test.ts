import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { evaluateDocuments } from './independent-documents.js';

it('counts refused exports as misses while separating safe blockers from automation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'independent-scorecard-'));
  try {
    const result = await evaluateDocuments(join(root, 'sources'));
    expect(result.count).toBe(12);
    expect(result.groupCount).toBe(2);
    expect(result.rows.filter(row => row.exportFailure)).toHaveLength(6);
    expect(result.exactTargets.status).toEqual({ total: 12, correct: 6, excluded: 0, accuracy: 0.5 });
    expect(result.exactTargets.review_reason.correct).toBe(6);
    expect(result.operationalStatusReasonChecks).toEqual({ correct: 12, total: 12 });
    expect(result.falseClears).toBe(0);
    expect(result.automationCoverage).toBe(4 / 12);
    expect(result.sentMessages).toBe(0);
    await expect(evaluateDocuments(join(root, 'sources'))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
