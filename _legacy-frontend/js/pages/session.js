// Session detail: one study session's workspace. Loads GET /api/sessions/:id
// (session + its sources + its decks), renders the header with edit/archive
// actions, lists material with per-source moves, lists decks, and wires the
// scoped Study / Quiz / Flashcards actions. The session id comes from
// ?id=ses_… in the URL — the same page always shows the same session.

import { mountShell, mountHealthBanner } from '../components/shell.js';
import { openSessionDialog, categoryLabel } from '../components/session-form.js';
import { mountImportPanel } from '../components/material-import.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, showEmpty, showError, formatRelative,
  sourceIcon,
} from '../ui.js';

mountShell('library');
mountHealthBanner(document.querySelector('[data-health]'));

// The session page gets a light restyle, so the classic data-* hosts stay the
// contract; anything missing degrades to a detached element instead of
// crashing the page.
const headHost = document.querySelector('[data-session-head]') || document.createElement('div');
const sourcesHost = document.querySelector('[data-sources]') || document.createElement('div');
const sourcesMeta = document.querySelector('[data-sources-meta]');
const decksHost = document.querySelector('[data-decks]') || document.createElement('div');
const importPanel = document.querySelector('[data-import-panel]');

const params = new URLSearchParams(window.location.search);
const sessionId = (params.get('id') || '').trim();

let session = null;
let sources = [];
let decks = [];
let otherSessions = []; // for the per-source move dropdowns

/* ---------------------------------------------------------------- load --- */

async function load() {
  if (!sessionId) {
    renderFatal('No session selected', 'Open a session from your Study Library.', 'library.html', 'Back to library');
    return;
  }
  try {
    const data = await api.getSession(sessionId);
    session = data.session;
    sources = data.sources || [];
    decks = data.decks || [];
    document.title = `${session.title} — Socius AI`;
    renderHead();
    renderSources();
    renderDecks();
  } catch (error) {
    if (error.code === 'SESSION_NOT_FOUND') {
      renderFatal('Session not found', 'It may have been removed. Your material is safe in the library.', 'library.html', 'Back to library');
      return;
    }
    showError(headHost, error, { title: 'Could not load this session', onRetry: load });
  }
}

async function loadOtherSessions() {
  try {
    const data = await api.listSessions();
    otherSessions = (data.sessions || []).filter((item) => item.id !== sessionId);
  } catch {
    otherSessions = []; // move dropdowns degrade to Unsorted only
  }
}

function renderFatal(title, text, href, label) {
  headHost.innerHTML = '';
  const target = headHost.parentElement || document.getElementById('main');
  if (!target) return;
  showEmpty(target, {
    iconName: 'folder', title, text,
    actions: `<a class="btn btn-primary btn-sm" href="${href}">${label}</a>`,
  });
}

/* --------------------------------------------------------------- head --- */

function renderHead() {
  const archived = session.status === 'archived';
  headHost.innerHTML = `
    <div class="sd-head">
      <p class="page-eyebrow"><a href="library.html" class="sd-crumb">Library</a> · ${escapeHtml(categoryLabel(session.category))}</p>
      <div class="sd-title-row">
        <h1 class="page-title">${escapeHtml(session.title)}</h1>
        ${archived ? '<span class="badge">Archived</span>' : ''}
      </div>
      ${session.description ? `<p class="page-sub">${escapeHtml(session.description)}</p>` : ''}
      <div class="sd-tags">
        <span class="badge badge-blue">${escapeHtml(categoryLabel(session.category))}</span>
        ${(session.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
      </div>
      <div class="sd-meta">
        <span>${sources.length} ${sources.length === 1 ? 'source' : 'sources'}</span>
        <span>${decks.length} ${decks.length === 1 ? 'deck' : 'decks'}</span>
        <span>updated ${escapeHtml(formatRelative(session.updatedAt))}</span>
        ${archived ? '<span>Archived sessions stay available here — nothing is deleted.</span>' : ''}
      </div>
      <div class="sd-actions">
        <button type="button" class="btn btn-secondary" data-add-toggle aria-expanded="false" aria-controls="import-panel">Add material</button>
        <button type="button" class="btn btn-secondary" data-edit>${icon('pencil', { size: 14 })} Edit session</button>
        ${archived
          ? '<button type="button" class="btn btn-quiet" data-restore>Restore</button>'
          : '<button type="button" class="btn btn-quiet" data-archive>Archive</button>'}
      </div>
      <div class="sd-tools">
        <span class="sd-tools-label">Study with this session's material only</span>
        <a class="btn btn-primary" href="study.html?session=${encodeURIComponent(session.id)}">${icon('book', { size: 15 })} Study</a>
        <a class="btn btn-secondary" href="quiz.html?session=${encodeURIComponent(session.id)}">${icon('clipboard', { size: 15 })} Quiz me</a>
        <a class="btn btn-secondary" href="flashcards.html?session=${encodeURIComponent(session.id)}">${icon('layers', { size: 15 })} Flashcards</a>
      </div>
    </div>`;

  if (archived) headHost.querySelector('[data-restore]')?.addEventListener('click', () => setStatus('active'));
  else headHost.querySelector('[data-archive]')?.addEventListener('click', () => setStatus('archived'));
  headHost.querySelector('[data-edit]')?.addEventListener('click', async () => {
    if (await openSessionDialog(session)) load();
  });
  wireImportToggle(headHost.querySelector('[data-add-toggle]'));
}

