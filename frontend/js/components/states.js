// =============================================================================
// components/states.js — ONE renderer for every loading / empty / error /
//                        validation state in Socius AI.
//
// Responsibility: turn "what the student should be told right now" into one
// consistent, accessible block of DOM. Nothing else. It does not fetch, does
// not hold page state, and writes no CSS — it composes the components.css
// vocabulary ui.js already uses (`.empty-state`, `.alert`, `.btn`, `.spinner`,
// `.progress`, `.skeleton`, `.badge`, `.error`).
//
// MODULE CONTRACT
//   responsibility  render the four shared states — loading, empty, error with
//                   retry, inline validation — plus the three honesty states
//                   (abstention, unassessed, capability-not-available) and the
//                   destructive-action confirmation, all through one door.
//   inputs          renderState(host, kind, options)
//   outputs         the state node, mounted inside `host`; null when there is
//                   no usable host or the kind is unknown. renderState
//                   replaces the host's children itself, so a page writes
//                   `renderState(host, 'loading')` and nothing more.
//   dependencies    frontend/js/ui.js (escapeHtml, errorMessage, icon) and
//                   frontend/css/{tokens,base,components}.css. No fetch, no
//                   auth, no other component. No new npm dependency.
//   test            rendered in a real browser and screenshotted (see
//                   docs/UX-COPY.md); `node --check` runs inside `npm run lint`.
//
// THE HONESTY RULES, ENCODED AS DEFAULT BEHAVIOUR
//   1. unassessed is not weak. The `unassessed` state prints no number, no
//      bar, no level and no judgement — it says nothing was measured yet.
//   2. a missing capability is not a failure. `unavailable` names what is
//      missing and what still works; it is never a stack trace and never a
//      fake success. `abstain` is the model correctly declining to answer for
//      lack of source material, so it is a status, never an alert.
//   3. nothing is fabricated. Loading shows a spinner and, when asked, an
//      indeterminate bar — never an invented percentage. Dates, counts,
//      masteries and confirmations come from the server; this module only
//      repeats what it is handed.
//   4. a retry is offered only when retrying can help. An action that already
//      completed (409 QUIZ_ALREADY_ANSWERED, 409 ONBOARDING_COMPLETE) gets no
//      retry button and no red error styling — it gets the stored result.
//
// DOM SHAPES (two, both from components.css)
//   .empty-state      every content state: loading, empty, no-results, error,
//                     abstain, unassessed, unavailable. One skeleton —
//                     icon, optional eyebrow, a REAL heading (h2–h4, default
//                     h3 so it sits under a panel's <h2 class="panel-title">),
//                     one body sentence, optional extras, optional actions.
//   .alert / .error   the prompts: `confirm` (.alert-warn, two buttons) and
//                     form-level `validation` (.alert-danger). Field-level
//                     validation is a single <p class="error"> wired to its
//                     input through aria-describedby.
//
// ARIA RULES
//   role="status"   loading · abstain · unavailable · confirm  (polite)
//   role="alert"    error · form-level validation             (assertive)
//   no live role    empty · no-results · unassessed — ordinary content with a
//                   real heading. The change is announced once through the
//                   page's live region instead, so nothing is said twice.
//
// FOCUS RULE (never steals focus)
//   Rendering a state moves focus only when focus is about to be LOST: if
//   document.activeElement was inside the host the state replaced, focus moves
//   to the state's first control. For `confirm` that first control is the safe
//   button, so pressing Enter cannot destroy anything. Pass `focus: true` to
//   move focus deliberately (e.g. after a failed submit) or `focus: false` to
//   never move it.
//
// MOUNTING NOTE (A30's finding, restated): render into a PAGE-PREFIXED hook
// (`data-library-states`, `data-quiz-states`, …). Never a bare
// `[data-content]` — components/shell.js owns that one and writing into it
// erases the shell's <main>.
// =============================================================================

import { escapeHtml, errorMessage, icon } from '../ui.js';

/* ------------------------------------------------------------------- kinds */

