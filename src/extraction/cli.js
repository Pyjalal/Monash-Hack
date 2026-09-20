#!/usr/bin/env node
import dotenv from 'dotenv';

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_MODEL } from '../classification/jev-classifier.js';
import { createOpenRouterEvaluator } from '../classification/openrouter.js';
import { extractEmails } from './jev-extractor.js';

dotenv.config({ quiet: true });

const DEFAULT_DATA_DIR = path.resolve('training_data/sdoc-hackathon-docker/extracted/data_v2');
const DEFAULT_CLASSIFICATIONS = path.resolve('outputs/jev-classification-submission.json');
const DEFAULT_OUTPUT = path.resolve('outputs/jev-full-pipeline-submission.json');
const DEFAULT_DETAILS = path.resolve('outputs/jev-extraction-details.json');

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function parseArgs(argv) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    classifications: DEFAULT_CLASSIFICATIONS,
    output: DEFAULT_OUTPUT,
    details: DEFAULT_DETAILS,
    model: process.env.JEV_MODEL ?? DEFAULT_MODEL,
    python: process.env.PYTHON_EXECUTABLE ?? 'python',
    concurrency: 3,
    limit: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--data-dir') options.dataDir = path.resolve(argv[++index]);
    else if (flag === '--classifications') options.classifications = path.resolve(argv[++index]);
    else if (flag === '--output') options.output = path.resolve(argv[++index]);
    else if (flag === '--details') options.details = path.resolve(argv[++index]);
    else if (flag === '--model') options.model = argv[++index];
    else if (flag === '--python') options.python = argv[++index];
    else if (flag === '--concurrency') options.concurrency = positiveInteger(argv[++index], flag);
    else if (flag === '--limit') options.limit = positiveInteger(argv[++index], flag);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

function usage() {
  return `Extract and compare the seven SI/BL fields with Jev.

Usage: npm run pipeline -- [options]

Options:
  --data-dir <path>          Dataset folder containing inbox/ and attachments/
  --classifications <path>   Existing Stage 1 submission JSON
  --output <path>            Full scorer-compatible pipeline submission
  --details <path>           Per-document extracted fields and confidence
  --model <id>               Jev model (default: typesafe/jev-1.13)
  --python <path>            Python executable used for PDF/DOCX/XLSX extraction
  --concurrency <n>          Concurrent Jev requests (default: 3)
  --limit <n>                Process only the first n emails
  -h, --help                 Show this help
`;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return process.stdout.write(usage());
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is missing');

  const names = (await readdir(path.join(options.dataDir, 'inbox')))
    .filter(name => /^email_\d+\.json$/.test(name))
    .sort();
  let emails = await Promise.all(
    names.map(name => readFile(path.join(options.dataDir, 'inbox', name), 'utf8').then(JSON.parse)),
  );
  if (options.limit !== null) emails = emails.slice(0, options.limit);

  const classifications = JSON.parse(await readFile(options.classifications, 'utf8'));
  emails = emails.map(email => ({
    ...email,
    category: classifications[email.email_id]?.category ?? 'GENERAL',
  }));
  const evaluator = createOpenRouterEvaluator({ apiKey: process.env.OPENROUTER_API_KEY });
  let lastReported = 0;
  const extractions = await extractEmails(emails, {
    dataDir: options.dataDir,
    evaluator,
    model: options.model,
    python: options.python,
    concurrency: options.concurrency,
    onEmailComplete: ({ processed, total }) => {
      if (processed === total || processed - lastReported >= 25) {
        process.stdout.write(`Processed ${processed}/${total}\n`);
        lastReported = processed;
      }
    },
  });

  const submission = Object.fromEntries(
    extractions.map(result => {
      const category = classifications[result.email_id]?.category ?? 'GENERAL';
      const needsReview = result.review_reason !== null;
      const hasDefect = !needsReview && result.defect_fields.length > 0;
      return [
        result.email_id,
        {
          category,
          status: needsReview ? 'NEEDS_REVIEW' : hasDefect ? 'MISMATCH' : 'OK',
          review_reason: result.review_reason,
          defect_fields: result.defect_fields,
          has_defect: hasDefect,
        },
      ];
    }),
  );
  const details = {
    model: options.model,
    generated_at: new Date().toISOString(),
    total: extractions.length,
    policy:
      'Only BL_COMPARISON emails enter extraction. A BL_COMPARISON email without a complete readable SI/BL pair is escalated for human review.',
    extractions,
  };
  await Promise.all([
    atomicWriteJson(options.output, submission),
    atomicWriteJson(options.details, details),
  ]);
  process.stdout.write(`Submission: ${options.output}\nDetails:    ${options.details}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
