// =============================================================================
// pages/session.js — Study Sessions.
//
// TWO VIEWS, ONE PAGE (the shell gives sessions one nav entry, and the legacy
// frontend kept both here too):
//
//   · no ?id=      → the session list: search / category / sort / archived,
//                    create, archive & restore, and the "share a link" panel.
//   · ?id=ses_…    → one session's workspace: the material it searches (its
//                    scope), its flashcard decks, the activity recorded so far,
//                    the shared import panel for adding material to THIS
//                    session, and links into the three flows a session drives
//                    (study.html, quiz.html, flashcards.html — all with
//                    ?session=, which the backend enforces as the scope).
//
// DATA comes only from js/api.js (GET/POST/PATCH/DELETE /api/sessions…,
// POST /api/share). Every value that came from the user or the server is
// escaped with ui.js#escapeHtml before it reaches the DOM.
//
// A SHARED LINK IS EXTERNAL INPUT. It is never pasted into HTML: it is sent to
// the API as data, and the only place it can become a link is ui.js#citationEl,
// which renders an <a> only for an http(s) URL.
//
// HONEST DEGRADATION. Two calls have no backend yet:
//   · POST /api/share          — "planned (Wave 4)" in docs/API_CONTRACT.md
//   · DELETE /api/sessions/:id — not in the contract, and not in
//                                server/routes/sessions.js
// Both answer 404 NOT_FOUND today. The page then says plainly that the feature
// is not available and that nothing was changed. It never fakes a success and
// never crashes.
//
// A23 owns the shared session dialog (components/session-form.js) and the one
// import panel (components/material-import.js); this page imports both and does
// not re-implement either.
// =============================================================================

import { mountShell } from '../components/shell.js';
import { CATEGORIES, categoryLabel, openSessionDialog } from '../components/session-form.js';
import { mountImportPanel } from '../components/material-import.js';
import { apiDelete, apiGet, apiPatch, apiPost, isMockMode } from '../api.js';
import {
  citationEl, debounce, emptyState, errorMessage, errorState, escapeHtml, formatDate,
  formatRelative, icon, on, plural, spinner, toast,
} from '../ui.js';

// Mounts the sidebar/topbar/health pill and moves <main> into the content
// column. In supabase mode a visitor without a session is redirected, in which
// case the mount leaves no `.app-shell` behind and init() never runs.
await mountShell({ page: 'session' });

/* --------------------------------------------------------------- constants */

const SHARE_TITLE_MAX = 160;
const SHARE_TEXT_MIN = 50; // only when the student pastes page text
const SHARE_TEXT_MAX = 200000;

// Source types the citation schema documents; anything unknown renders as a file.
// One map, not two: the icon and the label share a key set, and keeping them in
// separate objects meant adding a type to one and forgetting the other, which
// produced a badge with an icon but no text.
const SOURCE_TYPES = {
  pdf: { icon: 'file', label: 'PDF' },
  pptx: { icon: 'slides', label: 'Slides' },
  docx: { icon: 'file', label: 'Document' },
  webpage: { icon: 'globe', label: 'Web page' },
  youtube: { icon: 'globe', label: 'Video' },
  image: { icon: 'file', label: 'Image' },
};
const sourceInfo = (type) => SOURCE_TYPES[type] ?? { icon: 'file', label: 'Source' };

/* ------------------------------------------------------------------ state */

const state = {
  view: 'list', // 'list' | 'detail'
  sessionId: '',
  session: null,
  sources: [],
  decks: [],
  sessions: [],
  unsortedSourceCount: 0,
  list: { q: '', category: '', sort: 'recent', includeArchived: false },
  importMounted: false,
};

/* ------------------------------------------------------------------- hosts */

const root = document.querySelector('.container');
const eyebrowEl = document.querySelector('[data-ses-eyebrow]');
const titleEl = document.querySelector('[data-ses-title]');
const subEl = document.querySelector('[data-ses-sub]');
const badgesEl = document.querySelector('[data-ses-badges]');
const actionsEl = document.querySelector('[data-ses-actions]');
const noticeEl = document.querySelector('[data-ses-notice]');