// `icon` is the default glyph, `live` the live role the block itself carries,
// `tone` the components.css treatment (`error` = the red .is-error variant).
const KINDS = {
  loading: { icon: null, live: 'status' },
  empty: { icon: 'inbox', live: null },
  'no-results': { icon: 'search', live: null },
  error: { icon: 'alert', live: 'alert', tone: 'error' },
  abstain: { icon: 'info', live: 'status' },
  unassessed: { icon: 'spark', live: null },
  unavailable: { icon: 'info', live: 'status' },
  confirm: { icon: 'alert', live: 'status' },
  validation: { icon: 'alert', live: null },
};

/* ------------------------------------------------------------- error copy */

// Codes that are real on the wire — docs/API_CONTRACT.md, plus the Wave-4
// routes and api.js — but that ui.js#errorMessage does not list yet. ui.js
// stays the single source for the contract codes; this is the extension until
// A02 folds them into CODE_FALLBACKS (see docs/HANDOFF.md).
const EXTRA_CODE_COPY = {
  FETCH_FAILED: 'That link could not be fetched. Check the address, or paste the page text instead.',
  NO_TRANSCRIPT: 'That video has no captions to read, so there is nothing to study from it. Try a video with subtitles.',
  OCR_FAILED: 'That image could not be read into text. Try a clearer photo with even light.',
  OCR_TIMEOUT: 'Reading this image took too long and was stopped part-way through. Try a smaller, clearer photo.',
  OCR_UNAVAILABLE: 'Reading text from an image is not part of this build yet. Add a PDF, Word, PowerPoint or web page instead.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  CONFLICT: 'That was already submitted.',
  UPSTREAM_ERROR: 'The server sent an empty answer, so nothing was saved. Try again.',
  VECTOR_DIMENSION_MISMATCH: 'The search index was built by a different model and needs rebuilding. Ask whoever runs the server to run npm run reindex.',
};

// A short heading per code, so a block never leads with a raw sentence.
const ERROR_TITLES = {
  CONFLICT: 'That was already submitted',
  EMPTY_CONTENT: 'No text could be read from that file',
  FETCH_FAILED: 'That link could not be fetched',
  FILE_TOO_LARGE: 'That file is too large',
  INVALID_URL: 'That is not a web address',
  NETWORK_ERROR: 'Cannot reach the server',
  NIM_ERROR: 'The AI service failed',
  NIM_TIMEOUT: 'The AI service took too long',
  NO_TRANSCRIPT: 'That video has no captions',
  OCR_FAILED: 'That image could not be read',
  OCR_TIMEOUT: 'Reading that image took too long',
  RATE_LIMITED: 'Too many attempts',
  SOURCE_NOT_FOUND: 'That material is gone',
  STORAGE_FETCH_FAILED: 'That upload could not be read back',
  UNSUPPORTED_FILE: 'That file type is not supported',
  UPSTREAM_ERROR: 'The server sent an empty answer',
  UNAUTHENTICATED: 'Your session ended',
  VALIDATION_ERROR: 'That was not accepted',
  VECTOR_DIMENSION_MISMATCH: 'The search index needs rebuilding',
};

// An action that already completed must never offer "try again": a second
// submit would double-record it. These render as neutral information carrying
// the stored result, not as a red error block.
const ALREADY_DONE_TITLES = {
  ONBOARDING_COMPLETE: 'The intro interview is finished',
  QUIZ_ALREADY_ANSWERED: 'Already submitted',
};
const NO_RETRY_CODES = new Set(Object.keys(ALREADY_DONE_TITLES));

/** The one 401 action: sign in again, back to the page that failed. */
function signInAction() {
  let next = '/';
  try {
    const { pathname, search } = window.location;
    next = `${pathname}${search}` || '/';
    // Site-relative only: a scheme-relative "//evil.example.com" would turn
    // this button into an open redirect.
    if (!/^\/[^/\\]/.test(next)) next = '/';
  } catch {
    next = '/';
  }
  return { label: 'Sign in again', href: `login.html?next=${encodeURIComponent(next)}` };
}

/* ------------------------------------------------------------ text safety */

/** Any value → one readable line (collapses whitespace, drops newlines). */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

const MESSAGE_LIMIT = 300;

/**
 * Server messages are written for people, but a proxy 502 or a body-parser
 * failure can still hand us a multi-line blob. Collapse it and cap the length
 * so a stack trace can never reach the screen.
 */
