import { DEFAULT_API_URL, MAX_RULES, RULE_PRESETS, healthEndpoint, isLoopbackApiUrl, normalizeApiUrl, parseSettings, rulesEndpoint,
  type ExtensionSettings, type FilterRule, type RuleAction } from "./settings.js";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const ACTION_LABELS: Record<RuleAction, string> = { pin: "Pin to top", highlight: "Highlight", hide: "Hide row" };
const SAMPLES = [
  { subject: "Customs hold on MSKU1234567", snippet: "Customs has placed the container on hold pending the missing packing list. Release is stopped until we receive it. Can you send it today?" },
  { subject: "Booking 8812 rolled to MSC AURORA", snippet: "Your booking has been rolled to the next vessel MSC AURORA ETD 24 Sep due to overbooking. New SI cut-off 22 Sep 12:00." },
  { subject: "Tracking update: MSKU1234567 discharged", snippet: "Automated notification: container MSKU1234567 was discharged at Callao on 18 Sep 08:12. No action required." },
  { subject: "Save 15% on transpacific bookings", snippet: "Book before 30 Sep and lock in promotional rates on all transpacific FAK services. Register for our webinar." },
];

let saved: ExtensionSettings = parseSettings({});
let draft: ExtensionSettings = structuredClone(saved);
let sampleIndex = 0;

