import { DEFAULT_API_URL, parseSettings } from './settings.js';
import { VerificationClient, renderVerification } from './verification.js';

const form = document.querySelector<HTMLFormElement>('#connection')!;
const token = document.querySelector<HTMLInputElement>('#token')!;
const cases = document.querySelector<HTMLSelectElement>('#cases')!;
const status = document.querySelector<HTMLElement>('#status')!;
const evidence = document.querySelector<HTMLElement>('#evidence')!;
let client: VerificationClient | undefined;
let generation = 0;
async function show(): Promise<void> {
  const version = ++generation; evidence.replaceChildren();
  const id = cases.value; if (!client || !id) return;
  status.textContent = 'Loading document evidence…';
  try {
    const record = await client.get(id);
    if (version !== generation) return;
    renderVerification(evidence, record); status.textContent = 'Evidence loaded. Refresh to check for new decisions.';
  } catch (error) { if (version === generation) status.textContent = error instanceof Error ? error.message : 'Evidence unavailable.'; }
}
form.addEventListener('submit', event => {
  event.preventDefault(); ++generation; evidence.replaceChildren(); cases.replaceChildren();
  const version = generation;
  void (async () => {
    status.textContent = 'Connecting…';
    const settings = parseSettings(await chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }));
    client = new VerificationClient(settings.apiUrl, token.value.trim());
    token.value = '';
    const records = await client.list();
    if (version !== generation) return;
    for (const record of records) {
      const option = document.createElement('option'); option.value = record.id; option.textContent = `${record.subject || 'Untitled'} · ${record.id}`; cases.append(option);
    }
    status.textContent = records.length ? `${records.length} imported messages` : 'No imported messages yet. Connect or import through your dashboard.';
    if (records.length) await show();
  })().catch(error => { if (version === generation) status.textContent = error instanceof Error ? error.message : 'Connection unavailable.'; });
});
cases.addEventListener('change', () => { void show(); });
document.querySelector('#refresh')?.addEventListener('click', () => { void show(); });
