// =============================================================================
// pages/library.js — My Materials.
//
// Responsibility: render the student's material library from GET /api/sources —
// type badge, size, added date, session — with per-source actions (view the
// stored text, re-organise it into a study session, remove it), plus search and
// filtering. It owns no upload UI of its own: it mounts the shared
// components/material-import.js panel, which is the ONE upload implementation.
//
// Data comes only from api.js (never fetch). All server/user text is escaped
// through ui.js#escapeHtml, and a title that looks like a server path is reduced
// to its final segment before display.
//
// Wave-4 endpoints this page uses defensively:
//   POST /api/viewer/:sourceId/document  (planned)  → in-app stored-text preview
//   DELETE /api/sources/:id              (not in the contract yet) → remove
// Both are guarded: when the route is absent the student sees a plain sentence,
// never a crash and never a raw "No route for …" message.
//
// Owner: A23.
// =============================================================================

import { mountShell } from '../components/shell.js';
import { apiDelete, apiGet, apiPatch, apiPost } from '../api.js';
import {
  debounce, emptyState, errorMessage, errorState, escapeHtml, formatDate,
  formatRelative, icon, on, plural, skeleton, toast,
} from '../ui.js';
import { mountImportPanel, offerSuggestion } from '../components/material-import.js';
import { openSessionDialog } from '../components/session-form.js';

/* ------------------------------------------------------------- type map ---- */

const TYPE_META = {
  pdf: { label: 'PDF', icon: 'file', badge: 'badge-info' },
  docx: { label: 'Word', icon: 'book', badge: 'badge-success' },
  pptx: { label: 'Slides', icon: 'slides', badge: 'badge-accent' },
  webpage: { label: 'Web page', icon: 'globe', badge: '' },
  youtube: { label: 'YouTube', icon: 'externalLink', badge: 'badge-info' },
  image: { label: 'Image', icon: 'file', badge: 'badge-warn' },
};

const TYPE_FILTERS = [
  { value: '', label: 'All types' },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'pptx', label: 'Slides (.pptx)' },
  { value: 'webpage', label: 'Web pages' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'image', label: 'Images' },
];

// The v8 canonical column is `source_kind`; accept every spelling so the badge
// stays right whichever field the API exposes.
function sourceType(source) {
  const raw = source?.sourceKind ?? source?.source_kind ?? source?.type ?? '';
  return String(raw).toLowerCase();
}

function typeMeta(type) {
  if (TYPE_META[type]) return TYPE_META[type];
  const label = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Source';
  return { label, icon: 'file', badge: '' };
}

/* --------------------------------------------------------------- helpers ---- */

// Never show a server path. Reduce an upload name like "/srv/data/x.pdf" or
// "C:\\tmp\\x.pdf" or "../../x.pdf" to its final segment; leave ordinary titles
// (which may contain a legitimate slash) alone.
function safeTitle(raw) {
  let name = String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const pathLike = /(^|\/)\.\.(\/|$)/.test(name)
    || /^[A-Za-z]:\//.test(name)
    || name.startsWith('/')
    || name.startsWith('~/');
  if (pathLike) name = name.split('/').filter(Boolean).pop() || '';
  return name || 'Untitled material';
}

function sessionName(id) {
  if (!id) return 'Unsorted';
  const found = state.sessions.find((session) => session.id === id);
  return found ? found.title : 'Unknown session';
}

function locationLabel(location) {
  if (!location || typeof location !== 'object') return '';
  if (location.page != null) return `p. ${location.page}`;
  if (location.slide != null) return `slide ${location.slide}`;
  if (location.paragraph != null) return `para. ${location.paragraph}`;
  if (location.timestamp != null) return `at ${location.timestamp}`;
  if (location.segment != null) return `segment ${location.segment}`;
  return '';
}

function typeBadge(type) {
  const meta = typeMeta(type);
  return `<span class="badge ${meta.badge}">${icon(meta.icon, { size: 12 })} ${escapeHtml(meta.label)}</span>`;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'Open original'; }
}