const listEl = document.querySelector('[data-ses-list]');
const listBody = document.querySelector('[data-ses-list-body]');
const unsortedEl = document.querySelector('[data-ses-unsorted]');
const searchInput = document.getElementById('ses-search');
const categorySelect = document.getElementById('ses-category');
const sortSelect = document.getElementById('ses-sort');
const archivedCheckbox = document.getElementById('ses-archived');

const detailEl = document.querySelector('[data-ses-detail]');
const toolsHost = document.querySelector('[data-ses-tools]');
const importEl = document.querySelector('[data-ses-import]');
const importBody = document.querySelector('[data-ses-import-body]');
const scopeHost = document.querySelector('[data-ses-scope]');
const decksHost = document.querySelector('[data-ses-decks]');
const activityHost = document.querySelector('[data-ses-activity]');

const shareEl = document.querySelector('[data-ses-share]');
const shareForm = document.querySelector('[data-share-form]');
const shareUrlInput = document.getElementById('ses-share-url');
const shareTitleInput = document.getElementById('ses-share-title-input');
const shareTextInput = document.getElementById('ses-share-text');
const shareError = document.querySelector('[data-share-error]');
const shareSubmit = document.querySelector('[data-share-submit]');
const shareStatus = document.querySelector('[data-share-status]');

/* ---------------------------------------------------------------- helpers */

/** "14 pages" / "8 slides" when the count is known, else the stored label. */
function sizeLabel(source) {
  if (source.pageCount) return plural(source.pageCount, 'page');
  if (source.slideCount) return plural(source.slideCount, 'slide');
  return source.sizeLabel || '';
}

/** <time> with a relative label and the exact date on hover. */
function timeEl(iso) {
  const relative = formatRelative(iso);
  if (!relative) return '';
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(formatDate(iso))}">`
    + `${escapeHtml(relative)}</time>`;
}

/** A plain http(s) URL? Mirrors the rule ui.js uses before it renders a link. */
function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value ?? '').trim());
}

/**
 * 404 NOT_FOUND is the server's "no route for this request" answer
 * (server/middleware/errors.js). A specific missing record uses its own code
 * (SESSION_NOT_FOUND, SOURCE_NOT_FOUND…), so this tells the two apart.
 */
function endpointMissing(error) {
  return Boolean(error) && error.status === 404 && error.code === 'NOT_FOUND';
}

/** A session that is gone, or not this user's. Never surfaced as an error. */
function sessionUnavailable(error) {
  return Boolean(error) && (error.status === 403 || error.status === 404
    || error.kind === 'NOT_FOUND' || error.code === 'SESSION_NOT_FOUND');
}

/** Show a page-level problem. `title` is a short, plain-English reason. */
function notifyProblem(message, title = 'That did not work') {
  noticeEl.hidden = false;
  noticeEl.innerHTML = `<div class="alert alert-danger" role="alert">
    ${icon('alert', { size: 16 })}
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>
  </div>`;
  noticeEl.scrollIntoView?.({ block: 'nearest' });
}

function clearNotice() {
  noticeEl.hidden = true;
  noticeEl.innerHTML = '';
}

