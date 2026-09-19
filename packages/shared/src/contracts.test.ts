import { describe, expect, it } from 'vitest';
import { EmailSchema, ClassifyRequestSchema, OperationalDecisionSchema } from './index.js';

describe('public boundaries', () => {
  it('keeps snippet classification separate from full-message processing', () => {
    const email = EmailSchema.parse({ id: 'visible-row-1', subject: 'Draft BL', from: 'docs@example.com', snippet: 'Please send the draft', contentScope: 'inbox_snippet' });
    expect(email.contentScope).toBe('inbox_snippet');
    expect(email.attachments).toEqual([]);
  });
  it('rejects empty and oversized anonymous classification batches', () => {
    expect(ClassifyRequestSchema.safeParse({ emails: [] }).success).toBe(false);
    expect(ClassifyRequestSchema.safeParse({ emails: Array(21).fill({ id: 'row', subject: 'Draft', from: 'x', snippet: 'Check' }) }).success).toBe(false);
  });
  it('does not accept verified completion with a missing field', () => {
    expect(OperationalDecisionSchema.safeParse({ category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW', verificationState: 'COMPLETE', workflowState: 'VERIFIED', knownMismatches: [], blockers: [], fieldResults: [], nextAction: 'CONFIRM_MATCH', sourceVersion: 'v1', decisionVersion: 1 }).success).toBe(false);
  });
});
