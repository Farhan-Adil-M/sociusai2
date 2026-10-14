// Learning Progress — real numbers only, no AI calls and no fabricated data.
//
// Every figure comes from existing authenticated endpoints:
//   GET /api/learner/progress → topics (mastery = correct/total), overall quiz
//                               accuracy, recent activity
//   GET /api/sources          → study-material (file) count
//   GET /api/decks            → flashcard mastery (cards marked "known")
//   GET /api/sessions         → session counts
//
// "Mastered" is deterministic: a topic is mastered at ≥80% mastery — the same
// 0.8 line the backend learner service uses for its "hard" band
// (server/services/learner.js THRESHOLDS). Clicking a topic in the checklist
// records the learner's own mark in this browser (localStorage); a mark
// overrides the computed value and survives reloads. Same data + same marks
// always render the same page.

import { mountShell } from '../components/shell.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, showError, showEmpty, formatRelative,
} from '../ui.js';

mountShell('progress');

/* ------------------------------------------------------------ deterministic */

/** Mastery at or above this percent counts as mastered (backend band: 0.8). */
const MASTERED_AT_PERCENT = 80;

/* -------------------------------------------------- learner's own marks */

// Stored per browser, keyed by lowercased topic name. `true` = the learner
// marked the topic mastered, `false` = marked not-mastered. Absent = use the
// computed value (mastery >= MASTERED_AT_PERCENT).
const MARKS_KEY = 'socius_progress_mastered';

function loadMarks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MARKS_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // corrupt or blocked storage → fall back to computed values
  }
}

function saveMarks(marks) {
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
  } catch {
    // Private browsing can block localStorage — marks then last this page
    // view only. Not worth failing the page over.
  }
}

function isMastered(topic, marks) {
  const key = topic.topic.toLowerCase();
  if (typeof marks[key] === 'boolean') return marks[key];
  return topic.masteryPercent >= MASTERED_AT_PERCENT;
}

/* ------------------------------------------------------------- stat boxes */

const byId = (id) => document.getElementById(id);

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

/** Second line under a stat box's number ("average across sessions", …). */
function setValueNote(boxIndex, html) {
  const value = document.querySelectorAll('#viewProgress .progress-stats .stat-box')[boxIndex]
    ?.querySelector('.action-box-value');
  if (value) value.innerHTML = html;
}

/** Add the "Flashcards" / "Sessions" stat boxes once, matching the three the
 *  page ships with. Skipped entirely when the container is missing. */
function ensureExtraStatBoxes() {
  const host = document.querySelector('.progress-stats');
  if (!host || byId('progressFlashcardsStat')) return;
  host.insertAdjacentHTML('beforeend', `
    <article class="top-action-box stat-box" id="progressFlashcardsStat">
      <div class="action-box-head"><span class="action-tag">Flashcards</span></div>
      <div class="action-box-title"><span id="progressFlashcardsKnown">—</span></div>
      <div class="action-box-value">cards marked known</div>
    </article>
    <article class="top-action-box stat-box" id="progressSessionsStat">
      <div class="action-box-head"><span class="action-tag">Sessions</span></div>
      <div class="action-box-title"><span id="progressSessionsCount">—</span></div>
      <div class="action-box-value" id="progressSessionsNote">study sessions</div>
    </article>`);
}

/* --------------------------------------------------------- topics checklist */

function topicItemHtml(topic, mastered) {
  const meta = `${topic.masteryPercent}% mastery · ${topic.correct}/${topic.total} correct`;
  return `
    <div class="topic-item${mastered ? ' is-mastered' : ''}"
         data-topic="${escapeHtml(topic.topic.toLowerCase())}"
         role="checkbox" aria-checked="${mastered}" tabindex="0">
      <span class="topic-checkbox" aria-hidden="true">${mastered ? '✓' : ''}</span>
      <div class="topic-info">
        <span class="topic-name" title="${escapeHtml(topic.topic)}">${escapeHtml(topic.topic)}</span>
        <span class="topic-subject-badge">${escapeHtml(meta)}</span>
      </div>
      <span class="topic-status-label">${mastered ? 'Mastered' : 'In progress'}</span>
    </div>`;
}

function renderTopics(topics, marks) {
  const host = byId('progressTopicsList');
  if (!host) return;

  if (topics.length === 0) {
    setText('progressMasteredFraction', 'No topics yet');
    setText('progressMasteredPercent', '0% mastered');
    setText('progressMasteredBadge', '0 of 0');
    const bar = byId('progressMasteredBar');
    if (bar) bar.style.width = '0%';
    showEmpty(host, {
      iconName: 'target',
      title: 'No topics tracked yet',
      text: 'Mastery is correct answers divided by attempts, per topic. It appears after your first graded quiz.',
      actions: '<a class="btn btn-primary btn-sm" href="quiz.html">Take your first quiz</a>',
    });
    return;
  }

  const masteredCount = topics.filter((topic) => isMastered(topic, marks)).length;
  const percent = Math.round((masteredCount / topics.length) * 100);
  setText('progressMasteredFraction', `${masteredCount} of ${topics.length}`);
  setText('progressMasteredPercent', `${percent}% mastered`);
  setText('progressMasteredBadge', `${masteredCount} of ${topics.length}`);
  const bar = byId('progressMasteredBar');
  if (bar) bar.style.width = `${percent}%`;

  host.innerHTML = topics.map((topic) => topicItemHtml(topic, isMastered(topic, marks))).join('');
}

/* ---------------------------------------------------------- recent activity */

