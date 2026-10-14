// Study Planner — a deterministic week built from the learner's real sources.
//
// Every item comes from existing authenticated endpoints:
//   GET /api/sources  → the learner's study materials
//   GET /api/sessions → each source session's last activity (for ordering)
//
// The rule, in full: sources are ordered least-recently-studied first (a
// source's "studied at" is its session's last activity, or its own upload
// date when unsorted; ties break alphabetically), then spread across the
// next 7 days at a fixed 2 sessions per day. Same data → same plan, always.
// No AI calls.
//
// Which sources are "in the plan" is the learner's own choice, stored in
// this browser (localStorage). Client-side state is fine for a planner —
// nothing here is a grade or a mastery number.

import { mountShell } from '../components/shell.js';
import { api } from '../api.js';
import { icon, escapeHtml, showError, showEmpty, typeLabel } from '../ui.js';

mountShell('planner'); // no planner nav item exists in shell.js yet; nothing highlights

/* ------------------------------------------------------------ deterministic */

const SESSIONS_PER_DAY = 2;
const PLAN_DAYS = 7;
const LONG_SESSION_CATEGORIES = new Set(['exam-prep']); // → 40 min, else 25 min

/* -------------------------------------------------- revision choices */

// { [sourceId]: true } = the learner wants this source in the week's plan.
// Absent key = included (a fresh planner starts with everything ticked).
const CHOICES_KEY = 'socius_planner_sources';

function loadChoices() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHOICES_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // corrupt or blocked storage → default (all included)
  }
}

function saveChoices(choices) {
  try {
    localStorage.setItem(CHOICES_KEY, JSON.stringify(choices));
  } catch {
    // Private browsing can block localStorage — choices then last this page
    // view only. Not worth failing the page over.
  }
}

/* ------------------------------------------------------------- ordering */

