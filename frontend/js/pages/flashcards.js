// =============================================================================
// pages/flashcards.js — the flashcards page: browse decks, then review cards.
//
// Responsibility: render the student's decks and run one review session. This
// page OWNS NO SCHEDULING. The server's spaced-repetition scheduler
// (server/services/flashcardService.js) decides `ease`, `intervalDays` and
// `dueAt`; the page only displays what a review returns. Card fronts/backs are
// model-generated, so every piece of text goes through escapeHtml() or
// markdownLite() before it reaches the DOM.
//
// Data, all through js/api.js (the only fetch caller):
//   GET    /api/decks                       deck list + per-deck dueCount
//   GET    /api/decks/due?limit&includeNew  the review queue (new + overdue)
//   PATCH  /api/decks/:deckId/cards/:idx    { grade } → the next schedule
//   POST   /api/flashcards/generate         generate AND save a deck
//   DELETE /api/decks/:deckId               remove one deck
//   GET    /api/sessions                    optional scoping for generation
// =============================================================================

import { apiGet, apiPost, apiPatch, apiDelete } from '../api.js';
import { mountShell } from '../components/shell.js';
import {
  escapeHtml,
  markdownLite,
  citationEl,
  emptyState,
  errorState,
  errorMessage,
  toast,
  skeleton,
  formatDate,
  formatRelative,
  plural,
  debounce,
  on,
  icon,
} from '../ui.js';

/* --------------------------------------------------------------- constants */

// The four Anki-style grades the server's scheduler accepts.
const GRADE_BUTTONS = [
  { key: 'again', label: 'Again', hint: 'Forgot it', kbd: '1' },
  { key: 'hard', label: 'Hard', hint: 'Barely', kbd: '2' },
  { key: 'good', label: 'Good', hint: 'Recalled it', kbd: '3' },
  { key: 'easy', label: 'Easy', hint: 'Too easy', kbd: '4' },
];
// The schedule strip and the live announcement read the label off the button
// list, so a grade can never be spelled two different ways.
const GRADE_LABEL = Object.fromEntries(GRADE_BUTTONS.map((grade) => [grade.key, grade.label]));
const KEY_TO_GRADE = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

/* ------------------------------------------------------------------- state */

const state = {
  decks: [],
  due: null, // { cards, dueCount, newCount, asOf }
  dueError: null,
  sessions: [],
  q: '',
  sort: 'recent',
  loading: true,
  error: null,
  createOpen: false,
  study: null, // { queue, index, total, revealed, busy, reviewed, scopeLabel, lastSchedule }
};

const els = {};

/* ---------------------------------------------------------------- utilities */

/** Announce text to screen readers through the study region's live area. */
function announce(text) {
  const live = els.studyRegion.querySelector('[data-live]');
  if (live) live.textContent = text;
}

/** "in 6 days · 12 Nov 2026" from a server-returned review schedule. */
function nextDueText(schedule) {
  if (!schedule || !schedule.dueAt) return 'now';
  const days = Number(schedule.intervalDays);
  if (Number.isFinite(days) && days > 0) {
    return `in ${plural(Math.round(days), 'day')} · ${formatDate(schedule.dueAt)}`;
  }
  return formatDate(schedule.dueAt);
}

/* -------------------------------------------------------------- loading data */

async function loadDecks() {
  const params = new URLSearchParams({ sort: state.sort });
  if (state.q) params.set('q', state.q);
  try {
    const data = await apiGet(`/api/decks?${params.toString()}`);
    state.decks = Array.isArray(data?.decks) ? data.decks : [];
    state.error = null;
  } catch (error) {
    state.error = error;
    state.decks = [];
  }
}

async function loadDue() {
  try {
    const data = await apiGet('/api/decks/due?limit=200&includeNew=1');
    state.due = {
      cards: Array.isArray(data?.cards) ? data.cards : [],
      dueCount: Number(data?.dueCount) || 0,
      newCount: Number(data?.newCount) || 0,
      asOf: data?.asOf ?? null,
    };
    state.dueError = null;
  } catch (error) {
    state.due = null;
    state.dueError = error;
  }
}

