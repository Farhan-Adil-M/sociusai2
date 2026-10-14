// =============================================================================
// server/services/planner.js — the study plan (deterministic, no AI).
//
// Responsibility: turn ONE learner's stored evidence into a dated study plan.
//
//   loadPlanEvidence(db, { userId, now })
//     → { evidence, suggestedNext } — every read is filtered by user_id.
//   computePlan(evidence, days, { now, suggestedNext })
//     → { horizonDays, hasEvidence, items, summary } — pure: no db, no AI, no
//       vector call, no randomness. The caller reads the clock ONCE and injects
//       it (the `new Date()` default is only a convenience for ad-hoc callers);
//       nothing here re-reads it, so the same evidence + the same instant always
//       produce the same plan.
//
// Inputs: evidence[] — one record per topic the learner has REAL evidence for:
//           { topic, correct, total, lastPracticedAt, dueCards, sourceIds,
//             goal: { label, deadline } | null }
//         days        — horizon, integer 1–30 (the route validates the query
//                       value; an unusable number falls back to the default).
//         suggestedNext — A14's "what to revise next" pick, from
//                       services/studyAdvice.js#revisionAdvice. It is CONSUMED
//                       here and never re-derived: this module schedules, it
//                       does not write a second recommendation engine.
//
// Outputs: items[i] = { day, date, topic, level, levelLabel, activity, reason,
//           estimatedMinutes, sourceIds } — exactly the shape
//           docs/API_CONTRACT.md v2.0 documents and the planner page (A29)
//           consumes.
//
// Dependencies: services/learner.js (the 1–4 level scale),
//           services/studyAdvice.js (the revision pick), store/sqlite.js
//           (profile read + defensive JSON parse). No ai, no vector, no config.
//
// Test: the same evidence and the same `now` produce a byte-identical plan —
//           the order is a total order over plain numbers and code-unit string
//           comparison, so two machines with different locales never disagree.
//           401 anonymous and 400 VALIDATION_ERROR on a bad `days` are the
//           route's responsibility; an empty account returns hasEvidence:false
//           with items:[] and a summary that says what to do next.
//
// Honesty rules this module exists to keep:
//   * A topic with no graded answer NEVER gets a mastery number or a level:
//     level stays null / 'unassessed' and the reason says so out loud.
//   * Nothing is invented to fill a day. Only topics with real evidence
//     (graded answers, or flashcards that are actually due) are scheduled.
//     An empty plan is an honest answer, not a failure.
// =============================================================================

import { levelFor, levelLabel } from './learner.js';
import { revisionAdvice } from './studyAdvice.js';
import { loadProfileRow, parseJsonObject } from '../store/sqlite.js';

// The same threshold vocabulary services/studyAdvice.js and routes/advice.js
// use, so the planner page reads in one voice: 0.6 is the revision line
// (learner.needsRevision) and 0.8 is the level-4 "on target" bar. The values
// are duplicated here only as named constants; the level scale itself always
// comes from learner.js#levelFor.
const REVISION_LINE = 0.6;
const TARGET_MASTERY = 0.8;

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 30;
const DAY_MS = 86400000;

/**
 * Base length of ONE session of each activity, in minutes.
 *
 * This is a stated planning assumption, NOT a measurement: the schema stores
 * no study-pace or availability field anywhere (routes/profile.js deliberately
 * refuses one — see its "Study availability isn't stored yet" note), so the
 * plan cannot claim to know how much free time a learner has. These numbers
 * are what a session of that kind normally takes and are combined with the
 * measured gap in the formula below.
 */
const BASE_MINUTES = Object.freeze({ review: 20, quiz: 15, flashcards: 10 });
const MINUTES_STEP = 5;          // round to the nearest 5 minutes
const MIN_SESSION_MINUTES = 5;   // never promise less than a working session

/**
 * Scheduling urgency: 0 is "put this on the first day". Lower wins.
 *
 *   0 DEADLINE      — a stored goal deadline falls inside the horizon. A real
 *                     date is the strongest scheduling signal the evidence can
 *                     carry, so it outranks a measured weakness.
 *   1 REVISE        — graded, and below the 0.6 revision line.
 *   2 DUE_CARDS     — not graded yet, but flashcards for it are due now.
 *   3 IMPROVE       — graded and below the 0.8 target (or nothing measurable
 *                     and nothing due: assess it first).
 *   4 MAINTAIN      — graded and on target: keep it strong.
 */
