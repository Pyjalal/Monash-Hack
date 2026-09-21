import { describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { CaseSchema } from '@cargolens/shared';
import { VerificationClient, renderVerification } from './verification.js';

function record() {
  return CaseSchema.parse({ email: { id: 'case/a', subject: '<img src=x onerror=alert(1)>', from: 'ops@example.test', attachments: [] }, sourceVersion: 'source-1', classification: null, status: 'classified', updatedAt: new Date().toISOString(), decision: {
    category: 'BL_COMPARISON', requestedAction: 'VERIFY_DOCUMENTS', documentExpectation: 'EXPECTED_NOW', verificationState: 'BLOCKED', workflowState: 'BLOCKED', nextAction: 'REQUEST_CLARIFICATION', sourceVersion: 'source-1', decisionVersion: 2, pairValidated: true,
    blockers: ['gross_weight_kg:MISSING'], knownMismatches: ['shipper'], fieldResults: [{ field: 'shipper', outcome: 'MISMATCH', si: { attachmentId: 'si', sha256: 'a'.repeat(64), locator: 'line:1', text: 'Shipper: A' }, bl: { attachmentId: 'bl', sha256: 'b'.repeat(64), locator: 'line:1', text: 'Shipper: B' } }],
  } });
}
describe('extension document verification', () => {
  it('uses authenticated, uncached requests and rejects stale evidence', async () => {
    const request = vi.fn(async () => Response.json(record()));
    const client = new VerificationClient('http://127.0.0.1:3001', 'test-token', request);
    await expect(client.get('case/a')).resolves.toMatchObject({ sourceVersion: 'source-1' });
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:3001/cases/case%2Fa', expect.objectContaining({ cache: 'no-store', redirect: 'error', headers: { Authorization: 'Bearer test-token' } }));
    request.mockImplementation(async () => Response.json({ ...record(), sourceVersion: 'source-2' }));
    await expect(client.get('case/a')).rejects.toThrow('stale');
  });
  it('rejects unauthorized and cross-case responses', async () => {
    const request = vi.fn(async () => new Response('', { status: 401 }));
    const client = new VerificationClient('http://localhost:3001', '', request);
    await expect(client.get('case/a')).rejects.toThrow('access token');
    request.mockImplementation(async () => Response.json(record()));
    await expect(client.get('different')).rejects.toThrow('stale');
    // A deployed API over HTTPS is a supported base; plaintext to a remote host is not.
    expect(() => new VerificationClient('https://example.test', 'token')).not.toThrow();
    expect(() => new VerificationClient('http://example.test', 'token')).toThrow('API URL');
    expect(() => new VerificationClient('https://example.test/cases', 'token')).toThrow('API URL');
  });
  it('shows blockers together with sourced differences without injecting message HTML', () => {
    const window = new Window(); const root = window.document.createElement('section');
    renderVerification(root as unknown as HTMLElement, record());
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('Established differences: shipper');
    expect(root.textContent).toContain('gross weight kg:MISSING');
    expect(root.textContent).toContain('Shipper: A');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(7);
    expect(root.textContent).toContain('NOT CHECKED');
    window.happyDOM.abort();
  });
});
