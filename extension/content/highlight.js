// highlight.js — the highlight engine for the Study Highlighter extension.
//
// Two flows live here, one job each:
//
//  1. Relevance. Collect candidate text blocks on the page, ask the backend
//     (via the background service worker) which of them relate to the
//     student's study documents, wrap those passages in <mark class="socius-hl">,
//     and open the floating briefing panel (window.SociusPanel, provided by
//     panel.js) when one is clicked. Fails quietly on pages or servers that
//     misbehave.
//
//  2. Selection. The diagram's "select text → hover the word → a button
//     appears → Socius AI takes it from there". Whatever the student selects
//     becomes a <mark class="soc-word"> highlight. Hovering it — or tabbing to
//     it — reveals a small "Ask Socius" button that hands the passage to
//     Socius AI through the same panel. That button reports what actually
//     happened: if the student is not signed in, the highlighter is off, or the
//     app cannot be reached, it says so plainly instead of pretending the
//     passage was sent.
//
// Everything runs in the page's isolated world. Nothing is written to window,
// every class and injected element carries a soc- prefix, and the hover button
// is rendered inside its own shadow root so neither the page's CSS nor ours can
// leak across the boundary.

(() => {
  'use strict';

  const DEFAULTS = { enabled: true, apiUrl: 'https://socius-ai.vercel.app' };
  const BLOCK_SELECTOR = 'p, li, blockquote, dd, dt, td, th, h2, h3, figcaption';
  const SKIP_SELECTOR = 'nav, header, footer, aside, form, script, style, noscript, [role="navigation"]';
  const PANEL_HOST_ATTR = 'data-socius-panel';
  const MAX_BLOCKS = 60;
  const MIN_SENTENCE = 40;
  const MAX_SENTENCE = 600;

  // ---- selection-highlight vocabulary (kept apart from the one above) ------
  const WORD_CLASS = 'soc-word';
  const WORD_ATTR = 'data-soc-sel';
  const BUBBLE_ATTR = 'data-soc-bubble';
  const MAX_HIGHLIGHTS = 40;        // every highlight is a tab stop; keep it bounded
  const MAX_SELECTION_CHARS = 1500; // the backend's briefing limit
  const MIN_ASK_CHARS = 60;         // mirrors panel.js#MIN_BRIEFING_CHARS
  const HIDE_DELAY_MS = 140;        // pointer grace period, so moving to the
                                    // button never makes the card flicker
  const VERDICT_TIMEOUT_MS = 20000; // panel.js's own answer timeout
  const STATE_CACHE_MS = 2000;      // how long one hover's state answer is reused
  const STATE_TIMEOUT_MS = 3000;    // a hung worker must not leave "Checking…"
  // A selection that reaches into any of these would move nodes the page still
  // owns (or cannot be split), so it is ignored rather than half-wrapped.
  const UNSAFE_SELECTOR =
    'input, textarea, select, option, button, script, style, noscript, template,' +
    ' iframe, object, embed, canvas, svg, audio, video, [contenteditable]';
  // The briefing panel's own markup, read only to mirror the outcome it shows.
  // A result hook from panel.js is requested in docs/HANDOFF.md and would
  // replace this; until then the read is defensive and never invents a verdict.
  const PANEL_ERROR_SELECTOR = '.banner-error';
  const PANEL_LOADING_SELECTOR = '.loading-row';

  // id -> { element, sentence } for every candidate block we sent.
  const sentencesById = new Map();
  // id -> server match object ({ id, score, citation, excerpt }) for highlights.
  const matchesById = new Map();
  // <mark class="soc-word"> -> { text, chars, id } for the student's own selections.
  const selectionMarks = new Map();

  let settings = { ...DEFAULTS };
  let selectionCounter = 0;

  /* ------------------------------------------------------------ settings */

  function loadSettings() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
      return Promise.resolve(null);
    }
    return chrome.storage.sync.get(DEFAULTS).then((stored) => {
      settings.enabled = stored.enabled ?? DEFAULTS.enabled;
      settings.apiUrl = stored.apiUrl ?? DEFAULTS.apiUrl;
    }).catch(() => {});
  }

  /* -------------------------------------------------------- messaging */

  // Send a message to the background worker. Resolves to the response or
  // null on any failure (orphaned script, missing runtime, lastError).
  function sendMessage(message) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /* ------------------------------------------------------ block collection */

  function shouldSkip(element) {
    if (element.closest(SKIP_SELECTOR)) return true;
    if (element.closest('[' + PANEL_HOST_ATTR + ']')) return true;
    if (element.getClientRects().length === 0) return true;
    if (element.offsetParent === null) return true;
    return false;
  }

  function splitSentences(text) {
    const parts = text.match(/[^.!?\n]+[.!?]*/g) || [];
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
  }

  function collectBlocks() {
    const blocks = [];
    sentencesById.clear();
    const elements = document.querySelectorAll(BLOCK_SELECTOR);
    for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
      const element = elements[elementIndex];
      if (shouldSkip(element)) continue;
      const sentences = splitSentences(element.textContent || '');
      for (let s = 0; s < sentences.length; s++) {
        if (blocks.length >= MAX_BLOCKS) return blocks;
        const sentence = sentences[s];
        if (sentence.length < MIN_SENTENCE || sentence.length > MAX_SENTENCE) continue;
        const id = 'e' + elementIndex + 's' + s;
        sentencesById.set(id, { element, sentence });
        blocks.push({ id, text: sentence });
      }
    }
    return blocks;
  }

  /* ----------------------------------------------------------- highlighting */

  // Find a text node inside element that fully contains the sentence.
  function findTextNode(element, sentence) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.data.includes(sentence)) return node;
    }
    return null;
  }

  function highlightSentence(id, entry) {
    const { element, sentence } = entry;
    const node = findTextNode(element, sentence);
    if (node) {
      const start = node.data.indexOf(sentence);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + sentence.length);
      const mark = document.createElement('mark');
      mark.className = 'socius-hl';
      mark.setAttribute('data-socius-id', id);
      try {
        range.surroundContents(mark);
        return;
      } catch {
        // Range crossed element boundaries; fall through to block highlight.
      }
    }
    element.classList.add('socius-hl-block');
    element.setAttribute('data-socius-id', id);
  }

  function applyMatches(matches) {
    for (const match of matches) {
      if (!match || typeof match.id !== 'string') continue;
      const entry = sentencesById.get(match.id);
      if (!entry) continue;
      matchesById.set(match.id, match);
      highlightSentence(match.id, entry);
    }
  }

  function removeHighlights() {
    for (const mark of document.querySelectorAll('mark.socius-hl')) {
      const parent = mark.parentNode;
      if (!parent) continue;
      mark.replaceWith(...mark.childNodes);
      parent.normalize();
    }
    for (const el of document.querySelectorAll('.socius-hl-block')) {
      el.classList.remove('socius-hl-block');
    }
    for (const el of document.querySelectorAll('[data-socius-id]')) {
      el.removeAttribute('data-socius-id');
    }
    sentencesById.clear();
    matchesById.clear();
  }

  /* ----------------------------------------------------------------- scan */

  // Idempotent: strips existing highlights, then re-scans if enabled.
  async function scan() {
    removeHighlights();
    if (!settings.enabled) return;
    if (onAppOwnPage()) return;

    const blocks = collectBlocks();
    if (blocks.length === 0) return;

    const response = await sendMessage({ type: 'relevance', blocks });
    if (!response || response.ok !== true || !Array.isArray(response.matches)) {
      console.debug('Socius AI: relevance scan did not run.', response && response.error && response.error.code);
      return;
    }
    applyMatches(response.matches);
  }

  /* -------------------------------------------------------- click handling */

  function onDocumentClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const host = target.closest('[data-socius-id]');
    if (!host) return;
    const panel = window.SociusPanel;
    if (!panel || typeof panel.open !== 'function') return;

    event.preventDefault();
    event.stopPropagation();

    const id = host.getAttribute('data-socius-id');
    const entry = sentencesById.get(id);
    const match = matchesById.get(id);
    panel.open({
      anchorRect: host.getBoundingClientRect(),
      text: entry ? entry.sentence : '',
      citation: match ? match.citation : undefined,
      excerpt: match && match.citation ? match.citation.excerpt : undefined,
    });
  }

  /* ==========================================================================
     Selection flow: what the student selects becomes a highlight, and hovering
     (or tabbing to) that highlight reveals the button that hands the passage
     to Socius AI.
     ========================================================================== */

  const BUBBLE_STYLES = `
    .card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      width: max-content;
      max-width: 268px;
      padding: 8px;
      background: #FFFFFF;
      border: 1px solid #DEE2E8;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(16, 20, 24, 0.14);
      color: #101418;
      font: 13px/1.5 "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .card[data-tone="error"] { border-color: #F1C4C1; background: #FDF7F6; }
    .ask {
      min-height: 32px;
      padding: 0 12px;
      border: 0;
      border-radius: 5px;
      background: #1D4ED8;
      color: #FFFFFF;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .ask:hover { background: #1740B4; }
    .ask:focus-visible { outline: 2px solid #1D4ED8; outline-offset: 2px; }
    .ask[aria-busy="true"] { background: #6B7480; cursor: progress; }
    .note { margin: 0; font-size: 12px; line-height: 1.45; color: #6B7480; }
    .note[data-tone="error"] { color: #7A1B15; }
  `;

  // One card for the whole page, anchored to whichever highlight is active.
  const bubble = {
    host: null,
    shadow: null,
    card: null,
    button: null,
    note: null,
    mark: null,
    view: null,
    visible: false,
    busy: false,
    hideTimer: 0,
    verdictTimer: 0,
    raf: 0,
  };

  let stateSnapshot = null;
  let stateRequest = null;
  let stateCheckedAt = 0;
  let panelObserver = null;
  let documentObserver = null;

  /* ------------------------------------------------------------- ancestors */

  // Walk up the composed tree (light DOM, then across any shadow boundary).
  // `closest()` stops at a shadow root, so the bubble's own content — which
  // lives inside a shadow root — needs this instead.
  function hasAncestorWith(node, attribute) {
    let current = node;
    while (current) {
      if (current.nodeType === Node.ELEMENT_NODE && current.hasAttribute && current.hasAttribute(attribute)) {
        return true;
      }
      if (current === document || current === document.documentElement) return false;
      const root = current.getRootNode ? current.getRootNode() : null;
      current = (root && root.host) || current.parentNode;
    }
    return false;
  }

  function isInsideBubble(node) {
    return hasAncestorWith(node, BUBBLE_ATTR);
  }

  // The card and the briefing panel are both ours. The panel moves focus to
  // itself when it opens, so "focus left" must not mean "dismiss the card" —
  // that used to happen, and the ask card vanished the instant the panel
  // answered.
  function insideOwnUI(node) {
    return hasAncestorWith(node, BUBBLE_ATTR) || hasAncestorWith(node, PANEL_HOST_ATTR);
  }

  function onAppOwnPage() {
    return typeof settings.apiUrl === 'string'
      && settings.apiUrl.length > 0
      && location.href.startsWith(settings.apiUrl);
  }

  function selectionIsSafe(range) {
    const container = range.commonAncestorContainer;
    const scope = container.nodeType === Node.TEXT_NODE
      ? container.parentElement
      : container;
    if (!scope || typeof scope.closest !== 'function') return false;
    return !scope.closest(UNSAFE_SELECTOR);
  }

  /* ---------------------------------------------------- selection → highlight */

  function pruneSelectionMarks() {
    for (const mark of selectionMarks.keys()) {
      if (!mark.isConnected) selectionMarks.delete(mark);
    }
  }

  // A selection that spans block elements (two paragraphs, several list items)
  // must never put a <p> inside a <mark>: a page that styles children with
  // `#content > p` would silently lose that styling, which is exactly the kind
  // of quiet layout damage this feature must not cause. Each block-level part
  // therefore gets its own mark, all of them carrying the same selection id so
  // one hover still asks about the whole passage.
  const BLOCK_TAGS = new Set(('ADDRESS,ARTICLE,ASIDE,BLOCKQUOTE,DD,DIV,DL,DT,FIELDSET,' +
    'FIGCAPTION,FIGURE,FOOTER,FORM,H1,H2,H3,H4,H5,H6,HEADER,HR,LI,MAIN,NAV,OL,P,PRE,' +
    'SECTION,TABLE,TD,TH,TR,UL').split(','));

  function isBlockNode(node) {
    return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName);
  }

  function newSelectionMark(selectionId) {
    const mark = document.createElement('mark');
    mark.className = WORD_CLASS;
    mark.setAttribute(WORD_ATTR, selectionId);
    mark.tabIndex = 0; // the highlight itself is the keyboard entry point
    return mark;
  }

  // Unwrap any highlight the new range swallowed, so the student can refine a
  // selection without nesting one <mark> inside another.
  function unwrapNested(mark) {
    let nested = mark.querySelector('.' + WORD_CLASS);
    while (nested) {
      selectionMarks.delete(nested);
      nested.replaceWith(...nested.childNodes);
      nested = mark.querySelector('.' + WORD_CLASS);
    }
  }

  function marksForFragment(fragment, selectionId) {
    const marks = [];
    let loose = newSelectionMark(selectionId); // text that sits between blocks
    for (const node of Array.from(fragment.childNodes)) {
      if (isBlockNode(node)) {
        if (loose.childNodes.length) {
          marks.push(loose);
          loose = newSelectionMark(selectionId);
        }
        const blockMark = newSelectionMark(selectionId);
        blockMark.appendChild(node);
        marks.push(blockMark);
      } else {
        loose.appendChild(node);
      }
    }
    if (loose.childNodes.length) marks.push(loose);
    return marks;
  }

  // extractContents()/insertNode() rather than surroundContents(): it handles a
  // selection that starts or ends part-way through an element by splitting the
  // nodes, where surroundContents() would throw and leave the page untouched.
  // Returns the first mark, which anchors the hover card.
  function wrapRange(range, text) {
    const target = range.cloneRange();
    const fragment = target.extractContents();
    selectionCounter += 1;
    const selectionId = 'sel' + selectionCounter;
    const marks = marksForFragment(fragment, selectionId);
    if (marks.length === 0) return null;

    const piece = document.createDocumentFragment();
    for (const mark of marks) piece.appendChild(mark);
    target.insertNode(piece);

    for (const mark of marks) {
      unwrapNested(mark);
      selectionMarks.set(mark, { text, chars: text.length, id: selectionId });
    }
    return marks[0];
  }

  function commitSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return;

    const text = range.toString().trim();
    if (text.length === 0) return;
    if (insideOwnUI(range.commonAncestorContainer)) return; // our own card or panel
    if (onAppOwnPage()) return;                             // the app is not a page to highlight
    if (!selectionIsSafe(range)) return;                    // never half-wrap a page's controls

    if (text.length > MAX_SELECTION_CHARS) {
      showBubbleAt(range.getBoundingClientRect(), null, {
        label: 'Selection too long',
        note: 'Socius AI accepts up to ' + MAX_SELECTION_CHARS + ' characters. This one is '
          + text.length + ' — select a shorter passage.',
        tone: 'error',
        action: 'wait',
      });
      return;
    }

    pruneSelectionMarks();
    if (selectionMarks.size >= MAX_HIGHLIGHTS) {
      showBubbleAt(range.getBoundingClientRect(), null, {
        label: 'Too many highlights',
        note: 'This page already carries ' + MAX_HIGHLIGHTS + ' highlights. Refresh the page to start again.',
        tone: 'error',
        action: 'wait',
      });
      return;
    }

    let mark;
    try {
      mark = wrapRange(range, text);
    } catch {
      // A selection the DOM will not accept to split. Leave the page exactly
      // as it was rather than tearing a node in half.
      return;
    }
    if (!mark) return;
    selection.removeAllRanges();
    showBubbleAt(mark.getBoundingClientRect(), mark, pendingView());
  }

  function onPointerUp(event) {
    if (insideOwnUI(event.target)) return; // using the button is not a selection
    commitSelection();
  }

  function onSelectionKeyUp(event) {
    if (event.shiftKey) { commitSelection(); return; }
    const key = event.key === 'a' || event.key === 'A';
    if (key && (event.ctrlKey || event.metaKey)) commitSelection(); // select all
  }

  /* ------------------------------------------------------------- the card */

  function buildBubble() {
    const host = document.createElement('div');
    host.setAttribute(BUBBLE_ATTR, '');
    // `all: initial` is what stops the page's CSS reaching in; the shadow root
    // below is what stops ours reaching out.
    host.setAttribute('style', 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = BUBBLE_STYLES;
    shadow.appendChild(style);

    const card = document.createElement('div');
    card.className = 'card';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ask';
    button.textContent = 'Ask Socius'; // the accessible name of the control

    const note = document.createElement('p');
    note.className = 'note';
    note.setAttribute('role', 'status'); // announced when it changes

    card.appendChild(button);
    card.appendChild(note);
    shadow.appendChild(card);
    document.documentElement.appendChild(host);

    button.addEventListener('click', onAskClick);

    bubble.host = host;
    bubble.shadow = shadow;
    bubble.card = card;
    bubble.button = button;
    bubble.note = note;
  }

  function ensureBubble() {
    if (!bubble.host) buildBubble();
  }

  function paintBubble(view) {
    bubble.view = view;
    bubble.button.textContent = view.label;
    bubble.card.setAttribute('data-tone', view.tone || '');
    bubble.note.setAttribute('data-tone', view.tone || '');
    bubble.note.textContent = view.note || '';
    if (view.busy) bubble.button.setAttribute('aria-busy', 'true');
    else bubble.button.removeAttribute('aria-busy');
  }

  // Written again one frame after the card becomes visible so the live region
  // sees a change: text set while the card is display:none is not announced.
  function queueNote() {
    if (bubble.raf) cancelAnimationFrame(bubble.raf);
    bubble.raf = requestAnimationFrame(() => {
      bubble.raf = 0;
      if (!bubble.visible || !bubble.view) return;
      bubble.note.textContent = bubble.view.note || '';
    });
  }

  function positionBubbleAt(rect) {
    const cardRect = bubble.card.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = window.innerHeight;
    const margin = 8;

    let left = rect.left + rect.width / 2 - cardRect.width / 2;
    left = Math.max(margin, Math.min(left, width - margin - cardRect.width));
    let top = rect.top - cardRect.height - margin;
    if (top < margin) top = rect.bottom + margin; // not enough room above
    top = Math.max(margin, Math.min(top, height - margin - cardRect.height));

    bubble.host.style.left = Math.round(left) + 'px';
    bubble.host.style.top = Math.round(top) + 'px';
  }

  // rect: a DOMRect to anchor to. mark: the highlight, or null for a one-off
  // message (a selection that could not be highlighted).
  function showBubbleAt(rect, mark, view) {
    ensureBubble();
    cancelHide();
    clearVerdictWatch();
    bubble.mark = mark;
    bubble.busy = false;
    bubble.visible = true;
    bubble.host.style.display = 'block';
    paintBubble(view || pendingView());
    positionBubbleAt(rect);
    queueNote();

    if (!mark) return; // a one-off message; there is nothing to ask about
    probeState().then((state) => {
      if (!bubble.visible || bubble.mark !== mark) return; // hovered elsewhere meanwhile
      paintBubble(readinessView(mark));
    });
  }

  function cancelHide() {
    if (bubble.hideTimer) {
      clearTimeout(bubble.hideTimer);
      bubble.hideTimer = 0;
    }
  }

  function scheduleHide() {
    cancelHide();
    // A grace period, not an instant hide: the pointer has to travel from the
    // highlight to the button, and an instant hide is what makes a card flicker.
    bubble.hideTimer = setTimeout(() => {
      bubble.hideTimer = 0;
      hideBubble();
    }, HIDE_DELAY_MS);
  }

  function hideBubble() {
    cancelHide();
    clearVerdictWatch();
    bubble.visible = false;
    bubble.mark = null;
    bubble.busy = false;
    bubble.view = null;
    if (bubble.host) bubble.host.style.display = 'none';
  }

  /* --------------------------------------------------------- honest state */

  function probeState() {
    const now = Date.now();
    if (stateRequest && now - stateCheckedAt < STATE_CACHE_MS) return stateRequest;
    stateCheckedAt = now;
    stateRequest = Promise.race([
      sendMessage({ type: 'getState' }),
      new Promise((resolve) => setTimeout(() => resolve(null), STATE_TIMEOUT_MS)),
    ]).then((response) => {
      stateSnapshot = response && response.ok === true ? response : null;
      return stateSnapshot;
    });
    return stateRequest;
  }

  function invalidateState() {
    stateRequest = null;
    stateCheckedAt = 0;
  }

  function pendingView() {
    return {
      label: 'Checking\u2026',
      note: 'Asking the extension whether Socius AI is reachable.',
      tone: null,
      action: 'wait',
      busy: true,
    };
  }

  function readinessView(mark) {
    if (!stateSnapshot) {
      return {
        label: "Can't reach Socius AI",
        note: 'The extension is not answering. Refresh the page, then try again.',
        tone: 'error',
        action: 'reload',
      };
    }
    if (stateSnapshot.enabled === false) {
      return {
        label: 'Socius AI is off',
        note: 'Turn the highlighter on with the Socius AI toolbar button, then ask again.',
        tone: 'error',
        action: 'recheck',
      };
    }
    if (stateSnapshot.auth && stateSnapshot.auth.signedIn === false) {
      return {
        label: 'Not signed in',
        note: 'Sign in from the Socius AI toolbar button, then ask again.',
        tone: 'error',
        action: 'signin',
      };
    }
    const entry = selectionMarks.get(mark);
    const chars = entry ? entry.chars : 0;
    if (chars > MAX_SELECTION_CHARS) return longSelectionView(chars);
    if (chars < MIN_ASK_CHARS) return shortSelectionView(chars);
    return {
      label: 'Ask Socius',
      note: 'Send this passage to Socius AI.',
      tone: null,
      action: 'ask',
    };
  }

  function longSelectionView(chars) {
    return {
      label: 'Selection too long',
      note: 'Socius AI accepts up to ' + MAX_SELECTION_CHARS + ' characters. This one is '
        + chars + ' — select a shorter passage.',
      tone: 'error',
      action: 'wait',
    };
  }

  function shortSelectionView(chars) {
    return {
      label: 'Too short to ask',
      note: 'Socius AI needs at least ' + MIN_ASK_CHARS + ' characters. This passage has '
        + chars + '.',
      tone: 'error',
      action: 'wait',
    };
  }

  /* --------------------------------------------------------- the ask itself */

  function onAskClick(event) {
    event.stopPropagation(); // our button must never reach the page's handlers
    const view = bubble.view;
    if (!view) return;

    if (view.action === 'reload') { location.reload(); return; }
    if (view.action === 'recheck') {
      invalidateState();
      paintBubble(pendingView());
      probeState().then((state) => {
        if (!bubble.visible || !bubble.mark) return;
        paintBubble(readinessView(bubble.mark));
      });
      return;
    }
    if (view.action === 'signin') { openSignIn(); return; }
    if (view.action !== 'ask' || bubble.busy || !bubble.mark) return;

    const entry = selectionMarks.get(bubble.mark);
    const text = entry ? entry.text : '';
    const chars = entry ? entry.chars : 0;
    if (chars < MIN_ASK_CHARS) { paintBubble(shortSelectionView(chars)); return; }
    if (chars > MAX_SELECTION_CHARS) { paintBubble(longSelectionView(chars)); return; }

    const panel = window.SociusPanel;
    if (!panel || typeof panel.open !== 'function') {
      paintBubble({
        label: 'Panel unavailable',
        note: 'The Socius AI briefing panel did not load. Refresh the page and try again.',
        tone: 'error',
        action: 'reload',
      });
      return;
    }

    bubble.busy = true;
    paintBubble({
      label: 'Sending\u2026',
      note: 'Handing this passage to Socius AI.',
      tone: null,
      action: 'ask',
    });
    try {
      panel.open({ anchorRect: bubble.mark.getBoundingClientRect(), text });
    } catch {
      bubble.busy = false;
      paintBubble({
        label: 'Not sent',
        note: 'The briefing panel could not be opened.',
        tone: 'error',
        action: 'ask',
      });
      return;
    }
    startVerdictWatch();
  }

  function onMarkKeyDown(event) {
    const mark = markFromEvent(event);
    if (!mark) return;
    if (event.key === 'Escape') { hideBubble(); return; }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      onAskClick(event);
    }
  }

  function openSignIn() {
    paintBubble({
      label: 'Opening Socius AI\u2026',
      note: 'Sign in there, then come back and ask again.',
      tone: null,
      action: 'wait',
    });
    sendMessage({ type: 'openSite' }).then(() => {
      if (!bubble.visible || !bubble.mark) return;
      paintBubble(readinessView(bubble.mark));
    });
  }

  /* ----------------------------------------------------- did it get sent? */

  function clearVerdictWatch() {
    if (bubble.verdictTimer) {
      clearTimeout(bubble.verdictTimer);
      bubble.verdictTimer = 0;
    }
    if (panelObserver) { panelObserver.disconnect(); panelObserver = null; }
    if (documentObserver) { documentObserver.disconnect(); documentObserver = null; }
  }

  function startVerdictWatch() {
    clearVerdictWatch();
    // Never claim success just because time passed: if the panel says nothing
    // we can read, the card says it is still waiting.
    bubble.verdictTimer = setTimeout(() => {
      bubble.verdictTimer = 0;
      finishVerdict({ ok: null });
    }, VERDICT_TIMEOUT_MS);
    watchForPanel();
  }

  function watchForPanel() {
    if (!bubble.visible || !bubble.mark) return;
    const host = document.querySelector('[' + PANEL_HOST_ATTR + ']');
    if (host) { observePanel(host); return; }
    if (documentObserver) return;
    documentObserver = new MutationObserver(() => {
      const found = document.querySelector('[' + PANEL_HOST_ATTR + ']');
      if (found) observePanel(found);
    });
    documentObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function observePanel(host) {
    if (documentObserver) { documentObserver.disconnect(); documentObserver = null; }
    if (panelObserver) { panelObserver.disconnect(); panelObserver = null; }
    const shadow = host.shadowRoot;
    if (!shadow) { finishVerdict({ ok: null }); return; }

    panelObserver = new MutationObserver(() => {
      const verdict = readPanelVerdict(host, shadow);
      if (verdict) finishVerdict(verdict);
    });
    panelObserver.observe(shadow, { childList: true, subtree: true });

    const already = readPanelVerdict(host, shadow);
    if (already) finishVerdict(already); // it answered before we started looking
  }

  // Mirror only what the panel actually shows: an error banner means the send
  // failed, a spinner means it is still in flight, anything else means the app
  // answered.
  function readPanelVerdict(host, shadow) {
    if (!host.isConnected) {
      return { ok: null, message: 'The briefing panel was closed before Socius AI answered.' };
    }
    const error = shadow.querySelector(PANEL_ERROR_SELECTOR);
    if (error) {
      const message = (error.textContent || '').trim();
      return { ok: false, message: message || 'Socius AI could not be reached.' };
    }
    if (shadow.querySelector(PANEL_LOADING_SELECTOR)) return null;
    return { ok: true };
  }

  function finishVerdict(verdict) {
    clearVerdictWatch();
    if (!bubble.visible || !bubble.mark) return;
    bubble.busy = false;
    if (verdict && verdict.ok === true) {
      paintBubble({
        label: 'Sent to Socius AI',
        note: 'The briefing panel shows the answer.',
        tone: null,
        action: 'ask',
      });
      return;
    }
    if (verdict && verdict.ok === false) {
      paintBubble({
        label: 'Not sent',
        note: verdict.message || 'Socius AI could not be reached. The briefing panel explains why.',
        tone: 'error',
        action: 'ask',
      });
      return;
    }
    paintBubble({
      label: 'Still sending',
      note: (verdict && verdict.message) || 'Socius AI has not answered yet — the briefing panel shows the result.',
      tone: null,
      action: 'ask',
    });
  }

  /* ---------------------------------------------------------- event plumbing */

  function markFromEvent(event) {
    const path = event.composedPath ? event.composedPath() : [];
    for (const node of path) {
      if (node && node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains(WORD_CLASS)) {
        return node;
      }
    }
    const target = event.target;
    if (target && typeof target.closest === 'function') {
      return target.closest('.' + WORD_CLASS);
    }
    return null;
  }

  function touchesBubble(event) {
    const path = event.composedPath ? event.composedPath() : [];
    for (const node of path) {
      if (node === bubble.host) return true;
      if (node && node.nodeType === Node.ELEMENT_NODE && node.hasAttribute && node.hasAttribute(BUBBLE_ATTR)) {
        return true;
      }
    }
    return false;
  }

  function isMarkOrBubble(node) {
    if (!node) return false;
    if (insideOwnUI(node)) return true;
    return typeof node.closest === 'function' && node.closest('.' + WORD_CLASS) !== null;
  }

  function onPointerOver(event) {
    if (touchesBubble(event)) { cancelHide(); return; }
    const mark = markFromEvent(event);
    if (!mark) return;
    cancelHide();
    if (bubble.mark !== mark || !bubble.visible) {
      showBubbleAt(mark.getBoundingClientRect(), mark, pendingView());
    }
  }

  function onPointerOut(event) {
    const fromMark = markFromEvent(event);
    if (!fromMark && !touchesBubble(event)) return;
    // Moving from the highlight to the button (or between the button's own
    // children) is the normal path to clicking it — never hide for that.
    if (isMarkOrBubble(event.relatedTarget)) return;
    scheduleHide();
  }

  function onFocusIn(event) {
    if (insideOwnUI(event.target)) { cancelHide(); return; }
    const mark = markFromEvent(event);
    if (!mark) return;
    cancelHide();
    showBubbleAt(mark.getBoundingClientRect(), mark, pendingView());
  }

  function onFocusOut(event) {
    if (isMarkOrBubble(event.relatedTarget)) return;
    hideBubble();
  }

  function onPointerDown(event) {
    if (insideOwnUI(event.target)) return;
    if (markFromEvent(event)) return; // keep the card for the highlight being clicked
    hideBubble();
  }

  document.addEventListener('click', onDocumentClick);

  // ---- selection flow listeners -------------------------------------------
  document.addEventListener('mouseup', onPointerUp);
  document.addEventListener('touchend', onPointerUp);
  document.addEventListener('keyup', onSelectionKeyUp);
  document.addEventListener('mouseover', onPointerOver);
  document.addEventListener('mouseout', onPointerOut);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onMarkKeyDown);
  // Scrolling moves the highlight away from the card, so the card goes rather
  // than floating over text the student did not point at.
  window.addEventListener('scroll', hideBubble, true);
  window.addEventListener('resize', hideBubble);

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.enabled) {
        settings.enabled = changes.enabled.newValue ?? DEFAULTS.enabled;
        invalidateState();
        if (settings.enabled) scan();
        else removeHighlights();
      }
      if (changes.apiUrl) {
        settings.apiUrl = changes.apiUrl.newValue ?? DEFAULTS.apiUrl;
      }
    });
  }

  loadSettings().then(() => scan());
})();
