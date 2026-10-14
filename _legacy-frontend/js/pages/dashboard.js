// Dashboard: pulls the learner rollup and the source list once each, then
// renders the workspace blocks. Every block handles its own loading, empty
// and error state so one failed request never blanks the whole page.
//
// Two markup generations are supported side by side during the redesign
// migration — the pre-redesign hooks ([data-summary], [data-continue],
// [data-mastery] …) and the redesign's ids (#dashboardName, #profileEmail,
// #profileAvatar, #dashboardSearch, #dashboardToast, the stat cards). Every
// lookup is optional: a page shipping only one generation still works.

import { mountShell, currentUser, mountHealthBanner } from '../components/shell.js';
import { authReady, getSupabaseClient } from '../auth.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, showError, showEmpty,
  formatDate, formatRelative, sourceIcon, typeLabel,
} from '../ui.js';

mountShell('dashboard');

const $ = (selector) => document.querySelector(selector);
const byId = (id) => document.getElementById(id);
const setText = (id, value) => { const node = byId(id); if (node) node.textContent = value; };

/* ------------------------------------------------------------ page chrome */

document.querySelectorAll('[data-icon]').forEach((node) => {
  node.innerHTML = icon(node.dataset.icon, { size: node.classList.contains('dash-jump-arrow') ? 16 : 18 });
});

const todayEl = $('[data-today]');
if (todayEl) {
  todayEl.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

const greetingEl = $('[data-welcome]');
const hour = new Date().getHours();
const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

/* ------------------------------------------- identity + toast (redesign) */

const toastHost = byId('dashboardToast');
let toastTimer = null;

/** Short-lived status line in the redesign's toast host. */
function toast(message) {
  if (!toastHost) return;
  toastHost.textContent = message;
  toastHost.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastHost.hidden = true; }, 3200);
}

/** The signed-in email when Supabase owns the session; '' otherwise. */
async function accountEmail() {
  try {
    const client = getSupabaseClient();
    if (!client) return '';
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.user && data.session.user.email) || '';
  } catch {
    return '';
  }
}

/** #dashboardName / #profileEmail / #profileAvatar, plus the legacy greeting. */
function renderIdentity() {
  const name = currentUser();
  setText('dashboardName', name || 'there');
  if (greetingEl) greetingEl.textContent = name ? `${greeting}, ${name}.` : 'Welcome back.';
  accountEmail().then((email) => {
    setText('profileEmail', email || name || 'Prototype mode');
    const avatarEl = byId('profileAvatar');
    const seed = (name || email || 'S').trim();
    if (avatarEl) avatarEl.textContent = seed.charAt(0).toUpperCase();
  });
}
renderIdentity();
authReady().then(renderIdentity);

/* ------------------------------------------------------- health banner */

mountHealthBanner($('[data-health]'));

/* ----------------------------------------------- search (redesign, live) */

const searchInput = byId('dashboardSearch');
const SEARCH_LISTS = ['[data-materials]', '[data-activity]', '[data-revision]'];

/** Filter the dashboard's rendered lists as the learner types. */
function filterLists(rawQuery) {
  const term = rawQuery.trim().toLowerCase();
  let rows = 0;
  let matches = 0;
  SEARCH_LISTS.forEach((selector) => {
    const host = $(selector);
    if (!host) return;
    host.querySelectorAll('.row-item, .revision-item').forEach((row) => {
      rows += 1;
      const match = !term || row.textContent.toLowerCase().includes(term);
      row.style.display = match ? '' : 'none';
      if (match) matches += 1;
    });
  });
  if (rows > 0 && term.length >= 2 && matches === 0) {
    toast('No matches on this page — press Enter to search the library.');
  }
}

if (searchInput) {
  searchInput.addEventListener('input', () => filterLists(searchInput.value));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      filterLists('');
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const term = searchInput.value.trim();
    // The Library page owns full search; `q` is passed for it to pick up.
    if (term) toast(`Searching the library for “${term}”…`);
    window.location.href = term ? `library.html?q=${encodeURIComponent(term)}` : 'library.html';
  });
}

/* ------------------------------------------------------------ summaries */

