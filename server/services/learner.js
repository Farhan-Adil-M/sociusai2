// Learner model: deterministic, transparent, explainable.
// mastery = correct / total per topic. No machine learning — a beginner can
// check every number by hand. Pure inference functions plus thin,
// user-scoped persistence helpers; no AI call happens anywhere in this module.
//
// Two scales coexist here and must NOT be confused:
//   * the shipped three-word difficulty (easy|medium|hard) — `difficultyFor`,
//     pinned by tests and used by POST /api/quiz/generate when it omits
//     `difficulty`;
//   * the v2.0 adaptive level 1–4 (foundation|developing|proficient|advanced)
//     with thresholds frozen in docs/API_CONTRACT.md. A31 must use the SAME
//     numbers — see LEVELS / LEVEL_THRESHOLDS below.
//
// Honesty rule: a topic with NO evidence is "unassessed". Its level is `null`,
// never `1`. Guessing a low level for an untested topic would misroute the
// adaptive quiz and invent knowledge the learner never demonstrated. Level 1
// means "evidence exists and mastery is below 0.4" — nothing else.
//
// Ownership note: stated preferences (what the learner *says*) belong to A15's
// personalization.js. Everything in this file is *inferred* from behaviour, and
// every record is tagged `source: 'inferred'` so the two can never be
// mistaken for each other.

import { ApiError } from '../middleware/errors.js';
import { EVENT_WEIGHTS, recordStudyEvent } from './events.js';

/** Grading bands (internal; mastery ranges → next difficulty + revision line). */
const THRESHOLDS = {
  easyBelow: 0.5, // mastery < 0.5 → next questions are easy
  mediumBelow: 0.8, // 0.5 ≤ mastery < 0.8 → medium, else hard
  revisionBelow: 0.6, // needs revision when mastery < 0.6 …
  revisionMinAttempts: 3, // … and the student has tried at least 3 questions
};

/**
 * Frozen adaptive level table — docs/API_CONTRACT.md v2.0 "Difficulty levels".
 * Labels + the practice difficulty each level uses; the numeric boundaries live
 * only in LEVEL_THRESHOLDS below so there is one source of truth:
 *   L1 mastery < 0.4 · L2 < 0.6 · L3 < 0.8 · L4 ≥ 0.8.
 */
export const LEVELS = Object.freeze({
  1: Object.freeze({ label: 'foundation', difficulty: 'easy' }),
  2: Object.freeze({ label: 'developing', difficulty: 'easy' }),
  3: Object.freeze({ label: 'proficient', difficulty: 'medium' }),
  4: Object.freeze({ label: 'advanced', difficulty: 'hard' }),
});

/** Lower mastery bound of each level above 1: level = 1 + (#bounds ≤ mastery). */
export const LEVEL_THRESHOLDS = Object.freeze([0.4, 0.6, 0.8]);

/** Deterministic weighting constants for mastery inference. */
export const MASTERY_MODEL = Object.freeze({
  halfLifeDays: 30, // a response 30 days old counts half as much
  difficultyWeight: Object.freeze({ 1: 1, 2: 2, 3: 3, 4: 4 }), // harder correct answers move mastery more
  fullConfidenceWeight: 12, // effective weight at/above which confidence is 1
});

const DAY_MS = 86400000;

