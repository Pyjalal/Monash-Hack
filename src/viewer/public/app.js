const state = {
  dashboard: null,
  resultFilter: 'all',
  categoryFilter: 'all',
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
  emailRows: document.querySelector('#emailRows'),
  emptyState: document.querySelector('#emptyState'),
  generatedAt: document.querySelector('#generatedAt'),
  incorrectCount: document.querySelector('#incorrectCount'),
  incorrectTabCount: document.querySelector('#incorrectTabCount'),
  modelName: document.querySelector('#modelName'),
  resultHeading: document.querySelector('#resultHeading'),
  searchInput: document.querySelector('#searchInput'),
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

function renderSummary() {
  const { summary, model, generated_at: generatedAt } = state.dashboard;
  elements.accuracy.textContent = percent(summary.accuracy);
  elements.correctCount.textContent = summary.correct.toLocaleString();
  elements.incorrectCount.textContent = summary.incorrect.toLocaleString();
  elements.totalCount.textContent = summary.total.toLocaleString();
  elements.allTabCount.textContent = summary.total;
  elements.correctTabCount.textContent = summary.correct;
  elements.incorrectTabCount.textContent = summary.incorrect;
  elements.modelName.textContent = model ?? 'Jev classification';
  elements.generatedAt.textContent = generatedAt
    ? `Run ${new Date(generatedAt).toLocaleString()}`
    : 'Latest run';
}

function renderCategoryBars() {
  elements.categoryBars.replaceChildren();
  for (const category of state.dashboard.categories) {
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
  for (const { category } of state.dashboard.categories) {
    const option = node('option', '', categoryLabel(category));
    option.value = category;
    elements.categoryFilter.append(option);
  }
}

function filteredEmails() {
  const query = state.search.toLowerCase();
  return state.dashboard.emails.filter(email => {
    const resultMatches =
      state.resultFilter === 'all' ||
      (state.resultFilter === 'correct' && email.correct) ||
      (state.resultFilter === 'incorrect' && !email.correct);
    const categoryMatches =
      state.categoryFilter === 'all' || email.expected === state.categoryFilter;
    const searchMatches =
      !query ||
      email.email_id.toLowerCase().includes(query) ||
      email.subject.toLowerCase().includes(query) ||
      email.from.toLowerCase().includes(query);
    return resultMatches && categoryMatches && searchMatches;
  });
}

function renderRows() {
  const emails = filteredEmails();
  elements.emailRows.replaceChildren();
  elements.emptyState.hidden = emails.length !== 0;
  elements.visibleCount.textContent = `Showing ${emails.length} of ${state.dashboard.summary.total} emails`;
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
    const predictedCell = document.createElement('td');
    predictedCell.append(node('span', 'badge', categoryLabel(email.predicted)));
    const expectedCell = document.createElement('td');
    expectedCell.append(node('span', 'badge badge--truth', categoryLabel(email.expected)));
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
    row.append(resultCell, mailCell, predictedCell, expectedCell, confidenceCell, fileCell);
    row.addEventListener('click', () => openEmail(email.email_id));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') openEmail(email.email_id);
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
    ['From', email.from],
    ['Subject', email.subject],
  ]) {
    const row = document.createElement('div');
    row.append(node('strong', '', label), node('span', '', value));
    wrapper.append(row);
  }
  return wrapper;
}

function attachmentCard(attachmentPath) {
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
  download.href = `/api/attachments/file?path=${encodeURIComponent(attachmentPath)}&download=1`;
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
      const response = await fetch(`/api/attachments/preview?path=${encodeURIComponent(attachmentPath)}`);
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

async function openEmail(emailId) {
  elements.drawerBackdrop.hidden = false;
  elements.drawer.classList.add('is-open');
  elements.drawer.setAttribute('aria-hidden', 'false');
  elements.drawerId.textContent = emailId;
  elements.drawerSubject.textContent = 'Loading email…';
  elements.drawerContent.replaceChildren(node('p', 'preview-message', 'Loading message and attachment details…'));
  document.body.style.overflow = 'hidden';

  try {
    const response = await fetch(`/api/emails/${emailId}`);
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
      for (const attachment of email.attachments) list.append(attachmentCard(attachment));
    } else {
      list.append(node('p', 'preview-message', 'This email has no attachments.'));
    }
    attachmentsSection.append(list);
    elements.drawerContent.replaceChildren(comparison, mailMetadata(email), bodySection, attachmentsSection);
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
  renderSummary();
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
elements.categoryFilter.addEventListener('change', event => {
  state.categoryFilter = event.target.value;
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
