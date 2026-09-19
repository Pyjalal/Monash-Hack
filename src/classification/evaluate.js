#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { CATEGORIES } from './categories.js';

const defaultTruth = path.resolve(
  'training_data/sdoc-hackathon-docker/extracted/data_v2/ground_truth.json',
);
const defaultPredictions = path.resolve('outputs/jev-classification-submission.json');

function metrics(tp, fp, fn) {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

async function main() {
  const predictionPath = path.resolve(process.argv[2] ?? defaultPredictions);
  const truthPath = path.resolve(process.argv[3] ?? defaultTruth);
  const [truth, predictions] = await Promise.all([
    readFile(truthPath, 'utf8').then(JSON.parse),
    readFile(predictionPath, 'utf8').then(JSON.parse),
  ]);

  const perCategory = {};
  let correct = 0;
  for (const category of CATEGORIES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const [emailId, expected] of Object.entries(truth)) {
      const actual = predictions[emailId]?.category;
      if (actual === expected.category) correct += category === expected.category ? 1 : 0;
      if (expected.category === category && actual === category) tp += 1;
      else if (expected.category !== category && actual === category) fp += 1;
      else if (expected.category === category && actual !== category) fn += 1;
    }
    perCategory[category] = metrics(tp, fp, fn);
  }

  const total = Object.keys(truth).length;
  const macroF1 =
    CATEGORIES.reduce((sum, category) => sum + perCategory[category].f1, 0) /
    CATEGORIES.length;
  process.stdout.write(`Accuracy: ${(correct / total).toFixed(4)} (${correct}/${total})\n`);
  process.stdout.write(`Macro-F1: ${macroF1.toFixed(4)}\n`);
  for (const category of CATEGORIES) {
    const value = perCategory[category];
    process.stdout.write(
      `${category.padEnd(15)} P=${value.precision.toFixed(3)} ` +
        `R=${value.recall.toFixed(3)} F1=${value.f1.toFixed(3)}\n`,
    );
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