function normalizeTopic(topic) {
  return typeof topic === 'string' ? topic.trim().toLowerCase() : '';
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// ---------- pure difficulty rules (shipped 3-word scale, unchanged) ----------

export function difficultyFor(mastery) {
  if (mastery < THRESHOLDS.easyBelow) return 'easy';
  if (mastery < THRESHOLDS.mediumBelow) return 'medium';
  return 'hard';
}

export function needsRevision({ correct, total }) {
  if (total < THRESHOLDS.revisionMinAttempts) return false;
  return correct / total < THRESHOLDS.revisionBelow;
}

// Apply a graded attempt to one topic's stats. Returns the update to persist.
export function applyAttempt(topic, stats, attempt) {
  const before = stats && stats.total > 0 ? stats.correct / stats.total : null;
  const correct = (stats?.correct ?? 0) + attempt.correct;
  const total = (stats?.total ?? 0) + attempt.total;
  const after = correct / total;
  return {
    topic: topic.trim().toLowerCase(),
    correct,
    total,
    mastery: after,
    difficulty: difficultyFor(after),
    before,
    delta: before === null ? null : Number((after - before).toFixed(4)),
  };
}

// The difficulty to use when the frontend does not pass one explicitly.
export function chooseDifficulty(stats) {
  if (!stats || stats.total === 0) return 'medium';
  return difficultyFor(stats.correct / stats.total);
}

// Which topic should the student tackle next?
// Worst mastery among topics that need revision, else least recently practised.
export function suggestNext(topics) {
  if (!topics || topics.length === 0) return null;
  const flagged = topics.filter(needsRevision);
  const pool = flagged.length > 0 ? flagged : topics;
  const worst = [...pool].sort((a, b) => (a.correct / a.total) - (b.correct / b.total))[0];
  return { topic: worst.topic, difficulty: difficultyFor(worst.correct / worst.total) };
}

// ---------- the 1–4 adaptive level scale (v2.0, frozen numbers) --------------

/**
 * Map a mastery value (0–1) to level 1–4.
 * `null` / `undefined` / any non-finite value → `null` (unassessed), NEVER 1.
 * Callers that need the contract's "no attempts → level 1" wire value for the
 * adaptive endpoint must apply that coercion themselves at the API boundary.
 */
export function levelFor(mastery) {
  const value = Number(mastery);
  if (!Number.isFinite(value)) return null;
  let level = 1;
  for (const bound of LEVEL_THRESHOLDS) if (value >= bound) level += 1;
  return level;
}

/** Level → label. Anything that is not a level 1–4 (including `null`) → "unassessed". */
export function levelLabel(level) {
  return LEVELS[level]?.label ?? 'unassessed';
}

/** Level → the practice difficulty the contract specifies for that level. */
export function difficultyForLevel(level) {
  return LEVELS[level]?.difficulty ?? null;
}

/**
 * Recency factor for one observation: `0.5 ** (ageDays / halfLifeDays)`.
 * A missing/unparseable timestamp scores 1 (unknown age counts fully).
 */
export function decayFactor(at, now = Date.now(), halfLifeDays = MASTERY_MODEL.halfLifeDays) {
  const time = at == null ? NaN : (typeof at === 'number' ? at : Date.parse(at));
  if (!Number.isFinite(time) || !(halfLifeDays > 0)) return 1;
  const ageDays = Math.max(0, (now - time) / DAY_MS);
  return 0.5 ** (ageDays / halfLifeDays);
}

// Correctness evidence kinds. Events that carry no right/wrong outcome
// (approach_change, repeated_question, …) are deliberately NOT accuracy
// evidence — including them would let effort masquerade as knowledge.
const CORRECT_KINDS = new Set(['quiz_item_correct', 'card_known']);
const INCORRECT_KINDS = new Set(['quiz_item_incorrect', 'card_review']);

function outcomeOf(item) {
  if (typeof item.correct === 'boolean') return item.correct;
  if (CORRECT_KINDS.has(item.kind)) return true;
  if (INCORRECT_KINDS.has(item.kind)) return false;
  return null;
}

/**
 * Weighted, time-decayed mastery over a list of evidence observations.
 * Deterministic: the same rows and the same `now` always give the same result.
 *
 * Each observation: `{ kind, correct?, difficulty?: 1–4, at?: ISO }`.
 * Weight = EVENT_WEIGHTS[kind] × difficultyWeight[difficulty] × recencyDecay.
 * mastery = Σ(weight where correct) / Σ(weight)  — i.e. a weighted accuracy in
 * which a hard question answered correctly moves the number more than an easy
 * one, and stale evidence matters less.
 *
 * @returns {{mastery: number|null, level: number|null, levelLabel: string,
 *   difficulty: string|null, hasEvidence: boolean, confidence: number,
 *   effectiveWeight: number, sampleSize: number, source: 'inferred'}}
 */
export function inferMastery(evidence, { now = Date.now() } = {}) {
  const rows = Array.isArray(evidence) ? evidence : [];
  let weightedCorrect = 0;
  let weightSum = 0;
  let sampleSize = 0;

  for (const item of rows) {
    if (!item) continue;
    const correct = outcomeOf(item);
    if (correct === null) continue; // no right/wrong signal → not accuracy evidence

    const difficulty = Number(item.difficulty) || 1;
    const difficultyWeight = MASTERY_MODEL.difficultyWeight[difficulty] ?? 1;
    const weight = (EVENT_WEIGHTS[item.kind] ?? 1) * difficultyWeight * decayFactor(item.at, now);
    if (!(weight > 0)) continue;

    weightSum += weight;
    if (correct) weightedCorrect += weight;
    sampleSize += 1;
  }

  if (sampleSize === 0 || weightSum <= 0) {
    return {
      mastery: null,
      level: null,
      levelLabel: 'unassessed',
      difficulty: null,
      hasEvidence: false,
      confidence: 0,
      effectiveWeight: 0,
      sampleSize: 0,
      source: 'inferred',
    };
  }

  const mastery = weightedCorrect / weightSum;
  const level = levelFor(mastery);
  return {
    mastery,
    level,
    levelLabel: levelLabel(level),
    difficulty: difficultyForLevel(level),
    hasEvidence: true,
    confidence: Math.min(1, weightSum / MASTERY_MODEL.fullConfidenceWeight),
    effectiveWeight: Number(weightSum.toFixed(4)),
    sampleSize,
    source: 'inferred',
  };
}

// ---------- evidence collection (user-scoped reads) --------------------------

// Reads the two authoritative evidence tables for ONE topic of ONE user. Quiz
// items carry their stored difficulty (schema v8) so mastery is difficulty
// weighted; flashcard cards contribute one observation per reviewed card.
// `learning_events` is deliberately NOT read here — it is the append-only
// record of these same observations, so reading both would double-count. Its
// pinned weights still drive inference through EVENT_WEIGHTS above.
async function collectTopicEvidence(db, { userId, topic }) {
  const key = normalizeTopic(topic);
  const evidence = [];

  const quizRows = await db.all(
    `SELECT qa.answers_json AS answers_json, qa.created_at AS at,
            qq.idx AS idx, qq.correct_choice_id AS correct_choice_id, qq.difficulty AS difficulty
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     JOIN quiz_questions qq ON qq.quiz_id = qa.quiz_id
     WHERE q.user_id = ? AND lower(trim(q.topic)) = ?`,
    userId, key,
  );
  for (const row of quizRows) {
    const submitted = parseJsonArray(row.answers_json).find((a) => a && a.index === row.idx);
    const choiceId = submitted && submitted.choiceId != null ? submitted.choiceId : null;
    const correct = choiceId !== null && choiceId === row.correct_choice_id;
    evidence.push({
      kind: correct ? 'quiz_item_correct' : 'quiz_item_incorrect',
      correct,
      difficulty: Number(row.difficulty) || 1,
      at: row.at,
    });
  }

  const cardRows = await db.all(
    `SELECT dc.status AS status, dc.reviewed_at AS at
     FROM deck_cards dc
     JOIN decks d ON d.id = dc.deck_id
     WHERE d.user_id = ? AND lower(trim(d.topic)) = ?`,
    userId, key,
  );
  for (const row of cardRows) {
    if (row.status === 'known') evidence.push({ kind: 'card_known', correct: true, difficulty: 1, at: row.at });
    else if (row.status === 'review') evidence.push({ kind: 'card_review', correct: false, difficulty: 1, at: row.at });
  }

  return evidence;
}

function unassessedRecord(topic) {
  return {
    topic,
    mastery: null,
    masteryPercent: null,
    level: null,
    levelLabel: 'unassessed',
    difficulty: null,
    hasEvidence: false,
    lastAssessedAt: null,
    source: 'inferred',
  };
}

/**
 * A stored `difficulty_levels` row → the assessed record shape every accessor
 * returns. One conversion, so `getTopicMastery` and `summarizeMastery` can
 * never disagree about the level derived from the same row.
 */
function assessedRecord(topic, row) {
  const mastery = Number(row.mastery);
  const level = Number(row.level);
  return {
    topic,
    mastery,
    masteryPercent: Math.round(mastery * 100),
    level,
    levelLabel: levelLabel(level),
    difficulty: difficultyForLevel(level),
    hasEvidence: true,
    lastAssessedAt: row.last_assessed_at,
    source: 'inferred',
  };
}

// ---------- persistence + accessors (all filtered by user_id) ----------------

/**
 * The learner model's record for one topic of one user.
 * No row (or no evidence) → an honest `unassessed` record (`level: null`).
 */
export async function getTopicMastery(db, { userId = 'default', topic } = {}) {
  const key = normalizeTopic(topic);
  if (!key) throw new ApiError(400, 'VALIDATION_ERROR', 'A topic is required.');
  const row = await db.get('SELECT * FROM difficulty_levels WHERE user_id = ? AND topic = ?', userId, key);
  if (!row) return unassessedRecord(key);
  return assessedRecord(key, row);
}

/**
 * Every assessed topic for one user, plus level counts — the read-only roll-up
 * the adaptive progress surface needs. Topics with no evidence simply do not
 * appear (they are unassessed, not level 1).
 */
export async function summarizeMastery(db, { userId = 'default' } = {}) {
  const rows = await db.all(
    'SELECT topic, level, mastery, last_assessed_at FROM difficulty_levels WHERE user_id = ? ORDER BY last_assessed_at DESC',
    userId,
  );
  const topics = rows.map((row) => assessedRecord(row.topic, row));
  const levelCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const item of topics) if (levelCounts[item.level] !== undefined) levelCounts[item.level] += 1;
  return { topics, levelCounts, overall: { topicsAssessed: topics.length } };
}

