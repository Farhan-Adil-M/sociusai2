// =============================================================================
// ui.js — shared, framework-free render helpers used by every Socius AI page.
//
// Responsibility: turn data into safe HTML — or into a DOM node when an element
// needs a live event listener. Nothing here calls fetch(), touches auth, or
// holds application state. Pages own their own state; they call these helpers.
//
// Two return shapes, deliberately:
//   HTML string   icon, spinner, skeleton, emptyState, citationEl, markdownLite
//   DOM node      errorState (it wires its own "Try again" button)
//                 toast      (it mounts itself in the toast region)
//
// Safety rule: every value that came from the user, the server, or a language
// model passes through escapeHtml() before it reaches innerHTML. Model answers
// are rendered by markdownLite(), which escapes FIRST and only then adds
// markup — never feed raw model text to innerHTML.
//
// Icons live in ONE <symbol> sprite defined below (see ensureSprite) and are
// referenced as <use href="#icon-name">. No page carries its own copy of any
// SVG, and page HTML never repeats the sprite.
// =============================================================================

/* ---------------------------------------------------------------- escaping */

/** Turn any value into text that is safe inside an HTML string. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ------------------------------------------------------------------- icons */

// Every glyph is drawn in one style: 24x24 grid, stroked outline, round caps,
// `currentColor` so CSS controls the colour. Add a name here and it becomes
// usable from any page as icon('name').
const ICONS = {
  // Navigation
  overview: '<rect x="3" y="3.5" width="7" height="7" rx="1.5"/><rect x="14" y="3.5" width="7" height="7" rx="1.5"/><rect x="3" y="13.5" width="7" height="7" rx="1.5"/><rect x="14" y="13.5" width="7" height="7" rx="1.5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/>',
  message: '<path d="M21 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4.5 3v-4.4A7.5 7.5 0 0 1 11 4h2.5A7.5 7.5 0 0 1 21 11.5z"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3.6A1 1 0 0 1 10 2.6h4a1 1 0 0 1 1 1v.9"/><path d="M9 13.5l2 2 4-4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cards: '<rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 4h9a2 2 0 0 1 2 2v9"/>',
  person: '<circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',

  // Chrome and controls
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.8A1 1 0 0 1 10 3.8h4a1 1 0 0 1 1 1V7"/><path d="M6 7l1 12.2A1.5 1.5 0 0 0 8.5 20.5h7A1.5 1.5 0 0 0 17 19.2L18 7"/>',
  pencil: '<path d="M4 20l4.5-1L19.5 8a2.1 2.1 0 0 0-3-3L5.5 16z"/><path d="M14 6.5l3.5 3.5"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17.6 17.6 0 0 1-3.3 4.1"/><path d="M6.3 7.9A17.4 17.4 0 0 0 2 12s3.6 6.5 10 6.5a9.8 9.8 0 0 0 4-.8"/><path d="M9.9 10.2A3 3 0 0 0 14 14"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10H15"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',

  // Feedback and status
  alert: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 9.5V14"/><path d="M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.8h.01"/>',
  check: '<path d="M4.5 12.5l5 5L20 6.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  inbox: '<path d="M5.5 5h13l3 8v5a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2v-5z"/><path d="M2.5 13H7l2 3h6l2-3h4.5"/>',
  book: '<path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H10a2 2 0 0 1 2 2v14a1.5 1.5 0 0 0-1.5-1.5h-6A2.5 2.5 0 0 1 2 15z"/><path d="M22 5.5A2.5 2.5 0 0 0 19.5 3H14a2 2 0 0 0-2 2v14a1.5 1.5 0 0 1 1.5-1.5h6A2.5 2.5 0 0 0 22 15z"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',

  // Source types and links
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  externalLink: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

const SPRITE_ID = 'socius-icon-sprite';
const SVG_NS = 'http://www.w3.org/2000/svg';
let spriteMounted = false;

/**
 * Create the hidden <svg><symbol>…</symbol></svg> sprite once, in <body>.
 * Returns true when the sprite is ready (so icon() can use <use>), false when
 * there is no document yet (Node/tests) or no <body> — icon() then inlines the
 * path instead, which looks identical.
 */
function ensureSprite() {
  if (spriteMounted) return true;
  if (typeof document === 'undefined' || !document.body) return false;
  if (document.getElementById(SPRITE_ID)) {
    spriteMounted = true;
    return true;
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('id', SPRITE_ID);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  for (const [name, paths] of Object.entries(ICONS)) {
    const symbol = document.createElementNS(SVG_NS, 'symbol');
    symbol.setAttribute('id', `icon-${name}`);
    symbol.setAttribute('viewBox', '0 0 24 24');
    symbol.innerHTML = paths; // trusted, static, defined in this file
    svg.appendChild(symbol);
  }
  document.body.appendChild(svg);
  spriteMounted = true;
  return true;
}

/**
 * Inline SVG icon. `name` is a key of ICONS (unknown names fall back to
 * `info`, so a typo can never render an invisible gap).
 */
export function icon(name, { size = 16, className = '' } = {}) {
  const key = Object.hasOwn(ICONS, name) ? name : 'info';
  const px = Number(size) > 0 ? Math.round(Number(size)) : 16;
  const classes = className ? `icon ${escapeHtml(className)}` : 'icon';
  const attrs = `class="${classes}" width="${px}" height="${px}" viewBox="0 0 24 24"`
    + ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true" focusable="false"';
  if (ensureSprite()) return `<svg ${attrs}><use href="#icon-${key}"></use></svg>`;
  return `<svg ${attrs}>${ICONS[key]}</svg>`;
}

/* ----------------------------------------------------------- loading states */

/**
 * Loading indicator: spinner ring + visible label. Built from the shared
 * components.css primitives (.spinner, .cluster-2, .text-sm, .muted), so it
 * needs no CSS of its own.
 */
export function spinner(label = 'Loading…') {
  const text = label ? `<span class="text-sm muted">${escapeHtml(label)}</span>` : '';
  return `<span class="cluster-2" role="status">`
    + '<span class="spinner" aria-hidden="true"></span>'
    + `${text}</span>`;
}

/**
 * Placeholder bars shown while real content loads. `lines` is how many bars;
 * hidden from screen readers because spinner() carries the announcement.
 */
export function skeleton(lines = 3) {
  const count = Math.max(1, Math.min(Math.floor(Number(lines) || 3), 20));
  const bars = Array.from({ length: count }, () => '<span class="skeleton skeleton-text"></span>').join('');
  return `<div class="stack-2" aria-hidden="true">${bars}</div>`;
}

/* ------------------------------------------------------ empty / error states */

/**
 * "Nothing here yet" block (components.css `.empty-state`). `action` is
 * trusted markup for the buttons under the text — build them yourself, e.g.
 * '<button class="btn btn-primary">Add material</button>'.
 * Returns an HTML string.
 */
export function emptyState({ icon: iconName = 'inbox', title = 'Nothing here yet', body = '', action = '' } = {}) {
  return `<div class="empty-state">
    <span class="empty-state-icon">${icon(iconName, { size: 22 })}</span>
    <p class="empty-state-title">${escapeHtml(title)}</p>
    ${body ? `<p class="empty-state-text">${escapeHtml(body)}</p>` : ''}
    ${action ? `<div class="empty-state-actions">${action}</div>` : ''}
  </div>`;
}

// Friendly sentences for the API contract's stable error codes. Used by
// errorState() so a page never shows a raw stack trace or a blank message.
const CODE_FALLBACKS = {
  NETWORK_ERROR: 'Cannot reach the Socius AI server. Check that it is running, then try again.',
  UNAUTHENTICATED: 'Your session ended. Sign in again to continue.',
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
  SESSION_NOT_FOUND: 'That study session no longer exists. Reload the list and try again.',
  SESSION_EMPTY: 'This study session has no material yet. Add a file or web page first.',
  DECK_NOT_FOUND: 'That deck no longer exists. Reload the list and try again.',
  ONBOARDING_COMPLETE: 'The intro interview is already finished.',
  STORAGE_FETCH_FAILED: 'That upload could not be read back from storage. Please upload it again.',
  NOT_FOUND: 'That item does not exist.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
};

/**
 * Turn any thrown value into one sentence a student can act on: the API
 * error's own message when it has one (the server writes these for people),
 * otherwise a friendly fallback for its stable code.
 */
export function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message;
  const code = error && error.code;
  if (code && CODE_FALLBACKS[code]) return CODE_FALLBACKS[code];
  return CODE_FALLBACKS.INTERNAL;
}

/**
 * Error block. Pass the caught error and, if the user can retry, the function
 * to run. Returns a DOM node (not a string) because the retry click is wired
 * here — drop it in with replaceChildren(), or append().
 */
export function errorState(error, retry, { title = 'That did not work' } = {}) {
  const canRetry = typeof retry === 'function';
  const node = document.createElement('div');
  node.className = 'empty-state is-error';
  node.setAttribute('role', 'alert');
  node.innerHTML = `
    <span class="empty-state-icon">${icon('alert', { size: 22 })}</span>
    <p class="empty-state-title">${escapeHtml(title)}</p>
    <p class="empty-state-text">${escapeHtml(errorMessage(error))}</p>
    ${canRetry
      ? `<div class="empty-state-actions"><button type="button" class="btn btn-secondary btn-sm" data-retry>${icon('refresh', { size: 14 })} Try again</button></div>`
      : ''}
  `;
  if (canRetry) {
    node.querySelector('[data-retry]').addEventListener('click', retry);
  }
  return node;
}

/* -------------------------------------------------------------------- toast */

// Variants map onto components.css: .toast-info/.toast-success/.toast-warn/
// .toast-danger. 'error' is accepted as another name for 'danger'.
const TOAST_VARIANTS = { info: 'info', success: 'success', warn: 'warn', danger: 'danger', error: 'danger' };
const TOAST_ICONS = { info: 'info', success: 'checkCircle', warn: 'alert', danger: 'alert' };

function toastRegion() {
  let region = document.querySelector('[data-toast-region]');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('data-toast-region', '');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

/**
 * Show a short, self-dismissing message ("Saved", "Could not delete…").
 * `variant` is 'info' | 'success' | 'warn' | 'danger' (or 'error' for danger).
 * Problems stay on screen longer and are announced assertively.
 * Returns the toast element.
 */
export function toast(message, { variant = 'info', duration } = {}) {
  const kind = TOAST_VARIANTS[variant] || 'info';
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
  node.innerHTML = `${icon(TOAST_ICONS[kind], { size: 16 })}
    <span class="toast-message">${escapeHtml(message)}</span>
    <button type="button" class="btn btn-ghost btn-icon" data-toast-close aria-label="Dismiss">${icon('close', { size: 14 })}</button>`;

  let timer = 0;
  const remove = () => {
    window.clearTimeout(timer);
    node.remove();
  };
  node.querySelector('[data-toast-close]').addEventListener('click', remove);
  toastRegion().appendChild(node);

  const shownFor = duration ?? (kind === 'danger' ? 7000 : 4000);
  timer = window.setTimeout(remove, shownFor);
  return node;
}

/* ---------------------------------------------------------------- citations */

const TYPE_ICONS = { pdf: 'file', pptx: 'slides', webpage: 'globe' };
const TYPE_LABELS = { pdf: 'PDF', pptx: 'Slides', webpage: 'Web page' };

/** "p. 12" / "slide 3" / "para. 4" from a citation's `location` object. */
function locationLabel(citation) {
  const location = citation && citation.location;
  if (!location || typeof location !== 'object') return '';
  if (location.page != null) return `p. ${location.page}`;
  if (location.slide != null) return `slide ${location.slide}`;
  if (location.paragraph != null) return `para. ${location.paragraph}`;
  return '';
}

/** Only http(s) links are ever rendered, so a stray scheme cannot get in. */
function safeUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\//i.test(url) ? url : '';
}

/**
 * One source citation chip, matching the citation schema in
 * docs/API_CONTRACT.md: { sourceId, type, title, url, location, excerpt, score }.
 * The chip shows title + location; activating it reveals the exact excerpt and
 * the link to the source. Returns an HTML string containing BOTH the chip
 * (`.citation` button) and its `.citation-detail` panel, which must stay
 * adjacent siblings — wrap a list of citations in `<div class="citations">`.
 *
 * The click handling is installed once, lazily, by the first call (see
 * ensureCitationClicks), so pages call citationEl() and nothing else.
 */
export function citationEl(citation) {
  const cite = citation && typeof citation === 'object' ? citation : {};
  const title = cite.title || 'Untitled source';
  const location = locationLabel(cite);
  const type = TYPE_LABELS[cite.type] || 'Source';
  const url = safeUrl(cite.url);
  const score = typeof cite.score === 'number' ? `match ${Math.round(cite.score * 100)}%` : '';

  ensureCitationClicks();

  return `<button type="button" class="citation" aria-expanded="false">
    ${icon(TYPE_ICONS[cite.type] || 'file', { size: 14 })}
    <span class="citation-title">${escapeHtml(title)}</span>
    ${location ? `<span class="citation-loc">${escapeHtml(location)}</span>` : ''}
    ${icon('chevronDown', { size: 12 })}
  </button>
  <div class="citation-detail" hidden>
    ${cite.excerpt ? `<blockquote>${escapeHtml(cite.excerpt)}</blockquote>` : ''}
    <p>
      <span>${escapeHtml(type)}</span>${score ? ` · ${escapeHtml(score)}` : ''}
      ${url ? ` · <a href="${url}" target="_blank" rel="noopener noreferrer">Open source</a>` : ''}
    </p>
  </div>`;
}

// One listener for every citation on every page: toggling a chip flips its own
// detail panel (the next sibling). Installed the first time a citation is
// rendered, so importing ui.js stays side-effect free.
const CITATION_KEY = 'sociusCitationsWired';

function ensureCitationClicks() {
  if (typeof document === 'undefined' || document[CITATION_KEY]) return;
  document[CITATION_KEY] = true;
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target ? target.closest('.citation[aria-expanded]') : null;
    if (!chip) return;
    const panel = chip.nextElementSibling;
    if (!panel || !panel.classList.contains('citation-detail')) return;
    const open = chip.getAttribute('aria-expanded') === 'true';
    chip.setAttribute('aria-expanded', open ? 'false' : 'true');
    panel.hidden = open;
  });
}