/** Reload both the deck list and today's queue, then repaint the library. */
async function loadAll({ silent = false } = {}) {
  if (!silent) {
    state.loading = true;
    state.error = null;
    renderDeckList();
    renderDueBanner();
  }
  await Promise.all([loadDecks(), loadDue()]);
  state.loading = false;
  renderDueBanner();
  renderDeckList();
}

async function loadSessions() {
  try {
    const data = await apiGet('/api/sessions?sort=recent');
    state.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  } catch {
    state.sessions = []; // scoping is a convenience; all-material still works
  }
  renderSessionOptions();
}

/* ------------------------------------------------------------------ rendering */

/** Show the library, the study stage, or the create panel — never two at once. */
function applyMode() {
  const studying = Boolean(state.study);
  els.library.hidden = studying;
  els.headActions.hidden = studying;
  els.dueBanner.hidden = studying; // its "Start review" must not sit above the stage
  els.studyRegion.hidden = !studying;
  els.createPanel.hidden = studying || !state.createOpen;
  els.newDeck.setAttribute('aria-expanded', String(state.createOpen && !studying));
}

function renderDueBanner() {
  const host = els.dueBanner;
  if (state.loading) {
    host.replaceChildren();
    return;
  }
  if (state.dueError) {
    host.innerHTML = `<div class="alert alert-warn" role="status">
      ${icon('alert', { size: 16 })}
      <div>Today’s review queue could not be loaded. ${escapeHtml(errorMessage(state.dueError))}
        <button type="button" class="btn btn-ghost btn-sm" data-retry-due>Try again</button>
      </div>
    </div>`;
    return;
  }
  const ready = state.due ? state.due.cards.length : 0;
  if (ready > 0) {
    host.innerHTML = dueBannerHtml(state.due);
    return;
  }
  if (state.decks.length > 0) {
    host.innerHTML = allDoneHtml();
    return;
  }
  host.replaceChildren();
}

function dueBannerHtml(due) {
  const parts = [];
  if (due.dueCount > 0) parts.push(`${plural(due.dueCount, 'card')} due`);
  if (due.newCount > 0) parts.push(`${plural(due.newCount, 'new card')}`);
  const summary = (parts.length ? parts : [`${plural(due.cards.length, 'card')} ready`]).join(' · ');
  return `<div class="fc-due" role="status">
    <span class="fc-due__icon">${icon('clock', { size: 20 })}</span>
    <div class="fc-due__text">
      <p class="fc-due__title">${escapeHtml(summary)} ready to review</p>
      <p class="text-sm muted">New cards come first, then the ones you have waited longest on. The server schedules each card as you grade it.</p>
    </div>
    <button type="button" class="btn btn-primary" data-study-due>Start review</button>
  </div>`;
}

function allDoneHtml() {
  return `<div class="fc-alldone" role="status">
    <span class="fc-alldone__icon">${icon('checkCircle', { size: 20 })}</span>
    <div>
      <p class="fc-alldone__title">You’re all caught up</p>
      <p class="text-sm muted">Nothing is due right now. Every card you review is scheduled by the server so it returns just before you would forget it — come back when the next one is due.</p>
    </div>
  </div>`;
}

function deckTile(deck) {
  const due = Number(deck.dueCount) || 0;
  const cards = Number(deck.cardCount) || 0;
  const known = Number(deck.knownCount) || 0;
  const topic = deck.topic ?? 'Untitled deck';
  const session = deck.sessionTitle ? `${escapeHtml(deck.sessionTitle)} · ` : '';
  const reviewed = deck.lastReviewedAt
    ? `Reviewed ${escapeHtml(formatRelative(deck.lastReviewedAt))}`
    : 'Not studied yet';
  // One decision — "is anything due?" — drives the badge and the study button,
  // so the two can never disagree about the same deck.
  const dueNow = due > 0;
  return `<article class="card deck-card">
    <div class="deck-card__head">
      <h3 class="deck-card__title truncate" title="${escapeHtml(topic)}">${escapeHtml(topic)}</h3>
      <button type="button" class="btn btn-ghost btn-icon" data-delete-deck="${escapeHtml(deck.id)}"
              aria-label="Delete deck ${escapeHtml(topic)}">${icon('trash', { size: 14 })}</button>
    </div>
    <p class="deck-card__meta muted text-xs">${session}${plural(cards, 'card')} · ${known} known</p>
    <div class="cluster cluster-2">
      ${dueNow
        ? `<span class="badge badge-info">${plural(due, 'card')} due</span>`
        : '<span class="badge badge-success">Caught up</span>'}
      <span class="text-xs muted">${reviewed}</span>
    </div>
    <div class="deck-card__actions">
      <button type="button" class="btn btn-sm ${dueNow ? 'btn-primary' : 'btn-secondary'}"
              data-study-deck="${escapeHtml(deck.id)}" ${dueNow ? '' : 'disabled'}>
        ${dueNow ? `Study ${due}` : 'Nothing due'}
      </button>
    </div>
  </article>`;
}