function renderSummary(progress, sources) {
  const node = $('[data-summary]');
  if (!node) return;
  const topics = progress?.topics || [];
  const revision = topics.filter((topic) => topic.needsRevision).length;
  const parts = [];
  if (topics.length === 0) {
    parts.push('No quiz attempts yet — take one to start tracking mastery.');
  } else if (revision > 0) {
    parts.push(`${revision} ${revision === 1 ? 'topic needs' : 'topics need'} revision.`);
  } else {
    parts.push('Nothing needs revision right now.');
  }
  parts.push(sources.length === 0
    ? 'Add material on the Study page to ask questions.'
    : `${sources.length} ${sources.length === 1 ? 'material is' : 'materials are'} ready to study.`);
  node.textContent = parts.join(' ');
}

/* -------------------------------------------------------- continue block */

function renderContinue(progress) {
  const host = $('[data-continue]');
  if (!host) return;
  const next = progress?.suggestedNext;
  const topics = progress?.topics || [];

  if (!next || !next.topic) {
    host.classList.add('is-empty');
    host.innerHTML = `
      <div class="dash-empty-inline">
        <span class="state-icon">${icon('target', { size: 20 })}</span>
        <div>
          <strong>Nothing to continue yet.</strong>
          <p>Finish one quiz and this becomes your next step, chosen from your lowest mastery.</p>
        </div>
        <a class="btn btn-primary" href="quiz.html">Start a quiz</a>
      </div>`;
    return;
  }

  const match = topics.find((topic) => topic.topic.toLowerCase() === next.topic.toLowerCase());
  const mastery = match ? match.masteryPercent : null;
  const encoded = encodeURIComponent(next.topic);
  const line = mastery === null
    ? `You have not been quizzed on this yet. The first quiz will start at ${escapeHtml(next.difficulty)} level.`
    : `Mastery sits at ${mastery}%, so the next quiz will run at ${escapeHtml(next.difficulty)} level.`;

  host.innerHTML = `
    <div class="dash-continue-inner">
      <div>
        <p class="dash-kicker">Continue studying</p>
        <h2 id="continue-title">${escapeHtml(next.topic)}</h2>
        <p>${line}</p>
      </div>
      <div class="dash-continue-actions">
        <a class="btn btn-primary" href="quiz.html?topic=${encoded}">Quiz me on this</a>
        <a class="btn btn-secondary" href="study.html?topic=${encoded}">Study it</a>
        <a class="btn btn-secondary" href="flashcards.html?topic=${encoded}">Make flashcards</a>
      </div>
    </div>`;
}

/* ------------------------------------------------------------- mastery */