/** Least-recently-studied first; ties break alphabetically. Deterministic. */
function orderSources(sources, sessionsById) {
  const studiedAt = (source) => {
    const iso = (sessionsById[source.sessionId]?.lastActivityAt) || source.createdAt;
    const time = new Date(iso ?? '').getTime();
    return Number.isNaN(time) ? 0 : time;
  };
  return [...sources].sort((a, b) => {
    const delta = studiedAt(a) - studiedAt(b);
    if (delta !== 0) return delta;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
}

/* ----------------------------------------------------------------- labels */

const CATEGORY_LABELS = {
  subject: 'Subject', research: 'Research', 'self-study': 'Self-study',
  'exam-prep': 'Exam prep', general: 'General',
};
const categoryLabel = (category) => CATEGORY_LABELS[category] || 'Unsorted';

function dayHeading(date, index) {
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${index === 0 ? 'Today' : weekday} · ${day}`;
}

/* ------------------------------------------------------------ render: grid */

function planCardHtml(dayDate, dayIndex, source, sessionsById) {
  const session = sessionsById[source.sessionId] || null;
  const category = session?.category || null;
  const duration = category && LONG_SESSION_CATEGORIES.has(category) ? '40 min' : '25 min';
  const detail = [typeLabel(source.type), source.sizeLabel].filter(Boolean).join(' · ');
  return `
    <article class="planner-card">
      <p class="planner-day">${escapeHtml(dayHeading(dayDate, dayIndex))}</p>
      <h3 class="planner-topic">${escapeHtml(source.title)}</h3>
      <p class="planner-meta">
        <span class="topic-subject-badge">${escapeHtml(categoryLabel(category))}</span>
        <span class="planner-time">${duration}</span>
      </p>
      <p class="planner-state">${escapeHtml(detail)}</p>
    </article>`;
}

function renderGrid(plannedSources, sessionsById, totalIncluded, sourcesEmpty) {
  const grid = document.getElementById('plannerGrid');
  if (!grid) return;

  if (plannedSources.length === 0) {
    if (sourcesEmpty) {
      showEmpty(grid, {
        iconName: 'inbox',
        title: 'No sources yet',
        text: 'Add a PDF, PowerPoint or web page on the Study page, then come back to plan your week.',
        actions: '<a class="btn btn-primary btn-sm" href="study.html">Add material</a>',
      });
      return;
    }
    showEmpty(grid, {
      iconName: 'clock',
      title: 'Nothing planned yet',
      text: 'Tick at least one source above to build this week’s plan.',
    });
    return;
  }

  // Start from local midnight today; setDate handles month ends and DST.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overflow = totalIncluded - plannedSources.length;

  const cards = plannedSources.map((source, index) => {
    const dayIndex = Math.floor(index / SESSIONS_PER_DAY);
    const dayDate = new Date(today);
    dayDate.setDate(today.getDate() + dayIndex);
    return planCardHtml(dayDate, dayIndex, source, sessionsById);
  }).join('');

  const overflowNote = overflow > 0
    ? `<div class="view-panel"><p class="upload-panel-desc">${overflow} more ${overflow === 1 ? 'source' : 'sources'} ${overflow === 1 ? 'does' : 'do'} not fit this week — ${overflow === 1 ? 'it rolls' : 'they roll'} into next week's plan.</p></div>`
    : '';

  grid.innerHTML = `${cards}${overflowNote}`;
}

/* -------------------------------------------------------- render: checklist */

function sourceItemHtml(source, included) {
  const detail = [typeLabel(source.type), source.sizeLabel].filter(Boolean).join(' · ');
  return `
    <div class="topic-item${included ? ' is-mastered' : ''}"
         data-source-id="${escapeHtml(source.id)}"
         role="checkbox" aria-checked="${included}" tabindex="0">
      <span class="topic-checkbox" aria-hidden="true">${included ? '✓' : ''}</span>
      <div class="topic-info">
        <span class="topic-name" title="${escapeHtml(source.title)}">${escapeHtml(source.title)}</span>
        <span class="topic-subject-badge">${escapeHtml(detail)}</span>
      </div>
      <span class="topic-status-label">${included ? 'In plan' : 'Skipped'}</span>
    </div>`;
}

function renderChecklist(sources, choices) {
  const host = document.getElementById('plannerSourcesList');
  if (!host) return;
  if (sources.length === 0) {
    showEmpty(host, {
      iconName: 'inbox',
      title: 'No sources yet',
      text: 'Once you add material, it appears here so you can choose what to revise.',
      actions: '<a class="btn btn-primary btn-sm" href="study.html">Add material</a>',
    });
    return;
  }
  host.innerHTML = sources.map((source) => sourceItemHtml(source, choices[source.id] !== false)).join('');
}

/** Insert the checklist panel + "Plan again" button once, above the grid. */
function ensureChecklistPanel() {
  const grid = document.getElementById('plannerGrid');
  if (!grid || document.getElementById('plannerSourcesPanel')) return;
  grid.insertAdjacentHTML('beforebegin', `
    <div class="view-panel" id="plannerSourcesPanel">
      <div class="section-head">
        <div>
          <h3 class="upload-panel-heading">Choose what to revise</h3>
          <p class="upload-panel-desc">Tick the materials you want in this week's plan.
            Your choices are saved in this browser.</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="plannerRefreshBtn">
          ${icon('refresh', { size: 14 })} Plan again
        </button>
      </div>
      <div class="topics-checklist" id="plannerSourcesList" aria-label="Sources in this week's plan"></div>
    </div>`);
  document.getElementById('plannerRefreshBtn')?.addEventListener('click', load);
}

/* ------------------------------------------------------------------ state */

// Latest data, kept where the checklist handler and render() can both reach it.
const state = { sources: [], sessionsById: {}, choices: loadChoices() };

function includedSources() {
  return orderSources(
    state.sources.filter((source) => state.choices[source.id] !== false),
    state.sessionsById,
  );
}

/** Re-render both surfaces from current state (no network, fully deterministic). */
function render() {
  const planned = includedSources();
  renderChecklist(state.sources, state.choices);
  renderGrid(
    planned.slice(0, PLAN_DAYS * SESSIONS_PER_DAY),
    state.sessionsById,
    planned.length,
    state.sources.length === 0,
  );
}

/** One delegated handler, attached once: click or keyboard ticks a source
 *  in/out of the plan. (The list's HTML is re-rendered; this host survives.) */
let checklistWired = false;
function wireChecklist() {
  const host = document.getElementById('plannerSourcesList');
  if (!host || checklistWired) return;
  checklistWired = true;
  const toggle = (item) => {
    const id = item.getAttribute('data-source-id');
    if (!state.sources.some((source) => source.id === id)) return;
    state.choices[id] = state.choices[id] === false; // absent (true) ↔ false
    saveChoices(state.choices);
    render();
  };
  host.addEventListener('click', (event) => {
    const item = event.target.closest('.topic-item');
    if (item && host.contains(item)) toggle(item);
  });
  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('.topic-item');
    if (!item || !host.contains(item)) return;
    event.preventDefault();
    toggle(item);
  });
}

/* ------------------------------------------------------------------ load */

async function load() {
  const [sourcesResult, sessionsResult] = await Promise.allSettled([
    api.listSources(), api.listSessions({ includeArchived: '1' }),
  ]);

  const grid = document.getElementById('plannerGrid');

  if (sourcesResult.status !== 'fulfilled') {
    if (grid) showError(grid, sourcesResult.reason, { title: 'Could not load your sources', onRetry: load });
    return;
  }

  const sessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value.sessions || [] : [];
  state.sources = sourcesResult.value.sources || [];
  state.sessionsById = Object.fromEntries(sessions.map((session) => [session.id, session]));
  state.choices = loadChoices();

  ensureChecklistPanel();
  wireChecklist();
  render();
}

load();
