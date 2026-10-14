// Flashcards — a persistent library plus a practice view.
//
// Two modes on one page:
//   * library (default): decks from GET /api/decks, grouped by study session,
//     with search / session filter / sorting.
//   * practice (?deck=deck_…): GET /api/decks/:deckId, then one card at a
//     time. Every "Know it" / "Review again" is saved with
//     PATCH /api/decks/:deckId/cards/:idx, so reopening a deck shows the
//     saved marks and the deck's real known/review counts.
//
// The generator writes decks from the chosen material (POST /api/flashcards/
// generate with an optional sessionId); the new deck lands in the library
// under its session.

import { mountShell, mountHealthBanner } from '../components/shell.js';
import { populateScopeSelect } from '../components/scope-select.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, renderCitations, wireCitations,
  showEmpty, showError, formatRelative, errorMessage,
  setTopicError, topicCheck, setGenerating,
} from '../ui.js';

mountShell('flashcards');
mountHealthBanner(document.querySelector('[data-health]'));

// The flashcards page gets a light restyle, so the classic hosts stay the
// contract; anything missing degrades to a detached element instead of
// crashing the page.
const stage = document.querySelector('[data-stage]') || document.createElement('div');
const libraryView = document.querySelector('[data-library]');
const groupsHost = document.querySelector('[data-deck-groups]') || document.createElement('div');
const live = document.querySelector('[data-live]') || document.createElement('p');
const setupStatus = document.querySelector('[data-setup-status]') || document.createElement('div');
const form = document.querySelector('[data-generate-form]');
const topicInput = document.querySelector('#fc-topic');
const topicError = document.querySelector('#fc-topic-error');
const countSelect = document.querySelector('#fc-count');
const scopeSelect = document.querySelector('[data-scope]');
const sessionSelect = document.querySelector('[data-session]');
const generateButton = document.querySelector('[data-generate]');
const scopeNote = document.querySelector('[data-scope-note]');

const searchIcon = document.querySelector('[data-search-icon]');
if (searchIcon) searchIcon.innerHTML = icon('search', { size: 16 });
wireCitations(stage);

const params = new URLSearchParams(window.location.search);
const openDeckId = (params.get('deck') || '').trim();
const presetSessionId = (params.get('session') || '').trim();
const presetTopic = (params.get('topic') || '').trim(); // dashboard deep-link

const GENERATING_LABELS = { ready: 'Generate deck', busy: 'Generating cards…' };

const libState = { q: '', sessionId: '', sort: 'recent' };

/* ------------------------------------------------------------- library --- */

async function loadLibrary() {
  try {
    const data = await api.listDecks({
      q: libState.q,
      sessionId: libState.sessionId,
      sort: libState.sort,
    });
    renderGroups(data.decks || []);
  } catch (error) {
    showError(groupsHost, error, { title: 'Could not load your decks', onRetry: loadLibrary });
  }
}

function deckRow(deck) {
  const reviewed = deck.lastReviewedAt ? `reviewed ${formatRelative(deck.lastReviewedAt)}` : 'not reviewed yet';
  return `
    <a class="row-item fc-deck" href="flashcards.html?deck=${encodeURIComponent(deck.id)}">
      <span class="row-icon">${icon('layers', { size: 15 })}</span>
      <span class="fc-deck-main">
        <span class="fc-deck-title">${escapeHtml(deck.topic)}</span>
        <span class="fc-deck-meta">
          <span>${deck.cardCount} cards · created ${escapeHtml(formatRelative(deck.createdAt))}</span>
          <span>${escapeHtml(reviewed)}</span>
        </span>
      </span>
      <span class="fc-deck-counts">
        <span class="badge badge-green">${icon('check', { size: 11 })} ${deck.knownCount} known</span>
        <span class="badge badge-pink">${icon('refresh', { size: 11 })} ${deck.reviewCount} to review</span>
      </span>
      <span class="row-meta fc-deck-open">Open</span>
    </a>`;
}

function groupHead(title, meta, href = null) {
  const inner = href
    ? `<a class="fc-group-title" href="${href}">${escapeHtml(title)}</a>`
    : `<span class="fc-group-title">${escapeHtml(title)}</span>`;
  return `<div class="fc-group-head">${inner}<span class="row-meta">${escapeHtml(meta)}</span></div>`;
}

