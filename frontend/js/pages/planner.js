// =============================================================================
// pages/planner.js — the Study Planner page.
//
// Responsibility: turn the learner's own progress into a plan, a short list of
// what to work on next, and an explanation of *why* a topic is recommended.
//
// The awkward, deliberate part: this page is built to the FULL contract for
// GET /api/planner and GET /api/advice (docs/API_CONTRACT.md § v2.0, both
// "Status: planned (Wave 4)"), but neither route exists on the server yet, so
// today both answer 404. When that happens this page does NOT fake a plan and
// does NOT invent dates. It renders a clearly-labelled "not available yet"
// state, names the reason, and falls back to what really exists today:
// GET /api/learner/progress. Everything it shows is computed from that rollup.
//
// The moment Wave 4 mounts the routes, the plan/day-card UI and the live advice
// panel render themselves from the real payloads — no change here.
//
// Dependencies: ../components/shell.js (chrome), ../api.js (the only fetch
// caller), ../ui.js (escaping + render helpers). No fetch, no innerHTML of
// untrusted text, no invented data.
// =============================================================================

import { mountShell } from '../components/shell.js';
import { apiGet } from '../api.js';
import {
  escapeHtml, icon, spinner, skeleton, emptyState, errorState, errorMessage,
  formatDate, formatRelative, plural, on,
} from '../ui.js';

/* --------------------------------------------------------------- constants */

const DEFAULT_DAYS = 7;
const HORIZON_OPTIONS = [
  { days: 7, label: 'Next 7 days' },
  { days: 14, label: 'Next 14 days' },
  { days: 30, label: 'Next 30 days' },
];

// The v2.0 1–4 scale. level 1 is "foundation" — a MEASURED low score, which is
// not the same statement as "unassessed". A null level (or the explicit
// "unassessed" label) must never be painted as level 1.
const LEVEL_LABELS = { 1: 'foundation', 2: 'developing', 3: 'proficient', 4: 'advanced' };
// Same mapping the other level-rendering pages use (A22's dashboard): foundation
// is the neutral badge, not the amber one — amber means "needs revision" here
// and on the progress page, and a level is not a warning.
const LEVEL_BADGES = { 1: '', 2: 'badge-info', 3: 'badge-success', 4: 'badge-accent' };

// How the server proposes to practise a planned item, and where that happens.
const ACTIVITY = {
  quiz:       { label: 'Quiz',       icon: 'clipboard', href: 'quiz.html',       cta: 'Take a quiz' },
  review:     { label: 'Review',     icon: 'refresh',   href: 'study.html',      cta: 'Review with the tutor' },
  flashcards: { label: 'Flashcards', icon: 'cards',     href: 'flashcards.html', cta: 'Study flashcards' },
  tutor:      { label: 'Tutor',      icon: 'message',   href: 'study.html',      cta: 'Ask the tutor' },
};
const FALLBACK_ACTIVITY = ACTIVITY.review;

const ACTION_CTA = { revise: 'Revise this topic', practise: 'Practise this topic', start: 'Start this topic' };

const ACTIVITY_ICONS = {
  quiz: 'clipboard', question: 'message', upload: 'upload',
  tutor_asked: 'message', quiz_generated: 'clipboard', quiz_answered: 'checkCircle',
  card_reviewed: 'cards', source_uploaded: 'upload', session_opened: 'clock',
  level_changed: 'trend',
};

const ACTIVITY_LABELS = {
  quiz: 'Quiz', question: 'Tutor question', upload: 'Material added',
  tutor_asked: 'Tutor question', quiz_generated: 'Quiz generated', quiz_answered: 'Quiz answered',
  card_reviewed: 'Flashcard reviewed', source_uploaded: 'Material added',
  session_opened: 'Session opened', level_changed: 'Level changed',
};

/* ------------------------------------------------------------------- state */

const state = {
  horizonDays: DEFAULT_DAYS,
  loading: true,
  // Each endpoint is { status: 'loading'|'ok'|'unavailable'|'error', data?, error? }.
  // 'unavailable' means "the server does not have this route yet" (a 404) —
  // an expected state, not a failure.
  planner: { status: 'loading' },
  advice: { status: 'loading' },
  progress: { status: 'loading' },
  adviceTopic: null, // the topic the advice panel is currently asking about
};

