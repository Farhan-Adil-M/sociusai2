// =============================================================================
// pages/dashboard.js — the Overview page: "what should I do right now?"
//
// Responsibility: read the learner's rollup, sources, due cards and sessions,
// then render four panels inside the app shell. It owns no data and no rules —
// grading, mastery and due dates all come from the server (see
// docs/API_CONTRACT.md). No filtering, no judging: a topic the server reports
// as "unassessed" is shown as "Not assessed yet", never as level 1.
//
// Data (all through api.js — this file never calls fetch itself):
//   GET /api/learner/progress  topics[], overall, suggestedNext, decks, sources
//   GET /api/sources           sources[]
//   GET /api/decks/due         { dueCount, newCount, cards[] }
//   GET /api/sessions          { sessions[] }  (sort=active; already active-only)
//
// Wave-4 endpoints (/api/adaptive, /planner, /advice, /events …) do NOT exist
// yet, so this page calls none of them. Everything it shows is shipped API.
//
// Every panel is an independent state machine: loading (skeleton), loaded,
// empty (with a real call to action) or error (with retry). One failed request
// never blanks another panel.
//
// Rendering rule: untrusted text (topic names, file titles, card fronts — all
// server data) always goes through escapeHtml(); model/user text is never
// passed to innerHTML raw. Numbers and this file's own class names are safe.
// =============================================================================

import { mountShell } from '../components/shell.js';
import { apiGet } from '../api.js';
import { getUserName } from '../auth.js';
import {
  emptyState,
  errorState,
  escapeHtml,
  formatDate,
  formatRelative,
  icon,
  plural,
  skeleton,
} from '../ui.js';

/* ------------------------------------------------------------------ mapping */

// One icon + plain-English label per material type. ui.js owns the glyph set,
// so these map onto names that exist there today; the label beside each row
// makes the type unmistakable. New glyphs are requested in docs/HANDOFF.md
// rather than pasted into this page (docx/youtube/image reuse book/slides/eye).
const SOURCE_TYPES = {
  pdf: { icon: 'file', label: 'PDF' },
  pptx: { icon: 'slides', label: 'Slides' },
  docx: { icon: 'book', label: 'Word document' },
  webpage: { icon: 'globe', label: 'Web page' },
  youtube: { icon: 'slides', label: 'Video' },
  image: { icon: 'eye', label: 'Image' },
};

// The server's levelLabel enum → a components.css badge variant and the words a
// student reads. "unassessed" is deliberately NOT here: it is not a level.
const LEVELS = {
  foundation: { badge: 'badge', name: 'Foundation' },
  developing: { badge: 'badge-info', name: 'Developing' },
  proficient: { badge: 'badge-success', name: 'Proficient' },
  advanced: { badge: 'badge-accent', name: 'Advanced' },
};

const MAX_TOPICS = 6;
const MAX_SOURCES = 5;
const MAX_DUE_PREVIEW = 3;

/* -------------------------------------------------------------------- nodes */

const hosts = {
  continue: document.querySelector('[data-dashboard-continue]'),
  progress: document.querySelector('[data-dashboard-progress]'),
  due: document.querySelector('[data-dashboard-due]'),
  materials: document.querySelector('[data-dashboard-materials]'),
};

/* ------------------------------------------------------------------ helpers */