function renderGroups(decks) {
  if (decks.length === 0) {
    const filtering = libState.q || libState.sessionId;
    showEmpty(groupsHost, {
      iconName: 'layers',
      title: filtering ? 'No decks match' : 'No decks yet',
      text: filtering
        ? 'Try a different search term or pick another session.'
        : 'Generate a deck below from your own material — it will appear here, grouped by session.',
      actions: filtering
        ? '<button type="button" class="btn btn-secondary btn-sm" data-clear-filters>Clear filters</button>'
        : '',
    });
    return;
  }

  const bySession = new Map();
  for (const deck of decks) {
    const key = deck.sessionId || null;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(deck);
  }

  // Sessions first (in the order the API returned them), Unsorted last.
  const ordered = [...bySession.entries()]
    .sort((a, b) => (a[0] === null) - (b[0] === null));

  groupsHost.innerHTML = ordered.map(([sessionId, list]) => {
    if (sessionId === null) {
      return `<section class="fc-group">${groupHead('Unsorted', `${list.length} ${list.length === 1 ? 'deck' : 'decks'} not in a session`)}
        <div class="row-list">${list.map((deck) => deckRow(deck)).join('')}</div></section>`;
    }
    const title = list[0].sessionTitle || 'Session';
    const category = list[0].category || '';
    return `<section class="fc-group">${groupHead(title, `${category ? `${category} · ` : ''}${list.length} ${list.length === 1 ? 'deck' : 'decks'}`, `session.html?id=${encodeURIComponent(sessionId)}`)}
      <div class="row-list">${list.map((deck) => deckRow(deck)).join('')}</div></section>`;
  }).join('');
}

const searchInput = document.querySelector('#fc-search');
const sessionFilter = document.querySelector('#fc-session-filter');
const sortSelectEl = document.querySelector('#fc-sort');

groupsHost.addEventListener('click', (event) => {
  if (event.target.closest('[data-clear-filters]')) {
    libState.q = ''; libState.sessionId = '';
    if (searchInput) searchInput.value = '';
    if (sessionFilter) sessionFilter.value = '';
    loadLibrary();
  }
});

/* ------------------------------------------------------------ toolbar --- */

let searchTimer = null;
searchInput?.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { libState.q = event.target.value.trim(); loadLibrary(); }, 300);
});
sessionFilter?.addEventListener('change', (event) => {
  libState.sessionId = event.target.value;
  loadLibrary();
});
sortSelectEl?.addEventListener('change', (event) => {
  libState.sort = event.target.value;
  loadLibrary();
});

async function populateSessionFilter() {
  const select = sessionFilter;
  if (!select) return;
  try {
    const data = await api.listSessions();
    for (const session of data.sessions || []) {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = session.title;
      select.appendChild(option);
    }
  } catch {
    // Filtering stays usable without the session list (Unsorted still works).
  }
}

/* ------------------------------------------------------------ practice --- */

const practice = {
  deck: null,   // { id, topic, sessionTitle, category, … }
  cards: [],    // [{ idx, front, back, citations, status, reviewedAt }]
  index: 0,
  revealed: false,
  finished: false,
  saving: false,
  error: '',
  deleteArmed: false,
};

async function openDeck(deckId) {
  try {
    const data = await api.getDeck(deckId);
    practice.deck = data.deck;
    practice.cards = data.cards || [];
    practice.index = 0;
    practice.revealed = false;
    practice.finished = false;
    practice.error = '';
    practice.deleteArmed = false;
    document.title = `${data.deck.topic} — Socius AI`;
    if (libraryView) libraryView.hidden = true;
    stage.hidden = false;
    render();
    live.textContent = `Deck open: ${data.deck.topic}, ${practice.cards.length} cards.`;
  } catch (error) {
    if (libraryView) libraryView.hidden = true;
    stage.hidden = false;
    if (error.code === 'DECK_NOT_FOUND') {
      showEmpty(stage, {
        iconName: 'layers',
        title: 'Deck not found',
        text: 'It may have been deleted. Your other decks are in the library below.',
        actions: '<a class="btn btn-primary btn-sm" href="flashcards.html">Back to the library</a>',
      });
      return;
    }
    showError(stage, error, { title: 'Could not open that deck', onRetry: () => openDeck(deckId) });
  }
}

function statusBadge(card) {
  if (card.status === 'known') return '<span class="badge badge-green">You marked this: known</span>';
  if (card.status === 'review') return '<span class="badge badge-pink">You marked this: review again</span>';
  return '';
}

function counts() {
  const known = practice.cards.filter((card) => card.status === 'known').length;
  const review = practice.cards.filter((card) => card.status === 'review').length;
  return { known, review, fresh: practice.cards.length - known - review };
}