const URGENCY = Object.freeze({
  DEADLINE: 0,
  REVISE: 1,
  DUE_CARDS: 2,
  IMPROVE: 3,
  MAINTAIN: 4,
});

/** The same topic key learner_topics / quizzes store: trimmed, lower-cased. */
export function normalizeTopic(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** A stored JSON array column, or [] when it is missing/malformed. */
function parseJsonArray(json) {
  try {
    const value = JSON.parse(json ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** UTC calendar date (YYYY-MM-DD) of a Date. */
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** A Date, or a defensive `new Date()` for an unusable clock value. */
function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(value ?? Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** Mastery in 0–1 from graded counts, or null when nothing was graded. */
function masteryOf(record) {
  const total = Number(record?.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  const correct = Number(record?.correct);
  if (!Number.isFinite(correct)) return null;
  return Math.min(1, Math.max(0, correct / total));
}

/** How the server proposes to practise one topic. Pure: evidence decides. */
function activityOf(mastery, dueCards) {
  if (mastery === null) return dueCards > 0 ? 'flashcards' : 'quiz';
  if (mastery < REVISION_LINE) return 'review';      // weakest → tutor-led review
  if (mastery < TARGET_MASTERY) return 'quiz';       // below target → practise
  return dueCards > 0 ? 'flashcards' : 'quiz';       // on target → keep it fresh
}

/**
 * Scheduling urgency for one topic; see URGENCY for the band order. A stored
 * deadline outranks every measured signal, so it is checked first.
 */
function urgencyOf(mastery, dueCards, hasDeadline) {
  if (hasDeadline) return URGENCY.DEADLINE;
  if (mastery === null) return dueCards > 0 ? URGENCY.DUE_CARDS : URGENCY.IMPROVE;
  if (mastery < REVISION_LINE) return URGENCY.REVISE;
  if (mastery < TARGET_MASTERY) return URGENCY.IMPROVE;
  return URGENCY.MAINTAIN;
}

/**
 * estimatedMinutes = max(5, round(BASE_MINUTES[activity] * NEED / 5) * 5)
 *
 * The formula, checkable by hand:
 *   BASE_MINUTES[activity] — the stated base length of one session of that
 *                            activity (see BASE_MINUTES above).
 *   NEED                   — 1 + max(0, TARGET_MASTERY - mastery) when mastery
 *                            was measured: 1.0 on target, up to 1.8 at mastery
 *                            0, so a weaker topic gets a longer session and
 *                            never a shorter one. Exactly 1 when the topic has
 *                            no graded answers, because we refuse to invent a
 *                            gap we never measured.
 *   round to the nearest 5 minutes — the plan must not claim false precision.
 *
 * Examples: review at 42% → 20 × 1.38 = 27.6 → 30 min; quiz at 70% →
 * 15 × 1.10 = 16.5 → 15 min; flashcards on target → 10 × 1.0 → 10 min.
 */
function minutesFor(activity, mastery) {
  const base = BASE_MINUTES[activity] ?? BASE_MINUTES.quiz;
  const need = mastery === null ? 1 : 1 + Math.max(0, TARGET_MASTERY - mastery);
  return Math.max(MIN_SESSION_MINUTES, Math.round((base * need) / MINUTES_STEP) * MINUTES_STEP);
}

/** The one goal sentence the plan summary and a topic's reason both use. */
function goalSentence(goal, today) {
  const tense = goal.deadline <= today ? 'was due' : 'is due';
  return `Your goal «${goal.label}» ${tense} on ${goal.deadline}.`;
}

/** A goal's deadline, phrased with the tense the calendar actually supports. */
function goalNote(goal, today) {
  if (!goal || typeof goal.deadline !== 'string' || goal.deadline === '') return '';
  // Leading space: a reason already has text in front of it.
  return ` ${goalSentence(goal, today)}`;
}

/** One human-readable sentence; every number in it is stored evidence. */
function reasonFor({ mastery, total, dueCards, goal, today }) {
  const cards = dueCards > 0 ? ` ${dueCards} card${dueCards === 1 ? '' : 's'} due for review.` : '';

  if (mastery === null) {
    // Nothing was graded, so the sentence says exactly that — and points at the
    // one thing there IS to do (the cards already says how many are due).
    const why = dueCards > 0
      ? `No graded answers yet — ${dueCards} flashcard${dueCards === 1 ? '' : 's'} are due, so start there.`
      : 'No graded attempts yet — start with a diagnostic quiz.';
    return `${why}${goalNote(goal, today)}`;
  }

  const questions = `${total} question${total === 1 ? '' : 's'}`;
  const percent = Math.round(mastery * 100);
  let why;
  if (mastery < REVISION_LINE) why = `Mastery ${percent}% over ${questions} — below the 0.6 revision line.`;
  else if (mastery < TARGET_MASTERY) why = `Mastery ${percent}% over ${questions} — below the 0.8 target.`;
  else why = `Mastery ${percent}% over ${questions} — on target, so keep it strong with maintenance practice.`;
  return `${why}${cards}${goalNote(goal, today)}`;
}

/**
 * Priority order — a single total order over plain numbers, so two machines with
 * different locales always build the same plan:
 *   1. urgency band (see URGENCY above).
 *   2. the topic A14's engine recommended leads its own band. It never
 *      overrides a band: a stored deadline still outranks a measured weakness,
 *      and the scheduler still never re-decides the recommendation itself.
 *   3. weakest mastery first — an unmeasured topic has nothing measured, so it
 *      sorts as weakest inside its own band.
 *   4. most flashcards due.
 *   5. least recently practised.
 *   6. topic name, in code-unit order (plain string comparison, never
 *      localeCompare, which two machines can order differently).
 */
function byPriority(a, b) {
  if (a.urgency !== b.urgency) return a.urgency - b.urgency;
  if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
  if (a.mastery !== b.mastery) return (a.mastery ?? 0) - (b.mastery ?? 0);
  if (a.dueCards !== b.dueCards) return b.dueCards - a.dueCards;
  const at = Date.parse(a.lastPracticedAt ?? '') || 0;
  const bt = Date.parse(b.lastPracticedAt ?? '') || 0;
  if (at !== bt) return at - bt;
  if (a.topic === b.topic) return 0;
  return a.topic < b.topic ? -1 : 1;
}

// ---------- evidence gathering (all reads filtered by user_id) --------------

/**
 * Everything the planner is allowed to schedule from, for ONE user.
 *
 * Four kinds of stored evidence, and nothing else:
 *   1. graded answers   — `learner_topics` (correct / total / last practised).
 *                         The ONLY source of a mastery number.
 *   2. due flashcards   — `deck_cards` that are not known and whose `due_at`
 *                         has passed (NULL means "never scheduled", so it is
 *                         due) — the same rule `GET /api/learner/progress`
 *                         uses to count due cards.
 *   3. goal deadlines   — `learner_profile.fields_json.goals[].deadline`,
 *                         matched to a topic by an EXACT (case-insensitive)
 *                         name match. A goal with no deadline cannot influence
 *                         a schedule and is ignored; a goal that matches no
 *                         topic is never forced onto one.
 *   4. the learner's own source ids for the topic — the sources their quiz
 *      questions cited, plus the sources their deck was generated from. Every
 *      candidate id is verified against `sources` for this user before it is
 *      reported, so another account's id can never leak through.
 *
 * Recent activity needs no separate read: every graded attempt rewrites
 * `learner_topics.last_practiced_at`, which is the same recency signal the
 * schedule already sorts on. "Available time" is not stored anywhere (the
 * profile deliberately has no such field), so the plan uses the stated base
 * session lengths instead of pretending to know the learner's free hours.
 *
 * @returns {{evidence: Array<object>, suggestedNext: {topic: string,
 *   difficulty: string}|null}} — `suggestedNext` is A14's deterministic pick.
 */
export async function loadPlanEvidence(db, { userId, now = new Date() } = {}) {
  const dueCutoff = asDate(now).toISOString();

  // 1. graded evidence — a mastery number exists only here.
  const graded = new Map();
  const topicRows = await db.all(
    'SELECT topic, correct, total, last_practiced_at FROM learner_topics '
    + 'WHERE user_id = ? AND total > 0',
    userId,
  );
  for (const row of topicRows) {
    const key = normalizeTopic(row.topic);
    if (!key) continue;
    graded.set(key, {
      correct: Number(row.correct) || 0,
      total: Number(row.total) || 0,
      lastPracticedAt: row.last_practiced_at ?? null,
    });
  }

  // 2. flashcards that are actually due, per topic. Grouped by the stored
  //    topic string and re-keyed with the learner model's normaliser below, so
  //    two decks written with different casing still merge into one topic.
  const dueByTopic = new Map();
  const deckRows = await db.all(
    `SELECT d.topic AS topic, COUNT(*) AS due
       FROM decks d JOIN deck_cards dc ON dc.deck_id = d.id
      WHERE d.user_id = ? AND dc.status <> 'known' AND (dc.due_at IS NULL OR dc.due_at <= ?)
      GROUP BY d.topic`,
    userId, dueCutoff,
  );
  for (const row of deckRows) {
    const key = normalizeTopic(row.topic);
    if (!key) continue;
    dueByTopic.set(key, (dueByTopic.get(key) ?? 0) + (Number(row.due) || 0));
  }

  // 3. goal deadlines the learner stated, keyed by their exact label.
  const goalByTopic = new Map();
  const profile = await loadProfileRow(db, userId);
  const fields = parseJsonObject(profile?.fields_json);
  for (const goal of (Array.isArray(fields.goals) ? fields.goals : [])) {
    const label = typeof goal?.label === 'string' ? goal.label.trim() : '';
    const deadline = typeof goal?.deadline === 'string' ? goal.deadline : null;
    if (!label || deadline === null || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) continue;
    const key = normalizeTopic(label);
    if (key && !goalByTopic.has(key)) goalByTopic.set(key, { label, deadline });
  }

  // 4. the learner's own source ids per topic.
  const candidatesByTopic = new Map();
  const addCandidate = (topic, sourceId) => {
    const key = normalizeTopic(topic);
    if (!key || typeof sourceId !== 'string' || sourceId === '') return;
    if (!candidatesByTopic.has(key)) candidatesByTopic.set(key, new Set());
    candidatesByTopic.get(key).add(sourceId);
  };

  const citationRows = await db.all(
    `SELECT q.topic AS topic, qq.citations_json AS citations_json
       FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.id
      WHERE q.user_id = ? AND qq.citations_json <> '[]'`,
    userId,
  );
  for (const row of citationRows) {
    for (const citation of parseJsonArray(row.citations_json)) {
      if (citation && typeof citation === 'object') addCandidate(row.topic, citation.sourceId ?? citation.source_id);
    }
  }

  const deckSourceRows = await db.all(
    'SELECT topic, source_ids_json FROM decks WHERE user_id = ?',
    userId,
  );
  for (const row of deckSourceRows) {
    for (const sourceId of parseJsonArray(row.source_ids_json)) addCandidate(row.topic, sourceId);
  }

  // One ownership check for every candidate id: only this user's own sources
  // are ever reported.
  const wanted = [...new Set([...candidatesByTopic.values()].flatMap((ids) => [...ids]))];
  const owned = new Set();
  if (wanted.length > 0) {
    const placeholders = wanted.map(() => '?').join(', ');
    const ownRows = await db.all(
      `SELECT id FROM sources WHERE user_id = ? AND id IN (${placeholders})`,
      userId, ...wanted,
    );
    for (const row of ownRows) owned.add(row.id);
  }

  // ---- assemble: a topic is schedulable when it has graded answers, or
  // flashcards that are due. Neither is ever invented.
  const evidence = [];
  for (const topic of new Set([...graded.keys(), ...dueByTopic.keys()])) {
    const stats = graded.get(topic);
    const dueCards = dueByTopic.get(topic) ?? 0;
    if (!stats && dueCards <= 0) continue; // engaged, but nothing actionable
    if (stats && stats.total <= 0) continue; // no graded answer → not measurable

    const sourceIds = [...(candidatesByTopic.get(topic) ?? [])]
      .filter((id) => owned.has(id))
      .sort();
    evidence.push({
      topic,
      correct: stats?.correct ?? 0,
      total: stats?.total ?? 0,
      lastPracticedAt: stats?.lastPracticedAt ?? null,
      dueCards,
      sourceIds,
      goal: goalByTopic.get(topic) ?? null,
    });
  }

  // The recommendation itself is A14's deterministic engine, called here so the
  // plan and the tutor's "what should I revise next" can never disagree. Same
  // rows in, same pick out.
  const advice = await revisionAdvice(db, userId);
  return { evidence, suggestedNext: advice?.suggestedNext ?? null };
}

// ---------- the schedule (pure) ---------------------------------------------

/**
 * One topic's scheduling record — everything `byPriority` sorts on and every
 * `items[]` entry copies. Null for an unusable record, so the caller drops
 * those in one pass.
 */
function planRecord(raw, { recommended, horizonEnd, today }) {
  const topic = normalizeTopic(raw?.topic ?? raw?.name);
  if (!topic) return null;

  const mastery = masteryOf(raw);
  // null, never 1: levelFor(null) is 0, and 0 is not "unassessed".
  const level = mastery === null ? null : levelFor(mastery);
  const dueCards = Math.max(0, Number(raw?.dueCards) || 0);
  const goal = raw?.goal && typeof raw.goal.deadline === 'string' && raw.goal.deadline <= horizonEnd
    ? raw.goal
    : null;
  const activity = activityOf(mastery, dueCards);

  return {
    topic,
    mastery,
    level,
    levelLabel: levelLabel(level),
    activity,
    urgency: urgencyOf(mastery, dueCards, goal !== null),
    recommended: topic === recommended,
    dueCards,
    lastPracticedAt: raw?.lastPracticedAt ?? raw?.last_practiced_at ?? null,
    goal,
    sourceIds: Array.isArray(raw?.sourceIds)
      ? [...new Set(raw.sourceIds.filter((id) => typeof id === 'string' && id !== ''))].sort()
      : [],
    reason: reasonFor({
      mastery,
      total: Math.max(0, Number(raw?.total) || 0),
      dueCards,
      goal,
      today,
    }),
    estimatedMinutes: minutesFor(activity, mastery),
  };
}

/**
 * Build the study plan.
 *
 * @param {Array<object>} evidence — see loadPlanEvidence's record shape.
 * @param {number} days — horizon, integer 1–30.
 * @param {{now?: Date, suggestedNext?: {topic: string}|null}} [options]
 * @returns {{horizonDays: number, hasEvidence: boolean, items: Array<object>,
 *   summary: string}}
 */
export function computePlan(evidence, days, { now = new Date(), suggestedNext = null } = {}) {
  const horizonDays = Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS
    ? days
    : DEFAULT_DAYS;
  const start = asDate(now);
  const today = isoDate(start);
  const horizonEnd = isoDate(new Date(start.getTime() + (horizonDays - 1) * DAY_MS));
  const recommended = normalizeTopic(suggestedNext?.topic);

  // One total order (see byPriority): the topic A14's engine recommended leads
  // its own urgency band; the scheduler never re-decides the recommendation.
  const records = (Array.isArray(evidence) ? evidence : [])
    .map((raw) => planRecord(raw, { recommended, horizonEnd, today }))
    .filter((record) => record !== null)
    .sort(byPriority);

  // One session per day of the horizon. Topics cycle in priority order, so the
  // weakest topic comes back first whenever the horizon outgrows the topic list
  // — the plan fills every day the learner asked for and never pads with an
  // invented topic.
  const items = [];
  for (let day = 1; records.length > 0 && day <= horizonDays; day++) {
    const chosen = records[(day - 1) % records.length];
    items.push({
      day,
      date: isoDate(new Date(start.getTime() + (day - 1) * DAY_MS)),
      topic: chosen.topic,
      level: chosen.level,
      levelLabel: chosen.levelLabel,
      activity: chosen.activity,
      reason: chosen.reason,
      estimatedMinutes: chosen.estimatedMinutes,
      sourceIds: chosen.sourceIds,
    });
  }

  const dueTotal = records.reduce((sum, record) => sum + record.dueCards, 0);
  // Only goals that matched a scheduled topic are reported: the plan never
  // claims progress toward a deadline it cannot act on.
  const goals = records
    .filter((record) => record.goal !== null)
    .map((record) => record.goal)
    .sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));

  return {
    horizonDays,
    hasEvidence: records.length > 0,
    items,
    summary: summaryFor({ records, horizonDays, dueTotal, goals, today }),
  };
}

/** The plan's one-paragraph explanation. Every figure in it is stored data. */
function summaryFor({ records, horizonDays, dueTotal, goals, today }) {
  if (records.length === 0) {
    return 'There is nothing to plan yet — no graded answers and no flashcards are due. '
      + 'Take a short quiz and this plan will be scheduled from your real results.';
  }

  const parts = [
    `Focus on ${records.length} topic${records.length === 1 ? '' : 's'} ${
      horizonDays === 7 ? 'this week' : `over the next ${horizonDays} days`}, `
      + `starting with «${records[0].topic}».`,
  ];
  if (goals.length === 1) {
    parts.push(goalSentence(goals[0], today));
  } else if (goals.length > 1) {
    parts.push(`${goals.length} goals fall inside this plan; the nearest is due on ${goals[0].deadline}.`);
  }
  if (dueTotal > 0) parts.push(`${dueTotal} flashcard${dueTotal === 1 ? '' : 's'} are due for review.`);
  return parts.join(' ');
}