function renderDeckList() {
  const host = els.deckList;
  if (state.loading) {
    host.innerHTML = `<div class="stack stack-3">${skeleton(6)}</div>`;
    return;
  }
  if (state.error) {
    host.replaceChildren(errorState(state.error, () => loadAll()));
    return;
  }
  if (state.decks.length === 0) {
    if (state.q) {
      host.innerHTML = emptyState({
        icon: 'search',
        title: 'No decks match',
        body: `Nothing matches “${state.q}”. Try another word or clear the search.`,
      });
    } else {
      host.innerHTML = emptyState({
        icon: 'cards',
        title: 'No decks yet',
        body: 'Create a deck from your material and the AI writes grounded question-and-answer cards you can review over time.',
        action: '<button type="button" class="btn btn-primary" data-new-deck>Create a deck</button>'
          + '<a class="btn btn-secondary" href="library.html">Add material</a>',
      });
    }
    return;
  }
  host.innerHTML = `<div class="grid grid-auto">${state.decks.map(deckTile).join('')}</div>`;
}

/* --------------------------------------------------------------- study stage */

function startStudy(cards, scopeLabel) {
  if (!Array.isArray(cards) || cards.length === 0) {
    toast('Nothing is due to review right now.', { variant: 'info' });
    return;
  }
  state.createOpen = false;
  state.study = {
    queue: cards,
    index: 0,
    total: cards.length,
    revealed: false,
    busy: false,
    reviewed: 0,
    scopeLabel: scopeLabel || 'Review',
    lastSchedule: null,
  };
  renderStudy();
  const target = els.studyRegion.querySelector('[data-reveal]');
  if (target) target.focus();
}

function startFromDue() {
  if (!state.due || state.due.cards.length === 0) {
    toast('Nothing is due right now.', { variant: 'info' });
    return;
  }
  startStudy(state.due.cards, 'All due cards');
}

function startFromDeck(deckId) {
  const deck = state.decks.find((item) => item.id === deckId);
  const label = deck ? deck.topic : 'Deck';
  if (!state.due) {
    toast('The review queue is unavailable right now — try again in a moment.', { variant: 'warn' });
    return;
  }
  const cards = state.due.cards.filter((card) => card.deckId === deckId);
  if (cards.length === 0) {
    toast(`Nothing in “${label}” is due right now.`, { variant: 'info' });
    return;
  }
  startStudy(cards, label);
}

function revealButtonHtml() {
  return `<button type="button" class="btn btn-primary btn-lg" data-reveal aria-keyshortcuts="Space">
    ${icon('eye', { size: 16 })}<span>Reveal answer</span><span class="kbd">Space</span>
  </button>`;
}

function gradeButtonsHtml() {
  return `<div class="grade-row" role="group" aria-label="Grade this card">${
    GRADE_BUTTONS.map((grade) => `
      <button type="button" class="btn grade-btn grade-${grade.key}" data-grade="${grade.key}"
              aria-keyshortcuts="${grade.kbd}">
        <span class="kbd">${grade.kbd}</span>
        <span class="grade-btn__label">${escapeHtml(grade.label)}</span>
        <span class="grade-btn__hint">${escapeHtml(grade.hint)}</span>
      </button>`).join('')
  }</div>`;
}

