/* Floating briefing panel for the Socius AI Study Highlighter content script.
   Everything renders inside one shadow-root host so page CSS cannot touch it.
   Exposes only window.SociusPanel = { open, close, isOpen }. */

(function () {
  'use strict';

  var PANEL_WIDTH = 380;
  var SMALL_VIEWPORT = 420;
  var MARGIN = 12;
  var GAP = 10;
  var MAX_TEXT = 1500;
  var MIN_BRIEFING_CHARS = 60;
  var RESPONSE_TIMEOUT_MS = 20000;
  var RELOAD_MESSAGE = 'Extension was reloaded \u2014 refresh the page.';
  var SHORT_PASSAGE_MESSAGE = 'This passage is too short for a briefing. Click a longer highlighted passage.';
  var DEFAULT_ABSTAIN_MESSAGE = 'Not in your study materials yet \u2014 add materials on this topic in Socius AI to get a grounded briefing.';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var state = {
    host: null,
    shadow: null,
    panel: null,
    body: null,
    open: false,
    payload: null,
    lastMessage: null,
    seq: 0,
    timer: 0,
    raf: 0,
    listeners: false
  };

  /* ------------------------------------------------------------ styles/DOM */

  var STYLES = `
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
      --font-sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-serif: "IBM Plex Serif", Georgia, "Times New Roman", serif;
    }
    *, *::before, *::after { box-sizing: border-box; }

    .panel {
      position: fixed;
      width: 380px;
      max-height: 60vh;
      overflow-y: auto;
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
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
    .brand-mark { display: block; flex: none; }
    .brand-name { font-size: 13px; font-weight: 600; color: var(--ink); }
    .brand-tag { font-size: 11px; color: var(--ink-3); }
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

    .body { padding: 16px; }
    .body p { margin: 0 0 10px; }
    .body p:last-child { margin-bottom: 0; }

    .loading-row { display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--ink-3); }
    .spinner {
      flex: none;
      width: 15px;
      height: 15px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 700ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .banner-block { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
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
      line-height: 1.35;
    }
    .banner svg { flex: none; margin-top: 2px; }
    .banner-info { background: var(--blue-soft); border-color: var(--blue-line); border-left-color: var(--blue); color: var(--blue-ink); }
    .banner-error { background: var(--red-soft); border-color: #F1C4C1; border-left-color: #B3261E; color: #7A1B15; }

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
    .citation-detail blockquote:last-child { margin-bottom: 0; }

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
      padding: 12px 16px;
      border-top: 1px solid var(--line);
      background: var(--paper);
    }
    .foot .btn { width: 100%; }

    :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  `;

  var SHELL =
    '<section class="panel" role="dialog" aria-label="Socius AI briefing" tabindex="-1">' +
    '<header class="head">' +
    '<span class="brand">' +
    '<span class="brand-name">Socius AI</span>' +
    '<span class="brand-tag">Briefing</span>' +
    '</span>' +
    '<button type="button" class="close" aria-label="Close">\u2715</button>' +
    '</header>' +
    '<div class="body" data-body></div>' +
    '<footer class="foot">' +
    '<button type="button" class="btn btn-primary" data-open-site>Open Socius AI</button>' +
    '</footer>' +
    '</section>';

  var FILE_SHAPES = [
    ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z' }],
    ['path', { d: 'M14 3v5h5' }]
  ];
  var SLIDES_SHAPES = [
    ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 1.5 }],
    ['path', { d: 'M8 20h8' }],
    ['path', { d: 'M12 16v4' }]
  ];
  var GLOBE_SHAPES = [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z' }]
  ];
  var CHEVRON_SHAPES = [['path', { d: 'M6 9l6 6 6-6' }]];
  var ALERT_SHAPES = [
    ['path', { d: 'M12 3.5L2.5 20h19z' }],
    ['path', { d: 'M12 9.5V14' }],
    ['path', { d: 'M12 17.2h.01' }]
  ];
  var INFO_SHAPES = [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 11v5' }],
    ['path', { d: 'M12 7.8h.01' }]
  ];
  var TYPE_SHAPES = { pdf: FILE_SHAPES, pptx: SLIDES_SHAPES, webpage: GLOBE_SHAPES };

  function svgIcon(shapes, size) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    shapes.forEach(function (shape) {
      var node = document.createElementNS(SVG_NS, shape[0]);
      var attrs = shape[1];
      Object.keys(attrs).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
      svg.appendChild(node);
    });
    return svg;
  }

  function brandMark() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('brand-mark');
    var bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('width', '14');
    bg.setAttribute('height', '14');
    bg.setAttribute('rx', '3');
    bg.setAttribute('fill', '#1D4ED8');
    svg.appendChild(bg);
    [[2, 2, 10, 2], [2, 4, 2, 2], [2, 6, 10, 2], [10, 8, 2, 2], [2, 10, 10, 2]].forEach(function (px) {
      var rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(px[0]));
      rect.setAttribute('y', String(px[1]));
      rect.setAttribute('width', String(px[2]));
      rect.setAttribute('height', String(px[3]));
      rect.setAttribute('fill', '#FFFFFF');
      svg.appendChild(rect);
    });
    return svg;
  }

  function buildHost() {
    var host = document.createElement('div');
    host.setAttribute('data-socius-panel', '');
    host.setAttribute('style', 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483646;');
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = SHELL;
    var style = document.createElement('style');
    style.textContent = STYLES;
    shadow.insertBefore(style, shadow.firstChild);
    var brand = shadow.querySelector('.brand');
    brand.insertBefore(brandMark(), brand.firstChild);

    state.host = host;
    state.shadow = shadow;
    state.panel = shadow.querySelector('.panel');
    state.body = shadow.querySelector('[data-body]');

    shadow.querySelector('.close').addEventListener('click', close);
    shadow.querySelector('[data-open-site]').addEventListener('click', onOpenSite);
    state.body.addEventListener('click', onBodyClick);
  }

  function ensureHost() {
    if (!state.host) buildHost();
    if (!state.host.isConnected) document.documentElement.appendChild(state.host);
  }

  /* --------------------------------------------------------- runtime bridge */

  function runtimeAvailable() {
    try { return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id; }
    catch (err) { return false; }
  }

  function readLastError() {
    try { return chrome.runtime.lastError ? chrome.runtime.lastError.message : ''; }
    catch (err) { return ''; }
  }

  function friendlyError(message) {
    return /Receiving end does not exist|Extension context invalidated/i.test(message)
      ? RELOAD_MESSAGE
      : message;
  }

  function sendToBackground(message, callback) {
    if (!runtimeAvailable()) { callback(RELOAD_MESSAGE); return; }
    try {
      chrome.runtime.sendMessage(message, function (response) {
        var err = readLastError();
        if (err) { callback(friendlyError(err)); return; }
        callback(null, response);
      });
    } catch (err) {
      callback(RELOAD_MESSAGE);
    }
  }

  /* --------------------------------------------------------------- requests */

  function requestBriefing() {
    clearResponseTimer();
    var seq = ++state.seq;
    renderLoading();
    state.timer = setTimeout(function () {
      state.timer = 0;
      if (seq !== state.seq || !state.open) return;
      renderError('Socius AI did not answer in time. Try again.');
    }, RESPONSE_TIMEOUT_MS);
    sendToBackground(state.lastMessage, function (err, response) {
      if (seq !== state.seq || !state.open) return;
      clearResponseTimer();
      if (err) { renderError(err); return; }
      if (!response) return;
      if (response.ok) renderSuccess(response);
      else renderError((response.error && response.error.message) || 'Something went wrong. Try again.');
    });
  }

  function clearResponseTimer() {
    if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
  }

  function onOpenSite() {
    sendToBackground({ type: 'openSite' }, function (err) {
      if (err) renderError(err);
    });
  }

  /* ---------------------------------------------------------------- states */

  function renderLoading() {
    var row = document.createElement('div');
    row.className = 'loading-row';
    var spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    var label = document.createElement('span');
    label.textContent = 'Asking Socius AI\u2026';
    row.appendChild(spinner);
    row.appendChild(label);
    state.body.replaceChildren(row);
    schedulePlace();
  }

  function bannerBlock(kind, message, withRetry) {
    var wrap = document.createElement('div');
    wrap.className = 'banner-block';
    var banner = document.createElement('div');
    banner.className = 'banner ' + kind;
    banner.appendChild(svgIcon(kind === 'banner-error' ? ALERT_SHAPES : INFO_SHAPES, 16));
    var text = document.createElement('span');
    text.textContent = message;
    banner.appendChild(text);
    wrap.appendChild(banner);
    if (withRetry) {
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary';
      retry.setAttribute('data-retry', '');
      retry.textContent = 'Retry';
      wrap.appendChild(retry);
    }
    return wrap;
  }

  function renderError(message) {
    state.body.replaceChildren(bannerBlock('banner-error', message, true));
    schedulePlace();
  }

  function renderSuccess(data) {
    var frag = document.createDocumentFragment();
    if (data.needsContent) {
      var topics = suggestionTopics(data.suggestions);
      if (topics.length) {
        // New backend: friendly abstain copy in `answer` + topic chips.
        var block = bannerBlock('banner-info', friendlyAbstain(data.answer), false);
        block.appendChild(suggestionsList(topics));
        frag.appendChild(block);
      } else {
        // Older backend without `suggestions` — render exactly as before.
        frag.appendChild(bannerBlock('banner-info', DEFAULT_ABSTAIN_MESSAGE, false));
      }
    } else {
      String(data.answer || '').split(/\n{2,}/).forEach(function (paragraph) {
        var text = paragraph.trim();
        if (text) frag.appendChild(answerParagraph(text));
      });
    }
    var citations = orderedCitations(data.citations);
    if (citations.length) frag.appendChild(citationsList(citations));
    state.body.replaceChildren(frag);
    schedulePlace();
  }

  function answerParagraph(text) {
    var p = document.createElement('p');
    text.split(/\*\*(.+?)\*\*/g).forEach(function (part, index) {
      if (index % 2 === 1) {
        var strong = document.createElement('strong');
        strong.textContent = part;
        p.appendChild(strong);
      } else if (part) {
        p.appendChild(document.createTextNode(part));
      }
    });
    return p;
  }

  /* --------------------------------------------------------- suggestions */

  // Topic chips shown when the tutor abstains. The panel has no question
  // input (briefings are triggered by highlighting a passage, not typed), so
  // these are informational labels — not buttons — and older backends that
  // omit `suggestions` simply never reach this code path.

  function friendlyAbstain(answer) {
    var text = String(answer || '').trim();
    return text || DEFAULT_ABSTAIN_MESSAGE;
  }

  function suggestionTopics(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(function (topic) { return typeof topic === 'string' && topic.trim(); })
      .map(function (topic) { return topic.trim(); })
      .slice(0, 4);
  }

  function suggestionsList(topics) {
    var wrap = document.createElement('div');
    wrap.className = 'suggestions';
    var label = document.createElement('span');
    label.className = 'suggestions-label';
    label.textContent = 'Covered in your material:';
    var chips = document.createElement('div');
    chips.className = 'suggestion-chips';
    topics.forEach(function (topic) {
      var chip = document.createElement('span');
      chip.className = 'suggestion';
      chip.textContent = topic;
      chips.appendChild(chip);
    });
    wrap.appendChild(label);
    wrap.appendChild(chips);
    return wrap;
  }

  /* ------------------------------------------------------------- citations */

  function locationLabel(citation) {
    var loc = citation && citation.location;
    if (!loc) return '';
    if (loc.page != null) return 'p. ' + loc.page;
    if (loc.slide != null) return 'slide ' + loc.slide;
    if (loc.paragraph != null) return 'para. ' + loc.paragraph;
    return '';
  }

  function citationKey(citation) {
    return String(citation.sourceId || '') + '|' + locationLabel(citation);
  }

  function orderedCitations(list) {
    var result = [];
    var seen = {};
    var anchor = state.payload && state.payload.citation;
    if (anchor) {
      seen[citationKey(anchor)] = true;
      result.push(anchor);
    }
    if (Array.isArray(list)) {
      list.forEach(function (citation) {
        if (!citation || seen[citationKey(citation)]) return;
        seen[citationKey(citation)] = true;
        result.push(citation);
      });
    }
    return result;
  }

  function citationsList(citations) {
    var list = document.createElement('div');
    list.className = 'citations';
    citations.forEach(function (citation, index) {
      var id = 'socius-cite-' + index;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'citation';
      chip.setAttribute('aria-expanded', 'false');
      chip.setAttribute('aria-controls', id);
      chip.appendChild(svgIcon(TYPE_SHAPES[citation.type] || FILE_SHAPES, 13));
      var title = document.createElement('span');
      title.className = 'citation-title';
      title.textContent = citation.title || 'Untitled source';
      chip.appendChild(title);
      var loc = locationLabel(citation);
      if (loc) {
        var locEl = document.createElement('span');
        locEl.className = 'citation-loc';
        locEl.textContent = loc;
        chip.appendChild(locEl);
      }
      chip.appendChild(svgIcon(CHEVRON_SHAPES, 12));
      var detail = document.createElement('div');
      detail.className = 'citation-detail';
      detail.id = id;
      detail.hidden = true;
      var quote = document.createElement('blockquote');
      quote.textContent = citation.excerpt || 'No excerpt available for this passage.';
      detail.appendChild(quote);
      list.appendChild(chip);
      list.appendChild(detail);
    });
    return list;
  }

  function toggleCitation(chip) {
    var expanded = chip.getAttribute('aria-expanded') === 'true';
    state.body.querySelectorAll('.citation[aria-expanded="true"]').forEach(function (other) {
      other.setAttribute('aria-expanded', 'false');
      var detail = state.shadow.getElementById(other.getAttribute('aria-controls'));
      if (detail) detail.hidden = true;
    });
    if (!expanded) {
      chip.setAttribute('aria-expanded', 'true');
      var open = state.shadow.getElementById(chip.getAttribute('aria-controls'));
      if (open) open.hidden = false;
    }
    schedulePlace();
  }

  function onBodyClick(event) {
    var chip = event.target.closest('.citation');
    if (chip) { toggleCitation(chip); return; }
    if (event.target.closest('[data-retry]')) requestBriefing();
  }

  /* ----------------------------------------------------------- positioning */

  function schedulePlace() {
    if (!state.open || !state.host) return;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(function () {
      state.raf = 0;
      place();
    });
  }

  function place() {
    var rect = (state.payload && state.payload.anchorRect) || { top: 0, bottom: 0, left: 0 };
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var vh = window.innerHeight;
    var small = vw < SMALL_VIEWPORT;

    state.panel.style.width = small ? (vw - MARGIN * 2) + 'px' : PANEL_WIDTH + 'px';
    var width = state.panel.offsetWidth;
    var height = state.panel.offsetHeight;

    var left = small
      ? MARGIN
      : Math.max(MARGIN, Math.min(rect.left, vw - MARGIN - width));
    var top = rect.bottom + GAP;
    if (top + height > vh - MARGIN) top = rect.top - height - GAP;
    top = Math.max(MARGIN, Math.min(top, vh - MARGIN - height));

    state.panel.style.left = left + 'px';
    state.panel.style.top = top + 'px';
  }

  /* -------------------------------------------------------------- listeners */

  function onWindowKeyDown(event) { if (event.key === 'Escape') close(); }
  function onWindowPointerDown(event) {
    if (state.host && !event.composedPath().includes(state.host)) close();
  }
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

  /* ------------------------------------------------------------------- API */

  function open(payload) {
    state.payload = payload || {};
    ensureHost();
    if (!state.open) {
      state.open = true;
      attachListeners();
    }
    var text = String((payload && payload.text) || '');
    if (text.trim().length < MIN_BRIEFING_CHARS) {
      clearResponseTimer();
      state.lastMessage = null;
      state.body.replaceChildren(bannerBlock('banner-info', SHORT_PASSAGE_MESSAGE, false));
      schedulePlace();
      state.panel.focus();
      return;
    }
    var sourceId = payload && payload.citation && payload.citation.sourceId;
    var message = { type: 'briefing', text: text.slice(0, MAX_TEXT) };
    if (sourceId) message.sourceIds = [sourceId];
    state.lastMessage = message;
    renderLoading();
    state.panel.focus();
    requestBriefing();
  }

  function close() {
    state.open = false;
    state.seq += 1;
    clearResponseTimer();
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    detachListeners();
    if (state.host) state.host.remove();
  }

  function isOpen() { return state.open; }

  window.SociusPanel = { open: open, close: close, isOpen: isOpen };
})();