function renderCard() {
  const card = practice.cards[practice.index];
  const total = practice.cards.length;
  const tallies = counts();
  const isLast = practice.index === total - 1;
  const citations = Array.isArray(card.citations) && card.citations.length
    ? `<div class="exchange-citations">
         <p class="exchange-citations-label">Source passages</p>
         ${renderCitations(card.citations, `d${card.idx}`)}
       </div>`
    : '';
  const saveError = practice.error
    ? `<div class="banner banner-error" style="margin-top: var(--s3);">${icon('alert', { size: 16 })} <span>${escapeHtml(practice.error)}</span></div>`
    : '';

  stage.innerHTML = `
    <div class="session-card">
      <div class="session-card-head">
        <div>
          <p class="fc-session-title">${escapeHtml(practice.deck.topic)}</p>
          <div class="session-card-meta">
            <a class="fc-crumb" href="flashcards.html">Library</a>
            ${practice.deck.sessionTitle ? `<span>· in ${escapeHtml(practice.deck.sessionTitle)}</span>` : '<span>· Unsorted</span>'}
            <span class="badge badge-green">${tallies.known} known</span>
            <span class="badge badge-pink">${tallies.review} to review</span>
          </div>
        </div>
        <p class="fc-position">Card ${practice.index + 1} of ${total}</p>
      </div>

      <div class="fc-session-progress">
        <div class="progress" role="img" aria-label="Card ${practice.index + 1} of ${total}">
          <div class="progress-bar" style="width: ${Math.round(((practice.index + 1) / total) * 100)}%"></div>
        </div>
      </div>

      <div class="fc-card-area">
        <div class="fc-card" data-card>
          <div class="fc-card-inner">
            <div class="fc-face fc-face--front">
              <p class="fc-face-label"><span>Question</span><span>${statusBadge(card) || `<span class="badge">${practice.index + 1} / ${total}</span>`}</span></p>
              <p class="fc-question">${escapeHtml(card.front)}</p>
              <p class="fc-face-hint">${icon('spark', { size: 13 })} Select the card or press “Reveal answer”</p>
            </div>
            <div class="fc-face fc-face--back" data-back aria-hidden="true">
              <p class="fc-face-label"><span>Answer</span>${statusBadge(card)}</p>
              <div class="fc-answer">${escapeHtml(card.back)}</div>
              ${citations}
            </div>
          </div>
        </div>
      </div>

      <div class="fc-controls">
        <button type="button" class="btn btn-secondary btn-prev" data-prev ${practice.index === 0 ? 'disabled' : ''}>
          ${icon('chevronLeft', { size: 15 })} Previous
        </button>
        <div class="fc-controls-center">
          <button type="button" class="btn btn-primary" data-reveal>Reveal answer</button>
        </div>
        <button type="button" class="btn btn-secondary btn-next" data-next>
          ${isLast ? 'Finish' : `Next ${icon('chevronRight', { size: 15 })}`}
        </button>
      </div>

      <div class="fc-verdict">
        <button type="button" class="btn btn-secondary" data-know disabled>${icon('check', { size: 15 })} Know it</button>
        <button type="button" class="btn btn-secondary" data-review disabled>${icon('refresh', { size: 15 })} Review again</button>
        <p class="fc-verdict-hint" data-verdict-hint>Reveal the answer to mark this card — marks are saved to your deck.</p>
      </div>
      ${saveError}
    </div>`;
}

function renderSummary() {
  const tallies = counts();
  stage.innerHTML = `
    <div class="session-card">
      <div class="fc-summary">
        <span class="state-icon">${icon('checkCircle', { size: 20 })}</span>
        <h2>Deck complete</h2>
        <p class="muted">${escapeHtml(practice.deck.topic)}${practice.deck.sessionTitle ? ` — in ${escapeHtml(practice.deck.sessionTitle)}` : ''}. Your marks are saved.</p>
        ${practice.error ? `<div class="banner banner-error">${icon('alert', { size: 16 })} <span>${escapeHtml(practice.error)}</span></div>` : ''}
        <div class="fc-counts">
          <div class="fc-count is-know"><strong>${tallies.known}</strong><span>Know it</span></div>
          <div class="fc-count is-review"><strong>${tallies.review}</strong><span>Review again</span></div>
          ${tallies.fresh > 0 ? `<div class="fc-count"><strong>${tallies.fresh}</strong><span>Not marked</span></div>` : ''}
        </div>
        <div class="fc-summary-actions">
          ${tallies.review > 0 ? `<button type="button" class="btn btn-primary" data-review-flagged>Review the ${tallies.review} flagged card${tallies.review === 1 ? '' : 's'}</button>` : ''}
          <a class="btn btn-secondary" href="flashcards.html">Back to the library</a>
          ${practice.deck.sessionId ? `<a class="btn btn-secondary" href="session.html?id=${encodeURIComponent(practice.deck.sessionId)}">Open the session</a>` : ''}
          <button type="button" class="btn btn-quiet fc-delete" data-delete ${practice.deleteArmed ? 'data-delete-armed' : ''}>${practice.deleteArmed ? 'Click again to delete this deck' : 'Delete deck'}</button>
        </div>
      </div>
    </div>`;
}