function readableText(value) {
  const text = oneLine(value);
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

/**
 * One sentence a student can act on: the server's own message when it has one
 * (it is the specific, plain explanation), then ui.js#errorMessage's
 * contract-code table, then this module's extension map. Never a stack trace.
 */
export function stateMessage(error) {
  const own = readableText(error && error.message);
  if (own) return own;
  const code = error && error.code;
  if (code && EXTRA_CODE_COPY[code]) return EXTRA_CODE_COPY[code];
  return errorMessage(error);
}

/** The short heading for an error, by code. */
function errorTitle(error) {
  const code = error && error.code;
  if (code && ERROR_TITLES[code]) return ERROR_TITLES[code];
  if (code && ALREADY_DONE_TITLES[code]) return ALREADY_DONE_TITLES[code];
  return 'That did not work';
}

/**
 * The unassessed chip, for a row inside a list. Four pages render this same
 * sentence; it lives here so it can never drift. A topic with no graded
 * evidence is NEVER level 1, never 0% and never "needs work".
 */
export function unassessedBadge(label = 'Not assessed yet') {
  const title = 'No graded answers yet — this topic has not been measured.';
  return `<span class="badge" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

/* ----------------------------------------------------------- live regions */

// One polite region, created once and shared, exactly like ui.js#toastRegion.
// A page that already owns a live element passes it as `announceTo` instead.
const LIVE_ATTR = 'data-states-live';

function ownLiveRegion() {
  if (typeof document === 'undefined' || !document.body) return null;
  let region = document.querySelector(`[${LIVE_ATTR}]`);
  if (!region) {
    region = document.createElement('p');
    region.className = 'sr-only';
    region.setAttribute(LIVE_ATTR, '');
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

/**
 * Write one sentence to the live region. The text is replaced (not appended)
 * so a fast sequence of state changes still reads as one message.
 */
function announce(message, { target = null, assertive = false } = {}) {
  const text = readableText(message);
  if (!text || typeof document === 'undefined') return;
  const region = (target && target.isConnected) ? target : ownLiveRegion();
  if (!region) return;
  if (assertive) region.setAttribute('aria-live', 'assertive');
  region.textContent = text;
}

/* ------------------------------------------------------------------ focus */

/** Focusable descendants of `root`, in DOM order, skipping hidden controls. */
function focusablesIn(root) {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]),'
    + ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(selector)).filter((el) => el.tabIndex >= 0 && !el.hidden);
}

/**
 * The only two ways focus moves:
 *   focus: true  → deliberately move it to the state's first control;
 *   focus: false → never move it;
 *   default      → move it only if it was about to be stranded inside the host
 *                  the state replaced, so Tab order stays continuous.
 */
function moveFocus(host, node, option, stranded) {
  if (option === false || typeof document === 'undefined') return;
  const shouldMove = option === true || stranded;
  if (!shouldMove) return;
  const target = focusablesIn(node)[0];
  if (target) {
    target.focus();
    return;
  }
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.focus();
}

/* -------------------------------------------------------------- rendering */

/* One action shape for every kind, so no page ever builds markup by hand:
     { label, href }             → <a class="btn …">
     { label, onClick }          → <button type="button">
     { label, variant: 'danger' }→ the destructive button
   The default variant is secondary (the same look as ui.js#errorState's
   retry), so a caller opts INTO emphasis rather than getting it by accident. */
function buttonsMarkup(actions = []) {
  const items = Array.isArray(actions) ? actions : [];
  return items.map((action, index) => {
    if (!action || !action.label) return '';
    const label = escapeHtml(action.label);
    const variant = action.danger ? 'danger' : (action.variant || 'secondary');
    const classes = ['btn', `btn-${variant}`, 'btn-sm'].join(' ');
    if (action.href) return `<a class="${classes}" href="${escapeHtml(action.href)}">${label}</a>`;
    return `<button class="${classes}" type="button" data-state-action="${index}">${label}</button>`;
  }).join('');
}

/** Actions for a content state (.empty-state-actions row). */
function actionMarkup(actions = []) {
  const buttons = buttonsMarkup(actions);
  return buttons ? `<div class="empty-state-actions">${buttons}</div>` : '';
}

function wireActions(node, actions = []) {
  const items = Array.isArray(actions) ? actions : [];
  items.forEach((action, index) => {
    if (!action || action.href || typeof action.onClick !== 'function') return;
    const button = node.querySelector(`[data-state-action="${index}"]`);
    if (button) button.addEventListener('click', () => action.onClick());
  });
}

/** A real heading for the state, level 2–4 (default 3: inside a panel body). */
function headingMarkup(title, level) {
  if (!title) return '';
  const depth = Math.min(4, Math.max(2, Number(level) || 3));
  return `<h${depth} class="empty-state-title">${escapeHtml(title)}</h${depth}>`;
}

/* --------------------------------------------------------- the renderer */

/**
 * Render one state into `host`, replacing whatever is inside it.
 *
 * @param {HTMLElement|null} host where the state goes (a page-prefixed hook)
 * @param {string} kind loading | empty | no-results | error | abstain |
 *                      unassessed | unavailable | confirm | validation
 * @param {object} [options]
 * @param {string}  [options.title]     heading text (kind default if omitted).
 *                                      For `loading` this is the spinner's
 *                                      visible label — loading is a status,
 *                                      so it carries no heading of its own.
 * @param {string}  [options.body]      one plain sentence (escaped here)
 * @param {string}  [options.bodyHtml]  already-safe markup — e.g. the output
 *                                      of ui.js#markdownLite for model text.
 *                                      Never pass raw text to this.
 * @param {Array}   [options.actions]   [{ label, href, variant } |
 *                                       { label, onClick, variant|danger }]
 * @param {Error}   [options.error]     the caught error (kind: 'error')
 * @param {Function}[options.retry]     retry callback (kind: 'error')
 * @param {number}  [options.lines]     skeleton bars (kind: 'loading')
 * @param {boolean} [options.progress]  indeterminate bar (kind: 'loading')
 * @param {string}  [options.endpoint]  the route a capability waits on
 * @param {Array}   [options.suggestions] real topics from the student's own
 *                                       material (kind: 'abstain')
 * @param {Function}[options.onSuggestion] called with the chosen topic
 * @param {HTMLElement} [options.announceTo] a page-owned live region
 * @param {HTMLElement} [options.field] the input a validation message is for
 * @param {string}  [options.message]   the validation sentence
 * @param {boolean|'auto'} [options.focus] see the focus rule above
 * @param {number}  [options.level]     heading level 2–4 (default 3)
 * @returns {HTMLElement|null} the state node, or null when there is no host,
 *          the kind is unknown, or a validation message was cleared.
 */
export function renderState(host, kind, options = {}) {
  if (!host || typeof host.replaceChildren !== 'function') return null;
  if (typeof document === 'undefined') return null;

  const spec = KINDS[kind];
  if (!spec) return null; // an unknown kind is a bug, not a state: leave the page alone

  const opts = options && typeof options === 'object' ? options : {};
  // Capture focus BEFORE the host is emptied: removing the element that holds
  // focus resets activeElement to <body>, which would make the check below
  // believe nothing was stranded and drop a keyboard user at the page top.
  const stranded = Boolean(
    typeof document !== 'undefined'
    && document.activeElement
    && document.activeElement !== document.body
    && host.contains(document.activeElement),
  );

  const node = kind === 'confirm'
    ? renderConfirm(spec, opts)
    : (kind === 'validation' ? renderValidation(spec, opts) : renderBlock(spec, kind, opts));

  if (!node) {
    // A cleared field error: empty the host and drop the busy hook.
    host.replaceChildren();
    host.removeAttribute('aria-busy');
    return null;
  }

  host.replaceChildren(node);
  // `data-state` lives on the STATE BLOCK, never on the host: two elements
  // carrying the same attribute makes a state impossible to query reliably.
  if (kind === 'loading') host.setAttribute('aria-busy', 'true');
  else host.removeAttribute('aria-busy');

  moveFocus(host, node, opts.focus, stranded);

  // Exactly one announcement per state change: either the block announces
  // itself (it carries a live role) or the live region does — never both.
  if (!spec.live && opts.announce !== false) {
    announce([opts.title, opts.body].filter(Boolean).join('. '), {
      target: opts.announceTo,
      assertive: kind === 'validation' && !opts.field,
    });
  }
  return node;
}

/* ------------------------------------------------------------- .empty-state */

function renderBlock(spec, kind, opts) {
  const error = kind === 'error' ? opts.error : null;
  const code = error && error.code;
  const alreadyDone = Boolean(code && ALREADY_DONE_TITLES[code]);

  const title = opts.title
    || (kind === 'error' ? errorTitle(error) : defaultTitle(kind));
  const body = opts.body
    || (kind === 'error' ? stateMessage(error) : '');
  const tone = opts.tone || spec.tone;
  const neutral = alreadyDone || tone === 'info';
  const live = opts.live || (neutral ? 'status' : spec.live);

  const node = document.createElement('div');
  node.className = neutral ? 'empty-state' : 'empty-state is-error';
  node.setAttribute('data-state', kind);
  if (live) node.setAttribute('role', live);

  const parts = [];
  if (kind === 'loading') {
    // The one state with no heading: it is a status, not content, and it is
    // replaced within a moment. The labelled spinner IS the announcement.
    parts.push(`<div class="cluster-2">
      <span class="spinner" aria-hidden="true"></span>
      <span class="text-sm">${escapeHtml(title || 'Loading…')}</span>
    </div>`);
    if (body) parts.push(`<p class="empty-state-text">${escapeHtml(body)}</p>`);
  } else {
    if (spec.icon && opts.icon !== null) {
      parts.push(`<span class="empty-state-icon" aria-hidden="true">${icon(spec.icon, { size: 22 })}</span>`);
    }
    if (opts.kicker) parts.push(`<p class="eyebrow">${escapeHtml(opts.kicker)}</p>`);
    parts.push(headingMarkup(title, opts.level));
    if (opts.bodyHtml) parts.push(opts.bodyHtml);
    else if (body) parts.push(`<p class="empty-state-text">${escapeHtml(body)}</p>`);
  }

  if (opts.endpoint) {
    parts.push(`<p class="text-xs muted">Waiting on <span class="mono">${escapeHtml(opts.endpoint)}</span></p>`);
  }
  if (code && opts.code !== false && code !== 'INTERNAL') {
    parts.push(`<p class="text-xs mono muted">${escapeHtml(code)}</p>`);
  }

  parts.push(extrasMarkup(kind, opts));

  const actions = Array.isArray(opts.actions) ? opts.actions : defaultActions(kind, opts, code);
  parts.push(actionMarkup(actions));
  node.innerHTML = parts.join('');

  wireActions(node, actions);
  if (opts.onSuggestion) wireSuggestions(node, opts.onSuggestion);
  return node;
}

/**
 * The built-in actions, when the caller passes none. The retry button is
 * offered only when retrying can actually help — an action that already
 * completed gets the stored result instead of a second submit.
 */
function defaultActions(kind, opts, code) {
  if (kind !== 'error' || typeof opts.retry !== 'function') return [];
  if (code && NO_RETRY_CODES.has(code)) return [];
  return [{ label: 'Try again', onClick: opts.retry }];
}

/** Loading extras: placeholder bars (never the announcement) + progress. */
function extrasMarkup(kind, opts) {
  if (kind !== 'loading') return '';
  const lines = Math.max(0, Math.min(20, Math.floor(Number(opts.lines) || 0)));
  const skeleton = lines > 0
    ? `<div class="stack-2" aria-hidden="true">${
      Array.from({ length: lines }, () => '<span class="skeleton skeleton-text"></span>').join('')
    }</div>`
    : '';
  const bar = opts.progress
    ? `<div class="progress is-indeterminate" role="progressbar" aria-label="${escapeHtml(opts.progressLabel || 'Working')}"></div>`
    : '';
  return skeleton + bar;
}

/** Topic chips drawn from the student's OWN material (kind: 'abstain'). */
function suggestionsMarkup(topics) {
  const items = (Array.isArray(topics) ? topics : [])
    .filter((topic) => typeof topic === 'string' && topic.trim() !== '')
    .slice(0, 4)
    .map((topic) => `<button type="button" class="chip" data-state-suggestion="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`);
  if (items.length === 0) return '';
  return `<div class="cluster-2">${items.join('')}</div>`;
}

function wireSuggestions(node, onSuggestion) {
  node.querySelectorAll('[data-state-suggestion]').forEach((chip) => {
    chip.addEventListener('click', () => onSuggestion(chip.getAttribute('data-state-suggestion') || ''));
  });
}

function defaultTitle(kind) {
  return {
    empty: 'Nothing here yet',
    'no-results': 'No results',
    abstain: 'Not covered by your material',
    unassessed: 'Not assessed yet',
    unavailable: 'Not available yet',
    confirm: 'Are you sure?',
  }[kind] || '';
}

/* -------------------------------------------------- prompts: .alert blocks */

/**
 * A destructive-action confirmation. The SAFE button is first in the DOM, so
 * the focus rule above lands on it and Enter cannot destroy anything. Both
 * buttons are labelled with the action, never "OK"/"Cancel" (ux-copy).
 *
 * opts.title        the question, naming the thing ("Delete this deck?")
 * opts.body         the consequence, in one sentence ("This removes the 12
 *                   cards. Your material and sessions are kept.")
 * opts.safe         { label, onClick } — default "Keep it", which just closes
 *                   the confirmation when no handler is given.
 * opts.destructive  { label, onClick, danger: true } — required; without a
 *                   handler the button does nothing rather than deleting.
 */
function renderConfirm(spec, opts) {
  const node = document.createElement('div');
  node.className = 'alert alert-warn';
  node.setAttribute('data-state', 'confirm');
  node.setAttribute('role', 'status');

  const title = opts.title || 'Are you sure?';
  const safe = Object.assign(
    { label: 'Keep it', onClick: () => node.remove() },
    opts.safe,
  );
  const destructive = Object.assign({ label: 'Delete', danger: true }, opts.destructive);
  const actions = [safe, destructive].filter((action) => action && action.label);

  node.innerHTML = `${icon('alert', { size: 16 })}<div class="stack-2">
    ${headingMarkup(title, opts.level)}
    ${opts.body ? `<p>${escapeHtml(opts.body)}</p>` : ''}
    <div class="cluster-2">${buttonsMarkup(actions)}</div>
  </div>`;

  wireActions(node, actions);
  return node;
}

/**
 * Validation, two shapes behind one door:
 *   with `field` → <p class="error"> associated through aria-describedby, so
 *                  it is read when the field takes focus. `message: ''`
 *                  clears the association again.
 *   without      → <div class="alert alert-danger" role="alert">, for a
 *                  failure that belongs to the whole form.
 */
function renderValidation(spec, opts) {
  const message = opts.message === '' || opts.message == null ? '' : readableText(opts.message);
  const field = opts.field;

  if (field && typeof field.setAttribute === 'function') {
    if (!message) {
      clearFieldError(field);
      return null;
    }
    const node = document.createElement('p');
    node.className = 'error';
    node.setAttribute('data-state', 'validation');
    const id = field.id ? `${field.id}-error` : `state-error-${Math.random().toString(36).slice(2, 8)}`;
    node.id = id;
    node.textContent = message; // textContent: no markup can come from a message
    associateField(field, id);
    return node;
  }

  const node = document.createElement('div');
  node.className = 'alert alert-danger';
  node.setAttribute('data-state', 'validation');
  node.setAttribute('role', 'alert');
  node.innerHTML = `${icon('alert', { size: 16 })}<div>${escapeHtml(message || 'That was not accepted.')}</div>`;
  return node;
}

/** Show (or, with an empty message, clear) one field's error. */
export function fieldError(field, message, { host } = {}) {
  if (!field || typeof field.setAttribute !== 'function') return null;
  const target = host || field.closest('.field') || field.parentElement;
  if (!target) return null;
  return renderState(target, 'validation', { message, field });
}

/** Point the field at its error node, keeping any other described-by ids. */
function associateField(field, errorId) {
  const existing = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  const merged = existing.includes(errorId) ? existing : [...existing, errorId];
  field.setAttribute('aria-describedby', merged.join(' '));
  field.setAttribute('aria-invalid', 'true');
}

/** Remove the association, so a field the student fixed is no longer invalid. */
function clearFieldError(field) {
  const existing = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  const kept = existing.filter((id) => !id.endsWith('-error') && !id.startsWith('state-error-'));
  if (kept.length > 0) field.setAttribute('aria-describedby', kept.join(' '));
  else field.removeAttribute('aria-describedby');
  field.removeAttribute('aria-invalid');
}
