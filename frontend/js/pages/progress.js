// =============================================================================
// pages/progress.js — the Learning Progress page (A28).
//
// ONE data source: GET /api/learner/progress (docs/API_CONTRACT.md § learner).
// No AI call, no vector call, no second endpoint, and no re-implementation of
// the learner model in the browser — every number on this page is the server's.
//
// THE RULE THIS PAGE MUST NEVER LOSE (built deliberately by A18 + A20):
// a topic with no graded evidence is "Not assessed yet", NOT level 1.
//   level: null, levelLabel: "unassessed", hasEvidence: false, masteryPercent: null
// means "we have not measured this learner yet". Level 1 means "we measured
// them and they are below 40%". Painting an unmeasured topic as 0% would turn
// an honest "unknown" into a false judgement, so unassessed topics get their own
// chip, their own dashed treatment, no bar and no percentage.
//
// On the wire, the reliable signal for "measured" is a NUMERIC masteryPercent
// (it is `null` exactly when there is no evidence) — `hasEvidence` is the
// explicit flag and wins when present.
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

// The endpoint caps the feed at 10 (docs/API_CONTRACT.md); ask for the maximum
// rather than relying on the default, so the number is visible at the call site.
const ACTIVITY_LIMIT = 10;

// The deterministic 1–4 scale (docs/API_CONTRACT.md § Difficulty levels). We
// only ever RENDER the server's level; we never compute one from a percentage.
const LEVELS = Object.freeze({
  1: { label: 'Foundation', range: 'below 40% mastery' },
  2: { label: 'Developing', range: '40–59% mastery' },
  3: { label: 'Proficient', range: '60–79% mastery' },
  4: { label: 'Advanced', range: '80% mastery or above' },
});

// Fallback for a payload that carries `levelLabel` but not the integer `level`.
const LEVEL_BY_LABEL = Object.freeze({
  foundation: 1, developing: 2, proficient: 3, advanced: 4,
});

// Activity types → how a learner would say them, with the closest existing
// icon (ui.js's sprite). `question` / `source_uploaded` are the older names for
// `tutor_asked` / `upload`; an unknown type still renders readably.
const ACTIVITY_TYPES = Object.freeze({
  upload: { icon: 'upload', label: 'Uploaded material' },
  source_uploaded: { icon: 'upload', label: 'Uploaded material' },
  quiz_generated: { icon: 'clipboard', label: 'Generated a quiz' },
  quiz_answered: { icon: 'checkCircle', label: 'Answered a quiz' },
  quiz: { icon: 'clipboard', label: 'Quiz result' },
  tutor_asked: { icon: 'message', label: 'Asked the tutor' },
  question: { icon: 'message', label: 'Asked the tutor' },
  card_reviewed: { icon: 'cards', label: 'Reviewed flashcards' },
  level_changed: { icon: 'trend', label: 'Level changed' },
  session_opened: { icon: 'folder', label: 'Opened a study session' },
  session: { icon: 'folder', label: 'Study session' },
  organize: { icon: 'folder', label: 'Organised material' },
});

/* ------------------------------------------------------------------ reading */

// One `topics[]` entry, normalised. `unassessed` is the flag the whole page
// hangs on — see the file header.
function readTopic(entry) {
  const topic = typeof entry?.topic === 'string' ? entry.topic.trim() : '';
  const mastery = typeof entry?.masteryPercent === 'number' && Number.isFinite(entry.masteryPercent)
    ? Math.min(100, Math.max(0, Math.round(entry.masteryPercent)))
    : null;

  const level = Number.isInteger(entry?.level) && LEVELS[entry.level]
    ? entry.level
    : LEVEL_BY_LABEL[String(entry?.levelLabel ?? '').toLowerCase()] ?? null;

  return {
    topic,
    masteryPercent: mastery,
    correct: Number(entry?.correct) || 0,
    total: Number(entry?.total) || 0,
    needsRevision: entry?.needsRevision === true,
    lastPracticedAt: typeof entry?.lastPracticedAt === 'string' ? entry.lastPracticedAt : '',
    level,
    // Explicit flag wins; otherwise "has a percentage" is the legacy signal.
    unassessed: entry?.hasEvidence === false || mastery === null,
  };
}