function detailRow(label, valueHtml) {
  return `<div class="lib-detail-row"><span class="lib-k">${escapeHtml(label)}</span>`
    + `<span class="lib-v">${valueHtml}</span></div>`;
}

function tagChips(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return '<span class="muted">—</span>';
  return `<span class="cluster-2">${list.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</span>`;
}

function sourceLink(source) {
  const url = typeof source.url === 'string' && /^https?:\/\//i.test(source.url) ? source.url : '';
  if (url) {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">`
      + `${escapeHtml(hostOf(url))} ${icon('externalLink', { size: 12 })}</a>`;
  }
  return '<span class="muted">Uploaded file — only its indexed text is stored, not the original.</span>';
}

/* ----------------------------------------------------------------- state ---- */

const state = {
  sources: [],
  sessions: [],
  loading: true,
  error: null,
  q: '',
  type: '',
  sessionFilter: '',
  expanded: new Set(), // source ids whose detail panel is open
  previews: new Map(), // source id → { status: 'loading' | 'ready' | 'error', doc?, message? }
  deleteFor: null, // source id awaiting delete confirmation
};

/* ------------------------------------------------------------- page refs ---- */

const region = document.querySelector('[data-sources]');
const countEl = document.querySelector('[data-count]');
const searchInput = document.querySelector('#lib-search');
const typeSelect = document.querySelector('#lib-type');
const sessionSelect = document.querySelector('#lib-session');
const refreshButton = document.querySelector('[data-refresh]');
const importToggle = document.querySelector('[data-import-toggle]');
const importPanel = document.querySelector('[data-import-panel]');

/* -------------------------------------------------------------- loading ----- */

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const [sourcesData, sessionsData] = await Promise.all([
      apiGet('/api/sources'),
      apiGet('/api/sessions?includeArchived=1').catch(() => ({ sessions: [] })),
    ]);
    state.sources = Array.isArray(sourcesData?.sources) ? sourcesData.sources : [];
    state.sessions = Array.isArray(sessionsData?.sessions) ? sessionsData.sessions : [];
    state.loading = false;
    populateFilters();
    render();
  } catch (error) {
    state.loading = false;
    state.error = error;
    render();
  }
}

function populateFilters() {
  if (typeSelect) {
    typeSelect.innerHTML = TYPE_FILTERS
      .map((item) => `<option value="${item.value}">${escapeHtml(item.label)}</option>`)
      .join('');
    typeSelect.value = TYPE_FILTERS.some((item) => item.value === state.type) ? state.type : '';
  }
  if (sessionSelect) {
    const options = ['<option value="">All sessions</option>', '<option value="unsorted">Unsorted only</option>'];
    for (const session of state.sessions) {
      const label = session.status === 'archived' ? `${session.title} (archived)` : session.title;
      options.push(`<option value="${escapeHtml(session.id)}">${escapeHtml(label)}</option>`);
    }
    sessionSelect.innerHTML = options.join('');
    const known = state.sessionFilter === ''
      || state.sessionFilter === 'unsorted'
      || state.sessions.some((session) => session.id === state.sessionFilter);
    sessionSelect.value = known ? state.sessionFilter : '';
  }
}

/* --------------------------------------------------------------- filters ---- */

