// =============================================================================
// pages/activity.js — the study activity feed (A40).
//
// ONE data source: GET /api/events (docs/API_CONTRACT.md v2.0). Every row is a
// real stored event — an id, a type, a timestamp and a detail the app wrote
// when the student did something. This page never invents an entry, a count or
// a timestamp: when the history is empty it says so.
//
// Three things the page must show honestly:
//
//   1. ONE ROW PER ACTION. Some actions are written to the activity table
//      twice (the older `quiz` row plus the `quiz_answered` study event). The
//      server collapses them and says which two stored rows it saw
//      (`recordedAs: ['quiz', 'quiz_answered']`), so this page prints that note
//      instead of silently hiding a row or showing the same action twice.
//
//   2. A LINK ONLY WHEN THERE IS SOMETHING REAL TO LINK. `ref` is resolved by
//      the server from the user's own quiz/source table; it is absent when no
//      single unambiguous record exists, so nothing is printed for it rather
//      than a made-up title.
//
//   3. UNASSESSED IS NOT LEVEL 1. `topicMastery.level` is `null` and
//      `levelLabel` is "unassessed" for a topic with no graded answers, and
//      that renders as "Not assessed yet" — never as 0% and never as level 1.
//      The page derives nothing from a percentage: the thresholds live in the
//      server's learner model.
//
// Accessibility: a real h1/h2, a role="status" live region for loading and
// "load older" announcements, aria-busy on the host while a request is in
// flight, <time datetime> on every timestamp, ordinary buttons/select for
// keyboard use, and focus kept on the control that was used after a re-render.
//
// SHELL HAZARD (A30's finding): this page never renders into a bare
// `data-content` hook — that is the shell's own slot, and writing into it wipes
// the topbar and <main>. Every hook here is prefixed with the page name
// (`data-activity-*`). The page module renders its own header, so the page's
// HTML only has to provide the `[data-activity-root]` host.
// =============================================================================

import { mountShell } from '../components/shell.js';
import { apiGet } from '../api.js';
import {
  emptyState,
  escapeHtml,
  errorState,
  formatRelative,
  icon,
  plural,
  skeleton,
  spinner,
} from '../ui.js';

// The feed's page key in shell.js's navigation. Until a nav entry for it
// exists the shell marks nothing active — honest, and the page still works.
await mountShell({ page: 'activity' });

const root = document.querySelector('[data-activity-root]');
const liveRegion = document.querySelector('[data-activity-live]');

if (!root) {
  console.error('[activity] This page has no [data-activity-root] element — the feed cannot mount.');
}

/* ------------------------------------------------------------------ reading */

// Stored activity type → the words and glyph a student would use. `question`
// and `source_uploaded` are the older names for `tutor_asked` / `upload`; an
// unknown type still renders readably instead of disappearing.
const ACTIVITY_TYPES = Object.freeze({
  upload: { icon: 'upload', label: 'Uploaded material' },
  source_uploaded: { icon: 'upload', label: 'Uploaded material' },
  session: { icon: 'folder', label: 'Study session' },
  session_opened: { icon: 'folder', label: 'Opened a study session' },
  organize: { icon: 'folder', label: 'Organised material' },
  tutor_asked: { icon: 'message', label: 'Asked the tutor' },
  question: { icon: 'message', label: 'Asked the tutor' },
  quiz_generated: { icon: 'clipboard', label: 'Generated a quiz' },
  quiz_answered: { icon: 'checkCircle', label: 'Answered a quiz' },
  quiz: { icon: 'checkCircle', label: 'Answered a quiz' },
  card_reviewed: { icon: 'cards', label: 'Reviewed flashcards' },
  level_changed: { icon: 'trend', label: 'Level changed' },
  'deck-failed': { icon: 'alert', label: 'Deck generation failed' },
});

// The level badge, matching the mapping A22's dashboard and A29's planner use
// (foundation = neutral, developing = info, proficient = success, advanced =
// accent). Unassessed is deliberately a plain neutral badge — never coloured.
const LEVEL_BADGE = Object.freeze({
  foundation: 'badge',
  developing: 'badge badge-info',
  proficient: 'badge badge-success',
  advanced: 'badge badge-accent',
});

// The filter's options. Every one names types the server actually writes, so no
// option can present a view that is empty by construction.
const FILTERS = Object.freeze([
  { value: '', label: 'All activity' },
  { value: 'quiz_answered,quiz', label: 'Quiz results' },
  { value: 'upload,source_uploaded', label: 'Uploaded material' },
  { value: 'tutor_asked,question', label: 'Tutor questions' },
  { value: 'card_reviewed', label: 'Flashcard reviews' },
  { value: 'level_changed', label: 'Level changes' },
]);

const PAGE_SIZE = 20; // the endpoint's default, and a sensible screenful

let events = []; // rows currently on screen, oldest last
let nextCursor = null; // the server's cursor for the next page; null at the end
let filter = ''; // the `type` query value in force
let loading = false; // exactly one request at a time

function announce(message) {
  if (liveRegion) liveRegion.textContent = message;
}