/* --------------------------------------------------------------- markdownLite */

const KEEP_START = '\uE000';
const KEEP_END = '\uE001';
const KEEP_PATTERN = new RegExp(`${KEEP_START}(\\d+)${KEEP_END}`, 'g');

/** Bold then italic, inside one line that is ALREADY escaped. */
function emphasise(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

/**
 * Inline formatting for one already-escaped line: `code`, [links](url),
 * **bold**, *italic*. Markup produced here is stashed behind private-use
 * placeholders so later passes cannot re-process it.
 */
function inlineFormat(escaped) {
  const kept = [];
  const keep = (html) => {
    kept.push(html);
    return `${KEEP_START}${kept.length - 1}${KEEP_END}`;
  };

  let out = escaped.replace(/`([^`]+)`/g, (_match, code) => keep(`<code>${code}</code>`));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, href) => (
    // Only http(s) links become real links; anything else stays readable text.
    /^https?:\/\//i.test(href)
      ? keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">${emphasise(text)}</a>`)
      : match
  ));
  out = emphasise(out);
  return out.replace(KEEP_PATTERN, (_match, index) => kept[Number(index)]);
}

/**
 * Safe minimal Markdown for model-written text (tutor answers, explanations).
 * Supports headings, lists, bold, italic, inline code and links — nothing else.
 *
 * It escapes the whole input FIRST, so no HTML in the source can ever become
 * live markup. Consecutive lines form one paragraph separated by <br>, which
 * keeps the line breaks the model wrote; blank lines start a new block.
 * Headings are pushed into <h3>…<h6> so a page's own <h1> keeps its place.
 * Returns an HTML string.
 */
