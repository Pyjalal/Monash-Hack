const state = {
  dashboard: null,
  datasetFilter: 'data_v2',
  resultFilter: 'all',
  categoryFilter: 'all',
  statusFilter: 'all',
  search: '',
};

const elements = {
  accuracy: document.querySelector('#accuracy'),
  allTabCount: document.querySelector('#allTabCount'),
  categoryBars: document.querySelector('#categoryBars'),
  categoryFilter: document.querySelector('#categoryFilter'),
  closeDrawer: document.querySelector('#closeDrawer'),
  correctCount: document.querySelector('#correctCount'),
  correctTabCount: document.querySelector('#correctTabCount'),
  drawer: document.querySelector('#emailDrawer'),
  drawerBackdrop: document.querySelector('#drawerBackdrop'),
  drawerContent: document.querySelector('#drawerContent'),
  drawerId: document.querySelector('#drawerId'),
  drawerSubject: document.querySelector('#drawerSubject'),
  datasetFilter: document.querySelector('#datasetFilter'),
  emailRows: document.querySelector('#emailRows'),
  emptyState: document.querySelector('#emptyState'),
  generatedAt: document.querySelector('#generatedAt'),
  finalScore: document.querySelector('#finalScore'),
  fieldF1: document.querySelector('#fieldF1'),
  defectsCaught: document.querySelector('#defectsCaught'),
  reviewRecall: document.querySelector('#reviewRecall'),
  reviewPrecision: document.querySelector('#reviewPrecision'),
  pipelinePanel: document.querySelector('#pipelinePanel'),
  policyNote: document.querySelector('#policyNote'),
  incorrectCount: document.querySelector('#incorrectCount'),
  incorrectTabCount: document.querySelector('#incorrectTabCount'),
  modelName: document.querySelector('#modelName'),
  resultHeading: document.querySelector('#resultHeading'),
  searchInput: document.querySelector('#searchInput'),
  statusFilter: document.querySelector('#statusFilter'),
  toast: document.querySelector('#toast'),
  totalCount: document.querySelector('#totalCount'),
  visibleCount: document.querySelector('#visibleCount'),
};

function percent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function categoryLabel(category) {
  return category?.replaceAll('_', ' ') ?? '—';
}

function fieldLabel(field) {
  return categoryLabel(field)?.toLowerCase().replace(/^./, character => character.toUpperCase());
}

function statusBadge(status) {
  const value = status ?? 'NOT_RUN';
  return node(
    'span',
    `status-badge status-badge--${value.toLowerCase().replaceAll('_', '-')}`,
    categoryLabel(value),
  );
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => (elements.toast.hidden = true), 2600);
}

function summarise(rows) {
  const correct = rows.filter(row => row.correct).length;
  return {
    total: rows.length,
    correct,
    incorrect: rows.length - correct,
    accuracy: rows.length ? correct / rows.length : 0,
  };
}

function scopedEmails() {
  return state.datasetFilter === 'all'
    ? state.dashboard.emails
    : state.dashboard.emails.filter(email => email.dataset === state.datasetFilter);
}

function scopedCategories() {
  const rows = scopedEmails();
  return [...new Set(rows.map(row => row.expected))].map(category => {
    const categoryRows = rows.filter(row => row.expected === category);
    return { category, ...summarise(categoryRows) };
  });
}

function renderSummary() {
  const selectedDataset = state.dashboard.datasets.find(
    item => item.id === state.datasetFilter,
  );
  const model = selectedDataset?.model ?? state.dashboard.model;
  const generatedAt = selectedDataset?.generated_at ?? state.dashboard.generated_at;
  const summary = summarise(scopedEmails());
  const scopeLabel = state.datasetFilter === 'all'
    ? 'all datasets'
    : selectedDataset?.label;
  elements.accuracy.textContent = percent(summary.accuracy);
  elements.correctCount.textContent = summary.correct.toLocaleString();
  elements.incorrectCount.textContent = summary.incorrect.toLocaleString();
  elements.totalCount.textContent = summary.total.toLocaleString();
  elements.allTabCount.textContent = summary.total;
  elements.correctTabCount.textContent = summary.correct;
  elements.incorrectTabCount.textContent = summary.incorrect;
  elements.modelName.textContent = model ?? 'Jev classification';
  elements.generatedAt.textContent = generatedAt
    ? `${scopeLabel} · run ${new Date(generatedAt).toLocaleString()}`
    : scopeLabel;
}