/** Disable a button while it works, and show that it is working. */
function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.restore = button.innerHTML;
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    button.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span>`
      + `<span>${escapeHtml(label ?? 'Working…')}</span>`;
  } else {
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-disabled');
    if (button.dataset.restore) {
      button.innerHTML = button.dataset.restore;
      delete button.dataset.restore;
    }
  }
}

/* ----------------------------------------------------------------- header */

/** Paint the shared header. `title` goes in as text, never as markup. */
function paintHead({ eyebrow = '', title, sub = '', badges = '' } = {}) {
  eyebrowEl.hidden = !eyebrow;
  eyebrowEl.innerHTML = eyebrow; // built by this file from escaped values
  titleEl.textContent = title;
  subEl.textContent = sub;
  subEl.hidden = !sub;
  badgesEl.hidden = !badges;
  badgesEl.innerHTML = badges;
}

function paintActions(html) {
  actionsEl.hidden = !html;
  actionsEl.innerHTML = html;
}

function shareTogglerHtml() {
  return `<button type="button" class="btn btn-secondary" data-action="share-toggle"
    aria-expanded="${shareEl.hidden ? 'false' : 'true'}" aria-controls="ses-share">
    ${icon('upload', { size: 15 })}<span>Share a link</span></button>`;
}

/* -------------------------------------------------------------- list view */

function renderListHead() {
  document.title = 'Study sessions — Socius AI';
  paintHead({
    title: 'Study sessions',
    sub: 'Group your material into sessions, then study, quiz or revise from one place.',
  });
  paintActions(`
    <button type="button" class="btn btn-primary" data-action="new-session">
      ${icon('plus', { size: 15 })}<span>New session</span>
    </button>
    ${shareTogglerHtml()}`);
}

function sessionRow(session) {
  const archived = session.status === 'archived';
  const tags = Array.isArray(session.tags) ? session.tags : [];
  const activity = session.lastActivityAt || session.updatedAt;
  const href = `session.html?id=${encodeURIComponent(session.id)}`;

  return `<div class="row-item ses-row">
    <span class="row-icon" aria-hidden="true">${icon('clock', { size: 15 })}</span>
    <div class="row-main">
      <a class="row-title ses-row-link" href="${href}">${escapeHtml(session.title)}</a>
      <span class="row-meta cluster-2">
        <span class="badge${archived ? '' : ' badge-info'}">${escapeHtml(archived ? 'Archived' : categoryLabel(session.category))}</span>
        <span>${plural(session.sourceCount ?? 0, 'source')} · ${plural(session.deckCount ?? 0, 'deck')}</span>
        ${activity ? `<span>· last activity ${timeEl(activity)}</span>` : ''}
      </span>
      ${tags.length
        ? `<span class="cluster-2 ses-row-tags">${tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</span>`
        : ''}
    </div>
    <div class="cluster-2 ses-row-actions">
      <a class="btn btn-sm btn-secondary" href="${href}">Open</a>
      <button type="button" class="btn btn-sm btn-ghost" data-action="${archived ? 'restore' : 'archive'}"
              data-id="${escapeHtml(session.id)}">
        ${icon(archived ? 'refresh' : 'folder', { size: 14 })}
        <span>${archived ? 'Restore' : 'Archive'}</span>
      </button>
    </div>
  </div>`;
}

function renderList() {
  renderListHead();
  const filtered = Boolean(state.list.q || state.list.category);

  if (state.sessions.length === 0) {
    listBody.innerHTML = emptyState(filtered
      ? {
        icon: 'search',
        title: 'No sessions match those filters',
        body: 'Try a different search word or category, or clear the filters to see everything.',
        action: '<button type="button" class="btn btn-secondary btn-sm" data-action="clear-filters">Clear filters</button>',
      }
      : {
        icon: 'clock',
        title: 'No study sessions yet',
        body: 'A session groups related material, so the tutor, quizzes and flashcards stay focused on one subject. Create your first one to get started.',
        action: '<button type="button" class="btn btn-primary" data-action="new-session">'
          + `${icon('plus', { size: 15 })}<span>New session</span></button>`,
      });
  } else {
    listBody.innerHTML = `<div class="row-list">${state.sessions.map(sessionRow).join('')}</div>`;
  }

  if (state.unsortedSourceCount > 0) {
    unsortedEl.hidden = false;
    unsortedEl.innerHTML = `${plural(state.unsortedSourceCount, 'item')} in your library `
      + 'do not belong to a session yet. Organise them in '
      + '<a href="library.html">My Materials</a>.';
  } else {
    unsortedEl.hidden = true;
  }
}

async function loadList() {
  listBody.innerHTML = '<span class="cluster-2 ses-loading" role="status">'
    + '<span class="spinner" aria-hidden="true"></span>'
    + '<span class="text-sm muted">Loading your sessions…</span></span>';

  const params = new URLSearchParams();
  if (state.list.q) params.set('q', state.list.q);
  if (state.list.category) params.set('category', state.list.category);
  if (state.list.sort && state.list.sort !== 'recent') params.set('sort', state.list.sort);
  if (state.list.includeArchived) params.set('includeArchived', '1');
  const query = params.toString();

  try {
    const data = await apiGet(`/api/sessions${query ? `?${query}` : ''}`);
    state.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    state.unsortedSourceCount = Number(data?.unsortedSourceCount) || 0;
    renderList();
  } catch (error) {
    unsortedEl.hidden = true;
    listBody.replaceChildren(errorState(error, loadList, { title: 'Could not load your sessions' }));
  }
}

/* ------------------------------------------------------------ detail view */

function renderNotFound() {
  document.title = 'Session not found — Socius AI';
  paintHead({
    eyebrow: '<nav aria-label="Breadcrumb"><ul class="breadcrumb">'
      + '<li><a href="session.html">Study sessions</a></li>'
      + '<li><span aria-current="page">Not found</span></li></ul></nav>',
    title: 'Session not found',
    sub: 'It may have been removed, or it may not be yours to open. Nothing was changed.',
  });
  paintActions('');
  scopeHost.innerHTML = emptyState({
    icon: 'folder',
    title: 'This session is not available',
    body: 'Your material is safe — check your sessions list and open it from there.',
    action: '<a class="btn btn-primary btn-sm" href="session.html">Back to your sessions</a>',
  });
  toolsHost.innerHTML = '';
  decksHost.innerHTML = '';
  activityHost.innerHTML = '';
  importEl.hidden = true;
}

function renderTools() {
  const count = state.sources.length;
  const session = encodeURIComponent(state.session.id);

  return count === 0
    ? `<div class="ses-band">
      <div class="stack-1">
        <p class="ses-band-title">This session has no material yet</p>
        <p class="text-sm ses-band-note">The tutor, quizzes and flashcards only search a
           session's own material, so they unlock as soon as you add some.</p>
      </div>
      <div class="cluster-2">
        <button type="button" class="btn btn-primary" data-action="import-toggle"
                aria-expanded="${importEl.hidden ? 'false' : 'true'}" aria-controls="ses-import">
          ${icon('upload', { size: 15 })}<span>Add material</span>
        </button>
      </div>
    </div>`
    : `<div class="ses-band">
      <div class="stack-1">
        <p class="ses-band-title">Study with this session’s material only</p>
        <p class="text-sm ses-band-note">These open the tutor, a quiz and flashcards scoped to
           the ${plural(count, 'source')} below. The server enforces the scope.</p>
      </div>
      <div class="cluster-2">
        <a class="btn btn-primary" href="study.html?session=${session}">
          ${icon('book', { size: 15 })}<span>Study</span></a>
        <a class="btn btn-secondary" href="quiz.html?session=${session}">
          ${icon('clipboard', { size: 15 })}<span>Quiz me</span></a>
        <a class="btn btn-secondary" href="flashcards.html?session=${session}">
          ${icon('cards', { size: 15 })}<span>Flashcards</span></a>
        <button type="button" class="btn btn-ghost" data-action="import-toggle"
                aria-expanded="${importEl.hidden ? 'false' : 'true'}" aria-controls="ses-import">
          ${icon('upload', { size: 15 })}<span>Add material</span>
        </button>
      </div>
    </div>`;
}

function sourceRow(source) {
  const size = sizeLabel(source);
  const passages = source.chunkCount ? plural(source.chunkCount, 'passage') : '';
  const meta = [size, passages].filter(Boolean).join(' · ');
  return `<div class="row-item">
    <span class="row-icon" aria-hidden="true">${icon(sourceInfo(source.type).icon, { size: 15 })}</span>
    <div class="row-main">
      <span class="row-title">${escapeHtml(source.title)}</span>
      <span class="row-meta">
        ${meta ? `${escapeHtml(meta)} · ` : ''}added ${timeEl(source.createdAt)}
      </span>
    </div>
    <span class="badge">${escapeHtml(sourceInfo(source.type).label)}</span>
  </div>`;
}

function renderScope() {
  const count = state.sources.length;
  const body = count
    ? `<div class="row-list">${state.sources.map(sourceRow).join('')}</div>`
    : emptyState({
      icon: 'inbox',
      title: 'No material in this session yet',
      body: 'Upload a PDF, Word document or PowerPoint, or paste a web page. Anything you add here is filed into this session, and the tutor, quizzes and flashcards can then search it.',
      action: '<button type="button" class="btn btn-primary btn-sm" data-action="import-toggle">Add material</button>',
    });

  scopeHost.innerHTML = `<section class="panel" aria-labelledby="ses-scope-title">
    <div class="panel-head">
      <h2 class="panel-title" id="ses-scope-title">Material in this session</h2>
      <span class="badge">${plural(count, 'source')}</span>
    </div>
    ${body}
  </section>`;
}

function deckRow(deck) {
  return `<a class="row-item" href="flashcards.html?deck=${encodeURIComponent(deck.id)}">
    <span class="row-icon" aria-hidden="true">${icon('cards', { size: 15 })}</span>
    <div class="row-main">
      <span class="row-title">${escapeHtml(deck.topic)}</span>
      <span class="row-meta">${plural(deck.cardCount ?? 0, 'card')} · created ${timeEl(deck.createdAt)}</span>
    </div>
    <span class="row-meta">Open</span>
  </a>`;
}

function renderDecks() {
  const count = state.decks.length;
  const body = count
    ? `<div class="row-list">${state.decks.map(deckRow).join('')}</div>`
    : emptyState({
      icon: 'cards',
      title: 'No flashcard decks yet',
      body: state.sources.length
        ? 'Generate a deck from this session’s material — it will be listed here.'
        : 'Add material first, then generate a deck from it.',
      action: state.sources.length
        ? `<a class="btn btn-primary btn-sm" href="flashcards.html?session=${encodeURIComponent(state.session.id)}">Make flashcards</a>`
        : '',
    });

  decksHost.innerHTML = `<section class="panel" aria-labelledby="ses-decks-title">
    <div class="panel-head">
      <h2 class="panel-title" id="ses-decks-title">Flashcard decks</h2>
      <span class="badge">${plural(count, 'deck')}</span>
    </div>
    ${body}
  </section>`;
}

/**
 * "Activity so far" — a timeline built ONLY from this session's own records
 * (the session, each source, each deck). There is no session-scoped activity
 * endpoint yet, so nothing here is invented: every entry is a real timestamp.
 */
function activityEntries() {
  const entries = [];
  if (state.session?.createdAt) {
    entries.push({ at: state.session.createdAt, icon: 'plus', text: 'Session created' });
  }
  for (const source of state.sources) {
    const size = sizeLabel(source);
    entries.push({
      at: source.createdAt,
      icon: sourceInfo(source.type).icon,
      text: `Added ${source.title}${size ? ` (${size})` : ''}`,
    });
  }
  for (const deck of state.decks) {
    entries.push({
      at: deck.createdAt,
      icon: 'cards',
      text: `Deck “${deck.topic}” created (${plural(deck.cardCount ?? 0, 'card')})`,
    });
  }
  return entries.filter((entry) => entry.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function renderActivity() {
  const entries = activityEntries();
  const body = entries.length
    ? `<ol class="ses-timeline">${entries.map((entry) => `<li class="ses-timeline-item">
        <span class="row-icon" aria-hidden="true">${icon(entry.icon, { size: 14 })}</span>
        <span class="ses-timeline-main">
          <span class="ses-timeline-text">${escapeHtml(entry.text)}</span>
          <span class="row-meta">${timeEl(entry.at)}</span>
        </span>
      </li>`).join('')}</ol>`
    : '<p class="muted text-sm">Nothing recorded yet.</p>';

  activityHost.innerHTML = `<section class="panel" aria-labelledby="ses-activity-title">
    <div class="panel-head">
      <h2 class="panel-title" id="ses-activity-title">Activity so far</h2>
    </div>
    <div class="panel-body">
      ${body}
      <p class="help">Every entry comes from this session’s own records.</p>
    </div>
  </section>`;
}

function renderDetail() {
  const session = state.session;
  const archived = session.status === 'archived';
  const tags = Array.isArray(session.tags) ? session.tags : [];

  document.title = `${session.title} — Socius AI`;
  paintHead({
    eyebrow: '<nav aria-label="Breadcrumb"><ul class="breadcrumb">'
      + '<li><a href="session.html">Study sessions</a></li>'
      + `<li><span aria-current="page">${escapeHtml(session.title)}</span></li></ul></nav>`,
    title: session.title,
    sub: session.description || '',
    badges: [
      `<span class="badge badge-info">${escapeHtml(categoryLabel(session.category))}</span>`,
      archived ? '<span class="badge">Archived</span>' : '',
      `<span class="row-meta">${plural(state.sources.length, 'source')} · ${plural(state.decks.length, 'deck')}</span>`,
      `<span class="row-meta">updated ${timeEl(session.updatedAt)}</span>`,
      ...tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`),
    ].filter(Boolean).join(''),
  });

  const id = escapeHtml(session.id);
  paintActions(`
    <button type="button" class="btn btn-secondary" data-action="edit">
      ${icon('pencil', { size: 15 })}<span>Edit session</span>
    </button>
    ${shareTogglerHtml()}
    <button type="button" class="btn btn-ghost" data-action="${archived ? 'restore' : 'archive'}" data-id="${id}">
      ${icon(archived ? 'refresh' : 'folder', { size: 15 })}
      <span>${archived ? 'Restore' : 'Archive'}</span>
    </button>
    <button type="button" class="btn btn-danger" data-action="delete" data-id="${id}">
      ${icon('trash', { size: 15 })}<span>Delete</span>
    </button>`);

  toolsHost.innerHTML = renderTools();
  renderScope();
  renderDecks();
  renderActivity();
}