function setStatus(message: string, kind: "ok" | "error" | "" = ""): void {
  const status = $("#status");
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

function dirty(): boolean { return JSON.stringify(draft) !== JSON.stringify(saved); }

function render(): void {
  $<HTMLInputElement>("#enabled").checked = draft.enabled;
  $<HTMLInputElement>("#api-url").value = draft.apiUrl;
  $<HTMLInputElement>("#hide-spam").checked = draft.inbox.hideSpam;
  $<HTMLInputElement>("#spam-threshold").value = String(Math.round(draft.inbox.spamThreshold * 100));
  $("#spam-threshold-label").textContent = `${Math.round(draft.inbox.spamThreshold * 100)}% sure`;
  $("#spam-threshold-row").style.display = draft.inbox.hideSpam ? "" : "none";
  $<HTMLInputElement>("#pin-urgent").checked = draft.inbox.pinUrgent;
  $("#rule-count").textContent = `${draft.inbox.rules.filter(rule => rule.enabled).length} on · ${draft.inbox.rules.length} of ${MAX_RULES}`;
  $<HTMLButtonElement>("#add-rule").disabled = draft.inbox.rules.length >= MAX_RULES;
  const list = $("#rules");
  list.replaceChildren(...draft.inbox.rules.map(renderRule));
  $<HTMLButtonElement>("#save").disabled = !dirty();
  $<HTMLButtonElement>("#revert").disabled = !dirty();
}

function renderRule(rule: FilterRule, index: number): HTMLElement {
  const preset = RULE_PRESETS.find(candidate => candidate.id === rule.id);
  const card = document.createElement("article");
  card.className = `rule${rule.enabled ? "" : " disabled"}`;
  card.setAttribute("aria-label", `Filter: ${rule.label}`);
  const head = document.createElement("div"); head.className = "head";
  const toggle = document.createElement("input");
  toggle.type = "checkbox"; toggle.className = "switch"; toggle.checked = rule.enabled; toggle.setAttribute("aria-label", `Enable ${rule.label}`);
  toggle.addEventListener("change", () => { rule.enabled = toggle.checked; render(); });
  const text = document.createElement("div"); text.className = "text";
  const title = document.createElement("strong"); title.textContent = rule.label;
  const sub = document.createElement("span"); sub.textContent = preset?.description ?? "Custom filter";
  text.append(title, sub);
  const actionPill = document.createElement("span"); actionPill.className = `pill${rule.enabled ? " accent" : ""}`; actionPill.textContent = ACTION_LABELS[rule.action];
  head.append(toggle, text, actionPill);
  card.append(head);

  const body = document.createElement("div"); body.className = "body";
  const actionField = field("What happens when it fires", (() => {
    const select = document.createElement("select");
    for (const action of Object.keys(ACTION_LABELS) as RuleAction[]) {
      const option = document.createElement("option"); option.value = action; option.textContent = ACTION_LABELS[action]; option.selected = action === rule.action; select.append(option);
    }
    select.addEventListener("change", () => { rule.action = select.value as RuleAction; render(); });
    return select;
  })());
  const sensitivity = document.createElement("div"); sensitivity.className = "slider";
  const range = document.createElement("input"); range.type = "range"; range.min = "50"; range.max = "99"; range.step = "1"; range.value = String(Math.round(rule.threshold * 100));
  range.setAttribute("aria-label", `Sensitivity for ${rule.label}`);
  const rangeLabel = document.createElement("span"); rangeLabel.className = "pill"; rangeLabel.textContent = `${range.value}% sure`;
  range.addEventListener("input", () => { rule.threshold = Number(range.value) / 100; rangeLabel.textContent = `${range.value}% sure`; $<HTMLButtonElement>("#save").disabled = !dirty(); $<HTMLButtonElement>("#revert").disabled = !dirty(); });
  sensitivity.append(range, rangeLabel);
  body.append(actionField, field("Fires when Jev is at least", sensitivity));

  const wording = document.createElement("div"); wording.className = "wide";
  if (preset && rule.condition === preset.condition) {
    const details = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = "Show or edit the condition Jev evaluates";
    const condition = document.createElement("p"); condition.className = "condition"; condition.textContent = rule.condition;
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "ghost"; edit.textContent = "Edit wording";
    edit.addEventListener("click", () => { rule.condition = `${rule.condition} `; render(); card.querySelector("textarea")?.focus(); });
    details.append(summary, condition, edit);
    wording.append(details);
  } else {
    if (!preset) {
      const labelInput = document.createElement("input"); labelInput.type = "text"; labelInput.value = rule.label; labelInput.maxLength = 60; labelInput.placeholder = "Short name shown on the badge";
      labelInput.addEventListener("input", () => { rule.label = labelInput.value; title.textContent = rule.label || "Untitled filter"; $<HTMLButtonElement>("#save").disabled = !dirty(); });
      wording.append(field("Name", labelInput));
    }
    const textarea = document.createElement("textarea"); textarea.value = rule.condition; textarea.maxLength = 600;
    textarea.placeholder = "Describe the condition in plain language, e.g. “The sender reports a container that missed its cut-off and asks for a new booking.”";
    textarea.addEventListener("input", () => { rule.condition = textarea.value; $<HTMLButtonElement>("#save").disabled = !dirty(); });
    const hint = document.createElement("p"); hint.className = "condition";
    hint.textContent = "Write it as a yes/no statement about one message. Say what does not count too; Jev reads the whole condition as evidence for a single judgment.";
    wording.append(field("Condition Jev evaluates", textarea), hint);
    if (preset) {
      const restore = document.createElement("button"); restore.type = "button"; restore.className = "ghost"; restore.textContent = "Restore preset wording";
      restore.addEventListener("click", () => { rule.condition = preset.condition; render(); });
      wording.append(restore);
    }
  }
  body.append(wording);
  if (!preset) {
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ghost"; remove.textContent = "Remove filter";
    remove.addEventListener("click", () => { draft.inbox.rules.splice(index, 1); render(); });
    const wide = document.createElement("div"); wide.className = "wide"; wide.append(remove); body.append(wide);
  }
  card.append(body);
  return card;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement("div");
  const caption = document.createElement("label"); caption.className = "field"; caption.textContent = label; caption.style.marginTop = "0";
  wrapper.append(caption, control);
  return wrapper;
}

function validate(): string | null {
  if (!isLoopbackApiUrl(draft.apiUrl)) return "Use an http://localhost or http://127.0.0.1 URL for the API.";
  for (const rule of draft.inbox.rules) {
    if (rule.enabled && rule.condition.trim().length < 8) return `“${rule.label || rule.id}” needs a condition of at least 8 characters.`;
    if (!rule.label.trim()) return "Every filter needs a name.";
  }
  return null;
}

async function load(): Promise<void> {
  const stored = await chrome.storage.sync.get({ enabled: true, apiUrl: DEFAULT_API_URL, inbox: null });
  saved = parseSettings(stored);
  draft = structuredClone(saved);
  render();
  await checkHealth();
}

async function save(): Promise<void> {
  const problem = validate();
  if (problem) { setStatus(problem, "error"); return; }
  draft.apiUrl = normalizeApiUrl(draft.apiUrl);
  const response = await chrome.runtime.sendMessage({ type: "SET_SETTINGS", enabled: draft.enabled, apiUrl: draft.apiUrl, inbox: draft.inbox });
  if (!response || typeof response !== "object" || "error" in response) { setStatus("The extension rejected these settings.", "error"); return; }
  saved = parseSettings(response);
  draft = structuredClone(saved);
  render();
  setStatus("Saved. Open inboxes update immediately.", "ok");
}

async function checkHealth(): Promise<void> {
  const pill = $("#health-pill");
  if (!isLoopbackApiUrl(draft.apiUrl)) { pill.textContent = "Invalid API URL"; pill.className = "pill error"; return; }
  pill.textContent = "Checking API"; pill.className = "pill";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(healthEndpoint(draft.apiUrl), { signal: controller.signal });
    if (!response.ok) throw new Error(String(response.status));
    pill.textContent = "API connected"; pill.className = "pill ok";
  } catch {
    pill.textContent = "API offline"; pill.className = "pill error";
  } finally { clearTimeout(timer); }
}

