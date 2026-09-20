import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CategorySchema, type Email } from "@cargolens/shared";
import { RULE_PRESETS } from "@cargolens/shared/rules";
import { createJevRuleEvaluator } from "../../../apps/api/src/ai/rules.js";
import { loadDataset } from "../../../apps/api/src/dataset.js";

/**
 * Runs every smart-filter preset over a stratified dataset sample plus hand-written shipping
 * scenarios, as inbox snippets (subject + first 200 body characters) to mirror the extension.
 * Prints match rates per category so preset thresholds are chosen from data.
 * Usage: TYPESAFE_API_KEY=... npx tsx tools/eval/src/rules.ts [perCategory=8]
 */
const datasetRoot = resolve(process.env.DATASET_PATH ?? "training_data/sdoc-hackathon-docker/extracted/data_v2");
const output = resolve("runtime/eval/rules");
const perCategory = Number(process.argv[2] ?? 8);
const apiKey = process.env.TYPESAFE_API_KEY ?? "";
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");

function scenario(id: string, subject: string, body: string, expect: string[]): { email: Email; expect: string[]; category: string } {
  return { category: "scenario", expect, email: { id, subject, from: "ops@example.test", snippet: body, contentScope: "inbox_snippet", attachments: [] } };
}

const SCENARIOS = [
  scenario("s-reply", "Consignee change MEDUUD104332", "Can you confirm by 15:00 today whether we can still amend the consignee on the draft BL? Waiting on your go-ahead.", ["needs_reply_now"]),
  scenario("s-hold", "Customs hold MSKU1234567", "Customs has placed the container on hold pending the missing packing list. Release is stopped until we receive it.", ["cargo_blocked"]),
  scenario("s-do", "DO not released - unpaid THC", "Delivery order cannot be released until the outstanding THC of USD 420 is settled. Please advise payment status.", ["needs_reply_now", "cargo_blocked", "charges_dispute"]),
  scenario("s-roll", "Booking 8812 rolled to MSC AURORA", "Your booking has been rolled to the next vessel MSC AURORA ETD 24 Sep due to overbooking. New SI cut-off 22 Sep 12:00.", ["schedule_change"]),
  scenario("s-blank", "Blank sailing week 39 - Asia Europe", "Please note the week 39 sailing on this service is blanked. Affected bookings will be advised of new schedules.", ["schedule_change"]),
  scenario("s-dem", "Demurrage invoice dispute INV 55120", "We dispute the 6 days of demurrage billed on INV 55120; the free time was 10 days per our contract. Please revise.", ["charges_dispute"]),
  scenario("s-track", "Tracking update: MSKU1234567 discharged", "Automated notification: container MSKU1234567 was discharged at Callao on 18 Sep 08:12. No action required.", ["automated_notice"]),
  scenario("s-ack", "Ticket #48211 received", "Thank you for contacting the documentation desk. Your request has been logged and will be handled within 24 hours.", ["automated_notice"]),
  scenario("s-promo", "Save 15% on transpacific bookings this October", "Book before 30 Sep and lock in promotional rates on all transpacific FAK services. Register for our webinar.", ["marketing"]),
  scenario("s-news", "Freight market weekly - September edition", "This week: rates soften on Asia-Europe, new port congestion surcharges and our upcoming customer event.", ["marketing"]),
  scenario("s-thanks", "RE: Draft BL 5RSG-00133", "Thanks, received the draft and all looks good on our side. No further action from you.", []),
  scenario("s-fyi", "Berthing report Callao 19 Sep", "For your information, vessel berthed 06:40 and operations commenced. Full report attached.", []),
];

async function main() {
  await mkdir(output, { recursive: true });
  const dataset = await loadDataset(datasetRoot);
  const labels: Record<string, { category: unknown }> = JSON.parse(await readFile(resolve(datasetRoot, "ground_truth.json"), "utf8"));
  const byCategory = new Map<string, Email[]>();
  for (const email of dataset) {
    const category = CategorySchema.parse(labels[email.id]?.category);
    const bucket = byCategory.get(category) ?? [];
    if (bucket.length < perCategory) bucket.push({ id: email.id, subject: email.subject, from: email.from, snippet: (email.body ?? "").slice(0, 200), contentScope: "inbox_snippet", attachments: [] });
    byCategory.set(category, bucket);
  }
  const rows: Array<{ category: string; email: Email; expect?: string[] }> = [...[...byCategory.entries()].flatMap(([category, emails]) => emails.map(email => ({ category, email }))), ...SCENARIOS];
  const evaluate = createJevRuleEvaluator({ apiKey, totalTimeoutMs: 30_000 });
  const rules = RULE_PRESETS.map(({ id, condition }) => ({ id, condition }));
  const results: Array<{ id: string; category: string; subject: string; expect?: string[]; rules: Record<string, number> }> = [];
  for (let index = 0; index < rows.length; index += 8) {
    const chunk = rows.slice(index, index + 8);
    const batch = await evaluate(chunk.map(row => row.email), rules);
    for (const row of chunk) results.push({ id: row.email.id, category: row.category, subject: row.email.subject, expect: row.expect, rules: batch.probabilities.get(row.email.id) ?? {} });
    process.stdout.write(`\r${Math.min(index + 8, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n");
  await writeFile(resolve(output, "presets.json"), JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2) + "\n");

  const categories = [...byCategory.keys()];
  console.log("\nMean probability per preset by dataset category (n per category = " + perCategory + "):");
  console.log(["preset".padEnd(18), ...categories.map(c => c.slice(0, 10).padStart(11))].join(""));
  for (const preset of RULE_PRESETS) {
    const cells = categories.map(category => {
      const values = results.filter(row => row.category === category).map(row => row.rules[preset.id] ?? 0);
      const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      const above = values.filter(value => value >= preset.threshold).length;
      return `${mean.toFixed(2)} (${above})`.padStart(11);
    });
    console.log([preset.id.padEnd(18), ...cells].join(""));
  }
  console.log("\nHand-written scenarios (expected rules -> probabilities at or above threshold):");
  let misses = 0;
  for (const row of results.filter(row => row.expect)) {
    const fired = RULE_PRESETS.filter(preset => (row.rules[preset.id] ?? 0) >= preset.threshold).map(preset => preset.id);
    const expected = row.expect!;
    const ok = expected.every(id => fired.includes(id)) && fired.every(id => expected.includes(id));
    if (!ok) misses++;
    console.log(`${ok ? "ok  " : "MISS"} ${row.id.padEnd(9)} expected=[${expected.join(",")}] fired=[${fired.join(",")}] ` +
      Object.entries(row.rules).map(([id, p]) => `${id}=${p.toFixed(2)}`).join(" "));
  }
  console.log(`\n${misses} scenario mismatch(es). Raw output: ${resolve(output, "presets.json")}`);
}

await main();