// Reuses the icons those concepts already have elsewhere: `folder` marks
// sessions on the Library page, `archive` marks filing/organising actions.
const ACTIVITY_ICONS = {
  quiz: 'clipboard', upload: 'upload', question: 'message',
  session: 'folder', organize: 'archive', 'deck-failed': 'alert',
};

function renderRecentActivity(progress) {
  const panel = document.querySelector('#viewProgress .view-panel');
  if (!panel) return; // defensive: the section layout changed → skip quietly
  byId('progressActivityPanel')?.remove();

  const activity = progress?.recentActivity || [];
  panel.insertAdjacentHTML('afterend', `
    <div class="view-panel" id="progressActivityPanel">
      <div class="section-head">
        <div>
          <h3 class="upload-panel-heading">Recent activity</h3>
          <p class="upload-panel-desc">Your latest quizzes, uploads and questions.</p>
        </div>
      </div>
      <div id="progressActivityList"></div>
    </div>`);

  const host = byId('progressActivityList');
  if (!host) return;
  if (activity.length === 0) {
    showEmpty(host, {
      iconName: 'clock',
      title: 'No activity yet',
      text: 'Quizzes, uploads and tutor questions show up here as you work through your material.',
      actions: '<a class="btn btn-primary btn-sm" href="study.html">Start studying</a>',
    });
    return;
  }
  host.innerHTML = `<div class="row-list">${activity.map((entry) => `
    <div class="row-item">
      <span class="row-icon">${icon(ACTIVITY_ICONS[entry.type] || 'clock', { size: 15 })}</span>
      <span class="row-main">
        <span class="row-title">${escapeHtml(entry.topic || entry.detail || entry.type)}</span>
        <span class="row-meta">${entry.topic && entry.detail ? `${escapeHtml(entry.detail)} · ` : ''}${formatRelative(entry.at)}</span>
      </span>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ state */

// The latest data, kept where the toggle handler and load() can both reach it.
const state = { topics: [], marks: loadMarks() };

/** One delegated handler: click or keyboard toggles a topic's mastered mark. */
function wireTopicToggles() {
  const host = byId('progressTopicsList');
  if (!host) return;
  const toggle = (item) => {
    const key = item.getAttribute('data-topic');
    const topic = state.topics.find((candidate) => candidate.topic.toLowerCase() === key);
    if (!topic) return;
    state.marks[key] = !isMastered(topic, state.marks);
    saveMarks(state.marks);
    renderTopics(state.topics, state.marks);
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
  const [progressResult, sourcesResult, decksResult, sessionsResult] = await Promise.allSettled([
    api.getProgress(), api.listSources(), api.listDecks(), api.listSessions({ includeArchived: '1' }),
  ]);

  // --- progress (topics, accuracy, activity) — the page's core -------------
  if (progressResult.status === 'fulfilled') {
    const progress = progressResult.value;
    state.topics = progress.topics || [];
    state.marks = loadMarks();
    renderTopics(state.topics, state.marks);

    const overall = progress.overall || { questionsAnswered: 0, accuracyPercent: 0 };
    if (overall.questionsAnswered > 0) {
      setText('progressAccuracy', `${overall.accuracyPercent}%`);
      setValueNote(1, `across ${overall.questionsAnswered} answered question${overall.questionsAnswered === 1 ? '' : 's'}`);
    } else {
      setText('progressAccuracy', '—');
      setValueNote(1, 'No quizzes graded yet — take one to start.');
    }

    renderRecentActivity(progress);
  } else {
    state.topics = [];
    const host = byId('progressTopicsList');
    if (host) showError(host, progressResult.reason, { title: 'Could not load your progress', onRetry: load });
    setText('progressMasteredFraction', '—');
    setText('progressAccuracy', '—');
    setText('progressFilesCount', '—');
  }

  // --- files (study material count) ----------------------------------------
  if (sourcesResult.status === 'fulfilled') {
    const sources = sourcesResult.value.sources || [];
    setText('progressFilesCount', `${sources.length} ${sources.length === 1 ? 'file' : 'files'}`);
    if (sources.length === 0) {
      // Real link to the real upload location (the Study page hosts uploads).
      setValueNote(2, 'No sources yet — <a class="inline-link" href="study.html">add material on the Study page</a>');
    }
  } // on failure the box keeps its "—"; the other blocks still render

  // --- flashcard mastery (cards marked "known") ----------------------------
  if (decksResult.status === 'fulfilled') {
    ensureExtraStatBoxes();
    const decks = decksResult.value.decks || [];
    if (decks.length > 0) {
      const totalCards = decks.reduce((sum, deck) => sum + (deck.cardCount || 0), 0);
      const knownCards = decks.reduce((sum, deck) => sum + (deck.knownCount || 0), 0);
      setText('progressFlashcardsKnown', `${knownCards} of ${totalCards}`);
      const note = document.querySelector('#progressFlashcardsStat .action-box-value');
      if (note) note.textContent = `${totalCards > 0 ? Math.round((knownCards / totalCards) * 100) : 0}% of cards marked known`;
    } else {
      setText('progressFlashcardsKnown', 'No decks yet');
    }
  }

  // --- sessions -------------------------------------------------------------
  if (sessionsResult.status === 'fulfilled') {
    ensureExtraStatBoxes();
    const sessions = sessionsResult.value.sessions || [];
    const active = sessions.filter((session) => session.status === 'active').length;
    const archived = sessions.length - active;
    setText('progressSessionsCount', `${active} ${active === 1 ? 'session' : 'sessions'}`);
    setText('progressSessionsNote', `${archived} archived`);
  }
}

wireTopicToggles();
load();
