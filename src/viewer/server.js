#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATASETS = {
  data_v2: {
    label: 'data_v2',
    dataDir: path.join(ROOT, 'training_data/sdoc-hackathon-docker/extracted/data_v2'),
    submissionPath: path.join(ROOT, 'outputs/jev-classification-submission.json'),
    detailsPath: path.join(ROOT, 'outputs/jev-classification-details.json'),
  },
  data_v3: {
    label: 'dataset_v3',
    dataDir: path.join(ROOT, 'data_v3'),
    submissionPath: path.join(ROOT, 'outputs/jev-v3-submission.json'),
    detailsPath: path.join(ROOT, 'outputs/jev-v3-details.json'),
  },
};
const STATIC_DIR = path.join(HERE, 'public');
const EXTRACTOR_PATH = path.join(HERE, 'extract_attachment.py');
const PORT = Number(process.env.VIEWER_PORT ?? 4173);

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': CONTENT_TYPES['.json'] });
  response.end(`${JSON.stringify(value)}\n`);
}

function validateEmailId(value) {
  return /^email_\d{3}$/.test(value);
}

function datasetConfig(datasetId) {
  const config = DATASETS[datasetId];
  if (!config) throw new Error('Invalid dataset');
  return config;
}

function resolveAttachment(datasetId, requestedPath) {
  const { dataDir } = datasetConfig(datasetId);
  const attachmentDir = path.join(dataDir, 'attachments');
  const normalised = requestedPath.replaceAll('\\', '/');
  const relative = normalised.startsWith('attachments/')
    ? normalised.slice('attachments/'.length)
    : normalised;
  const target = path.resolve(attachmentDir, relative);
  const base = `${path.resolve(attachmentDir)}${path.sep}`;
  if (!target.startsWith(base)) throw new Error('Invalid attachment path');
  return target;
}

async function loadDataset(datasetId) {
  const config = datasetConfig(datasetId);
  const inboxDir = path.join(config.dataDir, 'inbox');
  const [truth, submission, names] = await Promise.all([
    readJson(path.join(config.dataDir, 'ground_truth.json')),
    readJson(config.submissionPath),
    readdir(inboxDir),
  ]);
  let details = { model: null, generated_at: null, predictions: [] };
  try {
    details = await readJson(config.detailsPath);
  } catch {
    // Confidence details are optional; category results remain usable.
  }
  const detailById = new Map(
    details.predictions.map(item => [item.email_id, item]),
  );

  const emails = await Promise.all(
    names
      .filter(name => /^email_\d+\.json$/.test(name))
      .sort()
      .map(name => readJson(path.join(inboxDir, name))),
  );

  const rows = emails.map(email => {
    const expected = truth[email.email_id]?.category ?? null;
    const predicted = submission[email.email_id]?.category ?? null;
    const detail = detailById.get(email.email_id);
    return {
      dataset: datasetId,
      dataset_label: config.label,
      record_id: `${datasetId}:${email.email_id}`,
      email_id: email.email_id,
      from: email.from,
      subject: email.subject,
      attachment_count: email.attachments?.length ?? 0,
      predicted,
      expected,
      correct: predicted === expected,
      confidence: detail?.confidence ?? null,
      probabilities: detail?.probabilities ?? null,
    };
  });

  return {
    id: datasetId,
    label: config.label,
    model: details.model,
    generated_at: details.generated_at,
    emails: rows,
  };
}

function summariseRows(rows) {
  const correct = rows.filter(row => row.correct).length;
  return {
    total: rows.length,
    correct,
    incorrect: rows.length - correct,
    accuracy: rows.length ? correct / rows.length : 0,
  };
}

function summariseCategories(rows) {
  const categoryNames = [...new Set(rows.map(row => row.expected))];
  return categoryNames.map(category => {
    const categoryRows = rows.filter(row => row.expected === category);
    const summary = summariseRows(categoryRows);
    return { category, ...summary };
  });
}

async function loadDashboard() {
  const datasets = await Promise.all(
    Object.keys(DATASETS).map(datasetId => loadDataset(datasetId)),
  );
  const emails = datasets.flatMap(dataset => dataset.emails);
  const generatedDates = datasets
    .map(dataset => dataset.generated_at)
    .filter(Boolean)
    .sort();
  return {
    model: [...new Set(datasets.map(dataset => dataset.model).filter(Boolean))].join(', '),
    generated_at: generatedDates.at(-1) ?? null,
    summary: summariseRows(emails),
    categories: summariseCategories(emails),
    datasets: datasets.map(dataset => ({
      id: dataset.id,
      label: dataset.label,
      model: dataset.model,
      generated_at: dataset.generated_at,
      ...summariseRows(dataset.emails),
    })),
    emails,
  };
}

