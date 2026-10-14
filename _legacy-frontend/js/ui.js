// Shared presentation helpers: HTML escaping, icons, formatting, the loading /
// empty / error states, and citation rendering. No fetch() lives here — that is
// api.js's job alone.

/* ---------------------------------------------------------------- escaping */

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ------------------------------------------------------------------- icons */

const ICON_PATHS = {
  book: '<path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H10a2 2 0 0 1 2 2v14a1.5 1.5 0 0 0-1.5-1.5h-6A2.5 2.5 0 0 1 2 15z"/><path d="M22 5.5A2.5 2.5 0 0 0 19.5 3H14a2 2 0 0 0-2 2v14a1.5 1.5 0 0 1 1.5-1.5h6A2.5 2.5 0 0 0 22 15z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 16l9 5 9-5"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3.6A1 1 0 0 1 10 2.6h4a1 1 0 0 1 1 1v.9"/><path d="M9 13.5l2 2 4-4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M4.5 12.5l5 5L20 6.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  alert: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 9.5V14"/><path d="M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.8h.01"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17.6 17.6 0 0 1-3.3 4.1"/><path d="M6.3 7.9A17.4 17.4 0 0 0 2 12s3.6 6.5 10 6.5a9.8 9.8 0 0 0 4-.8"/><path d="M9.9 10.2A3 3 0 0 0 14 14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  arrowRight: '<path d="M4 12h15"/><path d="M13 6l6 6-6 6"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10H15"/>',
  message: '<path d="M21 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4.5 3v-4.4A7.5 7.5 0 0 1 11 4h2.5A7.5 7.5 0 0 1 21 11.5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  inbox: '<path d="M5.5 5h13l3 8v5a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2v-5z"/><path d="M2.5 13H7l2 3h6l2-3h4.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/>',
  pencil: '<path d="M4 20l4.5-1L19.5 8a2.1 2.1 0 0 0-3-3L5.5 16z"/><path d="M14 6.5l3.5 3.5"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8"/><path d="M10 12h4"/>',
};

const TYPE_ICONS = { pdf: 'file', pptx: 'slides', webpage: 'globe' };