/** The schedule the SERVER returned for the last graded card — shown, not hidden. */
function scheduleStripHtml() {
  const last = state.study && state.study.lastSchedule;
  if (!last) return '';
  const ease = Number(last.ease);
  return `<div class="study__schedule" data-schedule>
    <span class="badge ${last.grade === 'again' ? 'badge-warn' : 'badge-success'}">${escapeHtml(GRADE_LABEL[last.grade] || last.grade)}</span>
    <span>Next review <strong>${escapeHtml(nextDueText(last))}</strong></span>
    ${Number.isFinite(ease) ? `<span class="muted text-xs">ease ${ease.toFixed(2)}</span>` : ''}
    <span class="muted text-xs">reviewed ${plural(last.reviewCount, 'time')}</span>
  </div>`;
}

/** "Card 2 of 8 · 6 cards left" plus the review progress bar. */
function studyProgressHtml(study) {
  const remaining = study.total - study.index;
  const pct = study.total ? Math.round((study.index / study.total) * 100) : 0;
  return `<div class="study__progress">
          <div class="progress-label">
            <span>Card <strong>${study.index + 1}</strong> of <strong>${study.total}</strong></span>
            <span>${escapeHtml(plural(remaining, 'card'))} left</span>
          </div>
          <div class="progress" role="progressbar" aria-label="Review progress"
               aria-valuemin="0" aria-valuemax="${study.total}" aria-valuenow="${study.index}">
            <div class="progress-bar" style="width:${pct}%"></div>
          </div>
        </div>`;
}

/** The card itself: prompt always, answer only once revealed, with citations. */
function studyCardHtml(card, revealed) {
  const citations = Array.isArray(card.citations) ? card.citations : [];
  return `<article class="flashcard">
          <div class="flashcard__side">
            <p class="eyebrow">Prompt</p>
            <div class="prose">${markdownLite(card.front)}</div>
          </div>
          <div class="flashcard__answer" data-answer tabindex="-1"${revealed ? '' : ' hidden'}>
            <hr class="divider">
            <p class="eyebrow">Answer</p>
            <div class="prose">${markdownLite(card.back)}</div>
            ${citations.length ? `<div class="citations">${citations.map(citationEl).join('')}</div>` : ''}
          </div>
        </article>`;
}

function renderStudy() {
  applyMode();
  const region = els.studyRegion;
  const study = state.study;
  if (!study) {
    region.replaceChildren();
    return;
  }
  if (study.index >= study.queue.length) {
    renderStudyComplete();
    return;
  }

  const card = study.queue[study.index];
  region.innerHTML = `
    <div class="panel study">
      <div class="panel-head study__head">
        <div class="study__meta">
          <p class="eyebrow">Reviewing</p>
          <h2 class="panel-title study__title">${escapeHtml(study.scopeLabel)}</h2>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-study-exit>
          ${icon('close', { size: 14 })}<span>Exit</span><span class="kbd">Esc</span>
        </button>
      </div>
      <div class="panel-body stack stack-5">
        ${studyProgressHtml(study)}

        ${studyCardHtml(card, study.revealed)}

        <div class="study__actions">
          ${study.revealed ? gradeButtonsHtml() : revealButtonHtml()}
        </div>
        ${scheduleStripHtml()}
        <p class="sr-only" role="status" aria-live="polite" data-live></p>
      </div>
    </div>`;
}

function renderStudyComplete() {
  const study = state.study;
  const message = study.reviewed > 0
    ? `You reviewed ${plural(study.reviewed, 'card')}. The server has scheduled each one — come back when it is due again.`
    : 'Nothing was due to review. Check back later.';
  els.studyRegion.innerHTML = `
    <div class="panel">
      <div class="panel-body stack stack-5">
        <div class="empty-state study-done">
          <span class="empty-state-icon study-done__icon">${icon('checkCircle', { size: 24 })}</span>
          <p class="empty-state-title">All done for today</p>
          <p class="empty-state-text">${escapeHtml(message)}</p>
          <div class="empty-state-actions">
            <button type="button" class="btn btn-primary" data-study-exit>Back to my decks</button>
          </div>
        </div>
        ${scheduleStripHtml()}
      </div>
    </div>`;
}

