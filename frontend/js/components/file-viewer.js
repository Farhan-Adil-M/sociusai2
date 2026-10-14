// =============================================================================
// components/file-viewer.js — read your material inside Socius AI.
//
// Replaces "Reading material inside the app is coming soon" with a real reader
// for the file types the app ingests (PDF, DOCX, PPTX — plus pasted web pages).
// It renders the text the server stored when the file was uploaded, organised by
// the document's own structure: one screen per PDF page, one per slide, or a
// readable grouping of paragraphs for a Word document.
//
// Data: GET /api/viewer/:sourceId →
//   { document: { sourceId, type, title, viewable, pageCount, slideCount,
//                 segments: [{ index, location, text }] } }
// There are no original file bytes to stream — the upload pipeline keeps only
// the extracted text (docs/ARCHITECTURE.md §4), which is the same text the
// tutor, quizzes and flashcards are grounded in. The reader says so plainly,
// rather than pretending the original layout is on screen.
//
// Accessibility is not an afterthought here: this is a reading tool. Real
// headings (h1 = the document, h2 = each section), the visible focus ring every
// control gets from base.css `:focus-visible`, full keyboard operation
// (Tab/Shift+Tab, ArrowLeft/ArrowRight, Home/End), aria-labels on the icon-only
// controls, and a polite live region that announces the section you land on.
//
// Responsibility: turn a document payload into a readable, keyboard-operable
// page. It calls the one viewer endpoint through api.js, never touches auth,
// and holds no shared application state.
// =============================================================================

import { apiGet } from '../api.js';
import { emptyState, errorState, escapeHtml, icon, plural, spinner } from '../ui.js';

/* ------------------------------------------------------------- vocabulary -- */

// Plain-English names for the source types the app can hold. `ui.js` keeps its
// own (unexported) map for citations; this one is the reader's.
const TYPE_LABELS = {
  pdf: 'PDF',
  docx: 'Word document',
  pptx: 'Slides',
  webpage: 'Web page',
  youtube: 'Video',
  image: 'Image',
};

const TYPE_ICONS = {
  pdf: 'file', docx: 'book', pptx: 'slides', webpage: 'globe', youtube: 'externalLink', image: 'file',
};

// How much text belongs on one screen. Word paragraphs are short, so they are
// grouped; a PDF page stays whole because the page IS the reading unit.
const MIN_PAGE_CHARS = 900;
const MAX_PAGE_CHARS = 6000;
const MAX_PAGE_SEGMENTS = 60;

const TEXT_SIZES = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'large', label: 'Large' },
  { value: 'extra-large', label: 'Extra large' },
];

/** Where this page lives — the link A23's library and A24's session page use. */
export function viewerUrl(sourceId) {
  return `viewer.html?source=${encodeURIComponent(String(sourceId ?? ''))}`;
}

/** "Page 3" / "Slide 5" / "Paragraph 12" from a stored segment's location. */
function unitLabel(location) {
  const where = location && typeof location === 'object' ? location : {};
  if (where.page != null) return `Page ${where.page}`;
  if (where.slide != null) return `Slide ${where.slide}`;
  if (where.paragraph != null) return `Paragraph ${where.paragraph}`;
  if (where.timestamp != null) return `At ${where.timestamp}`;
  if (where.segment != null) return `Section ${where.segment}`;
  return '';
}

/** True when every segment carries a page or slide number (PDF / PPTX). */
function isPageStructured(segments) {
  return segments.length > 0
    && segments.every((segment) => segment.location
      && (segment.location.page != null || segment.location.slide != null));
}

/** The label for one group of paragraphs: "Paragraphs 12–18". */
function groupedLabel(group) {
  const first = group[0]?.location?.paragraph;
  const last = group[group.length - 1]?.location?.paragraph;
  if (first == null && last == null) return '';
  if (first != null && last != null && first !== last) return `Paragraphs ${first}–${last}`;
  return `Paragraph ${first ?? last}`;
}