/* --------------------------------------------------------------- topic rows */

/** The level chip. Unassessed gets its own wording — never "Foundation". */
function levelChip(topic) {
  if (topic.unassessed) {
    return '<span class="badge level-chip--0"'
      + ' title="No graded answers yet — this topic has not been measured.">'
      + 'Not assessed yet</span>';
  }
  if (!topic.level) return ''; // payload without a level: show the percentage only
  const meta = LEVELS[topic.level];
  return `<span class="badge level-chip--${topic.level}"`
    + ` title="Level ${topic.level} of 4 — ${escapeHtml(meta.label)}: ${escapeHtml(meta.range)}">`
    + `${escapeHtml(meta.label)}</span>`;
}

/** Determinate mastery bar built from components.css `.progress`. */
function masteryBar(topic) {
  const percent = topic.masteryPercent ?? 0;
  return `<div class="progress-label">
      <span>Mastery</span><strong>${percent}%</strong>
    </div>
    <div class="progress" role="progressbar"
         aria-label="Mastery in ${escapeHtml(topic.topic)}"
         aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar" style="width:${percent}%"></div>
    </div>`;
}

// The unassessed treatment: a dashed placeholder where the bar would be. It
// states what is unknown and how to make it known, and never shows a number.
function notAssessedBox(topic) {
  return `<p class="topic-untracked">
      ${icon('info', { size: 14 })}
      <span>Not assessed yet — no graded answers for this topic.
        <a href="quiz.html?topic=${encodeURIComponent(topic.topic)}">Take a quiz to measure it</a>.</span>
    </p>`;
}

function topicRow(topic) {
  const badges = levelChip(topic);
  const revision = topic.needsRevision ? '<span class="badge badge-warn">Needs revision</span>' : '';
  const practiceNote = topic.unassessed
    ? ''
    : `<span class="row-meta">${topic.correct} of ${plural(topic.total, 'question')} correct${
      topic.lastPracticedAt ? ` · practised ${escapeHtml(formatRelative(topic.lastPracticedAt))}` : ''
    }</span>`;

  return `<li class="row-item topic-row${topic.unassessed ? ' is-unassessed' : ''}">
    <span class="row-icon" aria-hidden="true">${icon(topic.unassessed ? 'spark' : 'trend', { size: 15 })}</span>
    <div class="row-main">
      <div class="topic-row__head">
        <span class="topic-row__name" title="${escapeHtml(topic.topic)}">${escapeHtml(topic.topic)}</span>
        <span class="cluster cluster-2 topic-row__badges">${badges}${revision}</span>
      </div>
      ${topic.unassessed ? notAssessedBox(topic) : masteryBar(topic)}
      ${practiceNote}
    </div>
  </li>`;
}

// A short distribution of where the learner currently sits. Only rendered when
// every assessed topic actually reports a level, so the counts can never
// disagree with the rows below them.
function levelCounts(topics) {
  if (topics.some((topic) => !topic.unassessed && !topic.level)) return '';

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let unassessed = 0;
  for (const topic of topics) {
    if (topic.unassessed) unassessed += 1;
    else if (topic.level) counts[topic.level] += 1;
  }

  const chips = [1, 2, 3, 4].map((level) => `<span class="badge level-chip--${level}"`
    + ` title="Level ${level} of 4 — ${escapeHtml(LEVELS[level].range)}">`
    + `${escapeHtml(LEVELS[level].label)} <strong>${counts[level]}</strong></span>`);
  if (unassessed > 0) {
    chips.push('<span class="badge level-chip--0"'
      + ' title="No graded answers yet — these topics have not been measured.">'
      + `Not assessed <strong>${unassessed}</strong></span>`);
  }
  return `<div class="cluster cluster-2" aria-label="Topics by level">${chips.join('')}</div>`;
}

