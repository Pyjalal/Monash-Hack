import { createHash } from "node:crypto";

export const BENCHMARK_CATEGORIES = ["BL_COMPARISON", "SI_REQUEST", "INVOICE_QUERY", "GENERAL", "SPAM"] as const;

export function classificationMetrics(rows: { expected: string; predicted: string | null }[]) {
  const confusion: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const predicted = row.predicted ?? "PROVIDER_ERROR";
    confusion[row.expected] ??= {};
    confusion[row.expected][predicted] = (confusion[row.expected][predicted] ?? 0) + 1;
  }
  const perCategory = Object.fromEntries(BENCHMARK_CATEGORIES.map(category => {
    const tp = rows.filter(row => row.expected === category && row.predicted === category).length;
    const fp = rows.filter(row => row.expected !== category && row.predicted === category).length;
    const fn = rows.filter(row => row.expected === category && row.predicted !== category).length;
    return [category, { support: tp + fn, precision: tp + fp ? tp / (tp + fp) : 0,
      recall: tp + fn ? tp / (tp + fn) : 0, f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 0 }];
  }));
  return { count: rows.length, accuracy: rows.length ? rows.filter(row => row.expected === row.predicted).length / rows.length : 0,
    providerCoverage: rows.length ? rows.filter(row => row.predicted !== null).length / rows.length : 0,
    decisionCoverage: rows.length ? rows.filter(row => row.predicted !== null && row.predicted !== "UNCERTAIN").length / rows.length : 0,
    macroF1: Object.values(perCategory).reduce((sum, category) => sum + category.f1, 0) / BENCHMARK_CATEGORIES.length,
    perCategory, confusion };
}

export function templateGroup(body: string) {
  const normalized = body.replace(/^(?:dear|hi|hello)[^\n]*\n/i, "")
    .split(/\n(?:thank you|thanks|best regards|kind regards|regards|sincerely)\b/i)[0]
    .replace(/\b[^\s@]+@[^\s@]+\b/g, "<email>")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]+\b/g, "<reference>")
    .replace(/\d+(?:[.,:/-]\d+)*/g, "<number>")
    .toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function groupedSplit<T extends { id: string; group: string; category: string }>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  const buckets = new Map<string, T[][]>();
  for (const group of groups.values()) {
    const categories = [...new Set(group.map(row => row.category))].sort((a, b) =>
      group.filter(row => row.category === b).length - group.filter(row => row.category === a).length || a.localeCompare(b));
    buckets.set(categories[0], [...(buckets.get(categories[0]) ?? []), group]);
  }
  const dev: T[] = []; const holdout: T[] = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.length - b.length || a[0].group.localeCompare(b[0].group));
    const target = Math.round(bucket.reduce((sum, group) => sum + group.length, 0) * 0.23);
    let held = 0;
    bucket.forEach((group, index) => {
      if (held < target && index < bucket.length - 1) { holdout.push(...group); held += group.length; }
      else dev.push(...group);
    });
  }
  return { dev, holdout };
}

export async function pacedMap<T, R>(values: T[], concurrency: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  const results: R[] = new Array(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index], index);
    }
  }));
  return results;
}

export function quantile(values: number[], percentile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}
