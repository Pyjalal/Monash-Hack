import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { datasetConfig } from "./datasets.js";
import { buildPipelineReport } from "./pipeline-report.js";

interface Options {
  dataset: string;
  reuseClassification: boolean;
  allDocuments: boolean;
  concurrency?: string;
  batchSize?: string;
}

function argumentsForRun(): Options {
  const args = process.argv.slice(2);
  const datasetIndex = args.indexOf("--dataset");
  const dataset = datasetIndex >= 0 ? args[datasetIndex + 1] : undefined;
  if (!dataset || dataset.startsWith("--")) throw new Error("Usage: npm run pipeline:full -- --dataset <v2|v3|v4|v5> [--reuse-classification] [--all-documents] [--concurrency N] [--batch-size N]");
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrency = concurrencyIndex >= 0 ? args[concurrencyIndex + 1] : undefined;
  if (concurrencyIndex >= 0 && (!concurrency || concurrency.startsWith("--"))) throw new Error("--concurrency needs a value");
  const batchSizeIndex = args.indexOf("--batch-size");
  const batchSize = batchSizeIndex >= 0 ? args[batchSizeIndex + 1] : undefined;
  if (batchSizeIndex >= 0 && (!batchSize || batchSize.startsWith("--"))) throw new Error("--batch-size needs a value");
  const known = new Set(["--dataset", dataset, "--reuse-classification", "--all-documents", "--concurrency", concurrency, "--batch-size", batchSize].filter(Boolean));
  const unknown = args.filter(value => !known.has(value));
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(", ")}`);
  return { dataset, reuseClassification: args.includes("--reuse-classification"), allDocuments: args.includes("--all-documents"), concurrency, batchSize };
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function run(command: string, args: string[], capture = false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: resolve("."), env: process.env, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = ""; let stderr = "";
    if (capture && child.stdout && child.stderr) {
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stdout.on("data", chunk => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
  });
}

async function main(): Promise<void> {
  const options = argumentsForRun();
  const config = datasetConfig(options.dataset);
  const allDocuments = options.allDocuments || ("allDocuments" in config && config.allDocuments);
  const outputDirectory = resolve("outputs/pipeline", options.dataset);
  const classification = resolve(outputDirectory, "classification.json");
  const classificationDetails = resolve(outputDirectory, "classification-details.json");
  const submission = resolve(outputDirectory, "submission.json");
  const pipelineDetails = resolve(outputDirectory, "pipeline-details.json");
  const curatedTruth = resolve(outputDirectory, "ground-truth.curated.json");
  const scorePath = resolve(outputDirectory, "score.json");
  const reportPath = resolve(outputDirectory, "report.json");
  await mkdir(outputDirectory, { recursive: true });

  const exclusionArgs = "exclusions" in config ? ["--exclude-file", config.exclusions] : [];
  if (!(options.reuseClassification && await exists(classification) && await exists(classificationDetails))) {
    console.log(`\n[1/4] Classification · ${config.label}`);
    await run(process.execPath, ["--import", "tsx", "tools/eval/src/submission.ts", "classify", "--data-dir", config.root,
      "--output", classification, "--details", classificationDetails, ...exclusionArgs,
      ...(options.concurrency ? ["--concurrency", options.concurrency] : []),
      ...(options.batchSize ? ["--batch-size", options.batchSize] : [])]);
  } else console.log(`\n[1/4] Reusing classification outputs for ${config.label}`);

  console.log(`\n[2/4] Extraction + comparison · ${config.label}`);
  await run(process.execPath, ["--import", "tsx", "tools/eval/src/submission.ts", "pipeline", "--data-dir", config.root,
    "--classification", classification, "--classification-details", classificationDetails,
    "--output", submission, "--details", pipelineDetails, ...exclusionArgs,
    ...(allDocuments ? ["--all-documents"] : []),
    ...(options.concurrency ? ["--concurrency", options.concurrency] : []),
    ...(options.batchSize ? ["--batch-size", options.batchSize] : [])]);

  const truth = JSON.parse(await readFile(resolve(config.root, "ground_truth.json"), "utf8")) as Record<string, unknown>;
  let exclusions: Record<string, unknown> = {};
  if ("exclusions" in config) {
    const manifest = JSON.parse(await readFile(config.exclusions, "utf8")) as { cases?: Record<string, unknown> };
    exclusions = manifest.cases ?? {};
  }
  await writeJson(curatedTruth, Object.fromEntries(Object.entries(truth).filter(([id]) => !(id in exclusions))));

  console.log(`\n[3/4] Organizer score · ${config.label}`);
  const scoreOutput = await run("python", ["training_data/sdoc-hackathon-docker/extracted/server/score_cli.py", submission, "--ground-truth", curatedTruth, "--json"], true);
  const jsonStart = scoreOutput.indexOf("{");
  if (jsonStart < 0) throw new Error(`Scorer did not return JSON: ${scoreOutput.trim()}`);
  await writeJson(scorePath, JSON.parse(scoreOutput.slice(jsonStart)));

  console.log(`\n[4/4] Unified dashboard report · ${config.label}`);
  const report = await buildPipelineReport({ dataset: options.dataset, classificationDetails, pipelineDetails, submission, score: scorePath, output: reportPath, groundTruth: curatedTruth });
  console.log(JSON.stringify((report as { summary: unknown }).summary, null, 2));
  console.log(`\nComplete: ${reportPath}`);
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