/** Mark a panel as busy while its request is in flight (announced to AT). */
function setBusy(key, busy) {
  const host = hosts[key];
  if (host) host.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * Normalise one entry of `GET /api/learner/progress`.topics.
 *
 * `hasEvidence` is the server's own marker, but the honest signal is
 * `masteryPercent`: the contract reports `null` (with `level: null` and
 * `levelLabel: "unassessed"`) for a topic nothing was graded on. Deriving
 * "assessed" from the percentage keeps that distinction even if a payload
 * omits `hasEvidence`, and it can never turn "we have not measured this yet"
 * into "you scored 0%".
 */
function readTopic(entry) {
  const raw = entry ? entry.masteryPercent : null;
  const numeric = Number(raw);
  const assessed = raw !== null && raw !== undefined && Number.isFinite(numeric);
  const percent = assessed ? Math.max(0, Math.min(100, Math.round(numeric))) : null;
  const labelKey = entry && LEVELS[entry.levelLabel] ? entry.levelLabel : null;
  return {
    topic: String((entry && entry.topic) || ''),
    assessed,
    percent,
    level: assessed && Number.isInteger(entry.level) ? entry.level : null,
    levelLabel: labelKey,
    needsRevision: Boolean(entry && entry.needsRevision),
    lastPracticedAt: (entry && entry.lastPracticedAt) || null,
    correct: Number((entry && entry.correct) || 0),
    total: Number((entry && entry.total) || 0),
  };
}

/** "3 topics" / "1 topic" — a tiny wrapper so the wording stays consistent. */
function countTopics(n) {
  return plural(n, 'topic');
}

/** The level badge: a real level, "Not assessed yet", or nothing if level is absent. */
function levelBadge(topic) {
  if (!topic.assessed) return '<span class="badge">Not assessed yet</span>';
  if (!topic.level || !topic.levelLabel) return '';
  // topic.levelLabel is only ever set when LEVELS holds it (see readTopic).
  const level = LEVELS[topic.levelLabel];
  return `<span class="badge ${level.badge}">`
    + `Level ${topic.level} · ${escapeHtml(level.name)}</span>`;
}

/** One snapshot row: topic name, level badge, mastery bar, evidence line. */
function topicRow(topic) {
  const head = `<div class="dash-topic__head">
      <span class="row-title truncate dash-topic__name">${escapeHtml(topic.topic)}</span>
      ${levelBadge(topic)}
    </div>`;

  const bar = topic.assessed
    ? `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="${topic.percent}" aria-label="${escapeHtml(topic.topic)} mastery">
         <div class="progress-bar" style="width:${topic.percent}%"></div>
       </div>`
    : '';

  const meta = topic.assessed
    ? `${topic.percent}% mastery · ${topic.correct}/${topic.total} correct`
      + (topic.lastPracticedAt ? ` · practised ${formatRelative(topic.lastPracticedAt)}` : '')
    : 'No graded answers yet — this level appears after the first submitted quiz.';

  const flag = topic.needsRevision
    ? '<div class="cluster-2"><span class="badge badge-warn">Needs revision</span></div>'
    : '';

  return `<div class="dash-topic">${head}${bar}<span class="row-meta">${escapeHtml(meta)}</span>${flag}</div>`;
}

/** "PDF · 14 pages · 12 Oct 2026" — only the parts the server actually sent. */
function sourceMeta(source) {
  const parts = [SOURCE_TYPES[source.type]?.label || 'Material'];
  // `sizeLabel` is pre-formatted by the server, but the types that only Wave 4
  // can ingest (youtube, image) have no label rule yet and come back as
  // "null slides". Printing that would be noise, so it is dropped.
  const size = source.sizeLabel ? String(source.sizeLabel) : '';
  if (size && !/\bnull\b/i.test(size)) parts.push(size);
  const created = formatDate(source.createdAt);
  if (created) parts.push(created);
  return parts.join(' · ');
}

/** One "row with an action" used inside the Continue panel. */
function actionRow({ iconName, title, meta, href, label }) {
  return `<div class="cluster-3">
      <span class="row-icon">${icon(iconName, { size: 15 })}</span>
      <span class="row-main">
        <span class="row-title truncate">${escapeHtml(title)}</span>
        <span class="row-meta">${escapeHtml(meta)}</span>
      </span>
      <a class="btn btn-secondary btn-sm" href="${escapeHtml(href)}">${escapeHtml(label)}</a>
    </div>`;
}

/**
 * Why the server picked this topic, in words, using the evidence it sent.
 * Nothing is inferred: an unassessed topic says so instead of quoting a score.
 */
function nextStepReason(next, topic) {
  const difficulty = typeof next.difficulty === 'string' ? next.difficulty : 'medium';
  if (!topic) {
    return `No graded answers yet, so the first quiz sets the level. It will run at ${difficulty} difficulty.`;
  }
  if (!topic.assessed) {
    return `Nothing has been graded on this yet. The first quiz starts at ${difficulty} difficulty and sets the level.`;
  }
  const level = topic.level
    ? `Level ${topic.level}${topic.levelLabel ? ` (${LEVELS[topic.levelLabel].name.toLowerCase()})` : ''} — `
    : '';
  return `${level}${topic.percent}% mastery over ${plural(topic.total, 'answered question')}. `
    + `The next quiz runs at ${difficulty} difficulty.`;
}

/** The most recently active study session that actually holds something. */
function firstUsableSession(payload) {
  const list = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
  return list.find((session) => session
    && session.status !== 'archived'
    && session.title
    && (Number(session.sourceCount) > 0 || Number(session.deckCount) > 0)) || null;
}

/* ------------------------------------------------------------------- states */

/** Skeletons in every panel, before any request goes out. */
function renderLoading() {
  Object.keys(hosts).forEach((key) => setBusy(key, true));
  hosts.continue.innerHTML = skeleton(4);
  hosts.progress.innerHTML = skeleton(4);
  hosts.due.innerHTML = skeleton(3);
  hosts.materials.innerHTML = `<div class="panel-body">${skeleton(3)}</div>`;
}

/** Date eyebrow + greeting. The name is only readable after auth has booted. */
function renderPageHead() {
  const date = document.querySelector('[data-dashboard-date]');
  if (date) {
    date.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  }
}

function renderGreeting() {
  const node = document.querySelector('[data-dashboard-greeting]');
  if (!node) return;
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = getUserName();
  // textContent, not innerHTML: the display name is user-controlled.
  node.textContent = name ? `${part}, ${name}` : part;
}

/* --------------------------------------------------------------- 1 · continue */

function renderContinue(progress, due, sessions) {
  const host = hosts.continue;
  setBusy('continue', false);

  const topics = Array.isArray(progress.topics) ? progress.topics.map(readTopic) : [];
  // `suggestedNext` is only usable when it carries a real topic string — the
  // contract says it is `null` until something has been practised.
  const next = progress.suggestedNext && typeof progress.suggestedNext.topic === 'string'
    && progress.suggestedNext.topic.trim()
    ? progress.suggestedNext
    : null;
  const nextTopic = next
    ? topics.find((topic) => topic.topic.toLowerCase() === next.topic.trim().toLowerCase())
    : null;

  const dueTotal = due
    ? (Number(due.newCount) || 0) + (Number(due.dueCount) || 0)
    : Number(progress.decks && progress.decks.dueCards) || 0;

  const rows = [];

  if (dueTotal > 0) {
    rows.push(actionRow({
      iconName: 'cards',
      title: `${plural(dueTotal, 'flashcard')} ready to review`,
      meta: 'Cards come back when they are due, so you revise what is fading.',
      href: 'flashcards.html',
      label: 'Review cards',
    }));
  }

  const session = firstUsableSession(sessions);
  if (session) {
    const parts = [];
    if (Number(session.sourceCount) > 0) parts.push(plural(Number(session.sourceCount), 'item'));
    if (Number(session.deckCount) > 0) parts.push(plural(Number(session.deckCount), 'deck'));
    const when = formatRelative(session.lastActivityAt);
    parts.push(when ? `last active ${when}` : 'not opened yet');
    rows.push(actionRow({
      iconName: 'clock',
      title: session.title,
      meta: parts.join(' · '),
      href: `session.html?id=${encodeURIComponent(session.id)}`,
      label: 'Open session',
    }));
  }

  // A topic with no graded answer is a quiz that was generated and never
  // submitted — the contract's documented meaning of the unassessed state.
  const pending = topics.filter((topic) => !topic.assessed);
  if (pending.length > 0) {
    rows.push(actionRow({
      iconName: 'clipboard',
      title: `Unfinished quiz: ${pending[0].topic}`,
      meta: pending.length > 1
        ? `You started ${plural(pending.length, 'quiz', 'quizzes')} without submitting them. Finishing one sets its level.`
        : 'You generated this quiz but have not submitted it. Finishing it sets your level.',
      href: `quiz.html?topic=${encodeURIComponent(pending[0].topic)}`,
      label: 'Finish quiz',
    }));
  }

  if (!next && rows.length === 0) {
    host.innerHTML = emptyState({
      icon: 'spark',
      title: 'Nothing waiting for you yet',
      body: 'Add your first material, then take a short quiz. This panel then points at exactly what to study next.',
      action: '<a class="btn btn-primary btn-sm" href="library.html">Add material</a>'
        + '<a class="btn btn-secondary btn-sm" href="quiz.html">Start a quiz</a>',
    });
    return;
  }

  const topicQuery = next ? encodeURIComponent(next.topic) : '';
  const hero = next
    ? `<div class="dash-next">
        <span class="eyebrow">Suggested next step</span>
        <h3 class="dash-next__title">${escapeHtml(next.topic)}</h3>
        <span class="text-sm">${escapeHtml(nextStepReason(next, nextTopic))}</span>
        <div class="cluster-2">
          <a class="btn btn-primary btn-sm" href="quiz.html?topic=${topicQuery}">Practise this topic</a>
          <a class="btn btn-secondary btn-sm" href="study.html?topic=${topicQuery}">Study it first</a>
        </div>
      </div>`
    : '';

  const list = rows.length ? `<div class="stack-3">${rows.join('')}</div>` : '';
  host.innerHTML = `<div class="stack-4">${hero}${list}</div>`;
}

/* --------------------------------------------------------------- 2 · progress */

function renderProgress(progress) {
  const host = hosts.progress;
  setBusy('progress', false);

  const topics = Array.isArray(progress.topics) ? progress.topics.map(readTopic) : [];

  if (topics.length === 0) {
    host.innerHTML = emptyState({
      icon: 'trend',
      title: 'No mastery data yet',
      body: 'Mastery is your correct answers divided by attempts, topic by topic. It appears after your first graded quiz.',
      action: '<a class="btn btn-primary btn-sm" href="quiz.html">Take a quiz</a>',
    });
    return;
  }

  // The snapshot shows the first `MAX_TOPICS` topics but reserves its last tile
  // for an unassessed one: the server lists zero-evidence topics last, and
  // "you started a quiz and never finished it" is exactly what this page exists
  // to surface — it must not be the row that "See all" hides.
  let shown = topics.slice(0, MAX_TOPICS);
  const firstUnassessed = topics.findIndex((topic) => !topic.assessed);
  if (firstUnassessed >= MAX_TOPICS) {
    shown = [...shown.slice(0, MAX_TOPICS - 1), topics[firstUnassessed]];
  }

  const remaining = topics.length - shown.length;
  const more = remaining > 0
    ? `<hr class="divider">
       <a class="text-sm" href="progress.html">See all ${countTopics(topics.length)}</a>`
    : '';

  // `.grid.grid-2` is components.css: two tiles per row, one on a phone.
  host.innerHTML = `<div class="grid grid-2">${shown.map(topicRow).join('')}</div>${more}`;
}

/* -------------------------------------------------------------- 3 · due cards */

function renderDue(due) {
  const host = hosts.due;
  setBusy('due', false);

  const newCount = Number(due.newCount) || 0;
  const dueCount = Number(due.dueCount) || 0;
  const total = newCount + dueCount;

  if (total === 0) {
    host.innerHTML = emptyState({
      icon: 'cards',
      title: 'Nothing to review yet',
      body: 'Flashcards are made from your own material. Generate a deck and the cards that are ready to study show up here.',
      action: '<a class="btn btn-secondary btn-sm" href="flashcards.html">Open flashcards</a>',
    });
    return;
  }

  const breakdown = [];
  if (newCount > 0) breakdown.push(`${plural(newCount, 'new card')}`);
  if (dueCount > 0) breakdown.push(`${plural(dueCount, 'card')} due for review`);

  const preview = (Array.isArray(due.cards) ? due.cards : [])
    .slice(0, MAX_DUE_PREVIEW)
    .filter((card) => card && typeof card.front === 'string')
    .map((card) => `<div class="cluster-2">
        <span class="row-icon">${icon('cards', { size: 15 })}</span>
        <span class="row-main">
          <span class="row-title truncate">${escapeHtml(card.front)}</span>
          <span class="row-meta">${escapeHtml(card.deckTopic || 'Deck')}</span>
        </span>
      </div>`)
    .join('');

  host.innerHTML = `<div class="stack-4">
      <div class="dash-count">
        <span class="dash-count__value">${total}</span>
        <span class="muted">cards ready to review</span>
      </div>
      <span class="row-meta">${escapeHtml(breakdown.join(' · '))}</span>
      ${preview ? `<div class="stack-3">${preview}</div>` : ''}
      <a class="btn btn-primary btn-sm btn-block" href="flashcards.html">Review now</a>
    </div>`;
}

/* -------------------------------------------------------------- 4 · materials */

function renderMaterials(sources) {
  const host = hosts.materials;
  setBusy('materials', false);

  if (sources.length === 0) {
    host.innerHTML = `<div class="panel-body">${emptyState({
      icon: 'inbox',
      title: 'No material yet',
      body: 'Upload a PDF, PowerPoint or Word file, paste a web page, or add a lecture video. The tutor, quizzes and flashcards all answer from your own material.',
      action: '<a class="btn btn-primary btn-sm" href="library.html">Add material</a>',
    })}</div>`;
    return;
  }

  const shown = sources.slice(0, MAX_SOURCES);
  const rows = shown.map((source) => `<div class="row-item">
      <span class="row-icon">${icon(SOURCE_TYPES[source.type]?.icon || 'file', { size: 15 })}</span>
      <span class="row-main">
        <span class="row-title truncate">${escapeHtml(source.title)}</span>
        <span class="row-meta">${escapeHtml(sourceMeta(source))}</span>
      </span>
    </div>`).join('');

  const more = sources.length > shown.length
    ? `<a class="row-item" href="library.html">
        <span class="row-icon">${icon('folder', { size: 15 })}</span>
        <span class="row-main">
          <span class="row-title">See all ${plural(sources.length, 'item')}</span>
        </span>
      </a>`
    : '';

  host.innerHTML = `<div class="row-list">${rows}${more}</div>`;
}

/* ------------------------------------------------------------------ summary */

function renderSummary(progress, sources) {
  const node = document.querySelector('[data-dashboard-summary]');
  if (!node) return;

  const topics = Array.isArray(progress.topics) ? progress.topics.map(readTopic) : [];
  const assessed = topics.filter((topic) => topic.assessed);
  const revision = assessed.filter((topic) => topic.needsRevision).length;
  const dueTotal = Number(progress.decks && progress.decks.dueCards) || 0;
  const sourceCount = sources
    ? sources.length
    : Number(progress.sources && progress.sources.count) || 0;

  const parts = [
    assessed.length === 0 ? 'No quiz attempts yet' : `${countTopics(assessed.length)} tracked`,
  ];
  if (revision > 0) parts.push(`${countTopics(revision)} to revise`);
  if (dueTotal > 0) parts.push(`${plural(dueTotal, 'flashcard')} due`);
  parts.push(sourceCount === 0 ? 'your library is empty' : `${plural(sourceCount, 'item')} of material`);

  node.textContent = parts.join(' · ');
}

/* --------------------------------------------------------------------- load */

async function load() {
  renderLoading();

  const [progressResult, sourcesResult, dueResult, sessionsResult] = await Promise.allSettled([
    apiGet('/api/learner/progress'),
    apiGet('/api/sources'),
    apiGet('/api/decks/due?limit=50'),
    apiGet('/api/sessions?sort=active'),
  ]);

  const progress = progressResult.status === 'fulfilled' ? progressResult.value : null;
  const due = dueResult.status === 'fulfilled' ? dueResult.value : null;
  // The session list only feeds one optional row of the Continue panel, so a
  // failure here is not worth an error state over the whole panel: the row is
  // simply omitted, and the Flashcards/quiz rows still render. Same for the
  // `decks.dueCards` fallback used when /api/decks/due fails.
  const sessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : null;
  const sources = sourcesResult.status === 'fulfilled'
    ? (Array.isArray(sourcesResult.value.sources) ? sourcesResult.value.sources : [])
    : null;

  // The rollup feeds both Continue and Progress snapshot; if it failed, both
  // say so and offer a retry (each gets its own node — a DOM node can only
  // live in one place).
  if (progress) {
    renderContinue(progress, due, sessions);
    renderProgress(progress);
    renderSummary(progress, sources);
  } else {
    setBusy('continue', false);
    setBusy('progress', false);
    hosts.continue.replaceChildren(errorState(progressResult.reason, load, {
      title: 'Could not load your next step',
    }));
    hosts.progress.replaceChildren(errorState(progressResult.reason, load, {
      title: 'Could not load your progress',
    }));
  }

  if (due) {
    renderDue(due);
  } else {
    setBusy('due', false);
    hosts.due.replaceChildren(errorState(dueResult.reason, load, {
      title: 'Could not load your flashcards',
    }));
  }

  if (sources) {
    renderMaterials(sources);
  } else {
    setBusy('materials', false);
    const wrapper = document.createElement('div');
    wrapper.className = 'panel-body';
    wrapper.appendChild(errorState(sourcesResult.reason, load, {
      title: 'Could not load your material',
    }));
    hosts.materials.replaceChildren(wrapper);
  }
}

/* --------------------------------------------------------------------- boot */

async function start() {
  renderPageHead();
  renderLoading();

  await mountShell({ page: 'dashboard' });

  // In Supabase mode requireSignIn() has sent an unauthenticated visitor to
  // login.html and the shell did not mount — nothing left to render.
  const shell = document.getElementById('app-shell');
  if (!shell || !shell.classList.contains('app-shell')) return;

  renderGreeting(); // auth has booted by now, so the display name is readable
  await load();
}

start();