function reveal() {
  const study = state.study;
  if (!study || study.revealed || study.index >= study.queue.length) return;
  study.revealed = true;
  renderStudy();
  const answer = els.studyRegion.querySelector('[data-answer]');
  if (answer) answer.focus();
  announce('Answer revealed.');
}

function setGradeBusy(busy) {
  els.studyRegion.querySelectorAll('[data-grade]').forEach((button) => {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  });
}

async function submitGrade(grade) {
  const study = state.study;
  if (!study || study.busy || !study.revealed || study.index >= study.queue.length) return;
  const card = study.queue[study.index];
  if (!card.deckId) return;

  study.busy = true;
  setGradeBusy(true);
  try {
    const result = await apiPatch(`/api/decks/${card.deckId}/cards/${card.idx}`, { grade });
    study.lastSchedule = {
      grade: typeof result.grade === 'string' ? result.grade : grade,
      dueAt: result.dueAt ?? null,
      intervalDays: result.intervalDays ?? null,
      ease: result.ease,
      reviewCount: Number(result.reviewCount) || 0,
    };
    study.reviewed += 1;
    study.index += 1;
    study.revealed = false;
    study.busy = false;
    const finished = study.index >= study.queue.length;
    renderStudy();
    announce(`${GRADE_LABEL[study.lastSchedule.grade] || 'Saved'}. Next review ${nextDueText(study.lastSchedule)}.`);
    if (finished) loadAll({ silent: true });
  } catch (error) {
    study.busy = false;
    setGradeBusy(false);
    toast(errorMessage(error), { variant: 'danger' });
  }
}

function exitStudy() {
  const study = state.study;
  if (!study) return;
  state.study = null;
  renderStudy();
  if (study.reviewed > 0) toast(`Reviewed ${plural(study.reviewed, 'card')}.`, { variant: 'success' });
  loadAll({ silent: true });
}

/* -------------------------------------------------------------- create a deck */

function renderSessionOptions() {
  const select = els.sessionSelect;
  const current = select.value;
  select.innerHTML = ['<option value="">All my material</option>']
    .concat(state.sessions.map((session) => (
      `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`
    )))
    .join('');
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function toggleCreate(open) {
  const wasOpen = state.createOpen;
  const focusWasInside = els.createPanel.contains(document.activeElement);
  state.createOpen = typeof open === 'boolean' ? open : !state.createOpen;
  applyMode();
  if (state.createOpen) {
    els.topic.focus();
    return;
  }
  hideCreateError();
  // Closing must not strand keyboard focus on a now-hidden element.
  if (wasOpen && focusWasInside) els.newDeck.focus();
}

function showCreateError(message) {
  els.createError.textContent = message;
  els.createError.hidden = false;
}

function hideCreateError() {
  els.createError.hidden = true;
  els.createError.textContent = '';
}

function setCreateBusy(busy) {
  els.createSubmit.disabled = busy;
  els.createSubmit.setAttribute('aria-busy', String(busy));
}

async function submitCreate(event) {
  event.preventDefault();
  const topic = els.topic.value.trim();
  if (topic.length < 2) {
    showCreateError('Enter a topic of at least 2 characters.');
    els.topic.focus();
    return;
  }
  const count = Number(els.count.value) || 8;
  const sessionId = els.sessionSelect.value;

  setCreateBusy(true);
  hideCreateError();
  try {
    const body = { topic, count };
    if (sessionId) body.sessionId = sessionId;
    const result = await apiPost('/api/flashcards/generate', body);
    const cards = Array.isArray(result?.cards) ? result.cards : [];
    toast(`Created “${result?.topic || topic}” with ${plural(cards.length, 'card')}.`, { variant: 'success' });
    if (result?.weakEvidence) {
      toast('Your material on this topic is thin, so these cards may be loosely grounded.', {
        variant: 'warn',
        duration: 7000,
      });
    }
    els.topic.value = '';
    toggleCreate(false);
    await loadAll({ silent: true });

    if (result?.deckId && cards.length > 0) {
      const queue = cards.map((card, idx) => ({
        deckId: result.deckId,
        idx,
        front: card.front,
        back: card.back,
        citations: Array.isArray(card.citations) ? card.citations : [],
      }));
      startStudy(queue, result.topic || topic);
    }
  } catch (error) {
    showCreateError(errorMessage(error));
  } finally {
    setCreateBusy(false);
  }
}

async function deleteDeck(deckId) {
  const deck = state.decks.find((item) => item.id === deckId);
  if (!deck) return;
  const confirmed = window.confirm(
    `Delete the deck “${deck.topic}”? Your study material is not affected.`,
  );
  if (!confirmed) return;
  const really = window.confirm('This also removes its review history and cannot be undone. Delete it?');
  if (!really) return;
  try {
    await apiDelete(`/api/decks/${deckId}`);
    toast('Deck deleted.', { variant: 'success' });
    await loadAll({ silent: true });
  } catch (error) {
    toast(errorMessage(error), { variant: 'danger' });
  }
}

/* ----------------------------------------------------------------- keyboard */

function onKeydown(event) {
  const study = state.study;
  if (!study) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === ' ' || event.code === 'Space') {
    if (!study.revealed && study.index < study.queue.length) {
      event.preventDefault();
      reveal();
    }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    exitStudy();
    return;
  }
  const grade = KEY_TO_GRADE[event.key];
  if (grade && study.revealed) {
    event.preventDefault();
    submitGrade(grade);
  }
}