function topicsSection(topics) {
  if (topics.length === 0) {
    return `<section class="panel" aria-labelledby="topics-heading">
      <div class="panel-head"><h2 class="panel-title" id="topics-heading">Per-topic mastery</h2></div>
      <div class="panel-body">
        ${emptyState({
          icon: 'trend',
          title: 'No topics yet',
          body: 'Mastery is correct answers divided by graded attempts, per topic. It appears after your first quiz.',
          action: '<a class="btn btn-primary btn-sm" href="quiz.html">Take your first quiz</a>'
            + '<a class="btn btn-secondary btn-sm" href="library.html">Add study material</a>',
        })}
      </div>
    </section>`;
  }

  const assessed = topics.filter((topic) => !topic.unassessed);
  const unassessed = topics.filter((topic) => topic.unassessed);
  const rows = assessed.map(topicRow).join('')
    + (unassessed.length > 0
      ? '<li class="topic-divider" role="presentation">Not assessed yet</li>'
        + unassessed.map(topicRow).join('')
      : '');

  return `<section class="panel" aria-labelledby="topics-heading">
    <div class="panel-head">
      <h2 class="panel-title" id="topics-heading">Per-topic mastery</h2>
      ${levelCounts(topics)}
    </div>
    <ul class="row-list">${rows}</ul>
    <p class="topics-legend muted text-xs">
      Levels are measured, not guessed: Foundation below 40% · Developing 40–59% ·
      Proficient 60–79% · Advanced 80% or above.
    </p>
  </section>`;
}

/* ----------------------------------------------------------------- activity */

/** The older names for the newer study-event types. */
function normalType(type) {
  const name = String(type ?? '');
  if (name === 'question') return 'tutor_asked';
  if (name === 'source_uploaded') return 'upload';
  return name;
}

function humaniseType(type) {
  const words = String(type ?? 'activity').replace(/[_-]+/g, ' ').trim();
  return words === '' ? 'Activity' : words.charAt(0).toUpperCase() + words.slice(1);
}