export function markdownLite(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(inlineFormat).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    blocks.push(`<${tag}>${list.items.map((item) => `<li>${inlineFormat(item)}</li>`).join('')}</${tag}>`);
    list = null;
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(2 + heading[1].length, 6); // # -> h3 … #### -> h6
      blocks.push(`<h${level}>${inlineFormat(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(escapeHtml((bullet || numbered)[1]));
      continue;
    }

    flushList();
    paragraph.push(escapeHtml(line));
  }

  flushParagraph();
  flushList();
  return blocks.join('\n');
}

/* --------------------------------------------------------------- formatting */

/** "12 Oct 2026" from an ISO timestamp. Empty string for unusable input. */
export function formatDate(iso) {
  if (!iso) return '';
  const value = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? `${iso}T12:00:00` : iso;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "just now" / "5 min ago" / "2 days ago" / a plain date past a week. */
export function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'min')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${plural(days, 'day')} ago`;
  return formatDate(iso);
}

/**
 * "1 card" / "3 cards". Pass `pluralWord` for words that do not simply take an
 * "s": plural(2, 'quiz', 'quizzes').
 */
export function plural(n, word, pluralWord) {
  const count = Number(n) || 0;
  if (pluralWord) return `${count} ${count === 1 ? word : pluralWord}`;
  const auto = /(s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
  return `${count} ${count === 1 ? word : auto}`;
}

/* ------------------------------------------------------------------ events */

/**
 * Debounce a function: it runs only after `wait` ms of quiet. Useful for
 * search boxes and resize handlers. The returned function has .cancel(), so a
 * page can stop a pending run when it navigates or clears the input.
 */
export function debounce(fn, wait = 250) {
  let timer = 0;
  const debounced = (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => window.clearTimeout(timer);
  return debounced;
}

/**
 * Event delegation: one listener on `root` that fires only when the click (or
 * any other event) started on — or inside — an element matching `selector`.
 * The handler receives (event, matchedElement). Returns an unsubscribe function.
 * This is how lists of buttons stay cheap: add the buttons, delegate the clicks.
 */
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const match = target ? target.closest(selector) : null;
    if (match && root.contains(match)) handler(event, match);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}