function renderMastery(progress, materialCount = 0) {
  const host = $('[data-mastery]');
  if (!host) return;
  const meta = $('[data-mastery-meta]');
  const topics = progress?.topics || [];
  const overall = progress?.overall || { quizzesTaken: 0, questionsAnswered: 0, accuracyPercent: 0 };

  if (topics.length === 0) {
    if (meta) meta.textContent = '';
    showEmpty(host, {
      iconName: 'trend',
      title: 'No mastery data yet',
      text: 'Mastery is correct answers divided by attempts, per topic. It appears after your first graded quiz.',
      actions: '<a class="btn btn-primary btn-sm" href="quiz.html">Take the first quiz</a>',
    });
    return;
  }

  const average = Math.round(topics.reduce((sum, topic) => sum + topic.masteryPercent, 0) / topics.length);
  if (meta) meta.textContent = `${topics.length} ${topics.length === 1 ? 'topic' : 'topics'} tracked`;

  // With one topic "overall accuracy" and "average mastery" are the same number —
  // show the material count instead of a duplicated stat.
  const materialsTile = `<div class="stat"><span class="stat-value">${materialCount}</span><span class="stat-label">Materials ready</span></div>`;
  const averageTile = `<div class="stat"><span class="stat-value">${average}%</span><span class="stat-label">Average mastery</span></div>`;

  const stats = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-value">${overall.accuracyPercent}%</span><span class="stat-label">Overall accuracy</span></div>
      ${topics.length > 1 ? averageTile : materialsTile}
      <div class="stat"><span class="stat-value">${overall.quizzesTaken}</span><span class="stat-label">Quizzes taken</span></div>
      <div class="stat"><span class="stat-value">${overall.questionsAnswered}</span><span class="stat-label">Questions answered</span></div>
    </div>`;

  const meters = topics
    .slice()
    .sort((a, b) => a.masteryPercent - b.masteryPercent)
    .map((topic) => `
      <div class="topic-meter">
        <div class="meter-label">
          <strong>${escapeHtml(topic.topic)}</strong>
          <span>${topic.masteryPercent}% mastery · ${topic.correct}/${topic.total} correct</span>
        </div>
        <div class="progress" role="img" aria-label="${escapeHtml(topic.topic)} mastery ${topic.masteryPercent} percent">
          <div class="progress-bar${topic.needsRevision ? ' is-pink' : ''}" style="width: ${topic.masteryPercent}%"></div>
        </div>
        <div class="topic-meta">
          <span class="badge">next: ${escapeHtml(topic.difficulty)}</span>
          ${topic.needsRevision ? '<span class="badge badge-pink">needs revision</span>' : '<span class="badge badge-green">on track</span>'}
          <span>${topic.lastPracticedAt ? `practised ${formatRelative(topic.lastPracticedAt)}` : 'not practised yet'}</span>
        </div>
      </div>`)
    .join('');

  host.innerHTML = `${stats}<hr class="hairline" style="margin: var(--s5) 0;"><div class="mastery-list" style="margin-top: 0;">${meters}</div>`;
}

/* ----------------------------------------------------------- revision */

function renderRevision(progress) {
  const host = $('[data-revision]');
  if (!host) return;
  const topics = (progress?.topics || []).filter((topic) => topic.needsRevision);

  if (topics.length === 0) {
    showEmpty(host, {
      iconName: 'checkCircle',
      title: 'Nothing needs revision',
      text: 'A topic joins this list after 3 or more answered questions with mastery below 60%.',
      actions: '<a class="btn btn-secondary btn-sm" href="quiz.html">Practise anyway</a>',
    });
    return;
  }

  host.innerHTML = `<div class="row-list">${topics.map((topic) => `
    <div class="revision-item">
      <span class="revision-score">${topic.masteryPercent}%</span>
      <span class="revision-body">
        <span class="revision-topic">${escapeHtml(topic.topic)}</span>
        <span class="revision-meta">${topic.correct}/${topic.total} correct · next quiz: ${escapeHtml(topic.difficulty)}</span>
      </span>
      <a class="btn btn-secondary btn-sm" href="quiz.html?topic=${encodeURIComponent(topic.topic)}">Quiz me</a>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------ activity */

// Reuses the icons those concepts already have elsewhere: `folder` marks
// sessions on the Library page, `archive` marks filing/organising actions.
const ACTIVITY_ICONS = {
  quiz: 'clipboard', upload: 'upload', question: 'message',
  session: 'folder', organize: 'archive',
};

function renderActivity(progress) {
  const host = $('[data-activity]');
  if (!host) return;
  const activity = progress?.recentActivity || [];

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
        <span class="row-meta">${entry.topic ? escapeHtml(entry.detail || '') : ''}${entry.topic && entry.detail ? ' · ' : ''}${formatRelative(entry.at)}</span>
      </span>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------ materials */

function renderMaterials(sources) {
  const host = $('[data-materials]');
  if (!host) return;

  if (sources.length === 0) {
    showEmpty(host, {
      iconName: 'inbox',
      title: 'No material yet',
      text: 'Upload a PDF or PowerPoint, or paste a web page, on the Study page. Everything you ask gets answered from it.',
      actions: '<a class="btn btn-primary btn-sm" href="study.html">Add material</a>',
    });
    return;
  }

  host.innerHTML = `<div class="row-list">${sources.slice(0, 6).map((source) => `
    <div class="row-item">
      <span class="row-icon">${sourceIcon(source.type, { size: 15 })}</span>
      <span class="row-main">
        <span class="row-title" title="${escapeHtml(source.title)}">${escapeHtml(source.title)}</span>
        <span class="row-meta">${escapeHtml(typeLabel(source.type))} · ${escapeHtml(source.sizeLabel || '')} · ${formatDate(source.createdAt)}</span>
      </span>
    </div>`).join('')}</div>`;
}

/* --------------------------------------------------- redesign stat cards */

// Real numbers for the redesign's overview cards. "Mastered" is a display-only,
// deterministic rule: mastery ≥ 80% (the backend has no mastered flag).
const MASTERED_AT = 80;

function renderStatCards(progress, sources) {
  setText('filesCountBadge', `${sources.length} ${sources.length === 1 ? 'file' : 'files'}`);
  if (!progress) return; // progress request failed — leave the card defaults alone

  const topics = progress?.topics || [];
  const overall = progress?.overall;

  if (overall && topics.length > 0) {
    setText('quizAccuracyDisplay', `${overall.accuracyPercent}%`);
    setText('chartAvgBadge', `Avg: ${overall.accuracyPercent}%`);
  }

  if (topics.length === 0) {
    setText('masteredFraction', '0 of 0');
    setText('masteredPercentText', 'No topics yet');
    setText('masteredRemainingText', 'Take a quiz to start tracking mastery');
    return;
  }

  const masteredCount = topics.filter((topic) => topic.masteryPercent >= MASTERED_AT).length;
  const remaining = topics.length - masteredCount;
  const percent = Math.round((masteredCount / topics.length) * 100);

  setText('masteredFraction', `${masteredCount} of ${topics.length}`);
  const bar = byId('masteredProgressBar');
  if (bar) bar.style.width = `${percent}%`;
  setText('masteredPercentText', `${percent}% mastered`);
  setText('masteredRemainingText', remaining === 0
    ? 'All topics mastered'
    : `${remaining} ${remaining === 1 ? 'topic' : 'topics'} in progress`);

  const checklist = byId('topicsChecklist');
  if (checklist && checklist.childElementCount === 0) {
    checklist.innerHTML = topics
      .slice()
      .sort((a, b) => b.masteryPercent - a.masteryPercent)
      .map((topic) => {
        const mastered = topic.masteryPercent >= MASTERED_AT;
        return `
          <div class="topic-item${mastered ? ' is-mastered' : ''}">
            <span class="topic-checkbox" aria-hidden="true">${mastered ? '✓' : ''}</span>
            <div class="topic-info">
              <span class="topic-name">${escapeHtml(topic.topic)}</span>
              <span class="topic-subject-badge">${escapeHtml(topic.difficulty || '')}</span>
            </div>
            <span class="topic-status-label">${mastered ? 'Mastered' : 'In Progress'}</span>
          </div>`;
      }).join('');
  }
}

/* ------------------------------------------------- personalisation nudge */

/** One small nudge card while the profile is new or was skipped (v1.4). */
function renderProfileNudge(profile) {
  if (!profile || (profile.state !== 'new' && profile.state !== 'skipped')) return;
  const anchor = $('.dash-continue');
  if (!anchor) return;
  const skipped = profile.state === 'skipped';
  anchor.insertAdjacentHTML('beforebegin', `
    <a class="banner banner-info" href="profile.html">
      ${icon('heart', { size: 16 })}
      <span><strong>Personalise your learning →</strong> ${
        skipped
          ? 'You skipped the intro, but you can fill in your profile any time.'
          : 'Tell Socius your interests and how to teach you — it adapts explanations and quizzes.'
      }</span>
    </a>`);
}

/* ------------------------------------------------------------------ load */

async function load() {
  const [progressResult, sourcesResult, profileResult] = await Promise.allSettled([
    api.getProgress(),
    api.listSources(),
    api.getProfile(),
  ]);

  const sources = sourcesResult.status === 'fulfilled' ? sourcesResult.value.sources : [];
  const progress = progressResult.status === 'fulfilled' ? progressResult.value : null;

  renderStatCards(progress, sources);

  const materialsHost = $('[data-materials]');
  if (sourcesResult.status === 'fulfilled') renderMaterials(sources);
  else if (materialsHost) {
    showError(materialsHost, sourcesResult.reason, { title: 'Could not load your material', onRetry: load });
    toast('Your material could not be loaded.');
  }

  if (progressResult.status === 'fulfilled') {
    renderSummary(progress, sources);
    renderContinue(progress);
    renderMastery(progress, sources.length);
    renderRevision(progress);
    renderActivity(progress);
    // Nudge only when the page itself loaded fine, never when offline/error.
    if (profileResult.status === 'fulfilled') renderProfileNudge(profileResult.value.profile);
    return;
  }

  const error = progressResult.reason;
  toast('Your progress could not be loaded.');
  const summary = $('[data-summary]');
  if (summary) summary.textContent = 'Your progress could not be loaded.';
  renderContinue(null);
  const masteryHost = $('[data-mastery]');
  if (masteryHost) showError(masteryHost, error, { title: 'Could not load your progress', onRetry: load });
  const revisionHost = $('[data-revision]');
  if (revisionHost) {
    showEmpty(revisionHost, { iconName: 'clock', title: 'Unavailable', text: 'Progress is needed to build the revision queue.' });
  }
  const activityHost = $('[data-activity]');
  if (activityHost) {
    showEmpty(activityHost, { iconName: 'clock', title: 'Unavailable', text: 'Progress is needed to list recent activity.' });
  }
}

load();