function sameTopic(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** True when two ISO timestamps are within `seconds` of each other. */
function closeInTime(a, b, seconds = 5) {
  const first = Date.parse(a);
  const second = Date.parse(b);
  if (Number.isNaN(first) || Number.isNaN(second)) return false;
  return Math.abs(first - second) <= seconds * 1000;
}

/**
 * One submission writes TWO activity rows — the legacy `quiz` row and the v8
 * `quiz_answered` row (see docs/HANDOFF.md). We do not hide either: rows that
 * describe the same submission (same topic, timestamps within seconds) are
 * merged into ONE row that says it was recorded twice. Everything else renders
 * verbatim, so no real event is ever swallowed.
 */
function groupActivity(rows) {
  const consumed = new Set();
  const out = [];

  rows.forEach((row, index) => {
    if (consumed.has(index)) return;

    if (normalType(row?.type) === 'quiz_answered') {
      const legacy = rows.findIndex((other, otherIndex) => (
        otherIndex !== index
        && !consumed.has(otherIndex)
        && normalType(other?.type) === 'quiz'
        && sameTopic(other?.topic, row?.topic)
        && closeInTime(other?.at, row?.at)
      ));
      if (legacy !== -1) {
        consumed.add(legacy);
        out.push({ ...row, recordedTwice: `${rows[legacy].type} + ${row.type}` });
        return;
      }
    }

    out.push(row);
  });

  return out;
}

function activityRow(entry) {
  const type = normalType(entry?.type);
  const meta = ACTIVITY_TYPES[type] ?? { icon: 'clock', label: humaniseType(entry?.type) };
  const topic = typeof entry?.topic === 'string' ? entry.topic.trim() : '';
  const detail = typeof entry?.detail === 'string' ? entry.detail.trim() : '';
  const when = formatRelative(entry?.at);

  const title = topic || meta.label;
  const parts = [];
  if (topic) parts.push(meta.label);
  if (detail) parts.push(detail);

  return `<li class="row-item">
    <span class="row-icon" aria-hidden="true">${icon(meta.icon, { size: 15 })}</span>
    <span class="row-main">
      <span class="row-title">${escapeHtml(title)}</span>
      ${parts.length > 0 ? `<span class="row-meta">${escapeHtml(parts.join(' · '))}</span>` : ''}
      ${entry?.recordedTwice
      ? `<span class="row-meta feed-note" title="Two stored events for this submission: ${escapeHtml(entry.recordedTwice)}">`
        + 'Recorded twice by the app — shown as one row.</span>'
      : ''}
    </span>
    ${when ? `<time class="row-meta activity-time" datetime="${escapeHtml(entry.at)}">${escapeHtml(when)}</time>` : ''}
  </li>`;
}

function activitySection(activity) {
  const body = activity.length === 0
    ? `<div class="panel-body">${emptyState({
      icon: 'clock',
      title: 'No activity yet',
      body: 'Uploads, generated quizzes and tutor questions appear here as you study.',
      action: '<a class="btn btn-primary btn-sm" href="study.html">Start studying</a>',
    })}</div>`
    : `<ul class="row-list">${activity.map(activityRow).join('')}</ul>`;

  return `<section class="panel" aria-labelledby="activity-heading">
    <div class="panel-head">
      <h2 class="panel-title" id="activity-heading">Recent activity</h2>
      ${activity.length >= ACTIVITY_LIMIT
      ? `<span class="muted text-xs">Showing your ${ACTIVITY_LIMIT} most recent events</span>`
      : ''}
    </div>
    ${body}
  </section>`;
}

/* -------------------------------------------------------------------- stats */

function statCard({ label, value, note, href }) {
  const body = `<p class="eyebrow">${escapeHtml(label)}</p>
    <p class="stat-value">${escapeHtml(value)}</p>
    <p class="stat-note muted text-xs">${escapeHtml(note)}</p>`;
  return href
    ? `<a class="card stat-card" href="${href}">${body}</a>`
    : `<div class="card stat-card">${body}</div>`;
}

function overviewCards(data) {
  const { overall, sources, decks, topics, assessedCount } = data;
  const answered = overall.questionsAnswered;
  const everythingEmpty = topics.length === 0 && overall.quizzesTaken === 0 && sources.count === 0;

  return [
    {
      label: 'Quiz accuracy',
      // 0 answers is NOT 0% accuracy — it is no measurement at all.
      value: answered > 0 ? `${overall.accuracyPercent}%` : '—',
      note: answered > 0 ? `${plural(answered, 'answer')} graded` : 'No graded answers yet',
    },
    {
      label: 'Questions answered',
      value: String(answered),
      note: overall.quizzesTaken > 0
        ? `${plural(overall.quizzesTaken, 'quiz', 'quizzes')} submitted`
        : 'Take a quiz to start',
    },
    {
      label: 'Topics tracked',
      value: String(topics.length),
      note: topics.length === 0
        ? 'None yet'
        : `${assessedCount} with graded answers`,
    },
    {
      label: 'Study materials',
      value: String(sources.count),
      note: sources.count > 0 ? 'Files and pages in your library' : 'Add material to study',
      href: 'library.html',
    },
    {
      label: 'Flashcard decks',
      value: String(decks.count),
      note: decks.count > 0 ? 'Across your topics' : 'Generate a deck from a topic',
      href: 'flashcards.html',
    },
    {
      label: 'Cards due',
      value: String(decks.dueCards),
      note: decks.dueCards > 0 ? 'Waiting for review' : (everythingEmpty ? 'Nothing yet' : 'Nothing waiting'),
      href: 'flashcards.html',
    },
  ];
}

function statsSection(data) {
  const cards = overviewCards(data)
    .map((card) => statCard(card))
    .join('');
  return `<section class="stack stack-3" aria-labelledby="stats-heading">
    <h2 class="eyebrow" id="stats-heading">At a glance</h2>
    <div class="grid grid-3">${cards}</div>
  </section>`;
}

/* ---------------------------------------------------------------- suggested */

function suggestedSection(suggested) {
  const topic = typeof suggested?.topic === 'string' ? suggested.topic.trim() : '';
  if (topic === '') return '';
  const difficulty = typeof suggested.difficulty === 'string' && suggested.difficulty.trim()
    ? suggested.difficulty.trim()
    : '';

  const topicUrl = encodeURIComponent(topic);
  return `<section class="card suggested-next" aria-labelledby="suggested-heading">
    <div class="cluster cluster-between suggested-next__row">
      <div class="stack stack-1">
        <h2 class="eyebrow" id="suggested-heading">Suggested next</h2>
        <p class="suggested-next__topic">Practise <strong>${escapeHtml(topic)}</strong>
          ${difficulty ? `<span class="badge" title="The difficulty your next quiz will use">${escapeHtml(difficulty)} practice</span>` : ''}
        </p>
        <p class="muted text-sm">Chosen from your stored progress.</p>
      </div>
      <div class="cluster cluster-2">
        <a class="btn btn-primary btn-sm" href="quiz.html?topic=${topicUrl}">Take a quiz</a>
        <a class="btn btn-secondary btn-sm" href="study.html?topic=${topicUrl}">Ask the tutor</a>
      </div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ renders */

function renderLoading() {
  const placeholder = `<div class="card">${skeleton(2)}</div>`.repeat(6);
  return `${spinner('Loading your progress…')}
    <div class="grid grid-3">${placeholder}</div>
    <section class="panel" aria-hidden="true">
      <div class="panel-head"><span class="panel-title">Per-topic mastery</span></div>
      <div class="panel-body">${skeleton(6)}</div>
    </section>
    <section class="panel" aria-hidden="true">
      <div class="panel-head"><span class="panel-title">Recent activity</span></div>
      <div class="panel-body">${skeleton(4)}</div>
    </section>`;
}

function renderData(payload) {
  const overall = payload?.overall ?? {};
  const topics = (Array.isArray(payload?.topics) ? payload.topics : []).map(readTopic)
    .filter((topic) => topic.topic !== '');
  const activity = groupActivity(Array.isArray(payload?.recentActivity) ? payload.recentActivity : []);

  const data = {
    topics,
    assessedCount: topics.filter((topic) => !topic.unassessed).length,
    overall: {
      quizzesTaken: Number(overall.quizzesTaken) || 0,
      questionsAnswered: Number(overall.questionsAnswered) || 0,
      accuracyPercent: Number(overall.accuracyPercent) || 0,
    },
    sources: { count: Number(payload?.sources?.count) || 0 },
    decks: {
      count: Number(payload?.decks?.count) || 0,
      dueCards: Number(payload?.decks?.dueCards) || 0,
    },
  };

  return `${suggestedSection(payload?.suggestedNext)}
    ${statsSection(data)}
    ${topicsSection(topics)}
    ${activitySection(activity)}`;
}

/* --------------------------------------------------------------------- load */

async function load(root, refreshButton) {
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = renderLoading();
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
  }

  try {
    const payload = await apiGet(`/api/learner/progress?limit=${ACTIVITY_LIMIT}`);
    root.innerHTML = renderData(payload);
  } catch (error) {
    root.replaceChildren(errorState(error, () => load(root, refreshButton), {
      title: 'Could not load your progress',
    }));
  } finally {
    root.setAttribute('aria-busy', 'false');
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.removeAttribute('aria-busy');
    }
  }
}

/* ------------------------------------------------------------------- start */

await mountShell({ page: 'progress' });

// mountShell() redirected an unauthenticated visitor: nothing to render.
if (document.querySelector('.app-shell')) {
  const root = document.getElementById('progress-root');
  const refreshButton = document.querySelector('[data-refresh]');
  if (root) {
    if (refreshButton) refreshButton.addEventListener('click', () => load(root, refreshButton));
    await load(root, refreshButton);
  }
}