function render() {
  if (practice.finished) { renderSummary(); return; }
  renderCard();
}

function toggleReveal() {
  if (practice.finished || practice.saving) return;
  practice.revealed = !practice.revealed;
  stage.querySelector('[data-card]')?.classList.toggle('is-flipped', practice.revealed);
  stage.querySelector('[data-back]')?.setAttribute('aria-hidden', String(!practice.revealed));
  const revealButton = stage.querySelector('[data-reveal]');
  if (revealButton) revealButton.textContent = practice.revealed ? 'Hide answer' : 'Reveal answer';
  stage.querySelector('[data-know]')?.toggleAttribute('disabled', !practice.revealed);
  stage.querySelector('[data-review]')?.toggleAttribute('disabled', !practice.revealed);
  live.textContent = practice.revealed ? 'Answer revealed.' : 'Answer hidden.';
}

function goTo(index) {
  if (index < 0 || index >= practice.cards.length) return;
  practice.index = index;
  practice.revealed = false;
  practice.error = '';
  render();
  live.textContent = `Card ${practice.index + 1} of ${practice.cards.length}.`;
}

async function mark(status) {
  if (practice.saving) return;
  const card = practice.cards[practice.index];
  practice.saving = true;
  practice.error = '';
  try {
    const data = await api.updateCardStatus(practice.deck.id, card.idx, status);
    card.status = data.status;        // the server's stored value, not our guess
    card.reviewedAt = data.reviewedAt;
    practice.saving = false;
    if (practice.index >= practice.cards.length - 1) {
      practice.finished = true;
      render();
      live.textContent = 'Deck complete. Your marks are saved.';
      return;
    }
    goTo(practice.index + 1);
  } catch (error) {
    practice.saving = false;
    practice.error = `Your mark was not saved — ${errorMessage(error)}`;
    render();
  }
}

stage.addEventListener('click', (event) => {
  const target = event.target;

  if (target.closest('[data-reveal]')) { toggleReveal(); return; }
  if (target.closest('[data-prev]')) { goTo(practice.index - 1); return; }
  if (target.closest('[data-next]')) {
    if (practice.index >= practice.cards.length - 1) { practice.finished = true; render(); }
    else goTo(practice.index + 1);
    return;
  }
  if (target.closest('[data-know]')) { mark('known'); return; }
  if (target.closest('[data-review]')) { mark('review'); return; }

  if (target.closest('[data-review-flagged]')) {
    practice.cards = practice.cards.filter((card) => card.status === 'review');
    practice.index = 0;
    practice.revealed = false;
    practice.finished = false;
    render();
    live.textContent = `Reviewing ${practice.cards.length} flagged cards.`;
    return;
  }

  if (target.closest('[data-delete]')) {
    const button = target.closest('[data-delete]');
    if (!practice.deleteArmed) {
      practice.deleteArmed = true;
      renderSummary();
      return;
    }
    button.disabled = true;
    api.deleteDeck(practice.deck.id).then(
      () => { window.location.href = 'flashcards.html'; },
      (error) => { practice.deleteArmed = false; practice.error = errorMessage(error); renderSummary(); },
    );
    return;
  }

  if (target.closest('[data-card]') && !target.closest('button, a')) toggleReveal();
});

/* ---------------------------------------------------------- generator --- */

function setSetupStatus(kind, html) {
  setupStatus.innerHTML = html ? `<div class="banner banner-${kind}">${html}</div>` : '';
}

/** Start the generator's "Search in" select from a clean state. */
function resetGeneratorSessionSelect() {
  if (!sessionSelect) return;
  sessionSelect.replaceChildren();
  const allMaterial = document.createElement('option');
  allMaterial.value = '';
  allMaterial.textContent = 'All material';
  sessionSelect.appendChild(allMaterial);
}

/** Error banner for a broken session scope, with a Retry that reloads the list. */
function showSessionScopeError(messageHtml) {
  setSetupStatus('error', `${icon('alert', { size: 16 })} <span>${messageHtml}
    <button type="button" class="btn btn-secondary btn-sm" data-retry-sessions>Retry</button></span>`);
  setupStatus.querySelector('[data-retry-sessions]')?.addEventListener('click', () => {
    populateGeneratorSessionSelect();
  });
}