function renderPipelineSummary() {
  const score = state.dashboard.pipeline;
  elements.pipelinePanel.hidden = !score;
  if (!score) return;

  elements.finalScore.textContent = score.final_score.toFixed(4);
  elements.fieldF1.textContent = percent(score.stage3.field_f1);
  elements.defectsCaught.textContent = `${score.end_to_end.success}/${score.end_to_end.total}`;
  elements.reviewRecall.textContent = percent(score.reliability.escalation_recall);
  elements.reviewPrecision.textContent = percent(score.reliability.escalation_precision);
  const extraReviews = score.reliability.pred_review - score.reliability.gold_review;
  elements.policyNote.textContent =
    `${score.reliability.gold_review}/${score.reliability.gold_review} true review cases were caught. ` +
    `${extraReviews} additional BL-comparison emails are escalated because the active policy requires a complete readable SI/BL pair.`;
}

function renderCategoryBars() {
  elements.categoryBars.replaceChildren();
  for (const category of scopedCategories()) {
    const card = node('article', 'category-bar');
    const top = node('div', 'category-bar__top');
    top.append(
      node('span', 'category-bar__name', categoryLabel(category.category)),
      node('span', '', percent(category.accuracy, 0)),
    );
    const track = node('div', 'category-bar__track');
    const fill = node('div', 'category-bar__fill');
    fill.style.width = percent(category.accuracy);
    track.append(fill);
    card.append(
      top,
      track,
      node('div', 'category-bar__meta', `${category.correct} of ${category.total} correct`),
    );
    elements.categoryBars.append(card);
  }
}

function populateCategoryFilter() {
  elements.categoryFilter.replaceChildren();
  const allOption = node('option', '', 'All categories');
  allOption.value = 'all';
  elements.categoryFilter.append(allOption);
  for (const { category } of scopedCategories()) {
    const option = node('option', '', categoryLabel(category));
    option.value = category;
    elements.categoryFilter.append(option);
  }
}

function populateDatasetFilter() {
  for (const dataset of state.dashboard.datasets) {
    const option = node('option', '', `${dataset.label} (${dataset.total})`);
    option.value = dataset.id;
    elements.datasetFilter.append(option);
  }
  elements.datasetFilter.value = state.datasetFilter;
}

function filteredEmails() {
  const query = state.search.toLowerCase();
  return scopedEmails().filter(email => {
    const resultMatches =
      state.resultFilter === 'all' ||
      (state.resultFilter === 'correct' && email.correct) ||
      (state.resultFilter === 'incorrect' && !email.correct);
    const categoryMatches =
      state.categoryFilter === 'all' || email.expected === state.categoryFilter;
    const statusMatches =
      state.statusFilter === 'all' ||
      (state.statusFilter === 'NOT_RUN' && email.pipeline_status === null) ||
      email.pipeline_status === state.statusFilter;
    const searchMatches =
      !query ||
      email.email_id.toLowerCase().includes(query) ||
      email.subject.toLowerCase().includes(query) ||
      email.from.toLowerCase().includes(query) ||
      email.review_reason?.toLowerCase().includes(query) ||
      email.defect_fields.some(field => field.toLowerCase().includes(query));
    return resultMatches && categoryMatches && statusMatches && searchMatches;
  });
}

