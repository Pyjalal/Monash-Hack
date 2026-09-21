import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDataset } from "../../../apps/api/src/dataset.js";
import { datasetConfig } from "./datasets.js";
import { evaluationRoute } from "./evaluation-routing.js";

interface ReportOptions {
  dataset: string;
  classificationDetails: string;
  pipelineDetails: string;
  submission: string;
  score?: string;
  output: string;
  groundTruth?: string;
}

function parseArguments(): ReportOptions {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid argument near ${flag ?? "end"}`);
    values.set(flag, value);
  }
  const dataset = values.get("--dataset") ?? "v2";
  const base = resolve("outputs/pipeline", dataset);
  return {
    dataset,
    classificationDetails: resolve(values.get("--classification-details") ?? `${base}/classification-details.json`),
    pipelineDetails: resolve(values.get("--pipeline-details") ?? `${base}/pipeline-details.json`),
    submission: resolve(values.get("--submission") ?? `${base}/submission.json`),
    score: values.has("--score") ? resolve(values.get("--score")!) : `${base}/score.json`,
    output: resolve(values.get("--output") ?? `${base}/report.json`),
    groundTruth: values.has("--ground-truth") ? resolve(values.get("--ground-truth")!) : undefined,
  };
}

async function optionalJson(path: string | undefined): Promise<unknown | null> {
  if (!path) return null;
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch { return null; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function normalizedClassifications(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const record = value as { classifications?: unknown; predictions?: unknown };
  const rows = Array.isArray(record.classifications) ? record.classifications : Array.isArray(record.predictions) ? record.predictions : [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

function normalizedExtractions(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const rows = (value as { extractions?: unknown }).extractions;
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
}

function sortedFields(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((field): field is string => typeof field === "string").sort() : [];
}

function exactAnswer(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined): boolean {
  if (!left || !right) return false;
  return left.category === right.category && left.status === right.status && left.review_reason === right.review_reason
    && JSON.stringify(sortedFields(left.defect_fields)) === JSON.stringify(sortedFields(right.defect_fields));
}

export async function buildPipelineReport(options: ReportOptions): Promise<unknown> {
  const config = datasetConfig(options.dataset);
  const groundTruthPath = options.groundTruth ?? resolve(config.root, "ground_truth.json");
  const [emails, truthValue, classificationValue, pipelineValue, submissionValue, score, exclusionValue] = await Promise.all([
    loadDataset(config.root),
    optionalJson(groundTruthPath),
    optionalJson(options.classificationDetails),
    optionalJson(options.pipelineDetails),
    optionalJson(options.submission),
    optionalJson(options.score),
    "exclusions" in config ? optionalJson(config.exclusions) : Promise.resolve(null),
  ]);
  const exclusions = exclusionValue && typeof exclusionValue === "object"
    ? (exclusionValue as { cases?: Record<string, string> }).cases ?? {}
    : {};
  const excluded = new Set(Object.keys(exclusions));
  const groundTruth = truthValue && typeof truthValue === "object" ? truthValue as Record<string, Record<string, unknown>> : {};
  const submission = submissionValue && typeof submissionValue === "object" ? submissionValue as Record<string, Record<string, unknown>> : {};
  const classificationRows = normalizedClassifications(classificationValue);
  const extractionRows = normalizedExtractions(pipelineValue);
  const allDocumentsRun = (pipelineValue as { selection?: unknown } | null)?.selection === "all_documents";
  const classifications = new Map(classificationRows.map(row => [String(row.id ?? row.email_id), row]));
  const extractions = new Map(extractionRows.map(row => [String(row.email_id), row]));
  const cases = emails.filter(email => !excluded.has(email.id)).map(email => {
    const classification = classifications.get(email.id) ?? null;
    const extraction = extractions.get(email.id) ?? null;
    const prediction = submission[email.id] ?? null;
    const truth = groundTruth[email.id] ?? null;
    const routeDecision = evaluationRoute(classification);
    const extractionSkipped = extraction?.skipped === true;
    const documents = extraction?.documents && typeof extraction.documents === "object"
      ? Object.values(extraction.documents as Record<string, unknown>) : [];
    const hasLegacyFields = documents.length > 0 && documents.every(document => !!document && typeof document === "object"
      && !!(document as Record<string, unknown>).fields);
    const hasExtractionTrace = !!extraction?.extraction && typeof extraction.extraction === "object"
      && Object.keys(extraction.extraction as Record<string, unknown>).length > 0;
    const timingKnown = typeof classification?.expectation === "string" && typeof classification?.expectationConfidence === "number";
    const routeAllowsExtraction = allDocumentsRun || !timingKnown || routeDecision.selectedForExtraction;
    const extractionEvaluated = routeAllowsExtraction && !extractionSkipped && (hasExtractionTrace || hasLegacyFields);
    const hasComparison = extractionEvaluated && (!!extraction?.comparison || hasLegacyFields);
    const extractionState = extractionEvaluated ? "evaluated"
      : extraction?.review_reason && routeAllowsExtraction ? "blocked"
        : routeDecision.route === "WAITING_FOR_FUTURE_DRAFT" ? "deferred"
          : routeDecision.route === "NOT_APPLICABLE" ? "not_applicable" : "not_selected";
    const comparisonState = hasComparison ? "evaluated"
      : extraction && extraction.review_reason ? "blocked" : extractionState;
    return {
      id: email.id,
      email: { subject: email.subject, from: email.from, attachments: email.attachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType })) },
      classification,
      routeDecision,
      extraction,
      prediction,
      groundTruth: truth,
      stages: { classification: classification ? "evaluated" : "missing", extraction: extractionState, comparison: comparisonState },
      exactMatch: exactAnswer(prediction ?? undefined, truth ?? undefined),
    };
  });
  const comparable = cases.filter(row => row.groundTruth && row.prediction);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    dataset: { id: config.id, label: config.label, root: config.root, totalSourceRows: emails.length, includedRows: cases.length, excludedRows: Object.keys(exclusions).length, exclusions },
    run: {
      provider: (pipelineValue as { provider?: unknown } | null)?.provider ?? (classificationValue as { provider?: unknown } | null)?.provider ?? "legacy",
      classificationModel: (pipelineValue as { classificationModel?: unknown } | null)?.classificationModel ?? (classificationValue as { model?: unknown } | null)?.model ?? null,
      extractionModel: (pipelineValue as { extractionModel?: unknown } | null)?.extractionModel ?? null,
      comparisonModel: (pipelineValue as { comparisonModel?: unknown } | null)?.comparisonModel ?? null,
      selection: (pipelineValue as { selection?: unknown } | null)?.selection ?? "legacy",
    },
    summary: {
      total: cases.length,
      classified: cases.filter(row => row.classification).length,
      classificationCorrect: cases.filter(row => row.classification && row.groundTruth && row.classification.category === row.groundTruth.category).length,
      waitingForFutureDraft: cases.filter(row => row.routeDecision.route === "WAITING_FOR_FUTURE_DRAFT").length,
      extracted: cases.filter(row => row.stages.extraction === "evaluated").length,
      compared: cases.filter(row => row.stages.comparison === "evaluated").length,
      exactMatches: comparable.filter(row => row.exactMatch).length,
      comparable: comparable.length,
    },
    score,
    cases,
  };
  await writeJson(options.output, report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void buildPipelineReport(parseArguments()).then(report => {
    const summary = (report as { summary: unknown }).summary;
    console.log(`Wrote ${parseArguments().output}`);
    console.log(JSON.stringify(summary));
  });
}