/**
 * Recompute one topic's mastery from stored evidence, persist it to
 * `difficulty_levels`, and emit a `level_changed` study-history event when the
 * level moved. Call this after a graded attempt has been recorded.
 *
 * `level_changed` is recorded EXPLICITLY here (a direct `recordStudyEvent`
 * call), never as a hidden side effect of a shared read.
 *
 * @returns {{topic: string, before: object, after: object, levelChanged: boolean,
 *   masteryDelta: number|null}} — `before`/`after` are the accessor records;
 *   `masteryDelta` is null on the first assessment (contract: masteryBefore null).
 */
/**
 * The newest timestamp carried by the evidence rows, or `Date.now()` when none
 * of them has one.
 *
 * This — not the wall clock — is what recency decay is measured against when
 * the caller does not inject a `now`. Recency decay's job is to weigh a topic's
 * RECENT history above its stale history (the spaced-repetition semantic); it
 * is not meant to make the level depend on the millisecond the recompute
 * happened to run. Anchoring to the clock did exactly that: every weight
 * carries the decay factor, so a mastery sitting on one of the frozen
 * LEVEL_THRESHOLDS was nudged below it by the microseconds that elapsed since
 * the attempt, and the learner's level flipped between recomputes of
 * identical evidence:
 *
 *   same 4-of-5 attempt, ten recomputes -> 3,4,4,3,3,3,4,4,4,4
 *
 * Anchoring to the newest row instead makes mastery a pure function of the
 * stored evidence, which is what inferMastery's contract already claimed.
 * `difficulty_levels` is only rewritten on a graded attempt, so wall-clock
 * decay never actually aged stored mastery anyway — it bought nothing while
 * costing reproducibility.
 *
 * Never returns NaN: a non-finite `now` makes every observation's weight NaN,
 * every row gets skipped, and a well-evidenced topic reports unassessed (the
 * separate defect pinned in "a non-date now hides a well-evidenced topic").
 * Rows with no parseable timestamp still get decay 1 — the documented
 * "unknown age counts fully" rule.
 */