function renderRows() {
  const emails = filteredEmails();
  const scopedTotal = scopedEmails().length;
  elements.emailRows.replaceChildren();
  elements.emptyState.hidden = emails.length !== 0;
  elements.visibleCount.textContent = `Showing ${emails.length} of ${scopedTotal} emails`;
  elements.resultHeading.textContent =
    state.resultFilter === 'all'
      ? 'All emails'
      : `${state.resultFilter[0].toUpperCase()}${state.resultFilter.slice(1)} emails`;

  for (const email of emails) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open ${email.email_id}: ${email.subject}`);

    const resultCell = document.createElement('td');
    resultCell.append(
      node(
        'span',
        `result-icon ${email.correct ? 'result-icon--correct' : 'result-icon--incorrect'}`,
        email.correct ? '✓' : '!',
      ),
    );
    const mailCell = node('td', 'email-cell');
    mailCell.append(node('strong', '', email.subject), node('span', '', `${email.email_id} · ${email.from}`));
    const datasetCell = document.createElement('td');
    datasetCell.append(node('span', 'dataset-badge', email.dataset_label));
    const predictedCell = document.createElement('td');
    predictedCell.append(node('span', 'badge', categoryLabel(email.predicted)));
    const expectedCell = document.createElement('td');
    expectedCell.append(node('span', 'badge badge--truth', categoryLabel(email.expected)));
    const statusCell = document.createElement('td');
    statusCell.append(statusBadge(email.pipeline_status));
    const defectsCell = node(
      'td',
      'defect-cell',
      email.defect_fields.length ? email.defect_fields.map(fieldLabel).join(', ') : '—',
    );
    const confidenceCell = node(
      'td',
      'confidence',
      email.confidence == null ? '—' : percent(email.confidence),
    );
    const fileCell = node(
      'td',
      'attachment-count',
      email.attachment_count ? `${email.attachment_count} files` : '—',
    );
    row.append(
      resultCell,
      datasetCell,
      mailCell,
      predictedCell,
      expectedCell,
      statusCell,
      defectsCell,
      confidenceCell,
      fileCell,
    );
    row.addEventListener('click', () => openEmail(email.dataset, email.email_id));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') openEmail(email.dataset, email.email_id);
    });
    elements.emailRows.append(row);
  }
}

function comparisonItem(label, value, truth = false) {
  const item = node('div', 'comparison-item');
  item.append(node('span', '', label), node('strong', truth ? 'badge badge--truth' : 'badge', categoryLabel(value)));
  return item;
}

function mailMetadata(email) {
  const wrapper = node('div', 'mail-meta');
  for (const [label, value] of [
    ['Dataset', email.dataset_label],
    ['From', email.from],
    ['Subject', email.subject],
  ]) {
    const row = document.createElement('div');
    row.append(node('strong', '', label), node('span', '', value));
    wrapper.append(row);
  }
  return wrapper;
}

function attachmentCard(datasetId, attachmentPath) {
  const filename = attachmentPath.split('/').at(-1);
  const extension = filename.split('.').at(-1).toUpperCase();
  const card = node('article', 'attachment-card');
  const header = node('div', 'attachment-card__header');
  const title = node('div', 'attachment-card__title');
  title.append(node('span', 'file-icon', extension), node('span', '', filename));
  const actions = node('div', 'attachment-actions');
  const previewButton = node('button', 'small-button', 'Preview');
  previewButton.type = 'button';
  const download = node('a', 'small-button', 'Download');
  download.href = `/api/attachments/file?dataset=${encodeURIComponent(datasetId)}&path=${encodeURIComponent(attachmentPath)}&download=1`;
  download.addEventListener('click', event => event.stopPropagation());
  actions.append(previewButton, download);
  header.append(title, actions);
  card.append(header);

  previewButton.addEventListener('click', async () => {
    previewButton.disabled = true;
    previewButton.textContent = 'Loading…';
    let preview = card.querySelector('.attachment-preview');
    if (preview) {
      preview.remove();
      previewButton.disabled = false;
      previewButton.textContent = 'Preview';
      return;
    }
    try {
      const response = await fetch(`/api/attachments/preview?dataset=${encodeURIComponent(datasetId)}&path=${encodeURIComponent(attachmentPath)}`);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Preview failed');
      const data = await response.json();
      preview = renderAttachmentPreview(data);
      card.append(preview);
      previewButton.textContent = 'Hide';
    } catch (error) {
      showToast(error.message);
      previewButton.textContent = 'Retry';
    } finally {
      previewButton.disabled = false;
    }
  });
  return card;
}

function renderAttachmentPreview(data) {
  const wrapper = node('div', 'attachment-preview');
  if (data.kind === 'text') {
    wrapper.append(node('pre', 'text-preview', data.content || 'This document contains no readable text.'));
  } else if (data.kind === 'pdf') {
    const frame = node('iframe', 'pdf-preview');
    frame.src = data.url;
    frame.title = 'PDF attachment preview';
    wrapper.append(frame);
  } else if (data.kind === 'workbook') {
    for (const sheet of data.sheets) {
      const section = node('section', 'sheet');
      section.append(node('h4', '', sheet.name));
      const table = document.createElement('table');
      const body = document.createElement('tbody');
      for (const values of sheet.rows) {
        const row = document.createElement('tr');
        for (const value of values) row.append(node('td', '', value));
        body.append(row);
      }
      table.append(body);
      section.append(table);
      wrapper.append(section);
    }
  } else {
    wrapper.append(node('p', 'preview-message', data.message ?? 'Preview unavailable.'));
  }
  return wrapper;
}

function pipelineDecision(email) {
  const section = node('section', 'content-section pipeline-decision');
  section.append(node('h3', '', 'Pipeline decision'));
  if (!email.pipeline) {
    section.append(node('p', 'preview-message', 'The extraction pipeline has not been run for this dataset.'));
    return section;
  }

  const grid = node('div', 'decision-grid');
  const predicted = node('div', 'decision-item');
  predicted.append(node('span', '', 'Pipeline outcome'), statusBadge(email.pipeline.status));
  const expected = node('div', 'decision-item');
  expected.append(node('span', '', 'Ground truth'), statusBadge(email.expected_result.status));
  const reason = node('div', 'decision-item');
  reason.append(
    node('span', '', 'Review reason'),
    node('strong', '', categoryLabel(email.pipeline.review_reason) || '—'),
  );
  const attachmentState = node('div', 'decision-item');
  attachmentState.append(
    node('span', '', 'Attachment state'),
    node('strong', '', categoryLabel(email.extraction?.attachment_status)),
  );
  grid.append(predicted, expected, reason, attachmentState);

  const defects = node('div', 'defect-summary');
  const predictedFields = email.pipeline.defect_fields ?? [];
  const expectedFields = email.expected_result.defect_fields ?? [];
  defects.append(
    node('strong', '', 'Detected defects'),
    node('span', '', predictedFields.length ? predictedFields.map(fieldLabel).join(', ') : 'None'),
    node('strong', '', 'Ground-truth defects'),
    node('span', '', expectedFields.length ? expectedFields.map(fieldLabel).join(', ') : 'None'),
  );
  section.append(grid, defects);
  return section;
}

function extractedFieldComparison(email) {
  const section = node('section', 'content-section extraction-section');
  section.append(node('h3', '', 'Seven-field SI–BL comparison'));
  const extraction = email.extraction;
  if (!extraction) {
    section.append(node('p', 'preview-message', 'No extraction result is available for this email.'));
    return section;
  }

  const siFields = extraction.documents?.si?.fields;
  const blFields = extraction.documents?.bl?.fields;
  if (!siFields && !blFields) {
    section.append(
      node(
        'p',
        'preview-message preview-message--review',
        extraction.attachment_status === 'NOT_APPLICABLE'
          ? extraction.skipped_reason
          : extraction.attachment_status === 'NO_ATTACHMENTS'
          ? 'No attachments were supplied. The email was sent to human review and no field values were inferred.'
          : 'The available attachment could not support a complete SI–BL comparison.',
      ),
    );
    return section;
  }

  const documentMeta = node('div', 'document-meta');
  for (const [label, document] of [
    ['SI document', extraction.documents?.si],
    ['BL document', extraction.documents?.bl],
  ]) {
    const card = node('div', 'document-meta__item');
    card.append(
      node('span', '', label),
      node('strong', '', document?.filename?.split('/').at(-1) ?? 'Missing'),
      node('small', '', document?.readable === false
        ? `Unreadable · ${document.error ?? 'No text extracted'}`
        : categoryLabel(document?.document_type)),
    );
    documentMeta.append(card);
  }

  const wrapper = node('div', 'field-table-wrap');
  const table = node('table', 'field-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Field', 'Shipping instruction', 'Bill of lading', 'Result']) {
    headRow.append(node('th', '', label));
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  const fields = [
    'shipper',
    'consignee',
    'notify_party',
    'port_of_loading',
    'port_of_discharge',
    'container_count',
    'gross_weight_kg',
  ];
  for (const field of fields) {
    const si = siFields?.[field];
    const bl = blFields?.[field];
    const comparable = si?.normalized_value != null && bl?.normalized_value != null;
    const matches = comparable && si.normalized_value === bl.normalized_value;
    const row = document.createElement('tr');
    row.className = comparable ? (matches ? 'field-row--match' : 'field-row--mismatch') : 'field-row--review';
    row.append(
      node('td', 'field-name', fieldLabel(field)),
      node('td', 'field-value', si?.value ?? '—'),
      node('td', 'field-value', bl?.value ?? '—'),
    );
    const result = document.createElement('td');
    result.append(
      node(
        'span',
        `field-result field-result--${comparable ? (matches ? 'match' : 'mismatch') : 'review'}`,
        comparable ? (matches ? 'Match' : 'Mismatch') : 'Review',
      ),
    );
    row.append(result);
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  section.append(documentMeta, wrapper);
  return section;
}

async function openEmail(datasetId, emailId) {
  elements.drawerBackdrop.hidden = false;
  elements.drawer.classList.add('is-open');
  elements.drawer.setAttribute('aria-hidden', 'false');
  const datasetLabel = state.dashboard.datasets.find(item => item.id === datasetId)?.label ?? datasetId;
  elements.drawerId.textContent = `${datasetLabel} · ${emailId}`;
  elements.drawerSubject.textContent = 'Loading email…';
  elements.drawerContent.replaceChildren(node('p', 'preview-message', 'Loading message and attachment details…'));
  document.body.style.overflow = 'hidden';

  try {
    const response = await fetch(`/api/emails/${emailId}?dataset=${encodeURIComponent(datasetId)}`);
    if (!response.ok) throw new Error((await response.json()).error ?? 'Could not load email');
    const email = await response.json();
    elements.drawerSubject.textContent = email.subject;
    const comparison = node('div', 'comparison-card');
    comparison.append(
      comparisonItem('Jev prediction', email.predicted),
      comparisonItem('Ground truth', email.expected, true),
      node(
        'div',
        `match-callout ${email.correct ? 'match-callout--correct' : 'match-callout--incorrect'}`,
        email.correct
          ? `Correct classification${email.confidence == null ? '' : ` · ${percent(email.confidence)} confidence`}`
          : 'Incorrect classification — review the message evidence below.',
      ),
    );

    const bodySection = node('section', 'content-section');
    bodySection.append(node('h3', '', 'Email body'), node('pre', 'mail-body', email.body));
    const attachmentsSection = node('section', 'content-section');
    attachmentsSection.append(node('h3', '', `Attachments (${email.attachments.length})`));
    const list = node('div', 'attachment-list');
    if (email.attachments.length) {
      for (const attachment of email.attachments) list.append(attachmentCard(email.dataset, attachment));
    } else {
      list.append(node('p', 'preview-message', 'This email has no attachments.'));
    }
    attachmentsSection.append(list);
    elements.drawerContent.replaceChildren(
      comparison,
      pipelineDecision(email),
      extractedFieldComparison(email),
      mailMetadata(email),
      bodySection,
      attachmentsSection,
    );
  } catch (error) {
    elements.drawerContent.replaceChildren(node('p', 'preview-message', error.message));
  }
}

function closeDrawer() {
  elements.drawer.classList.remove('is-open');
  elements.drawer.setAttribute('aria-hidden', 'true');
  elements.drawerBackdrop.hidden = true;
  document.body.style.overflow = '';
}

async function initialise() {
  const response = await fetch('/api/dashboard');
  if (!response.ok) throw new Error((await response.json()).error ?? 'Could not load dashboard');
  state.dashboard = await response.json();
  populateDatasetFilter();
  renderSummary();
  renderPipelineSummary();
  renderCategoryBars();
  populateCategoryFilter();
  renderRows();
}

document.querySelectorAll('.filter-tab').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(item => item.classList.remove('is-active'));
    button.classList.add('is-active');
    state.resultFilter = button.dataset.filter;
    renderRows();
  });
});
elements.searchInput.addEventListener('input', event => {
  state.search = event.target.value.trim();
  renderRows();
});
elements.datasetFilter.addEventListener('change', event => {
  state.datasetFilter = event.target.value;
  state.categoryFilter = 'all';
  populateCategoryFilter();
  renderSummary();
  renderCategoryBars();
  renderRows();
});
elements.categoryFilter.addEventListener('change', event => {
  state.categoryFilter = event.target.value;
  renderRows();
});
elements.statusFilter.addEventListener('change', event => {
  state.statusFilter = event.target.value;
  renderRows();
});
elements.closeDrawer.addEventListener('click', closeDrawer);
elements.drawerBackdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDrawer();
});

initialise().catch(error => {
  showToast(error.message);
  elements.emailRows.replaceChildren();
  elements.emptyState.hidden = false;
  elements.emptyState.textContent = error.message;
});