async function loadDetail() {
  clearNotice();
  toolsHost.innerHTML = '';
  decksHost.innerHTML = '';
  activityHost.innerHTML = '';
  scopeHost.innerHTML = '<section class="panel"><div class="panel-body">'
    + spinner('Loading this session…') + '</div></section>';

  try {
    const data = await apiGet(`/api/sessions/${encodeURIComponent(state.sessionId)}`);
    state.session = data?.session ?? null;
    state.sources = Array.isArray(data?.sources) ? data.sources : [];
    state.decks = Array.isArray(data?.decks) ? data.decks : [];
    if (!state.session) {
      renderNotFound();
      return;
    }
    renderDetail();
  } catch (error) {
    if (sessionUnavailable(error)) {
      renderNotFound();
      return;
    }
    scopeHost.replaceChildren(errorState(error, loadDetail, { title: 'Could not load this session' }));
  }
}

/* ------------------------------------------------------------------ views */

function showListView() {
  state.view = 'list';
  listEl.hidden = false;
  detailEl.hidden = true;
  renderListHead();
}

function showDetailView() {
  state.view = 'detail';
  listEl.hidden = true;
  detailEl.hidden = false;
}

function goToList() {
  if (window.location.search) {
    window.location.href = 'session.html';
    return;
  }
  showListView();
  loadList();
}

