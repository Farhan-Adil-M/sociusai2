// Study Library: the list of persistent study sessions, with search, category
// filter, sorting, an Unsorted section for unfiled material, and the session
// create / edit / archive actions. Filtering and sorting are done by the
// backend (GET /api/sessions?q=&category=&sort=), so this file only renders
// what the API returns.

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

const sessionsHost = document.querySelector('[data-sessions]');
const sessionsMeta = document.querySelector('[data-sessions-meta]');
// The redesign's materials view lists uploads in #uploadedFilesList (demo4.1
// lines 671–677); the classic markup uses [data-unsorted]. Same rows, same
// data flow (GET /api/sources?sessionId=unsorted).
const unsortedHost = document.querySelector('[data-unsorted]')
  || document.getElementById('uploadedFilesList');
const unsortedMeta = document.querySelector('[data-unsorted-meta]');
const filesCount = document.getElementById('modalFilesCount'); // demo "Uploaded documents (N)"

const searchInput = document.querySelector('#lib-search');
const categorySelect = document.querySelector('#lib-category');
const sortSelect = document.querySelector('#lib-sort');
const archivedCheckbox = document.querySelector('#lib-include-archived');

const searchIcon = document.querySelector('[data-search-icon]');
if (searchIcon) searchIcon.innerHTML = icon('search', { size: 16 });

const state = {
  q: '',
  category: '',
  sort: 'recent',
  includeArchived: false,
  sessions: [],
  pendingArchive: null, // session id waiting for an inline confirmation
  unsortedSources: [],  // last loaded Unsorted list (feeds the import duplicate hint)
};

/* ---------------------------------------------------------------- load --- */

async function loadSessions() {
  try {
    const data = await api.listSessions({
      q: state.q,
      category: state.category,
      sort: state.sort,
      includeArchived: state.includeArchived ? 1 : '',
    });
    state.sessions = data.sessions || [];
    state.unsortedSourceCount = data.unsortedSourceCount || 0;
    renderSessions();
  } catch (error) {
    if (sessionsHost) showError(sessionsHost, error, { title: 'Could not load your sessions', onRetry: loadSessions });
  }
}

async function loadUnsorted() {
  try {
    const data = await api.listSources({ sessionId: 'unsorted' });
    renderUnsorted(data.sources || []);
  } catch (error) {
    if (unsortedHost) showError(unsortedHost, error, { title: 'Could not load unsorted material', onRetry: loadUnsorted });
  }
}

function loadAll() {
  loadSessions();
  loadUnsorted();
}

/* ------------------------------------------------------------ render --- */

function tagList(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '';
  return tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
}

function sessionRow(session) {
  const archived = session.status === 'archived';
  const activity = session.lastActivityAt ? `active ${formatRelative(session.lastActivityAt)}` : 'no activity yet';
  const actions = state.pendingArchive === session.id
    ? `<span class="lib-confirm">Archive «${escapeHtml(session.title)}»?
         <button type="button" class="btn btn-secondary btn-sm" data-archive-yes="${escapeHtml(session.id)}">Archive</button>
         <button type="button" class="btn btn-quiet btn-sm" data-archive-no>Cancel</button>
       </span>`
    : `<a class="btn btn-primary btn-sm" href="session.html?id=${encodeURIComponent(session.id)}">Open</a>
       <button type="button" class="btn btn-quiet btn-sm" data-edit="${escapeHtml(session.id)}">${icon('pencil', { size: 13 })} Edit</button>
       ${archived
         ? `<button type="button" class="btn btn-quiet btn-sm" data-restore="${escapeHtml(session.id)}">Restore</button>`
         : `<button type="button" class="btn btn-quiet btn-sm" data-archive="${escapeHtml(session.id)}">${icon('archive', { size: 13 })} Archive</button>`}`;

  return `
    <div class="lib-row">
      <div class="lib-row-main">
        <a class="lib-row-title" href="session.html?id=${encodeURIComponent(session.id)}">${escapeHtml(session.title)}${archived ? ' <span class="badge">Archived</span>' : ''}</a>
        <p class="lib-row-desc">${escapeHtml(session.description || '')}</p>
        <div class="lib-row-tags">
          <span class="badge badge-blue">${escapeHtml(categoryLabel(session.category))}</span>
          ${tagList(session.tags)}
        </div>
      </div>
      <div class="lib-row-stats">
        <span><strong>${session.sourceCount}</strong> ${session.sourceCount === 1 ? 'source' : 'sources'}</span>
        <span><strong>${session.deckCount}</strong> ${session.deckCount === 1 ? 'deck' : 'decks'}</span>
        <span>${escapeHtml(activity)}</span>
      </div>
      <div class="lib-row-actions">${actions}</div>
    </div>`;
}