/**
 * Split the ordered segments into readable sections.
 * Structured documents (PDF pages, slides) keep one segment per section — that
 * is the author's own unit, and a student expects "Page 12" to mean page 12.
 * Everything else (Word paragraphs, pasted web text) is grouped so one screen
 * holds a real amount of reading instead of a single sentence.
 */
function paginate(segments) {
  if (segments.length === 0) return [];

  if (isPageStructured(segments)) {
    return segments.map((segment) => ({ label: unitLabel(segment.location), segments: [segment] }));
  }

  const pages = [];
  let current = null;
  for (const segment of segments) {
    const chars = segment.text.length;
    const enoughOnThisPage = current
      && current.chars >= MIN_PAGE_CHARS
      && current.segments.length < MAX_PAGE_SEGMENTS;
    const wouldOverflow = current && current.chars + chars > MAX_PAGE_CHARS;
    if (!current || enoughOnThisPage || wouldOverflow) {
      current = { segments: [], chars: 0 };
      pages.push(current);
    }
    current.segments.push(segment);
    current.chars += chars;
  }
  return pages.map((page) => ({ label: groupedLabel(page.segments), segments: page.segments }));
}

/* ----------------------------------------------------------------- state --- */

const state = {
  document: null,
  pages: [],
  page: 0,
  mode: 'pages', // 'pages' | 'continuous'
  textSize: 'comfortable',
  moveFocus: false, // move focus to the section the reader just changed to
};

let host = null;
let liveRegion = null;

function announce(message) {
  if (liveRegion) liveRegion.textContent = message;
}

function paint(html) {
  if (host) host.innerHTML = html;
}

/* ---------------------------------------------------------------- loading -- */

function loadingHtml() {
  return `<div class="panel"><div class="panel-body stack stack-3">
    ${spinner('Opening your material…')}
    <p class="help">Socius is reading the text it stored when this file was uploaded.</p>
  </div></div>`;
}

function renderLoading() {
  paint(loadingHtml());
}

/* ----------------------------------------------------------------- reader -- */

function sizeLabelOf(document) {
  if (document.pageCount != null) return plural(document.pageCount, 'page');
  if (document.slideCount != null) return plural(document.slideCount, 'slide');
  return plural(document.segmentCount, 'stored passage');
}

function positionText() {
  const total = state.pages.length;
  if (state.mode === 'continuous') return `All ${plural(total, 'section')}`;
  return `Section ${state.page + 1} of ${total}`;
}