function newestObservedAt(evidence) {
  let newest = NaN;
  for (const item of evidence) {
    const raw = item?.at;
    const time = raw == null ? NaN : (typeof raw === 'number' ? raw : Date.parse(raw));
    if (Number.isFinite(time) && (!Number.isFinite(newest) || time > newest)) newest = time;
  }
  return Number.isFinite(newest) ? newest : Date.now();
}

export async function updateMasteryLevel(db, { userId = 'default', topic, now } = {}) {
  const key = normalizeTopic(topic);
  if (!key) throw new ApiError(400, 'VALIDATION_ERROR', 'A topic is required.');
  const nowMs = typeof now === 'number' ? now : (now == null ? NaN : Date.parse(now));
  // `at` is bookkeeping: when this row was written, and what summarizeMastery
  // orders by. It stays on the wall clock unless the caller pinned a time.
  const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();

  const before = await getTopicMastery(db, { userId, topic: key });
  const evidence = await collectTopicEvidence(db, { userId, topic: key });
  // The DECAY reference is a different matter — see newestObservedAt above.
  // An explicitly injected `now` still wins, so callers can pin the clock.
  const referenceMs = now == null ? newestObservedAt(evidence) : nowMs;
  const inferred = inferMastery(evidence, { now: referenceMs });

  if (!inferred.hasEvidence) {
    // No evidence → unassessed. Remove any stale cached row so the model never
    // reports a level it cannot back with stored evidence.
    await db.run('DELETE FROM difficulty_levels WHERE user_id = ? AND topic = ?', userId, key);
    return { topic: key, before, after: unassessedRecord(key), levelChanged: before.level !== null, masteryDelta: null };
  }

  await db.run(
    `INSERT INTO difficulty_levels (user_id, topic, level, mastery, last_assessed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, topic) DO UPDATE SET
       level = excluded.level, mastery = excluded.mastery,
       last_assessed_at = excluded.last_assessed_at, updated_at = excluded.updated_at`,
    userId, key, inferred.level, inferred.mastery, at, at,
  );

  const after = {
    topic: key,
    mastery: inferred.mastery,
    masteryPercent: Math.round(inferred.mastery * 100),
    level: inferred.level,
    levelLabel: inferred.levelLabel,
    difficulty: inferred.difficulty,
    hasEvidence: true,
    confidence: inferred.confidence,
    effectiveWeight: inferred.effectiveWeight,
    sampleSize: inferred.sampleSize,
    lastAssessedAt: at,
    source: 'inferred',
  };

  const levelChanged = before.level !== after.level;
  if (levelChanged) {
    await recordStudyEvent(db, {
      type: 'level_changed',
      topic: key,
      detail: `Level ${before.level ?? 'unassessed'} → ${after.level} (${after.levelLabel}); mastery ${after.masteryPercent}%`,
      userId,
    });
  }

  return {
    topic: key,
    before,
    after,
    levelChanged,
    masteryDelta: before.mastery === null ? null : Number((after.mastery - before.mastery).toFixed(4)),
  };
}
