/* =============================================================================
   panel.js — the floating briefing panel for the Socius AI Study Highlighter.
   =============================================================================

   Responsibility (one job):
     Show a grounded briefing for the passage a student selected on a web page:
     the tutor's answer, the exact stored citations behind it, and a way to
     continue in the app. Nothing else.

   Interface (do not change without telling highlight.js's owner — A41):
     window.SociusPanel = {
       open(payload),   // payload: { anchorRect, text, citation?, excerpt? }
       close(),         // Escape, outside click, scroll, resize, or programmatic
       isOpen(),
     }
     `citation` is the real citation the /relevance scan matched for this
     passage; it is server data and is rendered first, never invented.

   How it talks to the server:
     Only through the background service worker (extension/background.js):
       { type: 'briefing', text, sourceIds? }
         → { ok: true,  answer, citations, needsContent, model }
         → { ok: false, error: { code, message } }
       { type: 'openSite' } → opens the app (carrying the session handoff)
     The panel never sees or stores a token: the worker owns the session.

   Honesty rules (docs/API_CONTRACT.md + AGENTS.md), enforced here:
     · Citations come from the response ONLY. The panel never builds a title,
       page, slide, timestamp or excerpt of its own, and renders every field
       exactly as stored. No citations → a plain "no passages" note, never an
       empty box.
     · needsContent: true renders the server's abstain message as-is, with the
       real suggested topics (never a made-up answer).
     · Signed out → the sign-in affordance. Unreachable → a plain network
       message. Loading → a real busy state. A model failure → the server's
       message. No state ever fabricates an answer.
     · No token or key is ever written into the DOM.

   Host-page safety:
     Everything renders inside ONE shadow-root host. The host is
     `position: fixed` with `all: initial` and the highest-safe z-index, so no
     page stylesheet can reach inside it and no page z-index can bury it.
     Every id/class is namespaced `soc-panel-…`; the host attribute is
     `data-soc-panel-host` (see docs/HANDOFF.md — highlight.js's skip guard
     references it). Nothing is added to the page's global scope except
     `window.SociusPanel`, and the four window listeners are removed on close.

   This is a NON-modal dialog: it never traps focus. Escape closes it and
   focus returns to whatever the student last focused before it opened.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  const PANEL_WIDTH = 380;           // desktop width of the floating panel
  const SMALL_VIEWPORT = 420;        // below this the panel goes near-full width
  const MARGIN = 12;                 // minimum distance from the viewport edges
  const GAP = 10;                    // distance from the selected passage
  const MAX_TEXT = 1500;             // server cap for POST /api/extension/briefing
  const MIN_BRIEFING_CHARS = 60;     // server floor for the same endpoint
  const RESPONSE_TIMEOUT_MS = 20000; // worker's own timeout is 15s; a little slack
  const HOST_ATTRIBUTE = 'data-soc-panel-host';
  const RELOAD_MESSAGE = 'Extension was reloaded \u2014 refresh the page.';
  const SHORT_PASSAGE_MESSAGE =
    'This passage is too short for a briefing. Click a longer highlighted passage.';
  const DEFAULT_ABSTAIN_MESSAGE =
    'Not in your study materials yet \u2014 add materials on this topic in Socius AI to get a grounded briefing.';
  const NO_CITATIONS_NOTE = 'No passages were retrieved for this answer.';
  const NO_EXCERPT_NOTE = 'No excerpt was stored for this passage.';

  // Plain sentences for the API's stable codes, used only when the response
  // carries no message of its own (mirrors frontend/js/ui.js#CODE_FALLBACKS).
  const ERROR_FALLBACKS = {
    NETWORK_ERROR: 'Could not reach the Socius AI server. Check that it is running, then try again.',
    UNAUTHENTICATED: 'Sign in to Socius AI to get a briefing for this passage.',
    HTTP_401: 'Sign in to Socius AI to get a briefing for this passage.',
    VALIDATION_ERROR: 'That passage could not be sent.',
    NIM_ERROR: 'The AI service failed to respond. Please try again.',
    NIM_TIMEOUT: 'The AI service took too long to respond. Please try again.',
    CHROMA_UNAVAILABLE: 'The search index is unavailable right now. Please try again shortly.',
  };

  // Error codes that mean "the student is not signed in" — the background
  // worker returns exactly these (UNAUTHENTICATED, or HTTP_401 from a proxy).
  const AUTH_ERROR_CODES = ['UNAUTHENTICATED', 'HTTP_401'];

  // Popover (top layer) support — Chrome 114+, Firefox 125+.
  const SUPPORTS_TOP_LAYER =
    typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

  /* ------------------------------------------------------------------ state */

  const state = {
    host: null,
    shadow: null,
    panel: null,
    body: null,
    live: null,
    open: false,
    payload: null,
    lastMessage: null, // what Retry re-sends
    seq: 0,            // guards a response arriving after a newer request/close
    timer: 0,
    raf: 0,
    listeners: false,
    lastFocus: null,   // where focus returns to on close
  };

  /* ----------------------------------------------------------------- styles

     All of this lives inside the shadow root, so it can only ever reach the
     panel itself. The palette matches the app (frontend/css/tokens.css). */

  const STYLES = `
    :host {
      --ink: #101418;
      --ink-2: #39424E;
      --ink-3: #6B7480;
      --paper: #FFFFFF;
      --canvas: #F4F6F8;
      --canvas-2: #EAEDF1;
      --line: #DEE2E8;
      --line-strong: #C4CAD3;
      --blue: #1D4ED8;
      --blue-hover: #1740B4;
      --blue-ink: #14307F;
      --blue-soft: #E9EFFD;
      --blue-line: #C3D2F7;
      --red-soft: #FCEBEA;
      --red-ink: #7A1B15;
      --font-sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-serif: "IBM Plex Serif", Georgia, "Times New Roman", serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .panel {
      position: fixed;
      width: 380px;
      max-width: calc(100vw - 24px);
      max-height: 60vh;
      display: flex;
      flex-direction: column;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(16, 20, 24, 0.09);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.6;
      color: var(--ink);
    }

    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }
    .brand { display: flex; align-items: center; gap: 8px; flex: none; }
    .brand-mark { display: block; }
    .soc-panel-heading {
      margin: 0;
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      flex: 1;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--ink);
    }
    .brand-tag { font-size: 11px; font-weight: 400; color: var(--ink-3); }
    .close {
      flex: none;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: none;
      color: var(--ink-2);
      font-family: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .close:hover { background: var(--canvas-2); color: var(--ink); }

    .body {
      padding: 16px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .body p { margin: 0 0 10px; }
    .body p:last-child { margin-bottom: 0; }
    .body ul { margin: 0 0 10px; padding-left: 20px; }
    .body li { margin: 0 0 4px; }
    .body li:last-child { margin-bottom: 0; }

    .answer { font-size: 14px; }
    .answer blockquote { margin: 0; }

    .note { font-size: 12px; color: var(--ink-3); }

    /* Visually hidden, announced by screen readers. */
    .soc-panel-live {
      position: absolute;
      width: 1px; height: 1px;
      margin: -1px; padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    .loading-row { display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--ink-3); }
    .spinner {
      flex: none;
      width: 15px;
      height: 15px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: soc-panel-spin 700ms linear infinite;
    }
    @keyframes soc-panel-spin { to { transform: rotate(360deg); } }

    .state-block { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
    .banner {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      width: 100%;
      padding: 12px 16px;
      border: 1px solid var(--line);
      border-left-width: 3px;
      border-radius: 5px;
      background: var(--paper);
      font-size: 14px;
      line-height: 1.45;
    }
    .banner svg { flex: none; margin-top: 2px; }
    .banner-info { background: var(--blue-soft); border-color: var(--blue-line); border-left-color: var(--blue); color: var(--blue-ink); }
    .banner-error { background: var(--red-soft); border-color: #F1C4C1; border-left-color: #B3261E; color: var(--red-ink); }

    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 40px;
      padding: 0 16px;
      border: 1px solid transparent;
      border-radius: 5px;
      background: none;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease;
    }
    .btn-primary { background: var(--blue); color: #fff; }
    .btn-primary:hover { background: var(--blue-hover); }
    .btn-secondary { background: var(--paper); color: var(--ink); border-color: var(--line-strong); }
    .btn-secondary:hover { background: var(--canvas); }

    .citations { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; }
    .citation {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 4px 8px;
      background: var(--paper);
      border: 1px solid var(--line-strong);
      border-radius: 3px;
      font-family: inherit;
      font-size: 12px;
      color: var(--ink-2);
      cursor: pointer;
      text-align: left;
      transition: border-color 120ms ease, background-color 120ms ease;
    }
    .citation:hover { border-color: var(--blue); background: var(--blue-soft); }
    .citation[aria-expanded="true"] { border-color: var(--blue); background: var(--blue-soft); color: var(--blue-ink); }
    .citation svg { flex: none; color: var(--ink-3); }
    .citation-title { font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 22ch; }
    .citation-loc { color: var(--ink-3); white-space: nowrap; }
    .citation-detail {
      flex-basis: 100%;
      padding: 12px;
      background: var(--canvas);
      border: 1px solid var(--line);
      border-radius: 5px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--ink-2);
    }
    .citation-detail blockquote {
      margin: 0 0 8px;
      padding-left: 12px;
      border-left: 2px solid var(--line-strong);
      font-family: var(--font-serif);
      font-size: 14px;
      color: var(--ink);
    }
    .citation-detail p { margin: 0; font-size: 12px; }
    .citation-detail a { color: var(--blue); }

    .suggestions { display: flex; flex-direction: column; gap: 6px; width: 100%; }
    .suggestions-label { font-size: 12px; font-weight: 600; color: var(--blue-ink); }
    .suggestion-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .suggestion {
      max-width: 100%;
      padding: 3px 8px;
      background: var(--paper);
      border: 1px solid var(--blue-line);
      border-radius: 3px;
      font-family: inherit;
      font-size: 12px;
      color: var(--ink-2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .foot {
      position: sticky;
      bottom: 0;
      flex: none;
      padding: 12px 16px;
      border-top: 1px solid var(--line);
      background: var(--paper);
    }
    .foot .btn { width: 100%; }

    :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

    @media (prefers-reduced-motion: reduce) {
      .spinner { animation: none; }
      .btn, .close, .citation { transition: none; }
    }
  `;

  /* -------------------------------------------------------------- shell DOM */

  const SHELL =
    '<section class="panel" role="dialog" aria-modal="false" aria-labelledby="soc-panel-heading" tabindex="-1">' +
    '<header class="head">' +
    '<span class="brand"></span>' +
    '<h2 class="soc-panel-heading" id="soc-panel-heading">' +
    '<span class="brand-name">Socius AI</span>' +
    '<span class="brand-tag">Briefing</span>' +
    '</h2>' +
    '<button type="button" class="close" aria-label="Close briefing">\u2715</button>' +
    '</header>' +
    '<div class="body" data-body></div>' +
    '<p class="soc-panel-live" role="status" aria-live="polite"></p>' +
    '<footer class="foot">' +
    '<button type="button" class="btn btn-primary" data-open-site>Open Socius AI</button>' +
    '</footer>' +
    '</section>';

  /* ------------------------------------------------------------------ icons */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const FILE_SHAPES = [
    ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z' }],
    ['path', { d: 'M14 3v5h5' }],
  ];
  const DOC_SHAPES = [
    ...FILE_SHAPES,
    ['path', { d: 'M9 13h6' }],
    ['path', { d: 'M9 16.5h6' }],
  ];
  const SLIDES_SHAPES = [
    ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 1.5 }],
    ['path', { d: 'M8 20h8' }],
    ['path', { d: 'M12 16v4' }],
  ];
  const GLOBE_SHAPES = [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z' }],
  ];
  const VIDEO_SHAPES = [
    ['rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 3 }],
    ['path', { d: 'M10.2 9.3l4.6 2.7-4.6 2.7z' }],
  ];
  const IMAGE_SHAPES = [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ['circle', { cx: 8.5, cy: 9.5, r: 1.6 }],
    ['path', { d: 'M3 17.5l5-5 4 4 3-3 6 6' }],
  ];
  const CHEVRON_SHAPES = [['path', { d: 'M6 9l6 6 6-6' }]];
  const ALERT_SHAPES = [
    ['path', { d: 'M12 3.5L2.5 20h19z' }],
    ['path', { d: 'M12 9.5V14' }],
    ['path', { d: 'M12 17.2h.01' }],
  ];
  const INFO_SHAPES = [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 11v5' }],
    ['path', { d: 'M12 7.8h.01' }],
  ];

  // Icon per citation `type` (docs/API_CONTRACT.md: pdf | pptx | webpage |
  // docx | youtube | image). An unknown type falls back to the file glyph —
  // never a guessed source kind.
  const TYPE_SHAPES = {
    pdf: FILE_SHAPES,
    pptx: SLIDES_SHAPES,
    webpage: GLOBE_SHAPES,
    docx: DOC_SHAPES,
    youtube: VIDEO_SHAPES,
    image: IMAGE_SHAPES,
  };

  // Plain-English label per type, shown in the citation detail. ui.js uses the
  // same vocabulary on the study page.
  const TYPE_LABELS = {
    pdf: 'PDF',
    pptx: 'Slides',
    webpage: 'Web page',
    docx: 'Word document',
    youtube: 'Video',
    image: 'Image',
  };

  function svgIcon(shapes, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attributes] of shapes) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attributes)) {
        node.setAttribute(key, String(value));
      }
      svg.appendChild(node);
    }
    return svg;
  }

  function brandMark() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('brand-mark');
    const background = document.createElementNS(SVG_NS, 'rect');
    background.setAttribute('width', '14');
    background.setAttribute('height', '14');
    background.setAttribute('rx', '3');
    background.setAttribute('fill', '#1D4ED8');
    svg.appendChild(background);
    const pixels = [[2, 2, 10, 2], [2, 4, 2, 2], [2, 6, 10, 2], [10, 8, 2, 2], [2, 10, 10, 2]];
    for (const [x, y, width, height] of pixels) {
      const pixel = document.createElementNS(SVG_NS, 'rect');
      pixel.setAttribute('x', String(x));
      pixel.setAttribute('y', String(y));
      pixel.setAttribute('width', String(width));
      pixel.setAttribute('height', String(height));
      pixel.setAttribute('fill', '#FFFFFF');
      svg.appendChild(pixel);
    }
    return svg;
  }

  /* ------------------------------------------------------- small DOM helpers */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* ------------------------------------------------------------- host build */

  function buildHost() {
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, '');
    // Top layer when the browser supports it: a shown popover renders above
    // every page element regardless of z-index, so a hostile page cannot bury
    // the panel. Older browsers fall back to the fixed + near-max z-index path
    // below, which no ordinary page can beat.
    if (SUPPORTS_TOP_LAYER) host.setAttribute('popover', 'manual');
    // `all: initial` sheds any inherited page style (including the popover
    // user-agent rules); fixed positioning takes the host out of the page's
    // flow entirely, so the page layout cannot be affected; z-index is one
    // below the spec maximum. display is managed by showHost()/hideHost().
    host.setAttribute(
      'style',
      'all: initial; margin: 0; border: 0; padding: 0; overflow: visible;' +
      ' position: fixed; top: 0; left: 0; display: none; z-index: 2147483646;',
    );

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = SHELL;
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.insertBefore(style, shadow.firstChild);
    shadow.querySelector('.brand').appendChild(brandMark());

    state.host = host;
    state.shadow = shadow;
    state.panel = shadow.querySelector('.panel');
    state.body = shadow.querySelector('[data-body]');
    state.live = shadow.querySelector('.soc-panel-live');

    shadow.querySelector('.close').addEventListener('click', close);
    shadow.querySelector('[data-open-site]').addEventListener('click', onOpenSite);
    state.body.addEventListener('click', onBodyClick);
  }

  function ensureHost() {
    if (!state.host) buildHost();
    if (!state.host.isConnected) document.documentElement.appendChild(state.host);
  }

  // Make the host visible. On a top-layer browser the shown popover is above
  // all page content; otherwise the inline z-index carries it.
  function showHost() {
    if (SUPPORTS_TOP_LAYER) {
      try {
        state.host.showPopover();
      } catch (err) {
        // Popover refused (detached, unsupported) — the z-index path remains.
      }
    }
    state.host.style.display = 'block';
  }

  function hideHost() {
    if (SUPPORTS_TOP_LAYER) {
      try {
        state.host.hidePopover();
      } catch (err) {
        // Already detached or never shown — nothing to leave.
      }
    }
    state.host.style.display = 'none';
  }

  /* -------------------------------------------------------- runtime bridge */

  function runtimeAvailable() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (err) {
      return false;
    }
  }

  function readLastError() {
    try {
      return chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
    } catch (err) {
      return '';
    }
  }

  // An orphaned content script (extension reloaded/updated) reports these;
  // translate into one actionable sentence.
  function friendlyError(message) {
    return /Receiving end does not exist|Extension context invalidated/i.test(message)
      ? RELOAD_MESSAGE
      : message;
  }

  function sendToBackground(message, callback) {
    if (!runtimeAvailable()) {
      callback(RELOAD_MESSAGE);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = readLastError();
        if (err) {
          callback(friendlyError(err));
          return;
        }
        callback(null, response);
      });
    } catch (err) {
      callback(RELOAD_MESSAGE);
    }
  }

  /* ------------------------------------------------------------- announce */

  // One polite live region for the whole panel — the same contract the study
  // page uses (frontend/js/pages/study.js#announce).
  function announce(text) {
    if (state.live) state.live.textContent = text || '';
  }

  /* -------------------------------------------------------------- requests */

  function requestBriefing() {
    clearResponseTimer();
    const seq = ++state.seq;
    renderLoading();
    state.timer = setTimeout(() => {
      state.timer = 0;
      if (seq !== state.seq || !state.open) return;
      renderError('Socius AI did not answer in time. Try again.');
      announce('The briefing could not be loaded.');
    }, RESPONSE_TIMEOUT_MS);

    sendToBackground(state.lastMessage, (err, response) => {
      // A newer request (or a close) already replaced this one.
      if (seq !== state.seq || !state.open) return;
      clearResponseTimer();
      if (err) {
        renderError(err);
        announce('The briefing could not be loaded.');
        return;
      }
      if (!response) {
        renderError('Socius AI did not answer. Try again.');
        announce('The briefing could not be loaded.');
        return;
      }
      if (response.ok) renderSuccess(response);
      else {
        renderError(errorText(response.error));
        announce('The briefing could not be loaded.');
      }
    });
  }

  function clearResponseTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = 0;
    }
  }

  function onOpenSite() {
    sendToBackground({ type: 'openSite' }, (err) => {
      if (err) renderError(err);
    });
  }

  function isAuthError(error) {
    const code = error && error.code;
    return typeof code === 'string' && AUTH_ERROR_CODES.includes(code);
  }

  // The response's own message when present (the server writes these for
  // people), else a friendly sentence for its stable code.
  function errorText(error) {
    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    const code = error && error.code;
    if (code && ERROR_FALLBACKS[code]) return ERROR_FALLBACKS[code];
    return 'Something went wrong. Please try again.';
  }

  /* --------------------------------------------------------------- states */

  function setBusy(busy) {
    if (!state.panel) return;
    if (busy) state.panel.setAttribute('aria-busy', 'true');
    else state.panel.removeAttribute('aria-busy');
  }

  function renderLoading() {
    setBusy(true);
    const row = el('div', 'loading-row');
    const spinner = el('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    row.appendChild(spinner);
    row.appendChild(el('span', undefined, 'Asking Socius AI\u2026'));
    state.body.replaceChildren(row);
    schedulePlace();
  }

  // One banner + its action buttons. `kind` is 'banner-info' (not an error) or
  // 'banner-error'. The message is always shown verbatim.
  function bannerBlock(kind, message, actions) {
    const wrap = el('div', 'state-block');
    const banner = el('div', 'banner ' + kind);
    banner.appendChild(svgIcon(kind === 'banner-error' ? ALERT_SHAPES : INFO_SHAPES, 16));
    banner.appendChild(el('span', undefined, message));
    wrap.appendChild(banner);
    if (actions && actions.length > 0) {
      const row = el('div', 'actions');
      for (const action of actions) {
        const button = el('button', 'btn ' + (action.primary ? 'btn-primary' : 'btn-secondary'));
        button.type = 'button';
        button.textContent = action.label;
        button.setAttribute(action.attribute, '');
        row.appendChild(button);
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderError(message, error) {
    setBusy(false);
    const actions = [{ label: 'Try again', primary: false, attribute: 'data-retry' }];
    if (isAuthError(error)) {
      // The student is not signed in: say so and offer the sign-in link
      // (the app redirects to its sign-in page when there is no session).
      actions.unshift({ label: 'Sign in', primary: true, attribute: 'data-signin' });
    }
    state.body.replaceChildren(bannerBlock('banner-error', message, actions));
    schedulePlace();
  }

  function renderSuccess(data) {
    setBusy(false);

    if (data.needsContent === true) {
      // The tutor abstained: render its message exactly as written, plus the
      // real suggested topics. This is a distinct state, not an error.
      const topics = suggestionTopics(data.suggestions);
      const block = bannerBlock('banner-info', friendlyAbstain(data.answer), []);
      if (topics.length > 0) block.appendChild(suggestionsList(topics));
      state.body.replaceChildren(block);
      schedulePlace();
      announce('Socius AI has no material on that passage.');
      return;
    }

    const fragment = document.createDocumentFragment();
    const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
    if (answer) fragment.appendChild(answerBlocks(answer));
    else fragment.appendChild(el('p', 'note', 'Socius AI returned an empty answer. Try again.'));

    // Citations come from the response only. The relevance match that opened
    // the panel is prepended (it is the same stored data); duplicates of it in
    // the response are dropped so it is never shown twice.
    const citations = orderedCitations(data.citations);
    if (citations.length > 0) fragment.appendChild(citationsList(citations));
    else fragment.appendChild(el('p', 'note', NO_CITATIONS_NOTE));

    state.body.replaceChildren(fragment);
    schedulePlace();
    announce(citations.length > 0
      ? `Briefing ready, with ${citations.length} source ${citations.length === 1 ? 'passage' : 'passages'}.`
      : 'Briefing ready, with no source passages.');
  }

  /* -------------------------------------------------- answer text rendering

     Model prose is untrusted: everything goes in via textContent, so markup
     can never be injected. Only **bold**, bullet lines and paragraphs are
     given structure — the same restraint as frontend/js/ui.js#markdownLite. */

  function appendEmphasised(line, part) {
    // "**bold**" → <strong>; the rest is plain text.
    const pieces = part.split(/\*\*(.+?)\*\*/g);
    pieces.forEach((piece, index) => {
      if (!piece) return;
      if (index % 2 === 1) line.appendChild(el('strong', undefined, piece));
      else line.appendChild(document.createTextNode(piece));
    });
  }

  function answerBlocks(text) {
    const wrap = el('div', 'answer');
    let paragraph = null;
    let list = null;

    const flush = () => {
      paragraph = null;
      list = null;
    };

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        flush();
        continue;
      }
      const bullet = /^[-*\u2022]\s+(.*)$/.exec(line);
      if (bullet) {
        if (!list) {
          list = el('ul');
          wrap.appendChild(list);
        }
        const item = el('li');
        appendEmphasised(item, bullet[1]);
        list.appendChild(item);
        continue;
      }
      if (!paragraph) {
        paragraph = el('p');
        wrap.appendChild(paragraph);
      }
      if (paragraph.childNodes.length > 0) paragraph.appendChild(document.createTextNode(' '));
      appendEmphasised(paragraph, line);
    }
    flush();
    return wrap;
  }

  /* ---------------------------------------------------------- suggestions */

  // Topic chips shown when the tutor abstains. The panel has no question input
  // (briefings are triggered by highlighting, not typing), so these are
  // informational labels, not buttons — and only ever real topics the server
  // listed. An older backend without `suggestions` simply never reaches here.
  function friendlyAbstain(answer) {
    const text = String(answer || '').trim();
    return text || DEFAULT_ABSTAIN_MESSAGE;
  }

  function suggestionTopics(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((topic) => typeof topic === 'string' && topic.trim() !== '')
      .map((topic) => topic.trim())
      .slice(0, 4);
  }

  function suggestionsList(topics) {
    const wrap = el('div', 'suggestions');
    wrap.appendChild(el('span', 'suggestions-label', 'Your material covers these:'));
    const chips = el('div', 'suggestion-chips');
    for (const topic of topics) chips.appendChild(el('span', 'suggestion', topic));
    wrap.appendChild(chips);
    return wrap;
  }

  /* ------------------------------------------------------------- citations

     Every field below is read from the citation object the server sent —
     titles, locations, timestamps and excerpts are stored data, never model
     output, and each is rendered exactly as stored. */

  // "p. 12" / "slide 3" / "para. 4" / "at 00:01:31", from the citation's own
  // location object. Precedence matches server/services/retrieval.js#toCitation.
  function locationLabel(citation) {
    const location = citation && citation.location;
    if (!location || typeof location !== 'object') return '';
    if (location.page != null) return 'p. ' + location.page;
    if (location.slide != null) return 'slide ' + location.slide;
    if (location.timestamp != null) return 'at ' + location.timestamp;
    if (location.paragraph != null) return 'para. ' + location.paragraph;
    if (location.segment != null) return 'segment ' + location.segment;
    return '';
  }

  // Only http(s) links are ever rendered, so a stray scheme cannot get in
  // (same rule as frontend/js/ui.js#safeUrl).
  function safeUrl(value) {
    const url = typeof value === 'string' ? value.trim() : '';
    return /^https?:\/\//i.test(url) ? url : '';
  }

  function citationKey(citation) {
    const location = citation && citation.location ? JSON.stringify(citation.location) : '';
    const excerpt = typeof citation.excerpt === 'string' ? citation.excerpt.slice(0, 60) : '';
    return [citation.sourceId || '', location, excerpt].join('|');
  }

  function orderedCitations(list) {
    const result = [];
    const seen = new Set();
    const anchor = state.payload && state.payload.citation;
    if (anchor && typeof anchor === 'object') {
      seen.add(citationKey(anchor));
      result.push(anchor);
    }
    if (Array.isArray(list)) {
      for (const citation of list) {
        if (!citation || typeof citation !== 'object') continue;
        const key = citationKey(citation);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(citation);
      }
    }
    return result;
  }

  function citationsList(citations) {
    const list = el('div', 'citations');
    citations.forEach((citation, index) => {
      const id = 'soc-panel-cite-' + index;

      const chip = el('button', 'citation');
      chip.type = 'button';
      chip.setAttribute('aria-expanded', 'false');
      chip.setAttribute('aria-controls', id);
      chip.appendChild(svgIcon(TYPE_SHAPES[citation.type] || FILE_SHAPES, 13));
      chip.appendChild(el('span', 'citation-title', citation.title || 'Untitled source'));
      const location = locationLabel(citation);
      if (location) chip.appendChild(el('span', 'citation-loc', location));
      chip.appendChild(svgIcon(CHEVRON_SHAPES, 12));

      const detail = el('div', 'citation-detail');
      detail.id = id;
      detail.hidden = true;
      detail.appendChild(el(
        'blockquote',
        undefined,
        citation.excerpt ? citation.excerpt : NO_EXCERPT_NOTE,
      ));

      // Stored facts only: type label, section, match score, source link.
      const meta = el('p');
      const facts = [TYPE_LABELS[citation.type] || 'Source'];
      if (typeof citation.section === 'string' && citation.section.trim() !== '') {
        facts.push(citation.section.trim());
      }
      if (typeof citation.score === 'number' && Number.isFinite(citation.score)) {
        facts.push('match ' + Math.round(citation.score * 100) + '%');
      }
      meta.appendChild(document.createTextNode(facts.join(' \u00b7 ')));
      const url = safeUrl(citation.url);
      if (url) {
        meta.appendChild(document.createTextNode(' \u00b7 '));
        const link = el('a', undefined, 'Open source');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        meta.appendChild(link);
      }
      detail.appendChild(meta);

      list.appendChild(chip);
      list.appendChild(detail);
    });
    return list;
  }

  function toggleCitation(chip) {
    const expanded = chip.getAttribute('aria-expanded') === 'true';
    // One open excerpt at a time, like the study page.
    state.body.querySelectorAll('.citation[aria-expanded="true"]').forEach((other) => {
      other.setAttribute('aria-expanded', 'false');
      const detail = state.shadow.getElementById(other.getAttribute('aria-controls'));
      if (detail) detail.hidden = true;
    });
    if (!expanded) {
      chip.setAttribute('aria-expanded', 'true');
      const detail = state.shadow.getElementById(chip.getAttribute('aria-controls'));
      if (detail) detail.hidden = false;
    }
    schedulePlace();
  }

  function onBodyClick(event) {
    const chip = event.target.closest('.citation');
    if (chip) {
      toggleCitation(chip);
      return;
    }
    if (event.target.closest('[data-retry]')) requestBriefing();
    if (event.target.closest('[data-signin]')) onOpenSite();
  }

  /* ----------------------------------------------------------- positioning */

  function schedulePlace() {
    if (!state.open || !state.host) return;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      place();
    });
  }

  function place() {
    const rect = (state.payload && state.payload.anchorRect) || { top: 0, bottom: 0, left: 0 };
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Never wider than the viewport allows; on small screens the panel uses
    // the full width minus margins, so it cannot cover the whole viewport
    // (max-height caps it at 60vh).
    const width = Math.min(PANEL_WIDTH, viewportWidth - MARGIN * 2);
    state.panel.style.width = width + 'px';

    const height = state.panel.offsetHeight;
    const left = Math.max(MARGIN, Math.min(rect.left, viewportWidth - MARGIN - width));
    let top = rect.bottom + GAP;
    if (top + height > viewportHeight - MARGIN) top = rect.top - height - GAP;
    top = Math.max(MARGIN, Math.min(top, viewportHeight - MARGIN - height));

    state.panel.style.left = left + 'px';
    state.panel.style.top = top + 'px';
  }

  /* ------------------------------------------------------------- listeners */

  function onWindowKeyDown(event) {
    if (event.key === 'Escape') close();
  }

  function onWindowPointerDown(event) {
    // composedPath() sees through the shadow root, so clicks inside the panel
    // (retargeted to the host) do not count as "outside".
    if (state.host && !event.composedPath().includes(state.host)) close();
  }

  // The panel is anchored to a viewport rectangle: once the page moves, the
  // anchor is stale, so closing is more honest than floating away from the
  // passage it briefs.
  function onWindowScroll() { close(); }
  function onWindowResize() { close(); }

  function attachListeners() {
    window.addEventListener('keydown', onWindowKeyDown);
    window.addEventListener('pointerdown', onWindowPointerDown);
    window.addEventListener('scroll', onWindowScroll);
    window.addEventListener('resize', onWindowResize);
    state.listeners = true;
  }

  function detachListeners() {
    if (!state.listeners) return;
    window.removeEventListener('keydown', onWindowKeyDown);
    window.removeEventListener('pointerdown', onWindowPointerDown);
    window.removeEventListener('scroll', onWindowScroll);
    window.removeEventListener('resize', onWindowResize);
    state.listeners = false;
  }

  /* -------------------------------------------------------------- public API */

  function open(payload) {
    state.payload = payload || {};
    ensureHost();
    showHost();
    if (!state.open) {
      state.open = true;
      attachListeners();
    }
    // Remember where focus came from so close() can give it back.
    state.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const text = String((payload && payload.text) || '');
    if (text.trim().length < MIN_BRIEFING_CHARS) {
      clearResponseTimer();
      state.lastMessage = null;
      setBusy(false);
      state.body.replaceChildren(bannerBlock('banner-info', SHORT_PASSAGE_MESSAGE, []));
      schedulePlace();
      state.panel.focus();
      announce('The selected passage is too short for a briefing.');
      return;
    }

    // Scope the briefing to the source the highlight matched, when there is
    // one — the citation's sourceId is stored data from /relevance.
    const sourceId = payload && payload.citation && payload.citation.sourceId;
    const message = { type: 'briefing', text: text.slice(0, MAX_TEXT) };
    if (sourceId) message.sourceIds = [sourceId];
    state.lastMessage = message;

    state.panel.focus();
    requestBriefing();
  }

  function close() {
    state.open = false;
    state.seq += 1; // invalidate any in-flight response
    clearResponseTimer();
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    detachListeners();
    announce('');
    hideHost();
    if (state.host) state.host.remove();
    if (state.lastFocus && state.lastFocus.isConnected) {
      try {
        state.lastFocus.focus();
      } catch (err) {
        // The opener was removed from the page; nothing to restore.
      }
    }
    state.lastFocus = null;
  }

  function isOpen() {
    return state.open;
  }

  window.SociusPanel = { open, close, isOpen };
})();