/* ---------------------------------------------------------------- panels */

/** Toggle the shared import panel, mounting it on first open. */
function toggleImport(force) {
  const open = typeof force === 'boolean' ? force : importEl.hidden;
  importEl.hidden = !open;
  // The "Add material" buttons live in the tools band AND in the empty state,
  // so every one of them has to report the panel's real state.
  root.querySelectorAll('[data-action="import-toggle"]').forEach((button) => {
    button.setAttribute('aria-expanded', String(open));
  });
  if (open) {
    if (!state.importMounted) {
      // mountImportPanel owns the upload + paste behaviour and files everything
      // into THIS session through PATCH /api/sources/:id (A23's component).
      mountImportPanel({
        host: importBody,
        sessionId: state.sessionId,
        knownSources: () => state.sources,
        onOrganised: () => loadDetail(),
      });
      state.importMounted = true;
    }
    importEl.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    importBody.querySelector('#imp-file')?.focus();
  }
}

/** Toggle the share panel. */
function toggleShare(force) {
  const open = typeof force === 'boolean' ? force : shareEl.hidden;
  shareEl.hidden = !open;
  root.querySelectorAll('[data-action="share-toggle"]').forEach((button) => {
    button.setAttribute('aria-expanded', String(open));
  });
  if (open) {
    shareEl.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    shareUrlInput.focus();
  }
}