async function emailDetail(datasetId, emailId) {
  if (!validateEmailId(emailId)) throw new Error('Invalid email ID');
  const config = datasetConfig(datasetId);
  const [email, truth, submission, dataset] = await Promise.all([
    readJson(path.join(config.dataDir, 'inbox', `${emailId}.json`)),
    readJson(path.join(config.dataDir, 'ground_truth.json')),
    readJson(config.submissionPath),
    loadDataset(datasetId),
  ]);
  const row = dataset.emails.find(item => item.email_id === emailId);
  return {
    ...email,
    dataset: datasetId,
    dataset_label: config.label,
    predicted: submission[emailId]?.category ?? null,
    expected: truth[emailId]?.category ?? null,
    correct: row?.correct ?? false,
    confidence: row?.confidence ?? null,
    probabilities: row?.probabilities ?? null,
  };
}

async function attachmentPreview(datasetId, requestedPath) {
  const target = resolveAttachment(datasetId, requestedPath);
  await stat(target);
  const extension = path.extname(target).toLowerCase();
  if (extension === '.txt') {
    return {
      kind: 'text',
      format: 'TXT',
      content: await readFile(target, 'utf8'),
    };
  }
  if (extension === '.pdf') {
    return {
      kind: 'pdf',
      format: 'PDF',
      url: `/api/attachments/file?dataset=${encodeURIComponent(datasetId)}&path=${encodeURIComponent(requestedPath)}`,
    };
  }
  if (extension === '.docx' || extension === '.xlsx') {
    const { stdout } = await execFileAsync('python', [EXTRACTOR_PATH, target], {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  }
  return {
    kind: 'unavailable',
    format: extension.slice(1).toUpperCase() || 'FILE',
    message: 'No inline preview is available for this file type.',
  };
}

async function serveFile(response, filePath, { attachment = false } = {}) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('Not a file');
  const extension = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': info.size,
  };
  if (attachment) {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
  }
  response.writeHead(200, headers);
  createReadStream(filePath).pipe(response);
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    return json(response, 200, await loadDashboard());
  }

  const emailMatch = url.pathname.match(/^\/api\/emails\/(email_\d{3})$/);
  if (request.method === 'GET' && emailMatch) {
    const datasetId = url.searchParams.get('dataset') ?? 'data_v2';
    return json(response, 200, await emailDetail(datasetId, emailMatch[1]));
  }

  if (request.method === 'GET' && url.pathname === '/api/attachments/preview') {
    const requestedPath = url.searchParams.get('path');
    const datasetId = url.searchParams.get('dataset') ?? 'data_v2';
    if (!requestedPath) return json(response, 400, { error: 'path is required' });
    return json(response, 200, await attachmentPreview(datasetId, requestedPath));
  }

  if (request.method === 'GET' && url.pathname === '/api/attachments/file') {
    const requestedPath = url.searchParams.get('path');
    const datasetId = url.searchParams.get('dataset') ?? 'data_v2';
    if (!requestedPath) return json(response, 400, { error: 'path is required' });
    const target = resolveAttachment(datasetId, requestedPath);
    const shouldDownload = url.searchParams.get('download') === '1';
    return serveFile(response, target, { attachment: shouldDownload });
  }

  if (request.method !== 'GET') {
    return json(response, 405, { error: 'Method not allowed' });
  }

  const requestedStaticPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const staticTarget = path.resolve(STATIC_DIR, `.${requestedStaticPath}`);
  const staticBase = `${path.resolve(STATIC_DIR)}${path.sep}`;
  if (!staticTarget.startsWith(staticBase)) {
    return json(response, 404, { error: 'Not found' });
  }
  return serveFile(response, staticTarget);
}

const server = http.createServer((request, response) => {
  route(request, response).catch(error => {
    if (!response.headersSent) {
      const status = error.code === 'ENOENT' ? 404 : 500;
      json(response, status, { error: status === 404 ? 'Not found' : error.message });
    } else {
      response.destroy(error);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`SDOC classification viewer: http://127.0.0.1:${PORT}\n`);
});