function humaniseType(type) {
  const words = String(type ?? 'activity').replace(/[_-]+/g, ' ').trim();
  return words === '' ? 'Activity' : words.charAt(0).toUpperCase() + words.slice(1);
}

function typeMeta(type) {
  return ACTIVITY_TYPES[String(type)] ?? { icon: 'clock', label: humaniseType(type) };
}

/** The topic's measured level NOW, from the server's learner model. */
function levelBadge(mastery) {
  if (!mastery || mastery.hasEvidence !== true) {
    return '<span class="badge" title="No graded answers yet — this topic has not been measured.">Not assessed yet</span>';
  }
  const label = String(mastery.levelLabel ?? '').toLowerCase();
  const variant = LEVEL_BADGE[label] ?? 'badge';
  const percent = Number.isFinite(mastery.masteryPercent) ? ` · ${mastery.masteryPercent}% mastery` : '';
  return `<span class="${variant}" title="Measured from your graded answers${percent}.">${escapeHtml(label)}</span>`;
}

/** The real record the event is about — or nothing at all. */
function referenceLine(event) {
  const ref = event?.ref;
  if (!ref || typeof ref.id !== 'string' || ref.id === '') return '';
  const kind = ref.kind === 'source' ? 'Material' : ref.kind === 'quiz' ? 'Quiz' : 'Record';
  const label = typeof ref.label === 'string' && ref.label.trim() !== '' ? ref.label.trim() : null;
  // No page deep-links one source or quiz id today, so this prints the real
  // record's label with its real id in the tooltip — never a link that leads
  // nowhere useful.
  return `<span class="row-meta" title="${escapeHtml(kind)} id ${escapeHtml(ref.id)}">`
    + `${escapeHtml(kind)}${label ? `: ${escapeHtml(label)}` : ''}</span>`;
}

