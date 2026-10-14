// highlight.js — the highlight engine for the Study Highlighter extension.
//
// One job: collect candidate text blocks on the page, ask the backend (via
// the background service worker) which of them relate to the student's study
// documents, wrap those passages in <mark class="socius-hl">, and open the
// floating briefing panel (window.SociusPanel, provided by panel.js) when a
// highlight is clicked. Fails quietly on pages or servers that misbehave.

(() => {
  'use strict';

  const DEFAULTS = { enabled: true, apiUrl: 'https://socius-ai.vercel.app' };
  const BLOCK_SELECTOR = 'p, li, blockquote, dd, dt, td, th, h2, h3, figcaption';
  const SKIP_SELECTOR = 'nav, header, footer, aside, form, script, style, noscript, [role="navigation"]';
  const PANEL_HOST_ATTR = 'data-socius-panel';
  const MAX_BLOCKS = 60;
  const MIN_SENTENCE = 40;
  const MAX_SENTENCE = 600;

  // id -> { element, sentence } for every candidate block we sent.
  const sentencesById = new Map();
  // id -> server match object ({ id, score, citation, excerpt }) for highlights.
  const matchesById = new Map();

  let settings = { ...DEFAULTS };

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
    if (location.href.startsWith(settings.apiUrl)) return;

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

  /* ----------------------------------------------------------------- init */

  document.addEventListener('click', onDocumentClick);

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.enabled) {
        settings.enabled = changes.enabled.newValue ?? DEFAULTS.enabled;
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
