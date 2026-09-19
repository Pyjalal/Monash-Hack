#!/usr/bin/env node
import dotenv from 'dotenv';

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { classifyEmails, DEFAULT_MODEL } from './jev-classifier.js';
import { createOpenRouterEvaluator } from './openrouter.js';

dotenv.config({ quiet: true });

const DEFAULT_DATA_DIR = path.resolve(
  'training_data/sdoc-hackathon-docker/extracted/data_v2',
);
const DEFAULT_OUTPUT = path.resolve('outputs/jev-classification-submission.json');
const DEFAULT_DETAILS = path.resolve('outputs/jev-classification-details.json');

function parsePositiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    output: DEFAULT_OUTPUT,
    details: DEFAULT_DETAILS,
    model: process.env.JEV_MODEL ?? DEFAULT_MODEL,
    batchSize: 20,
    concurrency: 3,
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--data-dir') options.dataDir = path.resolve(argv[++index]);
    else if (flag === '--output') options.output = path.resolve(argv[++index]);
    else if (flag === '--details') options.details = path.resolve(argv[++index]);
    else if (flag === '--model') options.model = argv[++index];
    else if (flag === '--batch-size') {
      options.batchSize = parsePositiveInteger(argv[++index], flag);
    } else if (flag === '--concurrency') {
      options.concurrency = parsePositiveInteger(argv[++index], flag);
    } else if (flag === '--limit') {
      options.limit = parsePositiveInteger(argv[++index], flag);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

function usage() {
  return `Classify the SDOC inbox with Jev through Vercel AI Gateway.

Usage: npm run classify -- [options]

Options:
  --data-dir <path>     Dataset folder containing inbox/ (default: data_v2)
  --output <path>       Submission JSON output
  --details <path>      Confidence/probability JSON output
  --model <id>          Evaluation model (default: typesafe-ai/jev)
  --batch-size <n>      Emails per Jev request (default: 20)
  --concurrency <n>     Concurrent requests (default: 3)
  --limit <n>           Only classify the first n emails (smoke testing)
  -h, --help            Show this help
`;
}

async function readInbox(dataDir) {
  const inboxDir = path.join(dataDir, 'inbox');
  const names = (await readdir(inboxDir))
    .filter(name => /^email_\d+\.json$/.test(name))
    .sort();
  return Promise.all(
    names.map(async name => JSON.parse(await readFile(path.join(inboxDir, name), 'utf8'))),
  );
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

function toSubmission(predictions) {
  return Object.fromEntries(
    predictions.map(({ email_id: emailId, category }) => [
      emailId,
      {
        category,
        status: 'OK',
        review_reason: null,
        defect_fields: [],
        has_defect: false,
      },
    ]),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is missing. Copy .env.example to .env and add your OpenRouter key.',
    );
  }

  let emails = await readInbox(options.dataDir);
  if (options.limit !== null) emails = emails.slice(0, options.limit);
  if (emails.length === 0) throw new Error('No email_*.json records were found');

  process.stdout.write(
    `Classifying ${emails.length} emails with ${options.model} ` +
      `(batch=${options.batchSize}, concurrency=${options.concurrency})\n`,
  );

  const evaluator = createOpenRouterEvaluator({
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const predictions = await classifyEmails(emails, {
    model: options.model,
    evaluator,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    onBatchComplete: ({ processed, total }) => {
      process.stdout.write(`Processed ${processed}/${total}\n`);
    },
  });

  const submission = toSubmission(predictions);
  const details = {
    model: options.model,
    generated_at: new Date().toISOString(),
    total: predictions.length,
    predictions,
  };

  await Promise.all([
    atomicWriteJson(options.output, submission),
    atomicWriteJson(options.details, details),
  ]);

  const categoryCounts = predictions.reduce((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});
  process.stdout.write(`Submission: ${options.output}\n`);
  process.stdout.write(`Details:   ${options.details}\n`);
  for (const [category, count] of Object.entries(categoryCounts)) {
    process.stdout.write(`${category}: ${count}\n`);
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