/* ----------------------------------------------------------------- actions */

async function createSession() {
  const saved = await openSessionDialog(null);
  if (!saved) return;
  toast(`Session “${saved.title}” created.`, { variant: 'success' });
  await loadList();
}

async function editSession() {
  if (!state.session) return;
  const saved = await openSessionDialog(state.session);
  if (!saved) return;
  toast('Session updated.', { variant: 'success' });
  await loadDetail();
}

async function setStatus(button, id, status) {
  const archiving = status === 'archived';
  setBusy(button, true, archiving ? 'Archiving…' : 'Restoring…');
  try {
    await apiPatch(`/api/sessions/${encodeURIComponent(id)}`, { status });
    clearNotice();
    toast(archiving
      ? 'Session archived — it stays available under “Show archived”.'
      : 'Session restored.', { variant: 'success' });
    if (state.view === 'detail' && state.sessionId === id) await loadDetail();
    else await loadList();
  } catch (error) {
    setBusy(button, false);
    notifyProblem(errorMessage(error), archiving
      ? 'Could not archive this session'
      : 'Could not restore this session');
  }
}

async function removeSession(button, id) {
  const title = state.session && state.session.id === id ? state.session.title : 'this session';
  const confirmed = window.confirm(
    `Delete “${title}”?\n\nThe session grouping is removed. Your files stay in My Materials. This cannot be undone.`,
  );
  if (!confirmed) return;

  setBusy(button, true, 'Deleting…');
  try {
    await apiDelete(`/api/sessions/${encodeURIComponent(id)}`);
    toast('Session deleted.', { variant: 'success' });
    goToList();
  } catch (error) {
    setBusy(button, false);
    if (endpointMissing(error)) {
      notifyProblem(
        'The server does not have a delete endpoint for study sessions yet, so nothing was removed. '
        + 'You can archive it instead — archiving hides it without touching your material.',
        'Deleting sessions is not available yet',
      );
    } else {
      notifyProblem(errorMessage(error), 'Could not delete this session');
    }
  }
}