/* ------------------------------------------------------------------ helpers */

const isMissingEndpoint = (error) => Number(error?.status) === 404;

const sameTopic = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

const masteryRatio = (topic) => (Number(topic?.total) > 0 ? Number(topic.correct) / Number(topic.total) : 1);

const titleCase = (value) => {
  const text = String(value ?? '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
};

/** One level badge. A missing/"unassessed" level reads "Not assessed yet". */
function levelBadge(level, levelLabel) {
  const label = typeof levelLabel === 'string' && levelLabel ? levelLabel : LEVEL_LABELS[level];
  if (!label || label === 'unassessed' || level === null || level === undefined) {
    return '<span class="badge">Not assessed yet</span>';
  }
  const modifier = LEVEL_BADGES[level] ?? 'badge-info';
  return `<span class="badge${modifier ? ` ${modifier}` : ''}">${escapeHtml(titleCase(label))}</span>`;
}

const badge = (text, modifier = '') => `<span class="badge${modifier ? ` ${modifier}` : ''}">${escapeHtml(text)}</span>`;

/** A framed region. `flush` drops the body padding so a `.row-list` fills it. */
function panel({ id, title, badge: badgeHtml = '', body = '', flush = false }) {
  const labelled = id ? ` aria-labelledby="${id}"` : '';
  const heading = title
    ? `<div class="panel-head"><h2 class="panel-title"${id ? ` id="${id}"` : ''}>${escapeHtml(title)}</h2>${badgeHtml}</div>`
    : '';
  const bodyHtml = flush ? body : `<div class="panel-body">${body}</div>`;
  return `<section class="panel"${labelled}>${heading}${bodyHtml}</section>`;
}

/* ------------------------------------------------------- the fixed sections */

const PLAN_HEADING = 'planner-plan-heading';
const ADVICE_HEADING = 'planner-advice-heading';

/** The "Your plan" panel — id and title are fixed, so every caller agrees. */
function planPanel(badgeHtml, bodyHtml) {
  return panel({ id: PLAN_HEADING, title: 'Your plan', badge: badgeHtml, body: bodyHtml });
}

/** The "Next up" panel — same idea. */
function nextUpPanel(badgeHtml, bodyHtml) {
  return panel({ id: ADVICE_HEADING, title: 'Next up', badge: badgeHtml, body: bodyHtml });
}

/* --------------------------------------------------------- endpoint shaping */

function shapeEndpoint(result, key) {
  if (result.status === 'fulfilled') {
    const data = result.value;
    if (key === 'progress') return { status: 'ok', data };
    const payload = data && data[key] ? data[key] : null;
    return payload ? { status: 'ok', data: payload } : { status: 'unavailable' };
  }
  const error = result.reason;
  if (isMissingEndpoint(error)) return { status: 'unavailable', error };
  return { status: 'error', error };
}

/**
 * A topic counts as assessed only when the server sent real graded counts.
 * `hasEvidence === false`, or no finite masteryPercent, means unassessed — which
 * must never be painted as level 1 (see LEVEL_LABELS above).
 */
const isAssessed = (topic) => topic.hasEvidence !== false && Number.isFinite(topic.masteryPercent);

/* ------------------------------------------------------------------- loading */

function loadingMainHtml() {
  return `<section class="panel"><div class="panel-body">${skeleton(4)}</div></section>
    <section class="panel"><div class="panel-body">${skeleton(3)}</div></section>`;
}

function loadingAsideHtml() {
  return `<section class="panel"><div class="panel-body">${skeleton(3)}</div></section>
    <section class="panel"><div class="panel-body">${skeleton(2)}</div></section>`;
}

/* ---------------------------------------------------------------- the plan */

function planItemHtml(item, index) {
  const activity = ACTIVITY[item.activity] || FALLBACK_ACTIVITY;
  const day = Number(item.day) > 0 ? Number(item.day) : index + 1;
  const dateLabel = formatDate(item.date);
  const when = [`Day ${day}`, dateLabel].filter(Boolean).join(' · ');
  const minutes = Number(item.estimatedMinutes);
  const sourceCount = Array.isArray(item.sourceIds) ? item.sourceIds.length : 0;

  const meta = [];
  if (Number.isFinite(minutes) && minutes > 0) {
    meta.push(`${icon('clock', { size: 13 })}<span>${escapeHtml(plural(minutes, 'min', 'min'))}</span>`);
  }
  if (sourceCount > 0) {
    meta.push(`${icon('book', { size: 13 })}<span>${escapeHtml(plural(sourceCount, 'source'))}</span>`);
  }

  return `<li class="plan-day">
    <span class="plan-day__marker" aria-hidden="true">${escapeHtml(String(day))}</span>
    <div class="plan-day__body">
      <p class="plan-day__when">${escapeHtml(when)}</p>
      <h3 class="plan-day__topic">${escapeHtml(item.topic || 'Untitled topic')}</h3>
      ${item.reason ? `<p class="plan-day__reason">${escapeHtml(item.reason)}</p>` : ''}
      <div class="plan-day__foot">
        ${levelBadge(item.level, item.levelLabel)}
        ${badge(activity.label)}
        ${meta.length ? `<span class="plan-day__meta">${meta.join('<span class="dot-sep" aria-hidden="true">·</span>')}</span>` : ''}
        <a class="btn btn-sm btn-secondary plan-day__cta" href="${activity.href}">${escapeHtml(activity.cta)}</a>
      </div>
    </div>
  </li>`;
}

function planReadyHtml(plan) {
  const items = Array.isArray(plan.items) ? plan.items : [];
  if (plan.hasEvidence === false || items.length === 0) {
    return planPanel(badge('Nothing scheduled', 'badge-info'), emptyState({
      icon: 'calendar',
      title: 'No plan for this period yet',
      body: plan.summary
        || 'The planner needs some quiz history before it can schedule anything. Take a short quiz and come back.',
      action: `<a class="btn btn-primary btn-sm" href="quiz.html">${icon('clipboard', { size: 14 })} Take a quiz</a>`,
    }));
  }

  const horizon = Number(plan.horizonDays) > 0 ? Number(plan.horizonDays) : state.horizonDays;
  return planPanel(badge(plural(horizon, 'day'), 'badge-info'), `<div class="stack-4">
      ${plan.summary ? `<p class="muted text-sm">${escapeHtml(plan.summary)}</p>` : ''}
      <ol class="plan-days">${items.map(planItemHtml).join('')}</ol>
    </div>`);
}

function planUnavailableHtml(endpoint) {
  const isError = endpoint.status === 'error';
  if (isError) {
    return planPanel(badge('Could not load', 'badge-danger'), `<div class="empty-state is-error">
        <span class="empty-state-icon">${icon('alert', { size: 22 })}</span>
        <p class="empty-state-title">The planner could not be reached</p>
        <p class="empty-state-text">${escapeHtml(errorMessage(endpoint.error))}</p>
        <div class="empty-state-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-retry-planner>${icon('refresh', { size: 14 })} Try again</button>
        </div>
      </div>`);
  }

  return planPanel(badge('Not available yet'), `<div class="empty-state">
      <span class="empty-state-icon">${icon('calendar', { size: 22 })}</span>
      <p class="empty-state-title">The study planner isn’t available yet</p>
      <p class="empty-state-text">The automatic planner is still being built on the server, so there is no
        schedule to show. This page will not invent study dates — a made-up timetable is worse than none.
        Everything below comes from real results in your learner model.</p>
      <p class="empty-state-text text-xs muted">Waiting on <span class="mono">GET /api/planner</span>, planned for a later wave.</p>
    </div>`);
}

function planSectionHtml() {
  if (state.planner.status === 'ok') return planReadyHtml(state.planner.data);
  return planUnavailableHtml(state.planner);
}

/* -------------------------------------------------------- what to work on */

function workRowHtml(topic, kind) {
  const assessed = isAssessed(topic);
  const evidence = assessed
    ? `${topic.masteryPercent}% mastery · ${topic.correct} of ${topic.total} correct`
    : 'Not assessed yet';
  const when = topic.lastPracticedAt ? ` · last practised ${formatRelative(topic.lastPracticedAt)}` : '';
  const actionLabel = kind === 'start' ? 'Take a quiz' : 'Practise';
  return `<li class="row-item">
    <span class="row-icon">${icon(kind === 'start' ? 'inbox' : 'trend', { size: 16 })}</span>
    <span class="row-main">
      <span class="row-title">${escapeHtml(topic.topic)}</span>
      <span class="row-meta">${escapeHtml(`${evidence}${when}`)}</span>
    </span>
    ${levelBadge(topic.level, topic.levelLabel)}
    <a class="btn btn-sm btn-secondary" href="quiz.html">${escapeHtml(actionLabel)}</a>
  </li>`;
}

function workSectionHtml(progress) {
  const topics = Array.isArray(progress.topics) ? progress.topics : [];
  const flagged = topics.filter((topic) => topic.needsRevision).sort((a, b) => masteryRatio(a) - masteryRatio(b));
  const unassessed = topics.filter((topic) => topic.hasEvidence === false);

  const rows = [
    ...flagged.map((topic) => workRowHtml(topic, 'revise')),
    ...unassessed.map((topic) => workRowHtml(topic, 'start')),
  ];

  if (rows.length === 0) {
    const hasAssessed = topics.some((topic) => topic.hasEvidence !== false);
    return panel({
      id: 'planner-work-heading',
      title: 'What to work on',
      badge: badge('On track', 'badge-success'),
      body: emptyState({
        icon: 'checkCircle',
        title: 'Nothing is below the revision line right now',
        body: hasAssessed
          ? 'Every topic you have practised is at or above 60% mastery. Keep it fresh with a quick review.'
          : 'Practise a topic and the ones that need attention will be listed here.',
        action: '<a class="btn btn-secondary btn-sm" href="study.html">Review with the tutor</a>',
      }),
    });
  }

  const badgeHtml = flagged.length > 0
    ? badge(`${plural(flagged.length, 'topic')} to revise`, 'badge-warn')
    : badge(`${plural(unassessed.length, 'topic')} not assessed`);

  return panel({
    id: 'planner-work-heading',
    title: 'What to work on',
    badge: badgeHtml,
    body: `<ul class="row-list">${rows.join('')}</ul>`,
    flush: true,
  });
}

/* ------------------------------------------------------------ recent activity */

function activityIcon(type) {
  return ACTIVITY_ICONS[type] || 'book';
}

function activityLabel(type) {
  return ACTIVITY_LABELS[type] || titleCase(String(type ?? '').replace(/_/g, ' '));
}

function activitySectionHtml(progress) {
  const items = Array.isArray(progress.recentActivity) ? progress.recentActivity : [];
  if (items.length === 0) {
    return panel({
      id: 'planner-activity-heading',
      title: 'Recent activity',
      body: emptyState({
        icon: 'clock',
        title: 'No activity yet',
        body: 'Your uploaded material, quizzes and tutor questions will show up here.',
      }),
    });
  }

  const rows = items.map((entry) => {
    const heading = entry.detail || entry.topic || activityLabel(entry.type);
    const meta = [activityLabel(entry.type), entry.topic, formatRelative(entry.at)].filter(Boolean).join(' · ');
    return `<li class="row-item">
      <span class="row-icon">${icon(activityIcon(entry.type), { size: 16 })}</span>
      <span class="row-main">
        <span class="row-title">${escapeHtml(heading)}</span>
        <span class="row-meta">${escapeHtml(meta)}</span>
      </span>
    </li>`;
  }).join('');

  return panel({
    id: 'planner-activity-heading',
    title: 'Recent activity',
    body: `<ul class="row-list">${rows}</ul>`,
    flush: true,
  });
}

/* ------------------------------------------------------------- advice panel */

// The progress-derived recommendation. Used only when the advice service is not
// answering, and chosen exactly the way the server's own advice would be: the
// progress `suggestedNext` first, then the worst flagged topic, then the weakest
// assessed one.
function pickRecommended(progress, topics) {
  const suggested = progress.suggestedNext;
  if (suggested && suggested.topic) {
    const match = topics.find((topic) => sameTopic(topic.topic, suggested.topic));
    return match || { topic: suggested.topic, difficulty: suggested.difficulty };
  }
  const flagged = topics.filter((topic) => topic.needsRevision).sort((a, b) => masteryRatio(a) - masteryRatio(b));
  if (flagged.length > 0) return flagged[0];
  const assessed = topics.filter((topic) => topic.hasEvidence !== false).sort((a, b) => masteryRatio(a) - masteryRatio(b));
  return assessed[0] || topics[0] || null;
}

function fallbackAdvice(progress) {
  const topics = Array.isArray(progress.topics) ? progress.topics : [];
  const selected = state.adviceTopic
    ? topics.find((topic) => sameTopic(topic.topic, state.adviceTopic)) || { topic: state.adviceTopic }
    : null;
  const pick = selected || pickRecommended(progress, topics);
  if (!pick) return null;

  const alternatives = topics
    .filter((topic) => topic.needsRevision && !sameTopic(topic.topic, pick.topic))
    .sort((a, b) => masteryRatio(a) - masteryRatio(b))
    .slice(0, 3)
    .map((topic) => ({ topic: topic.topic, masteryPercent: topic.masteryPercent }));

  return { ...pick, alternatives, selected: Boolean(selected) };
}

function fallbackReason(topic) {
  if (!isAssessed(topic)) {
    return 'No graded answers for this topic yet. A short diagnostic quiz sets its starting level.';
  }
  const percent = topic.masteryPercent;
  if (topic.needsRevision) {
    return `Mastery ${percent}% over ${topic.total} questions — below the 60% revision line.`;
  }
  if (Number.isFinite(percent) && percent < 100) {
    return `Your weakest assessed topic right now at ${percent}%. A quiz would confirm whether it has stuck.`;
  }
  return `Already at ${percent}% — a quick pass keeps it fresh.`;
}

function alternativesHtml(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const chips = list.map((alternative) => {
    const percent = Number.isFinite(alternative.masteryPercent) ? ` · ${alternative.masteryPercent}%` : '';
    return `<button type="button" class="chip" data-advice-topic="${escapeHtml(alternative.topic)}">`
      + `${escapeHtml(alternative.topic)}${escapeHtml(percent)}</button>`;
  }).join('');
  return `<div class="stack-2">
    <p class="eyebrow">Also worth a look</p>
    <div class="cluster-2">${chips}</div>
  </div>`;
}

function fallbackAdviceHtml(fallback, noteHtml) {
  const sourceBadge = badge('From your progress');

  if (!fallback) {
    return nextUpPanel(sourceBadge, `<div class="stack-3">
        <p class="muted text-sm">There is no practice history yet, so there is nothing to recommend. Take a
          short quiz and your first topic will appear here.</p>
        <a class="btn btn-primary btn-sm" href="quiz.html">Take a quiz</a>
      </div>
      ${noteHtml}`);
  }

  const assessed = isAssessed(fallback);
  const evidence = assessed
    ? `${fallback.masteryPercent}% mastery · ${fallback.correct} of ${fallback.total} correct`
    : 'Not assessed yet';
  const when = fallback.lastPracticedAt ? ` · ${formatRelative(fallback.lastPracticedAt)}` : '';
  const selectedChip = state.adviceTopic
    ? `<span class="chip">Showing «${escapeHtml(fallback.topic)}»
        <button type="button" class="chip-remove" data-advice-reset aria-label="Show the overall recommendation">×</button>
      </span>`
    : '';

  return nextUpPanel(sourceBadge, `<div class="stack-3">
      ${selectedChip}
      <h3 class="advice-topic">${escapeHtml(fallback.topic)}</h3>
      <p class="advice-reason">${escapeHtml(fallbackReason(fallback))}</p>
      <div class="cluster-2">
        ${fallback.hasEvidence === false ? levelBadge(null, 'unassessed') : levelBadge(fallback.level, fallback.levelLabel)}
        ${fallback.difficulty ? badge(`Suggested difficulty: ${fallback.difficulty}`) : ''}
      </div>
      <p class="muted text-xs">${escapeHtml(`${evidence}${when}`)}</p>
      <a class="btn btn-primary btn-sm" href="quiz.html">${assessed ? 'Practise this topic' : 'Take a diagnostic quiz'}</a>
      ${alternativesHtml(fallback.alternatives)}
    </div>
    ${noteHtml}`);
}

function liveAdviceHtml(advice) {
  const sourceBadge = badge('Live advice', 'badge-info');

  if (advice.hasEvidence === false || !advice.evidence) {
    const scope = advice.topic ? `«${escapeHtml(advice.topic)}»` : 'this topic';
    return nextUpPanel(sourceBadge, `<div class="stack-3">
        <p>No practice history for ${scope} yet.</p>
        <p class="muted text-sm">${escapeHtml(advice.reason || 'Take a diagnostic quiz to set the starting level for this topic.')}</p>
        <a class="btn btn-primary btn-sm" href="quiz.html">Take a diagnostic quiz</a>
        ${alternativesHtml(advice.alternatives)}
      </div>`);
  }

  const evidence = advice.evidence;
  const actionModifier = { start: 'badge-info', practise: 'badge-accent', revise: 'badge-warn' }[advice.action];
  const priority = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' }[advice.priority];
  const meta = `${evidence.masteryPercent}% mastery · ${evidence.correct} of ${evidence.total} correct`
    + (evidence.lastPracticedAt ? ` · last practised ${formatRelative(evidence.lastPracticedAt)}` : '');

  return nextUpPanel(sourceBadge, `<div class="stack-3">
      <h3 class="advice-topic">${escapeHtml(advice.topic || 'Your next topic')}</h3>
      <p class="advice-reason">${escapeHtml(advice.reason || '')}</p>
      <div class="cluster-2">
        ${badge(titleCase(advice.action || 'revise'), actionModifier)}
        ${priority ? badge(priority) : ''}
        ${levelBadge(advice.level, advice.levelLabel)}
      </div>
      <p class="muted text-xs">${escapeHtml(meta)}</p>
      <a class="btn btn-primary btn-sm" href="quiz.html">${escapeHtml(ACTION_CTA[advice.action] || 'Practise this topic')}</a>
      ${alternativesHtml(advice.alternatives)}
      ${state.adviceTopic ? `<button type="button" class="btn btn-ghost btn-sm" data-advice-reset>${icon('chevronLeft', { size: 14 })} Overall recommendation</button>` : ''}
    </div>`);
}

function adviceErrorHtml(error) {
  return nextUpPanel(badge('Error', 'badge-danger'), `<div class="stack-3">
      <p class="muted text-sm">${escapeHtml(errorMessage(error))}</p>
      <button type="button" class="btn btn-secondary btn-sm" data-retry-advice>${icon('refresh', { size: 14 })} Try again</button>
    </div>`);
}

function advicePanelHtml() {
  if (state.advice.status === 'ok' && state.advice.data) return liveAdviceHtml(state.advice.data);
  if (state.advice.status === 'loading') {
    return nextUpPanel('', spinner('Working out your next step…'));
  }

  const progress = state.progress.status === 'ok' ? state.progress.data : null;
  if (!progress) {
    return state.advice.status === 'error'
      ? adviceErrorHtml(state.advice.error)
      : nextUpPanel('', '<p class="muted text-sm">Your recommendation will appear here once your progress loads.</p>');
  }

  const noteHtml = state.advice.status === 'error'
    ? `<div class="advice-note">
        <p class="muted text-xs">${icon('alert', { size: 12 })} ${escapeHtml(errorMessage(state.advice.error))}</p>
        <button type="button" class="btn btn-ghost btn-sm" data-retry-advice>${icon('refresh', { size: 12 })} Retry</button>
      </div>`
    : `<p class="advice-note muted text-xs">${icon('info', { size: 12 })}
        Live advice is not available yet (<span class="mono">GET /api/advice</span>), so this is worked out from
        your progress numbers.</p>`;

  return fallbackAdviceHtml(fallbackAdvice(progress), noteHtml);
}

/* ---------------------------------------------------------------- study now */

function studyNowHtml(progress) {
  const decks = progress.decks || {};
  const sources = progress.sources || {};
  const overall = progress.overall || {};
  const stats = [
    { label: 'due cards', value: Number(decks.dueCards) || 0, href: 'flashcards.html' },
    { label: 'decks', value: Number(decks.count) || 0, href: 'flashcards.html' },
    { label: 'materials', value: Number(sources.count) || 0, href: 'library.html' },
  ];

  return panel({
    id: 'planner-study-heading',
    title: 'Study now',
    body: `<div class="stack-4">
      <dl class="planner-stats">
        ${stats.map((stat) => `<div class="planner-stat">
          <dt>${escapeHtml(stat.label)}</dt>
          <dd><a href="${stat.href}">${escapeHtml(String(stat.value))}</a></dd>
        </div>`).join('')}
      </dl>
      <div class="planner-links">
        <a class="btn btn-secondary btn-sm btn-block" href="study.html">${icon('message', { size: 14 })} Ask the tutor</a>
        <a class="btn btn-secondary btn-sm btn-block" href="quiz.html">${icon('clipboard', { size: 14 })} Take a quiz</a>
        <a class="btn btn-secondary btn-sm btn-block" href="flashcards.html">${icon('cards', { size: 14 })} Review flashcards</a>
      </div>
      <p class="muted text-xs">${escapeHtml(`${Number(overall.accuracyPercent) || 0}% overall accuracy across ${plural(Number(overall.questionsAnswered) || 0, 'question')}.`)}</p>
    </div>`,
  });
}

/* ------------------------------------------------------------------ empty */

function isEmptyAccount(progress) {
  if (!progress) return false;
  const topics = Array.isArray(progress.topics) ? progress.topics : [];
  const activity = Array.isArray(progress.recentActivity) ? progress.recentActivity : [];
  const overall = progress.overall || {};
  const decks = progress.decks || {};
  const sources = progress.sources || {};
  return topics.length === 0
    && activity.length === 0
    && !Number(overall.questionsAnswered)
    && !Number(decks.count)
    && !Number(sources.count);
}

function emptyAccountHtml() {
  return panel({
    body: emptyState({
      icon: 'calendar',
      title: 'Nothing to plan yet',
      body: 'Add some study material and take a short quiz. Your plan, revision list and recommendation are all built from that.',
      action: `<a class="btn btn-primary btn-sm" href="library.html">${icon('book', { size: 14 })} Add material</a>
        <a class="btn btn-secondary btn-sm" href="quiz.html">Take a quiz</a>`,
    }),
  });
}

function noProgressHtml() {
  return panel({
    body: `<div class="empty-state is-error">
      <span class="empty-state-icon">${icon('alert', { size: 22 })}</span>
      <p class="empty-state-title">Your progress is not available</p>
      <p class="empty-state-text">This server does not expose your progress yet, so there is nothing truthful to
        plan from. Nothing has been invented.</p>
      <p class="empty-state-text text-xs muted">Waiting on <span class="mono">GET /api/learner/progress</span>.</p>
      <div class="empty-state-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-retry-planner>${icon('refresh', { size: 14 })} Try again</button>
      </div>
    </div>`,
  });
}

/* --------------------------------------------------------------- the toolbar */

function renderActions() {
  const host = document.getElementById('planner-actions');
  if (!host) return;
  host.innerHTML = `
    <div class="field planner-horizon" id="planner-horizon-field">
      <label class="label" for="planner-horizon">Plan length</label>
      <select class="select" id="planner-horizon">
        ${HORIZON_OPTIONS.map((option) => `<option value="${option.days}"${option.days === state.horizonDays ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    </div>
    <button type="button" class="btn btn-secondary" id="planner-refresh">${icon('refresh', { size: 14 })} Plan again</button>`;
}

function updateActions() {
  const field = document.getElementById('planner-horizon-field');
  const select = document.getElementById('planner-horizon');
  if (!field || !select) return;
  // A plan-length control only means something when the planner can honour it.
  const unavailable = state.planner.status === 'unavailable';
  field.hidden = unavailable;
  select.disabled = state.planner.status !== 'ok';
  if (select.value !== String(state.horizonDays)) select.value = String(state.horizonDays);
}

/* ------------------------------------------------------------------ render */

function render() {
  updateActions();
  const main = document.getElementById('planner-main');
  const aside = document.getElementById('planner-aside');
  if (!main || !aside) return;

  if (state.loading) {
    main.innerHTML = loadingMainHtml();
    aside.innerHTML = loadingAsideHtml();
    return;
  }

  // Progress is the backbone: without it there is nothing real to show. A hard
  // failure takes the main column and offers a retry; a server that does not
  // expose the route yet gets an equally honest "nothing to show" state.
  if (state.progress.status !== 'ok') {
    if (state.progress.status === 'error') {
      main.replaceChildren(errorState(state.progress.error, () => load(), { title: 'Could not load your progress' }));
    } else {
      main.innerHTML = noProgressHtml();
    }
    aside.innerHTML = advicePanelHtml();
    return;
  }

  const progress = state.progress.data;

  if (isEmptyAccount(progress)) {
    main.innerHTML = emptyAccountHtml();
    aside.innerHTML = advicePanelHtml();
    return;
  }

  main.innerHTML = `${planSectionHtml()}${workSectionHtml(progress)}${activitySectionHtml(progress)}`;
  aside.innerHTML = `${advicePanelHtml()}${studyNowHtml(progress)}`;
}

/* ------------------------------------------------------------------ events */

function wireEvents() {
  on(document, 'click', '[data-advice-topic]', (event, element) => {
    event.preventDefault();
    state.adviceTopic = element.getAttribute('data-advice-topic') || null;
    loadAdvice();
  });
  on(document, 'click', '[data-advice-reset]', () => {
    state.adviceTopic = null;
    loadAdvice();
  });
  on(document, 'click', '#planner-refresh, [data-retry-planner]', () => load());
  on(document, 'click', '[data-retry-advice]', () => loadAdvice());
  on(document, 'change', '#planner-horizon', (event) => {
    state.horizonDays = Number(event.target.value) || DEFAULT_DAYS;
    loadPlanner();
  });
}

/* -------------------------------------------------------------------- load */

function plannerPath() {
  return `/api/planner?days=${encodeURIComponent(state.horizonDays)}`;
}

function advicePath() {
  return state.adviceTopic
    ? `/api/advice?topic=${encodeURIComponent(state.adviceTopic)}`
    : '/api/advice';
}

/**
 * Refresh ONE slot: show its loading state, fetch, then record the outcome.
 * A 404 is "the server does not have this route yet" (an expected state, not a
 * failure), which is what keeps this page honest while Wave 4 is unfinished.
 */
async function refreshEndpoint(slot, path, key) {
  state[slot] = { status: 'loading' };
  render();
  try {
    const data = await apiGet(path, { timeoutMs: 15000 });
    const payload = data && data[key] ? data[key] : null;
    state[slot] = payload ? { status: 'ok', data: payload } : { status: 'unavailable' };
  } catch (error) {
    state[slot] = isMissingEndpoint(error) ? { status: 'unavailable', error } : { status: 'error', error };
  }
  render();
}

async function loadPlanner() {
  return refreshEndpoint('planner', plannerPath(), 'plan');
}

async function loadAdvice() {
  return refreshEndpoint('advice', advicePath(), 'advice');
}

async function load() {
  state.loading = true;
  state.planner = { status: 'loading' };
  state.advice = { status: 'loading' };
  state.progress = { status: 'loading' };
  render();

  const [plannerResult, adviceResult, progressResult] = await Promise.allSettled([
    apiGet(plannerPath(), { timeoutMs: 15000 }),
    apiGet(advicePath(), { timeoutMs: 15000 }),
    apiGet('/api/learner/progress', { timeoutMs: 20000 }),
  ]);

  state.planner = shapeEndpoint(plannerResult, 'plan');
  state.advice = shapeEndpoint(adviceResult, 'advice');
  state.progress = shapeEndpoint(progressResult, 'progress');
  state.loading = false;
  render();
}

/* -------------------------------------------------------------------- init */

async function init() {
  await mountShell({ page: 'planner' });
  renderActions();
  wireEvents();
  await load();
}

init();