function eventRow(event) {
  const meta = typeMeta(event?.type);
  const topic = typeof event?.topic === 'string' ? event.topic.trim() : '';
  const detail = typeof event?.detail === 'string' ? event.detail.trim() : '';
  const when = typeof event?.at === 'string' ? event.at : '';
  const relative = when ? formatRelative(when) : '';

  const title = topic || meta.label;
  const parts = [];
  if (topic) parts.push(meta.label);
  if (detail) parts.push(detail);

  const recordedTwice = Array.isArray(event?.recordedAs) && event.recordedAs.length === 2;

  return `<li class="row-item">
    <span class="row-icon" aria-hidden="true">${icon(meta.icon, { size: 15 })}</span>
    <div class="row-main">
      <div class="cluster cluster-2">
        <span class="row-title">${escapeHtml(title)}</span>
        ${event?.topicMastery ? levelBadge(event.topicMastery) : ''}
      </div>
      ${parts.length > 0 ? `<span class="row-meta">${escapeHtml(parts.join(' · '))}</span>` : ''}
      ${referenceLine(event)}
      ${recordedTwice
        ? `<span class="row-meta" title="Two stored events for this ${escapeHtml(title)}: `
          + `${escapeHtml(event.recordedAs.join(' + '))}">Recorded twice by the app — shown as one row.</span>`
        : ''}
    </div>
    ${relative ? `<time class="row-meta" datetime="${escapeHtml(when)}">${escapeHtml(relative)}</time>` : ''}
  </li>`;
}

/* ------------------------------------------------------------------ render */

function pageHeadHtml() {
  // The live/busy state is NOT baked into the markup: a re-render replaces the
  // controls, so paint() re-applies the current state to the new elements right
  // after every render (see setBusy). Baking `disabled` in here is what left
  // the Refresh button and the "show only" select permanently disabled after
  // the first load — found in the browser, not by any test.
  return `<header class="page-head">
    <div>
      <p class="eyebrow">Study history</p>
      <h1>Your activity</h1>
      <p>Everything the app recorded while you studied, newest first — uploads, quizzes,
        tutor questions and level changes. Each line is a real stored event; nothing here is
        guessed or filled in for you.</p>
    </div>
    <div class="page-head-actions">
      <label class="sr-only" for="activity-filter">Show only</label>
      <select class="select" id="activity-filter" data-activity-filter>
        ${FILTERS.map((entry) => `<option value="${escapeHtml(entry.value)}"${entry.value === filter ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-secondary btn-sm" data-activity-refresh>
        ${icon('refresh', { size: 14 })} Refresh
      </button>
    </div>
  </header>`;
}

const CONTROLS = ['[data-activity-refresh]', '[data-activity-more]', '[data-activity-filter]'];

// Which control the student was using, remembered across a re-render. A render
// replaces the controls (brand-new elements and state), and `setBusy(true)`
// disables the one that has focus — which by itself moves focus to <body>.
// Remembering the selector BEFORE that happens is what lets the page hand focus
// back afterwards, so a keyboard user never loses their place.
let focusedControl = null;

function feedPanel(list, { more }) {
  const body = list.length === 0
    ? `<div class="panel-body">${emptyState({
      icon: 'clock',
      title: filter ? 'Nothing of that kind yet' : 'No activity yet',
      body: filter
        ? 'No event of that type has been recorded for your account. Choose “All activity” to see everything.'
        : 'Uploads, generated quizzes, quiz results and tutor questions appear here as soon as you do them.',
      action: '<a class="btn btn-primary btn-sm" href="library.html">Add study material</a>'
        + '<a class="btn btn-secondary btn-sm" href="quiz.html">Take a quiz</a>'
        + '<a class="btn btn-secondary btn-sm" href="study.html">Ask the tutor</a>',
    })}</div>`
    : `<ul class="row-list">${list.map(eventRow).join('')}</ul>`;

  return `<section class="panel" aria-labelledby="activity-heading">
    <div class="panel-head">
      <h2 class="panel-title" id="activity-heading">Recent activity</h2>
      <span class="muted text-xs">${escapeHtml(plural(list.length, 'event'))} shown, newest first</span>
    </div>
    ${body}
    ${more ? `<div class="panel-body">
      <button type="button" class="btn btn-secondary btn-sm" data-activity-more>
        ${icon('plus', { size: 14 })} Load older activity
      </button>
    </div>` : ''}
  </section>`;
}

function paint(html) {
  root.innerHTML = html;
  // Every render creates brand-new controls, so the busy state has to be
  // re-applied here rather than written into the markup.
  setBusy(loading);
}

function renderFeed({ more = false } = {}) {
  paint(`${pageHeadHtml()}${feedPanel(events, { more })}`);
}

function renderLoading() {
  paint(`${pageHeadHtml()}
    <div class="cluster cluster-2">${spinner('Loading your activity…')}</div>
    <section class="panel" aria-hidden="true">
      <div class="panel-head"><span class="panel-title">Recent activity</span></div>
      <div class="panel-body">${skeleton(6)}</div>
    </section>`);
}

/* -------------------------------------------------------------------- load */

function setBusy(busy) {
  if (busy && focusedControl === null) {
    const active = document.activeElement;
    if (active && root?.contains(active)) focusedControl = CONTROLS.find((selector) => active.matches(selector)) ?? null;
  }
  loading = busy;
  root.setAttribute('aria-busy', busy ? 'true' : 'false');
  // The controls are re-created by every render, so the live state is applied
  // to whichever ones currently exist.
  for (const selector of CONTROLS) {
    const node = root.querySelector(selector);
    if (!node) continue;
    node.disabled = busy;
    if (busy) node.setAttribute('aria-busy', 'true');
    else node.removeAttribute('aria-busy');
  }
  if (!busy && focusedControl !== null) {
    // The control can go with the page it was on (the final "load older"
    // removes the button), so fall back to Refresh, which always exists.
    const selector = focusedControl;
    focusedControl = null;
    (root.querySelector(selector) ?? root.querySelector('[data-activity-refresh]'))?.focus();
  }
}

async function load(reset = true) {
  if (loading) return;
  // Loading "older" with no cursor left is really a fresh load.
  const fromScratch = reset || !nextCursor;

  setBusy(true);
  if (fromScratch) {
    events = [];
    nextCursor = null;
    renderLoading();
    announce('Loading your activity…');
  }

  try {
    // PAGE_SIZE, the active filter and the cursor, as one query string.
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (filter) params.set('type', filter);
    if (!fromScratch && nextCursor) params.set('cursor', nextCursor);
    const data = await apiGet(`/api/events?${params.toString()}`);
    const page = Array.isArray(data?.events) ? data.events : [];
    const before = events.length;
    events = fromScratch ? page : events.concat(page);
    nextCursor = typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null;
    renderFeed({ more: nextCursor !== null });
    announce(fromScratch
      ? (page.length > 0 ? `${plural(page.length, 'event')} loaded, newest first.` : 'No activity has been recorded yet.')
      : `${plural(events.length - before, 'older event')} loaded — ${plural(events.length, 'event')} in total.`);
  } catch (error) {
    if (events.length === 0) {
      // Nothing on screen to keep: the whole view becomes the error + retry.
      root.setAttribute('aria-busy', 'false');
      root.replaceChildren(errorState(error, () => load(fromScratch), { title: 'Could not load your activity' }));
      announce('Your activity could not be loaded.');
      return;
    }
    // A failed "load older" keeps the rows already loaded and shows the retry
    // inside the panel, so the student loses nothing.
    const panel = root.querySelector('.panel');
    const node = errorState(error, () => load(false), { title: 'Older activity could not be loaded' });
    if (panel) panel.replaceChildren(node);
    else root.replaceChildren(node);
    announce('Older activity could not be loaded.');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------- start */

if (root) {
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-activity-refresh]')) {
      load(true);
      return;
    }
    if (event.target.closest('[data-activity-more]') && nextCursor) load(false);
  });

  root.addEventListener('change', (event) => {
    const select = event.target.closest('[data-activity-filter]');
    if (!select) return;
    const value = typeof select.value === 'string' ? select.value : '';
    if (value === filter) return;
    filter = value;
    load(true);
  });

  await load(true);
}