function toolbarHtml() {
  const total = state.pages.length;
  const options = state.pages
    .map((page, index) => {
      const label = page.label || `Section ${index + 1}`;
      return `<option value="${index}"${index === state.page ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');

  const sizeOptions = TEXT_SIZES
    .map((entry) => `<option value="${entry.value}"${entry.value === state.textSize ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`)
    .join('');

  const pageControls = state.mode === 'pages'
    ? `<button type="button" class="btn btn-secondary btn-sm" data-fv="prev"
          ${state.page === 0 ? 'disabled' : ''} aria-label="Previous section">
          ${icon('chevronLeft', { size: 14 })}<span>Previous</span>
        </button>
        <p class="fv-position" data-fv-position>${escapeHtml(positionText())}</p>
        <button type="button" class="btn btn-secondary btn-sm" data-fv="next"
          ${state.page >= total - 1 ? 'disabled' : ''} aria-label="Next section">
          <span>Next</span>${icon('chevronRight', { size: 14 })}
        </button>`
    : `<p class="fv-position" data-fv-position>${escapeHtml(positionText())}</p>
       <span class="fv-hint">Scroll, or jump with the list.</span>`;

  return `
  <div class="fv-bar" data-fv-bar>
    <div class="fv-bar-row">
      ${pageControls}
      <span class="spacer"></span>
      <label class="fv-control" for="fv-jump">Jump to</label>
      <select class="select fv-select" id="fv-jump" data-fv="jump">${options}</select>
      <label class="fv-control" for="fv-mode">Layout</label>
      <select class="select fv-select" id="fv-mode" data-fv="mode">
        <option value="pages"${state.mode === 'pages' ? ' selected' : ''}>One section at a time</option>
        <option value="continuous"${state.mode === 'continuous' ? ' selected' : ''}>All sections, scrolling</option>
      </select>
      <label class="fv-control" for="fv-size">Text size</label>
      <select class="select fv-select" id="fv-size" data-fv="size">${sizeOptions}</select>
    </div>
    <p class="help fv-keys">${icon('info', { size: 14 })}
      Keyboard: <span class="kbd">&larr;</span> <span class="kbd">&rarr;</span> move between sections,
      <span class="kbd">Home</span> first, <span class="kbd">End</span> last.</p>
  </div>`;
}

function sectionHtml(page, index) {
  const headingId = `fv-section-heading-${index}`;
  const label = page.label || `Section ${index + 1}`;
  return `<article class="fv-section" data-fv-section="${index}" aria-labelledby="${headingId}" tabindex="-1">
      <h2 class="fv-section-title" id="${headingId}">${escapeHtml(label)}</h2>
      <div class="fv-text">${page.segments.map((segment) => `<p class="fv-para">${escapeHtml(segment.text)}</p>`).join('')}</div>
    </article>`;
}

function readerHtml() {
  const document = state.document;
  const typeLabel = TYPE_LABELS[document.type] || 'Study material';
  const typeIcon = TYPE_ICONS[document.type] || 'file';
  const visible = state.mode === 'pages'
    ? [[state.page, state.pages[state.page]]]
    : state.pages.map((page, index) => [index, page]);

  return `
  <div class="stack stack-4">
    <header class="fv-head">
      <div class="cluster-2">
        <span class="badge">${icon(typeIcon, { size: 12 })} ${escapeHtml(typeLabel)}</span>
        <span class="badge">${escapeHtml(sizeLabelOf(document))}</span>
        <span class="badge">${escapeHtml(plural(state.pages.length, 'reading section'))}</span>
      </div>
      <h1 class="fv-title">${escapeHtml(document.title)}</h1>
      <p class="lead fv-sub">Read it here — no download, no other app.</p>
    </header>

    ${toolbarHtml()}

    <div class="fv-reading" data-fv-reading data-fv-size="${escapeHtml(state.textSize)}"
         data-fv-mode="${escapeHtml(state.mode)}">
      ${visible.filter(([, page]) => page).map(([index, page]) => sectionHtml(page, index)).join('')}
    </div>

    <p class="help fv-note">${icon('info', { size: 14 })}
      This is the text Socius extracted and stored when the file was uploaded — the same text the
      tutor answers from. The original layout, images and fonts are not kept, so a page here may
      read a little differently from the file you uploaded.</p>
  </div>`;
}

function renderReader() {
  paint(readerHtml());
  if (state.moveFocus) {
    state.moveFocus = false;
    const target = host?.querySelector('[data-fv-section]') || host?.querySelector('[data-fv-reading]');
    target?.focus();
  }
}

/* ----------------------------------------------------------------- actions */

function goTo(index) {
  const total = state.pages.length;
  const next = Math.min(Math.max(0, index), Math.max(0, total - 1));
  if (next === state.page) return;
  state.page = next;
  state.moveFocus = true;
  renderReader();
  announce(`${positionText()}. ${state.pages[next]?.label ?? ''}`.trim());
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.moveFocus = true;
  renderReader();
  announce(mode === 'pages' ? positionText() : 'Showing every section, one after another.');
}

function setTextSize(value) {
  const entry = TEXT_SIZES.find((size) => size.value === value);
  if (!entry) return;
  state.textSize = entry.value;
  const reading = host?.querySelector('[data-fv-reading]');
  if (reading) reading.dataset.fvSize = entry.value;
  announce(`Text size: ${entry.label}.`);
}

function wireReader() {
  host?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-fv]');
    if (!button || !host.contains(button)) return;
    const action = button.dataset.fv;
    if (action === 'prev') goTo(state.page - 1);
    else if (action === 'next') goTo(state.page + 1);
  });

  host?.addEventListener('change', (event) => {
    const control = event.target.closest('[data-fv]');
    if (!control || !host.contains(control)) return;
    if (control.dataset.fv === 'jump') goTo(Number(control.value));
    else if (control.dataset.fv === 'mode') setMode(control.value);
    else if (control.dataset.fv === 'size') setTextSize(control.value);
  });

  // Arrow keys page through the document. Guarded so the arrow keys keep
  // working normally inside the selects and any future form field.
  host?.addEventListener('keydown', (event) => {
    if (event.target.closest('select, input, textarea')) return;
    if (event.defaultPrevented || state.mode !== 'pages') return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(state.page - 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); goTo(state.page + 1); }
    else if (event.key === 'Home') { event.preventDefault(); goTo(0); }
    else if (event.key === 'End') { event.preventDefault(); goTo(state.pages.length - 1); }
  });
}

/* ------------------------------------------------------- degraded states -- */

function panelState(inner) {
  return `<div class="panel"><div class="panel-body stack stack-3">${inner}</div></div>`;
}

function renderNotViewable(document) {
  paint(panelState(`
    ${emptyState({
      icon: 'inbox',
      title: 'Nothing to read here yet',
      body: 'Socius stored no readable text for this material. Scanned pages and image-only files '
        + 'cannot be turned into text yet, so there is nothing to show.',
      action: '<a class="btn btn-secondary btn-sm" href="library.html">Back to My Materials</a>',
    })}
    <p class="help">Material: ${escapeHtml(document.title)} (${
      escapeHtml(TYPE_LABELS[document.type] || document.type || 'unknown type')
    }).</p>`));
}

function renderNoSelection() {
  paint(panelState(emptyState({
    icon: 'folder',
    title: 'No material selected',
    body: 'Open a document from My Materials, or from a study session, to read it here.',
    action: '<a class="btn btn-primary btn-sm" href="library.html">Go to My Materials</a>',
  })));
  announce('No material selected.');
}

/* -------------------------------------------------------------------- boot */

async function load(sourceId) {
  renderLoading();
  state.document = null;
  state.pages = [];
  state.page = 0;

  try {
    const data = await apiGet(`/api/viewer/${encodeURIComponent(sourceId)}`);
    const document = data?.document;
    if (!document || typeof document !== 'object') {
      // A 200 with no document is still a broken answer — say so, never a blank panel.
      throw new Error('The server sent no readable document for this material.');
    }

    const segments = Array.isArray(document.segments) ? document.segments : [];
    state.document = document;
    state.pages = paginate(segments);
    if (document.viewable === false || state.pages.length === 0) {
      renderNotViewable(document);
      return;
    }
    renderReader();
    announce(`${document.title} opened — ${plural(state.pages.length, 'reading section')}.`);
  } catch (error) {
    host?.replaceChildren(errorState(error, () => load(sourceId), { title: 'Could not open this material' }));
  }
}

/* ------------------------------------------------------------------- mount */

/**
 * Mount the reader into `host`.
 *
 *   import { mountFileViewer } from '../components/file-viewer.js';
 *   mountFileViewer({ host: document.querySelector('[data-viewer-content]'), sourceId });
 *
 * `sourceId` is optional — without it the page URL's `?source=` is used, which
 * is what `viewerUrl()` produces. `liveRegion` is an optional polite status
 * element kept OUTSIDE `host`, so re-rendering the reader never cuts an
 * announcement short (the pattern profile.js uses).
 */
export function mountFileViewer({ host: hostEl, sourceId, liveRegion: liveEl } = {}) {
  host = hostEl ?? null;
  liveRegion = liveEl ?? null;
  if (!host) {
    console.error('[file-viewer] mountFileViewer() got no host element — nothing to read into.');
    return;
  }

  const fromUrl = new URLSearchParams(window.location.search).get('source');
  const id = String(sourceId ?? fromUrl ?? '').trim();

  wireReader();
  if (id === '') {
    renderNoSelection();
    return;
  }
  load(id);
}