function renderSessions() {
  if (!sessionsHost) return;
  if (state.sessions.length === 0) {
    const filtering = state.q || state.category;
    showEmpty(sessionsHost, {
      iconName: 'folder',
      title: filtering ? 'No sessions match' : 'No sessions yet',
      text: filtering
        ? 'Try a different search term or clear the category filter.'
        : 'A session groups your material and study tools by subject — create your first one.',
      actions: filtering
        ? '<button type="button" class="btn btn-secondary btn-sm" data-clear-filters>Clear filters</button>'
        : '<button type="button" class="btn btn-primary btn-sm" data-new-session-empty>New session</button>',
    });
    if (sessionsMeta) sessionsMeta.textContent = '';
    return;
  }
  if (sessionsMeta) sessionsMeta.textContent = `${state.sessions.length} ${state.sessions.length === 1 ? 'session' : 'sessions'}`;
  sessionsHost.innerHTML = `<div class="lib-rows">${state.sessions.map(sessionRow).join('')}</div>`;
}

function unsortedRow(source) {
  const options = state.sessions
    .filter((session) => session.status === 'active')
    .map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`)
    .join('');
  return `
    <div class="lib-row lib-row--unsorted" data-source-row="${escapeHtml(source.id)}">
      <div class="lib-row-main">
        <span class="lib-row-title">${sourceIcon(source.type, { size: 15 })} ${escapeHtml(source.title)}</span>
        <p class="lib-row-desc">${escapeHtml(source.sizeLabel || '')}${source.chunkCount ? ` · ${source.chunkCount} passages` : ''}</p>
      </div>
      <div class="lib-row-actions">
        <label class="sr-only" for="move-${escapeHtml(source.id)}">Move ${escapeHtml(source.title)} to a session</label>
        <select class="select lib-move-select" id="move-${escapeHtml(source.id)}" data-move-select>
          <option value="">Move to session…</option>
          ${options}
        </select>
      </div>
    </div>`;
}

function renderUnsorted(sources) {
  state.unsortedSources = sources; // remembered for the import panel's duplicate hint
  const count = sources.length;
  if (unsortedMeta) unsortedMeta.textContent = count ? `${count} ${count === 1 ? 'file' : 'files'} not in a session` : '';
  if (filesCount) filesCount.textContent = String(count); // demo panel counter
  if (!unsortedHost) return;
  if (count === 0) {
    showEmpty(unsortedHost, {
      iconName: 'checkCircle',
      title: 'Everything is filed',
      text: 'Material without a session shows up here so nothing gets lost.',
    });
    return;
  }
  unsortedHost.innerHTML = `<div class="lib-rows">${sources.map(unsortedRow).join('')}</div>`;
}

/* ----------------------------------------------------------- actions --- */

function sessionById(id) {
  return state.sessions.find((session) => session.id === id) || null;
}

async function newSession() {
  const session = await openSessionDialog(null);
  if (session) {
    // Jump to its page: a brand-new session is empty, so its detail view is
    // the natural next step (add material, then study).
    window.location.href = `session.html?id=${encodeURIComponent(session.id)}`;
  }
}

document.querySelector('[data-new-session]')?.addEventListener('click', newSession);

sessionsHost?.addEventListener('click', async (event) => {
  const target = event.target;

  if (target.closest('[data-new-session-empty]')) { newSession(); return; }
  if (target.closest('[data-clear-filters]')) {
    state.q = ''; state.category = '';
    if (searchInput) searchInput.value = '';
    if (categorySelect) categorySelect.value = '';
    loadSessions();
    return;
  }

  const edit = target.closest('[data-edit]');
  if (edit) {
    const session = sessionById(edit.dataset.edit);
    if (session && await openSessionDialog(session)) loadAll();
    return;
  }

  const archive = target.closest('[data-archive]');
  if (archive) { state.pendingArchive = archive.dataset.archive; renderSessions(); return; }

  if (target.closest('[data-archive-no]')) { state.pendingArchive = null; renderSessions(); return; }

  const yes = target.closest('[data-archive-yes]');
  if (yes) {
    yes.disabled = true;
    try {
      await api.updateSession(yes.dataset.archiveYes, { status: 'archived' });
      state.pendingArchive = null;
      await loadSessions();
      await loadUnsorted();
    } catch (error) {
      state.pendingArchive = null;
      renderSessions();
      showError(sessionsHost, error, { title: 'Could not archive that session', onRetry: loadSessions });
    }
    return;
  }

  const restore = target.closest('[data-restore]');
  if (restore) {
    try {
      await api.updateSession(restore.dataset.restore, { status: 'active' });
      await loadSessions();
    } catch (error) {
      showError(sessionsHost, error, { title: 'Could not restore that session', onRetry: loadSessions });
    }
  }
});

unsortedHost?.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-move-select]');
  if (!select || !select.value) return;
  const row = select.closest('[data-source-row]');
  const sourceId = row.dataset.sourceRow;
  select.disabled = true;
  try {
    await api.updateSource(sourceId, { sessionId: select.value });
    await loadAll();
  } catch (error) {
    select.disabled = false;
    showError(unsortedHost, error, { title: 'Could not move that file', onRetry: loadUnsorted });
  }
});

/* ------------------------------------------------------------ toolbar --- */

let searchTimer = null;
searchInput?.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = searchInput.value.trim(); loadSessions(); }, 300);
});
categorySelect?.addEventListener('change', () => { state.category = categorySelect.value; loadSessions(); });
sortSelect?.addEventListener('change', () => { state.sort = sortSelect.value; loadSessions(); });
archivedCheckbox?.addEventListener('change', () => { state.includeArchived = archivedCheckbox.checked; loadSessions(); });

// Deep link from the dashboard search box (Enter → library.html?q=…).
const deepLinkQ = new URLSearchParams(window.location.search).get('q');
if (deepLinkQ && searchInput) {
  searchInput.value = deepLinkQ;
  state.q = deepLinkQ.trim();
}

/* ------------------------------------------------------------ import --- */

const importToggle = document.querySelector('[data-import-toggle]');
// The redesign's materials view hosts the upload UI in #uploadInterface (a
// child of #filesExpandPanel, next to the #uploadedFilesPanel list); the
// classic markup uses [data-import-panel]. Prefer the INNER panel so mounting
// never wipes the sibling uploaded-files list.
const importPanel = document.querySelector('[data-import-panel]')
  || document.getElementById('uploadInterface')
  || document.getElementById('filesExpandPanel');

function mountImport() {
  if (!importPanel || importPanel.dataset.mounted) return;
  mountImportPanel({
    host: importPanel,
    sessionId: null, // imports from the Library land in Unsorted, then get suggested
    knownSources: () => state.unsortedSources, // feeds the duplicate hint
    onOrganised: loadAll,
  });
  importPanel.dataset.mounted = '1';
}

/** Show the panel plus any hidden ancestor (e.g. the demo's wrapper panel). */
function revealImportPanel() {
  for (let node = importPanel; node; node = node.parentElement) {
    node.hidden = false;
  }
}

/** Visible right now? Checks ancestors too — the demo hides the WRAPPER. */
function importPanelVisible() {
  for (let node = importPanel; node; node = node.parentElement) {
    if (node.hidden) return false;
  }
  return true;
}

if (importToggle && importPanel) {
  importToggle.addEventListener('click', () => {
    const open = !importPanelVisible();
    if (open) {
      revealImportPanel();
      mountImport();
    } else {
      importPanel.hidden = true; // only the panel itself; ancestors stay as they were
    }
    importToggle.setAttribute('aria-expanded', String(open));
    importToggle.textContent = open ? 'Hide import' : 'Import material';
  });
} else if (importPanel) {
  // The redesigned materials view ships the upload interface with no separate
  // toggle: show and mount it right away so importing stays reachable.
  revealImportPanel();
  mountImport();
}

/* Redesign extras: the demo's "Uploaded documents" panel opens via
   #viewUploadedFilesBtn and closes via #closeUploadedFilesBtn. When those
   exist, opening it also refreshes the list. */
const filesPanel = document.getElementById('uploadedFilesPanel');
if (filesPanel) {
  document.getElementById('viewUploadedFilesBtn')?.addEventListener('click', () => {
    filesPanel.hidden = false;
    loadUnsorted();
  });
  document.getElementById('closeUploadedFilesBtn')?.addEventListener('click', () => {
    filesPanel.hidden = true;
  });
}

/* ---------------------------------------------------------------- init --- */

loadAll();