async function populateGeneratorSessionSelect() {
  resetGeneratorSessionSelect();
  if (!sessionSelect) return; // no session dropdown in this markup → no scoping
  try {
    const data = await api.listSessions();
    for (const session of data.sessions || []) {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = session.title;
      sessionSelect.appendChild(option);
    }
    const presetListed = presetSessionId && [...sessionSelect.options].some((option) => option.value === presetSessionId);
    if (presetListed) sessionSelect.value = presetSessionId;
    if (presetSessionId && !presetListed) {
      // Reopened for a specific session, but it is not offered (e.g. filtered
      // out of the default list) — never silently fall back to All material.
      showSessionScopeError(`Flashcards cannot be scoped to <strong>${escapeHtml(presetSessionId)}</strong>:
        the session is not in the available list. Check that it exists, then Retry.`);
    } else {
      setSetupStatus('', '');
    }
  } catch {
    // Without the session list we cannot scope generation to a preset
    // session, and "All material" would quietly contradict the page URL.
    if (presetSessionId) {
      showSessionScopeError(`Flashcards cannot be scoped to <strong>${escapeHtml(presetSessionId)}</strong>:
        the session list could not be loaded. Retry to load it and generate.`);
    }
  }
  refreshScope();
}

/** Repopulate the "Search in" list whenever the chosen session changes. */
async function refreshScope() {
  if (!scopeSelect || !sessionSelect) return;
  const sessionId = sessionSelect.value || null;
  const sources = await populateScopeSelect(scopeSelect, scopeNote, { sessionId });
  if (sessionId && sources.length === 0 && scopeNote) {
    scopeNote.textContent = 'This session has no material yet — add material first.';
  }
}

sessionSelect?.addEventListener('change', refreshScope);

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!topicInput || !sessionSelect) return;

  const problem = topicCheck(topicInput);
  if (problem) {
    if (topicError) setTopicError(topicInput, topicError, problem);
    topicInput.focus();
    return;
  }
  if (topicError) setTopicError(topicInput, topicError, '');
  setSetupStatus('', '');

  const topic = topicInput.value.trim();
  const count = Number(countSelect ? countSelect.value : 8);
  const sourceIds = scopeSelect && scopeSelect.value ? [scopeSelect.value] : [];
  const sessionId = sessionSelect.value || null;

  // The page was opened for a specific session; never generate outside it.
  if (presetSessionId && sessionSelect.value !== presetSessionId) {
    showSessionScopeError(`Flashcards cannot be scoped to <strong>${escapeHtml(presetSessionId)}</strong>:
      the session list is not loaded correctly, so the deck could not be saved under it. Retry loading the sessions first.`);
    return;
  }

  if (generateButton) setGenerating(generateButton, GENERATING_LABELS, true);
  try {
    const data = await api.generateFlashcards({ topic, count, sourceIds, sessionId });
    live.textContent = `Deck ready: ${data.cards.length} cards, saved to your library.`;
    if (data.deckId) {
      // Practise the saved deck straight away; its status marks persist.
      window.location.href = `flashcards.html?deck=${encodeURIComponent(data.deckId)}`;
      return;
    }
    window.location.reload();
  } catch (error) {
    if (error.code === 'SESSION_EMPTY') {
      const sessionName = sessionSelect.options[sessionSelect.selectedIndex]?.text || 'that session';
      setSetupStatus('warn', `${icon('info', { size: 16 })} <span><strong>${escapeHtml(sessionName)} has no material yet.</strong>
        Add a file or web page to it first, then generate cards from it.
        <a href="session.html?id=${encodeURIComponent(sessionSelect.value)}">Open ${escapeHtml(sessionName)}</a></span>`);
    } else {
      setSetupStatus('error', `${icon('alert', { size: 16 })} <span>${escapeHtml(errorMessage(error))}</span>`);
    }
  } finally {
    if (generateButton) setGenerating(generateButton, GENERATING_LABELS, false);
  }
});

document.querySelector('[data-create-deck]')?.addEventListener('click', () => {
  document.querySelector('[data-setup]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  topicInput?.focus({ preventScroll: true });
});

/* ---------------------------------------------------------------- init --- */

if (presetTopic && topicInput) topicInput.value = presetTopic;

populateSessionFilter();
populateGeneratorSessionSelect();

if (openDeckId) {
  openDeck(openDeckId);
} else {
  loadLibrary();
}
