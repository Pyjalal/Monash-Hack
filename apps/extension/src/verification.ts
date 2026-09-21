import { CaseSchema, FIELD_NAMES, type Case } from '@cargolens/shared';
import { isLoopbackApiUrl, normalizeApiUrl } from './settings.js';

export class VerificationClient {
  constructor(private readonly base: string, private readonly token: string, private readonly request: typeof fetch = fetch) {
    if (!isLoopbackApiUrl(base)) throw new Error('Use the configured local API.');
  }
  private async read(path: string): Promise<unknown> {
    const response = await this.request(`${normalizeApiUrl(this.base)}${path}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      cache: 'no-store', signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (response.status === 401) throw new Error('Enter your dashboard access token to view document evidence.');
    if (!response.ok) throw new Error(`Document service unavailable (HTTP ${response.status}).`);
    return response.json();
  }
  async list(): Promise<Array<{ id: string; subject: string }>> {
    const payload = await this.read('/emails?limit=1000');
    if (!payload || typeof payload !== 'object' || !('emails' in payload) || !Array.isArray(payload.emails)) throw new Error('Invalid case list.');
    return payload.emails.filter((item): item is { id: string; subject: string } => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.subject === 'string');
  }
  async get(id: string): Promise<Case> {
    const parsed = CaseSchema.safeParse(await this.read(`/cases/${encodeURIComponent(id)}`));
    if (!parsed.success || parsed.data.email.id !== id) throw new Error('Invalid or stale document evidence. Refresh the case.');
    return parsed.data;
  }
}

export function renderVerification(root: HTMLElement, record: Case): void {
  const document = root.ownerDocument;
  root.replaceChildren();
  const add = (tag: string, text: string, parent: HTMLElement = root) => {
    const element = document.createElement(tag); element.textContent = text; parent.append(element); return element;
  };
  add('h2', record.email.subject || 'Untitled message');
  add('p', record.email.from);
  const decision = record.decision;
  if (!decision) { add('p', 'Document verification has not started.'); return; }
  add('h3', decision.workflowState.replaceAll('_', ' '));
  add('p', `Next action: ${decision.nextAction.replaceAll('_', ' ').toLowerCase()}`);
  add('p', `Decision ${decision.decisionVersion} · Source ${record.sourceVersion.slice(0, 12)}`);
  if (decision.blockers.length) {
    add('h3', 'Evidence needed'); const list = add('ul', '');
    for (const blocker of decision.blockers) add('li', blocker.replaceAll('_', ' '), list);
  }
  if (decision.knownMismatches.length) add('p', `Established differences: ${decision.knownMismatches.join(', ').replaceAll('_', ' ')}`);
  const table = add('table', ''); table.setAttribute('aria-label', 'Seven shipping document fields');
  const header = add('tr', '', add('thead', '', table));
  for (const text of ['Field', 'Result', 'Shipping instruction', 'Bill of lading']) add('th', text, header).setAttribute('scope', 'col');
  const body = add('tbody', '', table);
  for (const field of FIELD_NAMES) {
    const result = decision.fieldResults.find(result => result.field === field);
    const row = add('tr', '', body); add('th', field.replaceAll('_', ' '), row).setAttribute('scope', 'row');
    add('td', result?.outcome ?? 'NOT CHECKED', row);
    for (const span of [result?.si, result?.bl]) {
      const cell = add('td', span?.text ?? 'No verified source', row);
      if (span) add('small', `${span.attachmentId} · ${span.locator} · SHA ${span.sha256.slice(0, 12)}`, cell);
    }
  }
  add('p', 'Inbox labels describe message intent. Only sourced document results establish a match.');
}