/* ------------------------------------------------------------ actions --- */

async function setStatus(status) {
  try {
    await api.updateSession(sessionId, { status });
    await load();
  } catch (error) {
    showError(headHost, error, { title: status === 'archived' ? 'Could not archive this session' : 'Could not restore this session', onRetry: load });
  }
}

function wireImportToggle(toggle) {
  if (!toggle || !importPanel) return;
  toggle.addEventListener('click', () => {
    const open = importPanel.hidden;
    if (open && !importPanel.dataset.mounted) {
      // knownSources feeds the optional duplicate hint (see material-import.js).
      mountImportPanel({ host: importPanel, sessionId, knownSources: () => sources, onOrganised: () => loadOtherSessions().then(load) });
      importPanel.dataset.mounted = '1';
    }
    importPanel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide material tools' : 'Add material';
    if (open) importPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

/* ------------------------------------------------------------ sources --- */

function moveSelect(source) {
  const options = otherSessions
    .filter((item) => item.status === 'active')
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`)
    .join('');
  return `
    <label class="sr-only" for="sd-move-${escapeHtml(source.id)}">Move ${escapeHtml(source.title)} to another session</label>
    <select class="select lib-move-select" id="sd-move-${escapeHtml(source.id)}" data-move-select>
      <option value="">Move to…</option>
      <option value="unsorted">Unsorted</option>
      ${options}
    </select>`;
}

function renderSources() {
  if (sourcesMeta) sourcesMeta.textContent = sources.length ? `${sources.length} ${sources.length === 1 ? 'item' : 'items'}` : '';

  if (sources.length === 0) {
    if (decks.length === 0) {
      // Fully empty session: the primary guidance is adding material here.
      showEmpty(sourcesHost, {
        iconName: 'inbox',
        title: `Add material to «${session.title}» first`,
        text: `The Add material tools are right on this page — the button below opens them, where you can upload a PDF or PowerPoint or paste a web page directly into «${session.title}». The tutor and quiz features for this session unlock once it contains material, and flashcards can then be generated from the same sources.`,
        actions: '<button type="button" class="btn btn-primary btn-sm" data-add-empty>Add material</button>',
      });
    } else {
      showEmpty(sourcesHost, {
        iconName: 'inbox',
        title: 'Add material first',
        text: 'The tutor, quizzes and flashcards only search what is inside this session. Add a PDF, PowerPoint or web page to get started.',
        actions: '<button type="button" class="btn btn-primary btn-sm" data-add-empty>Add material</button>',
      });
    }
    sourcesHost.querySelector('[data-add-empty]')?.addEventListener('click', () => {
      headHost.querySelector('[data-add-toggle]')?.click();
    });
    return;
  }

  sourcesHost.innerHTML = `<div class="row-list">${sources.map((source) => `
    <div class="row-item">
      <span class="row-icon">${sourceIcon(source.type, { size: 15 })}</span>
      <span class="sd-source-main">
        <span class="sd-source-title">${escapeHtml(source.title)}</span>
        <span class="sd-source-meta">${escapeHtml(source.sizeLabel || '')}${source.chunkCount ? ` · ${source.chunkCount} passages` : ''}</span>
      </span>
      ${moveSelect(source)}
    </div>`).join('')}</div>`;
}

sourcesHost.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-move-select]');
  if (!select || !select.value) return;
  const row = select.closest('.row-item');
  const sourceId = row.querySelector('[data-move-select]').id.replace('sd-move-', '');
  select.disabled = true;
  try {
    await api.updateSource(sourceId, { sessionId: select.value === 'unsorted' ? null : select.value });
    await loadOtherSessions();
    await load();
  } catch (error) {
    select.disabled = false;
    showError(sourcesHost, error, { title: 'Could not move that file', onRetry: load });
  }
});

/* -------------------------------------------------------------- decks --- */

function renderDecks() {
  if (decks.length === 0) {
    showEmpty(decksHost, {
      iconName: 'layers',
      title: 'No decks yet',
      text: sources.length === 0
        ? 'Add material first, then generate flashcards from it.'
        : 'Generate a deck from this session\u2019s material — it will live here.',
      actions: sources.length === 0
        ? ''
        : `<a class="btn btn-primary btn-sm" href="flashcards.html?session=${encodeURIComponent(sessionId)}">Make flashcards</a>`,
    });
    return;
  }
  decksHost.innerHTML = `<div class="row-list">${decks.map((deck) => `
    <a class="row-item sd-deck" href="flashcards.html?deck=${encodeURIComponent(deck.id)}">
      <span class="row-icon">${icon('layers', { size: 15 })}</span>
      <span class="sd-source-main">
        <span class="sd-source-title">${escapeHtml(deck.topic)}</span>
        <span class="sd-source-meta">${deck.cardCount} cards · created ${escapeHtml(formatRelative(deck.createdAt))}</span>
      </span>
      <span class="row-meta">Open</span>
    </a>`).join('')}</div>`;
}

/* ---------------------------------------------------------------- init --- */

loadOtherSessions();
load();