async function handleAction(event, element) {
  const action = element.dataset.action;
  const id = element.dataset.id || '';

  if (action === 'new-session') return createSession();
  if (action === 'share-toggle') return toggleShare();
  if (action === 'import-toggle') return toggleImport();
  if (action === 'edit') return editSession();
  if (action === 'archive') return setStatus(element, id || state.sessionId, 'archived');
  if (action === 'restore') return setStatus(element, id || state.sessionId, 'active');
  if (action === 'delete') return removeSession(element, id || state.sessionId);
  if (action === 'clear-filters') {
    state.list.q = '';
    state.list.category = '';
    state.list.sort = 'recent';
    state.list.includeArchived = false;
    setToolbarControls();
    return loadList();
  }
  return undefined;
}

/* ---------------------------------------------------------------- toolbar */

function setToolbarControls() {
  searchInput.value = state.list.q;
  categorySelect.value = state.list.category;
  sortSelect.value = state.list.sort;
  archivedCheckbox.checked = state.list.includeArchived;
}

function wireToolbar() {
  // The category options come from the shared component, so the enum has ONE
  // definition (components/session-form.js) instead of one here and one there.
  categorySelect.innerHTML = '<option value="">All categories</option>'
    + CATEGORIES.map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');

  const runSearch = debounce(() => {
    state.list.q = searchInput.value.trim();
    loadList();
  }, 300);

  searchInput.addEventListener('input', runSearch);
  categorySelect.addEventListener('change', () => {
    state.list.category = categorySelect.value;
    loadList();
  });
  sortSelect.addEventListener('change', () => {
    state.list.sort = sortSelect.value || 'recent';
    loadList();
  });
  archivedCheckbox.addEventListener('change', () => {
    state.list.includeArchived = archivedCheckbox.checked;
    loadList();
  });
}

/* ------------------------------------------------------------------ share */

function showShareError(message) {
  shareError.textContent = message;
  shareError.hidden = false;
}

function clearShareError() {
  shareError.hidden = true;
  shareError.textContent = '';
}

/** The honest state: the endpoint is not built, so nothing happened. */
function renderShareUnavailable() {
  shareStatus.innerHTML = `<div class="panel-body">
    <div class="alert alert-warn" role="status">
      ${icon('info', { size: 16 })}
      <div>
        <strong>Sharing into Socius is not available yet.</strong>
        <p>The server has no <span class="mono">POST /api/share</span> yet, so nothing was
           created and nothing was changed. You can add a file or paste a web page in
           My Materials instead.</p>
        <p><a class="btn btn-secondary btn-sm" href="library.html">Go to My Materials</a></p>
      </div>
    </div>
  </div>`;
}

