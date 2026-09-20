import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Store } from "../../apps/api/src/store.js";
import { ClassificationService } from "../../apps/api/src/pipeline.js";
import { createApp } from "../../apps/api/src/app.js";
import { loadDataset } from "../../apps/api/src/dataset.js";
import { compareDocuments } from "../../apps/api/src/documents/comparison.js";
import type { Classification, Email } from "@cargolens/shared";

const root = await mkdtemp(join(tmpdir(), "cargolens-dashboard-qa-"));
await mkdir(join(root, "inbox"));
const body = (role: string, count: number) =>
  `${role}\nShipment reference: QA-1234\nShipper: Meridian Export Ltd\nConsignee: Harbour Trade BV\nNotify party: Harbour Trade BV\nPort of loading: Singapore\nPort of discharge: Rotterdam\nContainer count: ${count}\nGross weight kg: 22000\n`;
await writeFile(join(root, "si.txt"), body("SHIPPING INSTRUCTIONS", 3));
await writeFile(join(root, "bl.txt"), body("DRAFT BILL OF LADING", 4));
for (let i = 0; i < 520; i++) {
  const id = `qa-${String(i).padStart(3, "0")}`;
  await writeFile(
    join(root, "inbox", `${id}.json`),
    JSON.stringify({
      email_id: id,
      from:
        i % 2
          ? "Documentation <docs@example.test>"
          : "Meridian operations <operations@example.test>",
      subject:
        i === 0
          ? "[QA] Draft BL · Singapore to Rotterdam"
          : i === 1
            ? "[QA] Please prepare a draft bill of lading"
            : `[QA] Shipping correspondence ${i + 1}`,
      body: `Synthetic QA source ${i}. ${i === 1 ? "Please prepare a draft BL." : "Please verify the attached shipping documents."}`,
      attachments: i === 1 ? [] : ["si.txt", "bl.txt"],
    }),
  );
}
const store = new Store(join(root, "qa.sqlite"));
const emails = await loadDataset(root);
const classify = async (email: Email): Promise<Classification> => ({
  id: email.id,
  category: "BL_COMPARISON",
  confidence: 1,
  probabilities: { BL_COMPARISON: 1 },
  urgency: null,
  expectation: email.id === "qa-001" ? "FUTURE_DRAFT" : "VERIFY_NOW",
  expectationConfidence: 1,
  model: "synthetic-fixture",
  questionVersion: "qa",
  cached: false,
  usage: { input_tokens: 0, output_tokens: 0 },
  elapsedMs: 0,
});
for (const email of emails) store.upsertEmail(email);
for (const email of emails.slice(0, 8)) {
  const record = store.getCase(email.id)!;
  store.saveClassification(
    email.id,
    record.sourceVersion,
    await classify(email),
  );
}
const comparison = await compareDocuments(store.getCase("qa-000")!, root);
store.saveDocumentComparison(
  "qa-000",
  comparison.decision,
  comparison.evidence,
);
const service = new ClassificationService({
  store,
  classifier: classify,
  configurationKey: "synthetic-fixture:qa",
  requestsPerMinute: 1200,
});
const app = createApp({
  store,
  service,
  dashboardToken: "cargolens-qa-only",
  datasetRoot: root,
  dataMode: "synthetic",
});
serve({ fetch: app.fetch, port: 3003, hostname: "127.0.0.1" }, () =>
  console.log(
    "Synthetic dashboard QA API: http://127.0.0.1:3003, access token: cargolens-qa-only. No provider calls or outbound transport.",
  ),
);
