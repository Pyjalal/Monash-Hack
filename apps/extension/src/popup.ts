import { healthEndpoint, normalizeApiUrl, parseSettings, isAllowedApiUrl, ensureHostPermission, DEFAULT_API_URL } from "./settings.js";

const enabled = document.querySelector<HTMLInputElement>("#enabled");
const apiUrl = document.querySelector<HTMLInputElement>("#api-url");
const status = document.querySelector<HTMLElement>("#status");
const save = document.querySelector<HTMLButtonElement>("#save");
const health = document.querySelector<HTMLButtonElement>("#health");

function setStatus(message: string, kind: "ok" | "error" | "" = ""): void {
  if (!status) return;
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

async function notifyTabs(settings: { enabled: boolean; apiUrl: string; epoch: number }): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.flatMap((tab) => typeof tab.id === "number"
    ? [chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", ...settings })]
    : []));
}

async function load(): Promise<void> {
  const settings = parseSettings(await chrome.storage.sync.get({ enabled: true, apiUrl: DEFAULT_API_URL }));
  if (enabled) enabled.checked = settings.enabled;
  if (apiUrl) apiUrl.value = settings.apiUrl;
  await checkHealth(settings.apiUrl);
}

async function saveSettings(): Promise<void> {
  const value = apiUrl?.value.trim() ?? "";
  if (!isAllowedApiUrl(value)) {
    setStatus("Use an https:// URL, or http://localhost / http://127.0.0.1 for a local API.", "error");
    apiUrl?.focus();
    return;
  }
  const settings = { enabled: enabled?.checked ?? true, apiUrl: normalizeApiUrl(value) };
  if (!(await ensureHostPermission(settings.apiUrl))) {
    setStatus(`CargoLens needs permission to reach ${settings.apiUrl}.`, "error");
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "SET_SETTINGS", ...settings });
  if (response && typeof response === "object" && "error" in response) {
    setStatus("Settings were rejected by the extension.", "error");
    return;
  }
  await chrome.storage.sync.set(settings);
  const epoch = response && typeof response === "object" && "epoch" in response && typeof response.epoch === "number" ? response.epoch : 0;
  await notifyTabs({ ...settings, epoch });
  if (apiUrl) apiUrl.value = settings.apiUrl;
  setStatus("Saved for this browser profile.", "ok");
  await checkHealth(settings.apiUrl);
}

async function checkHealth(value = apiUrl?.value.trim() ?? DEFAULT_API_URL): Promise<void> {
  if (!isAllowedApiUrl(value)) {
    setStatus("Enter an https:// or loopback URL to check health.", "error");
    return;
  }
  setStatus("Checking API…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(healthEndpoint(value), { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setStatus("API is reachable.", "ok");
  } catch {
    setStatus(normalizeApiUrl(value) === DEFAULT_API_URL
      ? "Local API is unavailable. Start it with: npm run dev"
      : `API is unavailable at ${normalizeApiUrl(value)}.`, "error");
  } finally {
    clearTimeout(timer);
  }
}

document.querySelector<HTMLButtonElement>("#open-settings")?.addEventListener("click", () => { void chrome.runtime.openOptionsPage(); });
save?.addEventListener("click", () => { void saveSettings(); });
health?.addEventListener("click", () => { void checkHealth(); });
void load().catch(() => setStatus("Could not load CargoLens settings.", "error"));