/** Inline SVG icon. `name` is a key of ICON_PATHS. */
export function icon(name, { size = 16, className = '' } = {}) {
  const path = ICON_PATHS[name] || ICON_PATHS.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${className ? ` class="${className}"` : ''}>${path}</svg>`;
}

export function sourceIcon(type, opts) {
  return icon(TYPE_ICONS[type] || 'file', opts);
}

/* -------------------------------------------------------------- formatting */

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(iso);
}

/** "p. 12" / "slide 3" / "para. 4" from a citation's location object. */
export function locationLabel(citation) {
  const loc = citation && citation.location;
  if (!loc) return '';
  if (loc.page != null) return `p. ${loc.page}`;
  if (loc.slide != null) return `slide ${loc.slide}`;
  if (loc.paragraph != null) return `para. ${loc.paragraph}`;
  return '';
}

const TYPE_LABELS = { pdf: 'PDF', pptx: 'Slides', webpage: 'Web page' };
export function typeLabel(type) { return TYPE_LABELS[type] || type || 'Source'; }

/* ------------------------------------------------------------------ errors */

const CODE_FALLBACKS = {
  NETWORK_ERROR: 'Cannot reach the Socius AI server. Check that it is running, then try again.',
  VALIDATION_ERROR: 'Some of the input was not valid.',
  INVALID_URL: 'That is not a valid web address.',
  UNSUPPORTED_FILE: 'That file type is not supported. Use a PDF or PowerPoint file.',
  EMPTY_CONTENT: 'No readable text was found in that file.',
  FILE_TOO_LARGE: 'That file is too large.',
  SOURCE_NOT_FOUND: 'That study material no longer exists. Reload the list and try again.',
  QUIZ_NOT_FOUND: 'That quiz no longer exists. Start a new one.',
  QUIZ_ALREADY_ANSWERED: 'You already submitted this quiz.',
  QUIZ_CONTENT_INVALID: 'Valid questions could not be generated for that topic. Try a different topic.',
  NIM_ERROR: 'The AI service failed to respond. Please try again.',
  NIM_TIMEOUT: 'The AI service took too long to respond. Please try again.',
  CHROMA_UNAVAILABLE: 'The search index is unavailable right now. Please try again shortly.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
  NOT_FOUND: 'That page does not exist.',
  SESSION_NOT_FOUND: 'That study session no longer exists. Reload the list and try again.',
  SESSION_EMPTY: 'This session has no material yet. Add a file or web page first.',
  DECK_NOT_FOUND: 'That deck no longer exists. Reload the library and try again.',
};

/** Turn any thrown error into a sentence we can show a student. */
export function errorMessage(error) {
  if (!error) return CODE_FALLBACKS.INTERNAL;
  if (error.message) return error.message;
  return CODE_FALLBACKS[error.code] || CODE_FALLBACKS.INTERNAL;
}

/* ------------------------------------------------------------------ states */

/** Loading block. Replaces the container's contents. */
export function showLoading(container, text = 'Loading…') {
  container.innerHTML = `<div class="loading-row"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(text)}</span></div>`;
}

/** Empty state with an icon, a title, an explanation and optional actions. */
export function showEmpty(container, { iconName = 'inbox', title, text = '', actions = '' }) {
  container.innerHTML = `
    <div class="state">
      <span class="state-icon">${icon(iconName, { size: 20 })}</span>
      <span class="state-title">${escapeHtml(title)}</span>
      ${text ? `<p class="state-text">${escapeHtml(text)}</p>` : ''}
      ${actions ? `<div class="state-actions">${actions}</div>` : ''}
    </div>`;
}

/** Error state with a retry action. Always shows a real, human message. */
export function showError(container, error, { title = 'That did not work', onRetry } = {}) {
  container.innerHTML = `
    <div class="state">
      <span class="state-icon" style="color: var(--red); border-color: #F1C4C1; background: var(--red-soft);">${icon('alert', { size: 20 })}</span>
      <span class="state-title">${escapeHtml(title)}</span>
      <p class="state-text">${escapeHtml(errorMessage(error))}</p>
      ${onRetry ? '<div class="state-actions"><button type="button" class="btn btn-secondary btn-sm" data-retry>Try again</button></div>' : ''}
    </div>`;
  if (onRetry) container.querySelector('[data-retry]')?.addEventListener('click', onRetry);
}

/* -------------------------------------------------------------- citations */

function citationChip(citation, index, uid) {
  const title = citation.title || 'Untitled source';
  const loc = locationLabel(citation);
  const detailId = `${uid}-cite-${index}`;
  return `
    <button type="button" class="citation" aria-expanded="false" aria-controls="${detailId}">
      ${sourceIcon(citation.type, { size: 13 })}
      <span class="citation-title">${escapeHtml(title)}</span>
      ${loc ? `<span class="citation-loc">${escapeHtml(loc)}</span>` : ''}
      ${icon('chevronDown', { size: 12 })}
    </button>
    <div class="citation-detail" id="${detailId}" hidden>
      <blockquote>${escapeHtml(citation.excerpt || 'No excerpt available for this passage.')}</blockquote>
      <div class="inline" style="gap: var(--s2);">
        <span class="citation-source-tag">${escapeHtml(typeLabel(citation.type))}</span>
        <span>${escapeHtml(title)}${loc ? ` · ${escapeHtml(loc)}` : ''}</span>
        ${typeof citation.score === 'number' ? `<span>match ${(citation.score * 100).toFixed(0)}%</span>` : ''}
        ${citation.url ? `<a href="${escapeHtml(citation.url)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ''}
      </div>
    </div>`;
}

/**
 * Render a citation list as expandable chips. `uid` must be unique per list on
 * the page (study answers, quiz results…), so detail panels never share ids.
 * Call wireCitations(container) once on the parent element.
 */
export function renderCitations(citations, uid = 'c') {
  if (!Array.isArray(citations) || citations.length === 0) return '';
  return `<div class="citations">${citations.map((citation, index) => citationChip(citation, index, uid)).join('')}</div>`;
}

/** One delegated listener: open a citation detail, close the others. */
export function wireCitations(root) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('.citation');
    if (!button || !root.contains(button)) return;
    const open = button.getAttribute('aria-expanded') === 'true';
    root.querySelectorAll('.citation[aria-expanded="true"]').forEach((other) => {
      other.setAttribute('aria-expanded', 'false');
      const panel = document.getElementById(other.getAttribute('aria-controls'));
      if (panel) panel.hidden = true;
    });
    button.setAttribute('aria-expanded', String(!open));
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (panel) panel.hidden = open;
  });
}

/* -------------------------------------------------- topic generator forms */

// Shared plumbing for the quiz and flashcards generator forms. The two pages
// keep their own setSetupStatus: quiz escapes plain-text messages, flashcards
// embeds markup (icons and links), so they cannot be one function.

/** Clear or fill a generator topic's inline error field. */
export function setTopicError(input, errorEl, message) {
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/** The topic validation both pages share: message text, or '' when 2–80 chars. */
export function topicCheck(input) {
  const topic = input.value.trim();
  if (topic.length < 2) return 'Enter a topic — at least 2 characters.';
  if (topic.length > 80) return 'Keep the topic under 80 characters.';
  return '';
}

/** Busy/ready flip for a generator's submit button. */
export function setGenerating(button, labels, busy) {
  button.disabled = busy;
  button.innerHTML = busy
    ? `<span class="spinner" aria-hidden="true"></span> ${escapeHtml(labels.busy)}`
    : escapeHtml(labels.ready);
}