async function runTest(): Promise<void> {
  const subject = $<HTMLInputElement>("#test-subject").value.trim();
  const snippet = $<HTMLTextAreaElement>("#test-snippet").value.trim();
  const results = $("#test-results");
  const rules = draft.inbox.rules.filter(rule => rule.condition.trim().length >= 8).map(({ id, condition }) => ({ id, condition: condition.trim() }));
  if (!subject && !snippet) { setStatus("Add a subject or snippet to score.", "error"); return; }
  if (!rules.length) { setStatus("Add at least one filter to score against.", "error"); return; }
  if (!isLoopbackApiUrl(draft.apiUrl)) { setStatus("Set a valid API URL first.", "error"); return; }
  const button = $<HTMLButtonElement>("#run-test");
  button.disabled = true; results.textContent = "Asking Jev…";
  try {
    const response = await fetch(rulesEndpoint(draft.apiUrl), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: [{ id: "settings-test", subject, from: "test@example.test", snippet }], rules }) });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json() as { results: Array<{ status: string; rules?: Record<string, number> }> };
    const scores = body.results[0]?.status === "evaluated" ? body.results[0].rules ?? {} : null;
    if (!scores) throw new Error("unavailable");
    results.replaceChildren(...draft.inbox.rules.filter(rule => rule.id in scores).sort((a, b) => scores[b.id] - scores[a.id]).map(rule => {
      const probability = scores[rule.id];
      const row = document.createElement("div"); row.className = "result";
      const name = document.createElement("strong"); name.textContent = rule.label;
      const bar = document.createElement("div"); bar.className = "bar"; const fill = document.createElement("i"); fill.style.width = `${Math.round(probability * 100)}%`; bar.append(fill);
      const pct = document.createElement("span"); pct.textContent = `${Math.round(probability * 100)}%`;
      const verdict = document.createElement("span");
      const fires = probability >= rule.threshold;
      verdict.className = fires ? "fired" : "quiet";
      verdict.textContent = fires ? (rule.enabled ? `Fires → ${ACTION_LABELS[rule.action]}` : "Would fire (filter off)") : `Below ${Math.round(rule.threshold * 100)}%`;
      row.append(name, bar, pct, verdict);
      return row;
    }));
    setStatus("Scored with the saved API. Unsaved wording changes were included in this test.", "ok");
  } catch {
    results.textContent = "";
    setStatus("Could not score: the local API is unavailable or smart filters are not configured on it.", "error");
  } finally { button.disabled = false; }
}

$("#enabled").addEventListener("change", event => { draft.enabled = (event.target as HTMLInputElement).checked; render(); });
$("#api-url").addEventListener("input", event => { draft.apiUrl = (event.target as HTMLInputElement).value.trim(); $<HTMLButtonElement>("#save").disabled = !dirty(); });
$("#health").addEventListener("click", () => { void checkHealth(); });
$("#hide-spam").addEventListener("change", event => { draft.inbox.hideSpam = (event.target as HTMLInputElement).checked; render(); });
$("#spam-threshold").addEventListener("input", event => { draft.inbox.spamThreshold = Number((event.target as HTMLInputElement).value) / 100; $("#spam-threshold-label").textContent = `${(event.target as HTMLInputElement).value}% sure`; $<HTMLButtonElement>("#save").disabled = !dirty(); });
$("#pin-urgent").addEventListener("change", event => { draft.inbox.pinUrgent = (event.target as HTMLInputElement).checked; render(); });
$("#add-rule").addEventListener("click", () => {
  if (draft.inbox.rules.length >= MAX_RULES) return;
  const id = `custom_${Date.now().toString(36)}`;
  draft.inbox.rules.push({ id, label: "", condition: "", action: "highlight", threshold: 0.7, enabled: true, preset: false });
  render();
  const cards = document.querySelectorAll<HTMLElement>(".rule");
  cards[cards.length - 1]?.querySelector<HTMLInputElement>("input[type=text]")?.focus();
});
$("#reset-presets").addEventListener("click", () => {
  for (const rule of draft.inbox.rules) { const preset = RULE_PRESETS.find(candidate => candidate.id === rule.id); if (preset) rule.condition = preset.condition; }
  render();
});
$("#run-test").addEventListener("click", () => { void runTest(); });
$("#sample-test").addEventListener("click", () => {
  const sample = SAMPLES[sampleIndex++ % SAMPLES.length];
  $<HTMLInputElement>("#test-subject").value = sample.subject;
  $<HTMLTextAreaElement>("#test-snippet").value = sample.snippet;
});
$("#save").addEventListener("click", () => { void save(); });
$("#revert").addEventListener("click", () => { draft = structuredClone(saved); render(); setStatus("Reverted to saved settings."); });
window.addEventListener("beforeunload", event => { if (dirty()) event.preventDefault(); });
void load().catch(() => setStatus("Could not load CargoLens settings.", "error"));