/** Success is rendered from the contract's own response shape. */
function renderShareSuccess(data) {
  const source = data && data.source ? data.source : null;
  const title = (source && source.title) || (data?.share && data.share.title) || 'the link';
  // The stored URL is external input; citationEl() only turns an http(s) value
  // into an <a>, so a stray scheme can never become a link.
  const citation = source
    ? citationEl({
      sourceId: source.id,
      type: source.type,
      title,
      url: source.url,
      location: null,
      excerpt: null,
    })
    : '';

  shareStatus.innerHTML = `<div class="panel-body stack-3">
    <div class="alert alert-success" role="status">
      ${icon('checkCircle', { size: 16 })}
      <div>
        <strong>Imported “${escapeHtml(title)}”.</strong>
        <p>It is in My Materials and can be organised into a session from there.</p>
      </div>
    </div>
    ${citation ? `<div class="citations">${citation}</div>` : ''}
  </div>`;
}

function renderShareFailure(error) {
  shareStatus.innerHTML = `<div class="panel-body">
    <div class="alert alert-danger" role="alert">
      ${icon('alert', { size: 16 })}
      <div>
        <strong>That link could not be imported.</strong>
        <p>${escapeHtml(errorMessage(error))}</p>
      </div>
    </div>
  </div>`;
}

async function submitShare(event) {
  event.preventDefault();
  clearShareError();
  clearNotice();

  const url = shareUrlInput.value.trim();
  const title = shareTitleInput.value.trim();
  const text = shareTextInput.value.trim();

  if (!isHttpUrl(url)) {
    showShareError('Enter a full web link starting with http:// or https://.');
    shareUrlInput.focus();
    return;
  }
  if (title.length > SHARE_TITLE_MAX) {
    showShareError(`Keep the title to ${SHARE_TITLE_MAX} characters or fewer.`);
    shareTitleInput.focus();
    return;
  }
  if (text && (text.length < SHARE_TEXT_MIN || text.length > SHARE_TEXT_MAX)) {
    showShareError(`Pasted page text must be between ${SHARE_TEXT_MIN} and 200,000 characters.`);
    shareTextInput.focus();
    return;
  }

  const body = { url };
  if (title) body.title = title;
  if (text) body.text = text;

  setBusy(shareSubmit, true, 'Importing…');
  try {
    const data = await apiPost('/api/share', body);
    renderShareSuccess(data);
    toast('Link imported into My Materials.', { variant: 'success' });
    shareForm.reset();
    if (state.view === 'list') await loadList();
  } catch (error) {
    if (endpointMissing(error)) renderShareUnavailable();
    else renderShareFailure(error);
  } finally {
    setBusy(shareSubmit, false);
  }
}

/**
 * A share target can hand the app a link, e.g. session.html?share=<url>&title=…
 * The values only ever prefill a text field; they are validated on submit like
 * anything the student types.
 */
function applySharedLinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const shared = (params.get('share') || params.get('url') || '').trim();
  if (!shared) return;
  shareUrlInput.value = shared;
  const text = (params.get('text') || '').trim();
  if (text) shareTextInput.value = text;
  const title = (params.get('title') || '').trim().slice(0, SHARE_TITLE_MAX);
  if (title) shareTitleInput.value = title;
  toggleShare(true);
}

/* -------------------------------------------------------------------- boot */

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  state.sessionId = (params.get('id') || '').trim();
  state.list.q = (params.get('q') || '').trim();
  state.list.category = (params.get('category') || '').trim();
  const sort = (params.get('sort') || '').trim();
  state.list.sort = ['recent', 'alpha', 'active'].includes(sort) ? sort : 'recent';
  state.list.includeArchived = ['1', 'true'].includes((params.get('includeArchived') || '').toLowerCase());
}

async function init() {
  readUrl();
  wireToolbar();
  setToolbarControls();

  document.querySelector('[data-search-icon]').innerHTML = icon('search', { size: 15 });
  document.querySelector('[data-import-close-icon]').innerHTML = icon('close', { size: 14 });

  on(root, 'click', '[data-action]', handleAction);
  shareForm.addEventListener('submit', submitShare);

  if (state.sessionId) {
    showDetailView();
    await loadDetail();
  } else {
    showListView();
    await loadList();
  }
  applySharedLinkFromUrl();

  if (isMockMode()) {
    console.info('[session] ?mock=1 — this page is rendering fixture data, not live output.');
  }
}

const shellHost = document.getElementById('app-shell');
if (shellHost && shellHost.classList.contains('app-shell')) await init();