/* -------------------------------------------------------------------- wiring */

const onSearchInput = debounce(() => {
  state.q = els.search.value.trim();
  loadAll({ silent: true });
}, 250);

function cacheEls() {
  els.main = document.querySelector('main');
  els.headActions = document.querySelector('[data-head-actions]');
  els.newDeck = document.querySelector('[data-new-deck]');
  els.createPanel = document.querySelector('[data-create-panel]');
  els.createForm = document.querySelector('[data-create-form]');
  els.topic = document.querySelector('#fc-topic');
  els.count = document.querySelector('#fc-count');
  els.sessionSelect = document.querySelector('[data-session-select]');
  els.createError = document.querySelector('[data-create-error]');
  els.createSubmit = document.querySelector('[data-create-submit]');
  els.dueBanner = document.querySelector('[data-due-banner]');
  els.studyRegion = document.querySelector('[data-study-region]');
  els.library = document.querySelector('[data-library]');
  els.deckList = document.querySelector('[data-deck-list]');
  els.toolbar = document.querySelector('[data-toolbar]');
  els.search = document.querySelector('#fc-search');
  els.sort = document.querySelector('#fc-sort');
}

function wireEvents() {
  on(els.main, 'click', '[data-new-deck]', () => toggleCreate());
  on(els.main, 'click', '[data-close-create]', () => toggleCreate(false));
  on(els.main, 'click', '[data-study-due]', startFromDue);
  on(els.main, 'click', '[data-study-deck]', (event, el) => startFromDeck(el.getAttribute('data-study-deck')));
  on(els.main, 'click', '[data-delete-deck]', (event, el) => deleteDeck(el.getAttribute('data-delete-deck')));
  on(els.main, 'click', '[data-retry-due]', () => loadDue().then(renderDueBanner));

  on(els.studyRegion, 'click', '[data-reveal]', reveal);
  on(els.studyRegion, 'click', '[data-grade]', (event, el) => submitGrade(el.getAttribute('data-grade')));
  on(els.studyRegion, 'click', '[data-study-exit]', exitStudy);

  els.createForm.addEventListener('submit', submitCreate);
  els.toolbar.addEventListener('submit', (event) => event.preventDefault());
  els.search.addEventListener('input', onSearchInput);
  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    loadAll({ silent: true });
  });
  document.addEventListener('keydown', onKeydown);
}

/* ---------------------------------------------------------------------- init */

async function init() {
  await mountShell({ page: 'flashcards' });

  // In Supabase mode a signed-out visitor is redirected and the shell is not
  // mounted; in that case there is nothing for this page to render.
  const host = document.getElementById('app-shell');
  if (!host || !host.classList.contains('app-shell')) return;

  cacheEls();
  wireEvents();
  loadSessions(); // best-effort; the page works without it
  await loadAll();
}

init();