function visibleSources() {
  const query = state.q.trim().toLowerCase();
  return state.sources.filter((source) => {
    const type = sourceType(source);
    if (state.type && type !== state.type) return false;
    if (state.sessionFilter === 'unsorted' && source.sessionId) return false;
    if (state.sessionFilter && state.sessionFilter !== 'unsorted' && source.sessionId !== state.sessionFilter) return false;
    if (query) {
      const haystack = `${source.title || ''} ${(source.tags || []).join(' ')} ${sessionName(source.sessionId)}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function countText(shown) {
  const total = state.sources.length;
  if (total === 0) return '';
  // Counted from the list we hold (which is always the full library) rather
  // than the API's `unsortedSourceCount`, which counts every source on the
  // unfiltered list. See docs/HANDOFF.md (A23 → A08).
  const unsorted = state.sources.filter((source) => !source.sessionId).length;
  const tail = unsorted ? ` · ${unsorted} unsorted` : '';
  if (shown < total) return `Showing ${shown} of ${total}${tail}`;
  return `${plural(total, 'material')}${tail}`;
}

/* --------------------------------------------------------------- render ----- */

function loadingMarkup() {
  return `<div class="card" aria-busy="true" role="status">`
    + `<span class="sr-only">Loading your materials…</span>${skeleton(5)}</div>`;
}

function emptyMarkup() {
  return emptyState({
    icon: 'folder',
    title: 'Add your first material',
    body: 'Upload a PDF, Word document or slide deck, or paste the text of a web page. Socius uses this material to tutor you, make quizzes and build flashcards.',
    action: '<button type="button" class="btn btn-primary" data-action="add-first">Add material</button>',
  });
}

function noMatchMarkup() {
  return emptyState({
    icon: 'search',
    title: 'No materials match',
    body: 'Try a different search term, or clear the type and session filters.',
    action: '<button type="button" class="btn btn-secondary" data-action="clear-filters">Clear filters</button>',
  });
}

function render() {
  if (!region) return;
  if (countEl) countEl.textContent = '';

  if (state.loading) { region.innerHTML = loadingMarkup(); return; }
  if (state.error) {
    region.replaceChildren(errorState(state.error, load, { title: 'Could not load your materials' }));
    return;
  }
  if (state.sources.length === 0) { region.innerHTML = emptyMarkup(); return; }

  const list = visibleSources();
  if (list.length === 0) { region.innerHTML = noMatchMarkup(); return; }

  if (countEl) countEl.textContent = countText(list.length);
  region.innerHTML = `<div class="panel"><div class="row-list">${list.map(sourceBlock).join('')}</div></div>`;
}

function sourceBlock(source) {
  const type = sourceType(source);
  const meta = typeMeta(type);
  const title = safeTitle(source.title);
  const id = escapeHtml(source.id);
  const open = state.expanded.has(source.id);

  const bits = [typeBadge(type)];
  if (source.sizeLabel) bits.push(`<span>${escapeHtml(source.sizeLabel)}</span>`);
  if (Number(source.chunkCount) > 0) bits.push(`<span>${plural(source.chunkCount, 'passage')}</span>`);
  const added = formatRelative(source.createdAt) || formatDate(source.createdAt);
  if (added) bits.push(`<span>Added ${escapeHtml(added)}</span>`);
  bits.push(
    `<span class="lib-where">${icon(source.sessionId ? 'folder' : 'inbox', { size: 12 })} `
    + `${escapeHtml(sessionName(source.sessionId))}</span>`,
  );

  return `
    <div class="lib-item${open ? ' is-open' : ''}" data-item="${id}">
      <div class="row-item lib-row">
        <span class="row-icon" aria-hidden="true">${icon(meta.icon, { size: 18 })}</span>
        <div class="row-main">
          <span class="row-title">${escapeHtml(title)}</span>
          <span class="row-meta lib-meta">${bits.join('')}</span>
        </div>
        <div class="lib-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="view" data-id="${id}"
                  aria-expanded="${open ? 'true' : 'false'}">${icon('eye', { size: 14 })} View</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="organise" data-id="${id}"
                  aria-expanded="${open ? 'true' : 'false'}">${icon('folder', { size: 14 })} Organise</button>
          <button type="button" class="btn btn-ghost btn-icon" data-action="delete" data-id="${id}"
                  aria-label="Delete ${escapeHtml(title)}">${icon('trash', { size: 16 })}</button>
        </div>
      </div>
      ${open ? detailMarkup(source) : ''}
    </div>`;
}

function detailMarkup(source) {
  const preview = state.previews.get(source.id);
  const confirming = state.deleteFor === source.id;

  return `
    <div class="lib-detail">
      <div class="stack-4">
        <div class="lib-detail-grid">
          ${detailRow('Type', typeBadge(sourceType(source)))}
          ${detailRow('Size', escapeHtml(source.sizeLabel || '—'))}
          ${detailRow('Passages', source.chunkCount != null ? escapeHtml(String(source.chunkCount)) : '—')}
          ${detailRow('Added', escapeHtml(formatDate(source.createdAt) || '—'))}
          ${detailRow('Session', escapeHtml(sessionName(source.sessionId)))}
          ${detailRow('Organised by', source.orgSource === 'ai' ? 'Socius (AI suggestion)' : 'You')}
          ${detailRow('Tags', tagChips(source.tags))}
          ${detailRow('Source', sourceLink(source))}
        </div>

        <div class="lib-section">
          <h3 class="lib-section-title">Stored text</h3>
          <div data-preview>${previewMarkup(source.id, preview)}</div>
        </div>

        <hr class="divider-flush">

        <div class="lib-section">
          <h3 class="lib-section-title">Organise</h3>
          ${organiseMarkup(source)}
        </div>

        <div data-delete-slot>${confirming ? deleteConfirmMarkup(source) : ''}</div>
      </div>
    </div>`;
}

function previewMarkup(id, preview) {
  const safeId = escapeHtml(id);
  if (!preview || preview.status === 'idle') {
    return `<button type="button" class="btn btn-secondary btn-sm" data-action="load-preview" data-id="${safeId}">${icon('file', { size: 14 })} Show stored text</button>`;
  }
  if (preview.status === 'loading') {
    return `<div class="cluster-2" role="status"><span class="spinner" aria-hidden="true"></span>`
      + `<span class="text-sm muted">Opening the stored text…</span></div>`;
  }
  if (preview.status === 'error') {
    return `<div class="alert alert-info">${icon('info', { size: 16 })}`
      + `<div class="stack-2"><p>${escapeHtml(preview.message)}</p>`
      + `<div class="cluster-2"><button type="button" class="btn btn-ghost btn-sm" data-action="load-preview" data-id="${safeId}">Try again</button></div>`
      + '</div></div>';
  }

  const document_ = preview.doc;
  const segments = Array.isArray(document_?.segments) ? document_.segments : [];
  if (!document_ || document_.viewable === false || segments.length === 0) {
    return `<div class="alert alert-info">${icon('info', { size: 16 })}`
      + '<div>There is no stored text to show for this material.</div></div>';
  }
  return `<div class="lib-preview">${segments.map(segmentBlock).join('')}</div>`;
}

function segmentBlock(segment) {
  const loc = locationLabel(segment?.location);
  return `<div class="lib-segment">${loc ? `<span class="badge">${escapeHtml(loc)}</span>` : ''}`
    + `<p class="lib-segment-text">${escapeHtml(segment?.text || '')}</p></div>`;
}

function organiseMarkup(source) {
  const id = escapeHtml(source.id);
  const current = sessionName(source.sessionId);
  const options = [`<option value="__unsorted__"${source.sessionId ? '' : ' selected'}>Unsorted</option>`]
    .concat(state.sessions.map((session) => (
      `<option value="${escapeHtml(session.id)}"${session.id === source.sessionId ? ' selected' : ''}>`
      + `${escapeHtml(session.title)}${session.status === 'archived' ? ' (archived)' : ''}</option>`
    )))
    .join('');

  return `<div class="stack-3">
    <p class="text-sm muted">Currently in <strong>${escapeHtml(current)}</strong>.</p>
    <div class="field">
      <label class="label" for="move-${id}">Move to a session</label>
      <select class="select" id="move-${id}" data-move-select>${options}</select>
      <div class="cluster-2"><button type="button" class="btn btn-secondary btn-sm" data-action="move" data-id="${id}">Move</button></div>
    </div>
    <div class="cluster-2">
      <button type="button" class="btn btn-ghost btn-sm" data-action="suggest" data-id="${id}">${icon('spark', { size: 14 })} Suggest a session</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="new-session" data-id="${id}">${icon('plus', { size: 14 })} New session…</button>
    </div>
    <div data-suggestion aria-live="polite"></div>
  </div>`;
}

function deleteConfirmMarkup(source) {
  return `<div class="alert alert-danger" role="alert">${icon('alert', { size: 16 })}
    <div class="stack-2">
      <p><strong>Delete «${escapeHtml(safeTitle(source.title))}»?</strong></p>
      <p class="text-sm">This removes its indexed passages from your library. It cannot be undone.</p>
      <div class="cluster-2">
        <button type="button" class="btn btn-danger btn-sm" data-action="delete-confirm" data-id="${escapeHtml(source.id)}">Delete</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="delete-cancel">Cancel</button>
      </div>
    </div></div>`;
}

/* -------------------------------------------------------------- actions ----- */

function sourceById(id) {
  return state.sources.find((source) => source.id === id) || null;
}

function toggleDetail(id, { loadPreview: wantPreview = false } = {}) {
  if (!id || !sourceById(id)) return;
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    state.deleteFor = null;
    render();
    return;
  }
  state.expanded.add(id);
  if (wantPreview && !state.previews.has(id)) {
    state.previews.set(id, { status: 'loading' });
    render();
    fetchPreview(id);
    return;
  }
  render();
  scrollDetailIntoView(id);
}

function scrollDetailIntoView(id) {
  requestAnimationFrame(() => {
    region?.querySelector('.lib-item.is-open .lib-detail')?.scrollIntoView({ block: 'nearest' });
  });
}

async function fetchPreview(id) {
  try {
    const data = await apiPost(`/api/viewer/${encodeURIComponent(id)}/document`, {});
    state.previews.set(id, { status: 'ready', doc: data?.document || null });
  } catch (error) {
    const missing = error?.code === 'NOT_FOUND' || error?.status === 404;
    state.previews.set(id, {
      status: 'error',
      message: missing
        ? 'Reading material inside the app is coming soon. For now, ask the tutor about it, or open the original link.'
        : errorMessage(error),
    });
  }
  render();
}

async function moveSource(source, value) {
  if (!source || !value) return;
  const sessionId = value === '__unsorted__' ? null : value;
  const destination = sessionId ? sessionName(sessionId) : 'Unsorted';
  try {
    await apiPatch(`/api/sources/${encodeURIComponent(source.id)}`, { sessionId });
    toast(`Moved «${safeTitle(source.title)}» to ${destination}.`, { variant: 'success' });
    await load();
  } catch (error) {
    toast(errorMessage(error), { variant: 'danger' });
  }
}

async function suggestFor(source, button) {
  if (!source) return;
  const host = button.closest('.lib-detail')?.querySelector('[data-suggestion]');
  if (!host) return;
  host.innerHTML = `<div class="cluster-2" role="status"><span class="spinner" aria-hidden="true"></span>`
    + `<span class="text-sm muted">Asking Socius where this belongs…</span></div>`;
  await offerSuggestion(source, { host, onOrganised: () => load(), sessions: state.sessions });
}

async function createSessionFor(source) {
  const session = await openSessionDialog(null);
  if (!session) return;
  try {
    await apiPatch(`/api/sources/${encodeURIComponent(source.id)}`, { sessionId: session.id });
    toast(`Created «${session.title}» and filed the material there.`, { variant: 'success' });
  } catch (error) {
    toast(`Session created, but the material could not be filed: ${errorMessage(error)}`, { variant: 'warn' });
  }
  await load();
}

function requestDelete(id) {
  if (!id) return;
  state.expanded.add(id);
  state.deleteFor = id;
  render();
  scrollDetailIntoView(id);
}

async function deleteSource(source) {
  if (!source) return;
  try {
    await apiDelete(`/api/sources/${encodeURIComponent(source.id)}`);
    state.expanded.delete(source.id);
    state.previews.delete(source.id);
    state.deleteFor = null;
    toast(`Deleted «${safeTitle(source.title)}».`, { variant: 'success' });
    await load();
  } catch (error) {
    state.deleteFor = null;
    const missing = error?.code === 'NOT_FOUND' || error?.status === 404;
    if (missing) {
      toast('Removing material is not available on this server yet — nothing was deleted.', { variant: 'warn' });
    } else {
      toast(errorMessage(error), { variant: 'danger' });
    }
    render();
  }
}

function clearFilters() {
  state.q = '';
  state.type = '';
  state.sessionFilter = '';
  if (searchInput) searchInput.value = '';
  if (typeSelect) typeSelect.value = '';
  if (sessionSelect) sessionSelect.value = '';
  render();
}

function handleAction(event, el) {
  const action = el.dataset.action;
  const id = el.dataset.id;
  const source = id ? sourceById(id) : null;

  switch (action) {
    case 'add-first': openImport(); break;
    case 'clear-filters': clearFilters(); break;
    case 'view': toggleDetail(id, { loadPreview: true }); break;
    case 'organise': toggleDetail(id, { loadPreview: false }); break;
    case 'load-preview':
      state.previews.set(id, { status: 'loading' });
      render();
      fetchPreview(id);
      break;
    case 'move':
      moveSource(source, el.closest('.lib-detail')?.querySelector('[data-move-select]')?.value);
      break;
    case 'suggest': suggestFor(source, el); break;
    case 'new-session': createSessionFor(source); break;
    case 'delete': requestDelete(id); break;
    case 'delete-cancel': state.deleteFor = null; render(); break;
    case 'delete-confirm': deleteSource(source); break;
    default: break;
  }
}

/* ---------------------------------------------------------------- import ---- */

function openImport() {
  if (!importPanel) return;
  importPanel.hidden = false;
  importToggle?.setAttribute('aria-expanded', 'true');
  if (!importPanel.dataset.mounted) {
    mountImportPanel({
      host: importPanel,
      sessionId: null,
      knownSources: () => state.sources,
      onOrganised: () => load(),
    });
    importPanel.dataset.mounted = '1';
  }
  importPanel.querySelector('#imp-file')?.focus();
  importPanel.scrollIntoView({ block: 'nearest' });
}

function closeImport() {
  if (!importPanel) return;
  importPanel.hidden = true;
  importToggle?.setAttribute('aria-expanded', 'false');
}

function toggleImport() {
  if (!importPanel) return;
  if (importPanel.hidden) openImport();
  else closeImport();
}

/* -------------------------------------------------------------- wiring ------ */

function hydrateIcons(root) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, { size: 16 });
  });
}

function bindToolbar() {
  const applySearch = debounce(() => {
    state.q = searchInput ? searchInput.value.trim() : '';
    render();
  }, 200);
  searchInput?.addEventListener('input', applySearch);
  typeSelect?.addEventListener('change', () => { state.type = typeSelect.value; render(); });
  sessionSelect?.addEventListener('change', () => { state.sessionFilter = sessionSelect.value; render(); });
  refreshButton?.addEventListener('click', () => load());
  importToggle?.addEventListener('click', toggleImport);
  if (region) on(region, 'click', '[data-action]', handleAction);
}

/* ------------------------------------------------------------------ init ---- */

async function main() {
  await mountShell({ page: 'library' });
  hydrateIcons(document);
  bindToolbar();

  const params = new URLSearchParams(window.location.search);
  const query = params.get('q');
  if (query && searchInput) {
    searchInput.value = query;
    state.q = query.trim();
  }

  await load();

  if (params.get('import') === '1') openImport();
}

main();
