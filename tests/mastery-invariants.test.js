// Mastery invariants — the boundaries, not the happy path.
//
// learner.js / adaptive.js / events.js / grading.js were just refactored and
// carry the project's most delicate invariants. tests/learner.test.js and
// tests/grading.test.js already pin the happy paths; this file pins the
// INVARIANTS and the EDGES:
//
//   * the `levelFor(null) === 1` coercion trap (docs/HANDOFF.md A20) and every
//     caller-side guard that keeps "unassessed" from becoming "foundation";
//   * LEVEL_THRESHOLDS frozen, the ceiling derived from it, and the exact
//     behaviour one ULP either side of 0.4 / 0.6 / 0.8;
//   * unassessed is never level 1, never 0%, never "weak";
//   * the deterministic in-session sequencing rule across easy|medium|hard;
//   * grading determinism (no Math.random, no Date.now in a graded result);
//   * two FILED DEFECTS, documented rather than fixed (I do not own those
//     files): the `Date.now()` clock dependence in updateMasteryLevel, and the
//     `decayFactor` NaN trap when `now` is not a date.
//
// No network, no NIM, no sleeps. Where time matters it is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import {
  LEVELS,
  LEVEL_THRESHOLDS,
  MASTERY_MODEL,
  decayFactor,
  difficultyForLevel,
  getTopicMastery,
  inferMastery,
  levelFor,
  levelLabel,
  summarizeMastery,
  updateMasteryLevel,
} from '../server/services/learner.js';
import {
  adaptiveProgress,
  recordAdaptiveAttempt,
  replayAdaptiveResult,
  resolveLevel,
} from '../server/services/adaptive.js';
import { loadActivityFeed } from '../server/services/events.js';
import {
  CHOICE_IDS,
  gradeAnswers,
  gradeMultiSelect,
  gradeShortAnswer,
} from '../server/services/grading.js';

const DAY_MS = 86400000;
/** A fixed instant, so nothing in this file depends on the machine clock. */
const BASE = Date.UTC(2026, 0, 1);
const iso = (ms) => new Date(ms).toISOString();

// ---------- shared helpers (inlined: no other test file may be edited) ------

async function tempDb(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `socius-mastery-${name}-`));
  const db = await openDb(path.join(dir, 'app.db'));
  t.after(() => db.close());
  return db;
}

/** The next representable double below / above `x` (one ULP). */
const bits = new DataView(new ArrayBuffer(8));
function nextDown(x) {
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
  return bits.getFloat64(0);
}
function nextUp(x) {
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return bits.getFloat64(0);
}

/**
 * One evidence row, seeded straight into the three tables the learner model
 * reads (quizzes → quiz_questions → quiz_attempts), with an explicit
 * `created_at` so recency decay is fully controlled.
 */
async function seedEvidence(db, { topic, rows }) {
  rows.forEach((row, i) => {
    const quizId = `quiz_${topic}_${i}`;
    const at = iso(row.at);
    db.prepare(`INSERT INTO quizzes (id, user_id, topic, difficulty, question_count, created_at, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(quizId, 'default', topic, 'easy', 1, at, at);
    db.prepare(`INSERT INTO quiz_questions (quiz_id, idx, text, choices_json, correct_choice_id, explanation, citations_json, difficulty, estimated_minutes)
      VALUES (?, 0, 'A question long enough to be valid?', '[]', ?, 'Because.', '[]', ?, 1)`)
      .run(quizId, row.key, row.difficulty ?? 1);
    db.prepare(`INSERT INTO quiz_attempts (quiz_id, user_id, answers_json, correct, total, created_at, result_json)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(quizId, 'default', JSON.stringify([{ index: 0, choiceId: row.chosen }]), row.chosen === row.key ? 1 : 0, 1, at);
  });
}

/** A graded quiz, ready for recordAdaptiveAttempt. One question per key. */
async function seedQuiz(db, { topic, difficulty, keys, qDifficulty = 1, at = iso(BASE) }) {
  const quizId = `quiz_graded_${topic}`;
  db.prepare(`INSERT INTO quizzes (id, user_id, topic, difficulty, question_count, created_at, answered_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(quizId, 'default', topic, difficulty, keys.length, at);
  keys.forEach((key, i) => {
    db.prepare(`INSERT INTO quiz_questions (quiz_id, idx, text, choices_json, correct_choice_id, explanation, citations_json, difficulty, estimated_minutes)
      VALUES (?, ?, ?, '[]', ?, 'Because.', '[]', ?, 1)`)
      .run(quizId, i, `Question number ${i} for ${topic}?`, key, qDifficulty);
  });
  return { id: quizId, topic, difficulty, session_id: null };
}

/** `chosen` is what the learner submits, in question order. */
const answersFor = (chosen) => chosen.map((choiceId, index) => ({ index, choiceId }));

/**
 * An INDEPENDENT reference for the in-session sequencing rule, so this file
 * pins behaviour rather than echoing the implementation's own counters:
 * two correct in a row step up, two wrong in a row step down, anything else
 * leaves the level alone, clamped to the derived 1–4 ceiling.
 */
function expectedLevels(startLevel, outcomes) {
  let level = startLevel;
  let runCorrect = 0;
  let runWrong = 0;
  return outcomes.map((correct) => {
    if (correct) { runCorrect += 1; runWrong = 0; } else { runWrong += 1; runCorrect = 0; }
    if (runCorrect >= 2) { level = Math.min(LEVEL_THRESHOLDS.length + 1, level + 1); runCorrect = 0; runWrong = 0; }
    else if (runWrong >= 2) { level = Math.max(1, level - 1); runCorrect = 0; runWrong = 0; }
    return level;
  });
}

/**
 * The route-style guard around levelFor, copied verbatim from
 * services/adaptive.js#levelOf (private, so it is mirrored here):
 *   `mastery === null || mastery === undefined ? null : levelFor(mastery)`.
 */
function guardedLevel(mastery) {
  return mastery === null || mastery === undefined ? null : levelFor(mastery);
}

// ============================================================================
// 1. the frozen level table and the `levelFor(null) === 1` trap
// ============================================================================

test('levelFor(null) is 1 — the documented A20 coercion trap', () => {
  // FILED DEFECT (docs/HANDOFF.md A20, `Number(mastery)`): `Number(null) === 0`
  // is FINITE and below every threshold, so a literal null comes back as level
  // 1. Pinned here as the current behaviour — the guard belongs to the caller
  // (adaptive.js#levelOf), which is covered by the very next test. NOT fixed:
  // this file may not touch server code.
  assert.equal(levelFor(null), 1);

  // The same coercion swallows every non-numeric "empty" value.
  assert.equal(levelFor(undefined), null, 'Number(undefined) is NaN → null, not 1');
  assert.equal(levelFor(''), 1, 'Number("") is 0 → the trap swallows an empty string too');
  assert.equal(levelFor(' '), 1, 'Number(" ") is 0');
  assert.equal(levelFor([]), 1, 'Number([]) is 0');
  assert.equal(levelFor(NaN), null);
  assert.equal(levelFor(Infinity), null);
  assert.equal(levelFor(-Infinity), null);
  // Booleans coerce to 0/1, so `true` is a measured 100%.
  assert.equal(levelFor(true), 4, 'Number(true) is 1, above every bound');
  assert.equal(levelFor(false), 1, 'Number(false) is 0');

  // What the trap would report to a learner, if it were not guarded:
  assert.equal(levelLabel(levelFor(null)), 'foundation');
});

test('every caller-side guard keeps an unassessed topic at null, never 1', () => {
  // The guard adaptive.js applies at every boundary (levelOf), mirrored above.
  for (const value of [null, undefined]) {
    assert.equal(guardedLevel(value), null);
    assert.equal(levelLabel(guardedLevel(value)), 'unassessed');
    assert.equal(difficultyForLevel(guardedLevel(value)), null);
  }
  // A measured topic still resolves normally through the same guard.
  assert.equal(guardedLevel(0), 1, 'measured 0% IS level 1 — level 1 is a measurement');
  assert.equal(guardedLevel(0.5), 2);
  assert.equal(guardedLevel(1), 4);
});

test('LEVEL_THRESHOLDS and LEVELS are frozen and the ceiling is derived from them', () => {
  assert.deepEqual([...LEVEL_THRESHOLDS], [0.4, 0.6, 0.8]);
  assert.ok(Object.isFrozen(LEVEL_THRESHOLDS), 'the bounds must not be mutated at runtime');
  assert.ok(Object.isFrozen(LEVELS), 'the level table must not be mutated at runtime');
  assert.ok(Object.isFrozen(LEVELS[1]) && Object.isFrozen(LEVELS[4]), 'each level entry is frozen too');
  assert.deepEqual(Object.freeze({ ...MASTERY_MODEL }), MASTERY_MODEL);

  // Writing to either table throws in a module (strict mode) rather than
  // silently changing the scale under the app's feet.
  assert.throws(() => { LEVEL_THRESHOLDS[0] = 0.9; }, TypeError);
  assert.throws(() => { LEVEL_THRESHOLDS.push(0.9); }, TypeError);
  assert.throws(() => { LEVELS[1].label = 'novice'; }, TypeError);
  assert.throws(() => { LEVELS[5] = Object.freeze({ label: 'x', difficulty: 'hard' }); }, TypeError);
  assert.throws(() => { MASTERY_MODEL.halfLifeDays = 1; }, TypeError);

  // MAX_LEVEL is DERIVED (adaptive.js: `LEVEL_THRESHOLDS.length + 1`), never
  // hardcoded: the table has exactly one level per bound, plus level 1.
  assert.deepEqual(Object.keys(LEVELS), ['1', '2', '3', '4']);
  assert.equal(Object.keys(LEVELS).length, LEVEL_THRESHOLDS.length + 1);
  assert.equal(LEVEL_THRESHOLDS.length, 3);
  // The highest level levelFor can ever return is the derived ceiling.
  assert.equal(levelFor(1), Object.keys(LEVELS).length);
  for (const value of [0.8, 0.9, 1, 2, 100]) {
    assert.equal(levelFor(value), LEVEL_THRESHOLDS.length + 1, `mastery ${value} must clamp to the derived ceiling`);
  }
  // Every level has its contract label and practice difficulty.
  assert.deepEqual(Object.values(LEVELS).map((l) => l.label), ['foundation', 'developing', 'proficient', 'advanced']);
  assert.deepEqual(Object.values(LEVELS).map((l) => l.difficulty), ['easy', 'easy', 'medium', 'hard']);
});

test('level boundaries hold one ULP either side, and at the domain edges', () => {
  for (const bound of LEVEL_THRESHOLDS) {
    assert.equal(levelFor(nextDown(bound)), bound === 0.4 ? 1 : bound === 0.6 ? 2 : 3, `${nextDown(bound)} is below ${bound}`);
    assert.equal(levelFor(bound), bound === 0.4 ? 2 : bound === 0.6 ? 3 : 4, `exactly ${bound} reaches the level above`);
    assert.equal(levelFor(nextUp(bound)), bound === 0.4 ? 2 : bound === 0.6 ? 3 : 4, `just above ${bound} keeps the level above`);
  }

  // Domain edges: 0 and 1 are inside the documented 0–1 range.
  assert.equal(levelFor(0), 1, '0% is measured and below every bound');
  assert.equal(levelFor(-0), 1);
  assert.equal(levelFor(1), 4, '100% is the top of the scale');
  // Out-of-range mastery still clamps rather than inventing a level.
  assert.equal(levelFor(2), 4);
  assert.equal(levelFor(-1), 1, 'a negative mastery is below every bound, not "unassessed"');
  // Numeric strings are coerced by `Number(mastery)`.
  assert.equal(levelFor('0.9'), 4);
  assert.equal(levelFor('0.5'), 2);
  assert.equal(levelFor('nonsense'), null, 'Number("nonsense") is NaN → null');
});

// ============================================================================
// 2. unassessed is never level 1, never 0%, never "weak"
// ============================================================================

const UNASSESSED = Object.freeze({
  mastery: null,
  level: null,
  levelLabel: 'unassessed',
  difficulty: null,
  hasEvidence: false,
  confidence: 0,
  effectiveWeight: 0,
  sampleSize: 0,
  source: 'inferred',
});

test('inferMastery reports unassessed when there is no accuracy evidence', () => {
  assert.deepEqual(inferMastery([]), UNASSESSED);
  assert.deepEqual(inferMastery(null), UNASSESSED);
  assert.deepEqual(inferMastery(undefined), UNASSESSED);
  assert.deepEqual(inferMastery('not an array'), UNASSESSED);

  // Effort is not knowledge: events with no right/wrong outcome are not
  // accuracy evidence, so they can never produce a level.
  assert.deepEqual(inferMastery([
    { kind: 'approach_change', at: iso(BASE) },
    { kind: 'repeated_question', at: iso(BASE) },
    { kind: 'explain_again', at: iso(BASE) },
  ]), UNASSESSED);
  // A row with no outcome at all is skipped, not fatal.
  assert.deepEqual(inferMastery([{ at: iso(BASE) }, { difficulty: 2, at: iso(BASE) }]), UNASSESSED);
  // Falsy / junk rows are skipped, not fatal.
  assert.deepEqual(inferMastery([null, undefined, 0, '', {}]), UNASSESSED);
  // The `kind` alone carries the outcome when `correct` is absent: an event
  // whose kind is not in either accuracy set is not accuracy evidence, but
  // quiz_item_* and card_known/card_review always are.
  assert.equal(inferMastery([{ kind: 'quiz_item_correct' }]).hasEvidence, true,
    'the kind carries the outcome when `correct` is missing');
  assert.equal(inferMastery([{ kind: 'card_review' }]).hasEvidence, true);
  assert.equal(inferMastery([{ kind: 'no_such_event' }]).hasEvidence, false);

  // Mastery is NEVER 0 for an unassessed topic — 0% is a measurement.
  assert.equal(inferMastery([]).masteryPercent ?? null, null);
});

test('levelLabel and difficultyForLevel never invent a level outside 1-4', () => {
  for (const level of [null, undefined, 0, -1, 5, NaN, 'x', {}, [], true]) {
    assert.equal(levelLabel(level), 'unassessed', `levelLabel(${String(level)})`);
    assert.equal(difficultyForLevel(level), null, `difficultyForLevel(${String(level)})`);
  }
  // The frozen table, read back through the accessors.
  for (const level of [1, 2, 3, 4]) {
    assert.equal(levelLabel(level), LEVELS[level].label);
    assert.equal(difficultyForLevel(level), LEVELS[level].difficulty);
  }
});

test('a topic with no stored evidence reads unassessed from the learner model', async (t) => {
  const db = await tempDb(t, 'unassessed');

  const record = await getTopicMastery(db, { topic: 'Never Studied' });
  assert.equal(record.topic, 'never studied', 'the topic key is normalised');
  assert.equal(record.mastery, null);
  assert.equal(record.masteryPercent, null, 'never 0%');
  assert.equal(record.level, null, 'never level 1');
  assert.equal(record.levelLabel, 'unassessed');
  assert.equal(record.difficulty, null);
  assert.equal(record.hasEvidence, false);
  assert.equal(record.lastAssessedAt, null);
  assert.equal(record.source, 'inferred');

  // The roll-up: an empty account is empty, and no level is counted.
  const summary = await summarizeMastery(db, {});
  assert.deepEqual(summary.topics, []);
  assert.deepEqual(summary.levelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });
  assert.deepEqual(summary.overall, { topicsAssessed: 0 });

  // A blank topic is a validation error, not an unassessed topic.
  await assert.rejects(() => getTopicMastery(db, { topic: '   ' }), (err) => err.status === 400 && err.code === 'VALIDATION_ERROR');
});

test('the unassessed contract holds on every wire surface', async (t) => {
  const db = await tempDb(t, 'surfaces');

  // A generated but unanswered quiz is real engagement with no evidence.
  const pending = await seedQuiz(db, { topic: 'Pending Topic', difficulty: 'medium', keys: ['a', 'b'] });

  // 1. resolveLevel (POST /api/adaptive/generate)
  const resolved = await resolveLevel(db, { userId: 'default', topic: 'pending topic' });
  assert.equal(resolved.level, null, 'an unassessed topic is not served at level 1');
  assert.equal(resolved.levelLabel, 'unassessed');
  assert.equal(resolved.hasEvidence, false);
  assert.equal(resolved.masteryPercent, null);
  assert.equal(resolved.difficulty, 'medium', 'falls back to the neutral generate default');

  // 2. adaptiveProgress (GET /api/adaptive/progress)
  const progress = await adaptiveProgress(db, { userId: 'default' });
  assert.equal(progress.topics.length, 1, 'an unanswered topic is still listed');
  const entry = progress.topics[0];
  assert.equal(entry.topic, 'pending topic');
  assert.equal(entry.level, null);
  assert.equal(entry.levelLabel, 'unassessed');
  assert.equal(entry.masteryPercent, null, 'never 0%');
  assert.equal(entry.correct, 0);
  assert.equal(entry.total, 0);
  assert.equal(entry.needsRevision, false, 'needsRevision needs at least 3 attempts');
  assert.equal(entry.lastPracticedAt, null);
  assert.deepEqual(progress.levelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 }, 'an unmeasured topic is not counted as level 1');

  // 3. the activity feed's topicMastery block (events.js#topicMasteryOf)
  db.prepare(`INSERT INTO activity (type, topic, detail, at, user_id)
    VALUES ('quiz_answered', 'ghost topic', '3/3 correct', ?, 'default')`).run(iso(BASE + DAY_MS));
  const feed = await loadActivityFeed(db, { userId: 'default' });
  assert.equal(feed.events.length, 1);
  assert.deepEqual(feed.events[0].topicMastery, {
    masteryPercent: null,
    level: null,
    levelLabel: 'unassessed',
    hasEvidence: false,
  });

  // 4. the 409 replay path never invents a level either
  const replay = await replayAdaptiveResult(db, {
    quiz: pending,
    answersJson: JSON.stringify(answersFor(['a', 'b'])),
    userId: 'default',
  });
  assert.deepEqual(replay.levelUpdate, {
    topic: 'pending topic', beforeLevel: null, afterLevel: null, masteryBefore: null, masteryAfter: null,
  });
  assert.equal(replay.recommendedLevel, null);
});

// ============================================================================
// 3. the in-session sequencing rule, through recordAdaptiveAttempt
// ============================================================================

// ADAPTIVE SEQUENCING RULE (services/adaptive.js, STREAK_TO_SHIFT = 2):
//   two correct in a row → level + 1; two wrong in a row → level − 1;
//   any other outcome leaves the level alone; clamped to 1–4.
// Start levels come from the quiz's stored practice difficulty via the frozen
// LEVELS table: easy → 1, medium → 3, hard → 4.

test('two correct in a row step the level up; alternating never moves it', async (t) => {
  const db = await tempDb(t, 'sequence');

  const cases = [
    { difficulty: 'easy', start: 1, chosen: ['a', 'a'], final: 2 },
    { difficulty: 'medium', start: 3, chosen: ['a', 'a'], final: 4 },
    { difficulty: 'hard', start: 4, chosen: ['a', 'a'], final: 4 },
    { difficulty: 'easy', start: 1, chosen: ['a', 'b'], final: 1 },
    { difficulty: 'medium', start: 3, chosen: ['a', 'b'], final: 3 },
    { difficulty: 'hard', start: 4, chosen: ['a', 'b'], final: 4 },
    { difficulty: 'easy', start: 1, chosen: ['a', 'b', 'a', 'b'], final: 1 },
    { difficulty: 'medium', start: 3, chosen: ['a', 'b', 'a', 'b'], final: 3 },
    { difficulty: 'hard', start: 4, chosen: ['a', 'b', 'a', 'b'], final: 4 },
  ];

  for (const [i, testCase] of cases.entries()) {
    const topic = `seq ${i}`;
    const keys = Array.from({ length: testCase.chosen.length }, () => 'a');
    const quiz = await seedQuiz(db, { topic, difficulty: testCase.difficulty, keys });
    const result = await recordAdaptiveAttempt(db, { userId: 'default', quiz, answers: answersFor(testCase.chosen) });

    const { adaptation } = result;
    assert.equal(adaptation.startLevel, testCase.start, `${topic}: start level`);
    assert.equal(adaptation.finalLevel, testCase.final, `${topic}: final level`);
    assert.equal(adaptation.streakToShift, 2, 'the rule is "two in a row"');
    assert.equal(adaptation.practiceDifficulty, testCase.difficulty);
    assert.equal(result.recommendedLevel,
      result.levelUpdate === null ? adaptation.finalLevel : result.levelUpdate.afterLevel,
      'the learner model\'s level wins; the in-session run is the fallback');
    // One step per answer, each reporting the level before and after it, and
    // matching the independent reference implementation above.
    assert.equal(adaptation.steps.length, keys.length);
    adaptation.steps.forEach((step, index) => {
      assert.equal(step.index, index);
      assert.equal(step.correct, testCase.chosen[index] === 'a');
      assert.equal(step.levelBefore,
        index === 0 ? adaptation.startLevel : adaptation.steps[index - 1].levelAfter);
    });
    const outcomes = testCase.chosen.map((choice) => choice === 'a');
    assert.deepEqual(adaptation.steps.map((s) => s.levelAfter),
      expectedLevels(testCase.start, outcomes), `${topic}: the reference run`);
    assert.equal(adaptation.finalLevel, expectedLevels(testCase.start, outcomes).at(-1));
    // A single lucky or unlucky answer only starts a run: the first answer of
    // any attempt can never change the level.
    assert.equal(adaptation.steps[0].levelAfter, adaptation.steps[0].levelBefore);
  }
});

test('ten wrong answers clamp the level down to 1 on every difficulty', async (t) => {
  const db = await tempDb(t, 'clamp-low');

  for (const [i, difficulty] of ['easy', 'medium', 'hard'].entries()) {
    const topic = `clamp-low ${i}`;
    const keys = Array.from({ length: 10 }, () => 'a');
    const quiz = await seedQuiz(db, { topic, difficulty, keys });
    const result = await recordAdaptiveAttempt(db, {
      userId: 'default', quiz, answers: answersFor(Array(10).fill('b')),
    });
    const { adaptation } = result;
    assert.equal(adaptation.startLevel, difficulty === 'easy' ? 1 : difficulty === 'medium' ? 3 : 4);
    assert.equal(adaptation.finalLevel, 1, `${difficulty}: ten wrong clamp to the floor`);
    assert.equal(result.score.correct, 0);
    assert.equal(result.score.total, 10);
    assert.equal(result.score.percent, 0);
    // Every level value observed inside the run stays inside [1, 4].
    const seen = adaptation.steps.flatMap((s) => [s.levelBefore, s.levelAfter]);
    assert.ok(seen.every((level) => level >= 1 && level <= 4));
  }
});

test('the run is clamped to 4 at the top: a hard quiz never rises above it', async (t) => {
  const db = await tempDb(t, 'clamp-high');
  const keys = Array.from({ length: 10 }, () => 'a');
  const quiz = await seedQuiz(db, { topic: 'ceiling', difficulty: 'hard', keys });
  const result = await recordAdaptiveAttempt(db, { userId: 'default', quiz, answers: answersFor(keys) });
  assert.equal(result.adaptation.startLevel, 4, 'hard starts at the derived ceiling');
  assert.equal(result.adaptation.finalLevel, 4, 'twenty correct answers cannot exceed level 4');
  assert.ok(result.adaptation.steps.every((s) => s.levelAfter === 4));
});

test('a failing learner model degrades the level but never the grade', async (t) => {
  const db = await tempDb(t, 'degraded');
  const keys = ['a', 'a', 'b'];
  const quiz = await seedQuiz(db, { topic: 'degraded topic', difficulty: 'medium', keys });
  // Fail ONLY the learner-model table, so the attempt itself can still be
  // graded and recorded: the code must not turn a model failure into a 500.
  const failing = new Proxy(db, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (typeof args[0] === 'string' && args[0].includes('difficulty_levels')) {
          throw new Error('injected learner-model failure');
        }
        return value.apply(target, args);
      };
    },
  });

  const result = await recordAdaptiveAttempt(failing, { userId: 'default', quiz, answers: answersFor(['a', 'a', 'a']) });

  // The grade is intact and the in-session run still moved the level.
  assert.deepEqual(result.score, { correct: 2, total: 3, percent: 67 });
  assert.equal(result.adaptation.startLevel, 3);
  assert.equal(result.adaptation.finalLevel, 4);
  assert.equal(result.levelUpdate, null, 'no level update is reported');
  assert.equal(result.levelUpdateFailed, true, 'the client can say the level was not refreshed');
  assert.equal(result.recommendedLevel, 4, 'the in-session run is the fallback');

  // The attempt and the flat learner_topics counts were still written, so a
  // later attempt can recompute the same level from the stored evidence.
  const attempt = failing.prepare('SELECT correct, total, result_json FROM quiz_attempts WHERE quiz_id = ?').get(quiz.id);
  assert.equal(attempt.correct, 2);
  assert.equal(attempt.total, 3);
  assert.equal(JSON.parse(attempt.result_json).levelUpdateFailed, true);
  const stats = failing.prepare('SELECT correct, total FROM learner_topics WHERE topic = ?').get('degraded topic');
  assert.equal(stats.correct, 2);
  assert.equal(stats.total, 3);

  // A healthy db recomputes the level from that same evidence: self-healing.
  // Note this is a DIFFERENT number from the in-session run above (mastery is
  // 2/3 → level 3, while two correct in a row had raised the session to 4):
  // the learner model measures, the session rule sequences, and the wire
  // prefers the measurement when it is available.
  const healed = await updateMasteryLevel(db, { userId: 'default', topic: 'degraded topic' });
  assert.equal(healed.after.hasEvidence, true);
  assert.ok(Math.abs(healed.after.mastery - (2 / 3)) < 1e-12);
  assert.equal(healed.after.level, 3);
  assert.equal(healed.after.difficulty, 'medium');
});

test('the replay path rebuilds the identical in-session run', async (t) => {
  const db = await tempDb(t, 'replay');
  const keys = ['a', 'a', 'b', 'c', 'd'];
  const chosen = ['a', 'b', 'b', 'c', 'd']; // 2/5
  const quiz = await seedQuiz(db, { topic: 'replay topic', difficulty: 'medium', keys });
  const first = await recordAdaptiveAttempt(db, { userId: 'default', quiz, answers: answersFor(chosen) });

  // A result payload is stored verbatim, so a resubmission replays it exactly.
  const stored = JSON.parse(db.prepare('SELECT result_json AS j FROM quiz_attempts WHERE quiz_id = ?').get(quiz.id).j);
  assert.deepEqual(stored, first);

  // For a row written by an older build (no result_json), the replay recomputes
  // the same deterministic run but reports the pre-attempt state as null rather
  // than inventing it.
  db.prepare('UPDATE quiz_attempts SET result_json = NULL WHERE quiz_id = ?').run(quiz.id);
  const replayed = await replayAdaptiveResult(db, { quiz, answersJson: JSON.stringify(answersFor(chosen)), userId: 'default' });
  assert.deepEqual(replayed.adaptation, first.adaptation, 'the same answers give the same run');
  assert.deepEqual(replayed.score, first.score);
  assert.equal(replayed.levelUpdate.beforeLevel, null);
  assert.equal(replayed.levelUpdate.masteryBefore, null);
  assert.equal(replayed.levelUpdate.afterLevel, first.levelUpdate.afterLevel);
});

// ============================================================================
// 4. grading determinism
// ============================================================================

test('grading is deterministic: the same answers always produce the same score', () => {
  const questions = [
    { idx: 0, text: 'Q0?', correct_choice_id: 'b', explanation: 'x', citations_json: '[]' },
    { idx: 1, text: 'Q1?', correct_choice_id: 'a', explanation: 'y', citations_json: '[]' },
    { idx: 2, text: 'Q2?', correct_choice_id: 'a', explanation: 'z', citations_json: '[]' },
  ];
  const answers = [
    { index: 0, choiceId: 'b' },
    { index: 1, choiceId: null },
    { index: 2, choiceId: 'c' },
  ];
  const first = gradeAnswers(questions, answers);
  for (let i = 0; i < 25; i += 1) {
    assert.deepEqual(gradeAnswers(questions, answers), first, `run ${i} differs`);
  }
  // Hand-checkable: 1 correct of 3, unanswered and wrong both score 0.
  assert.equal(first.correct, 1);
  assert.equal(first.total, 3);
  assert.equal(first.partial, false, 'MCQ is binary every time');
  assert.deepEqual(first.perQuestion.map((q) => q.correct), [true, false, false]);
  // The result shape is exactly the four documented keys — nothing extra that
  // a caller could mistake for a timestamp or a random tie-breaker.
  assert.deepEqual(Object.keys(first).sort(), ['correct', 'partial', 'perQuestion', 'total']);

  // The other two graders in the module are equally repeatable, and the key is
  // exactly the choice ids the contract allows.
  assert.deepEqual([...CHOICE_IDS], ['a', 'b', 'c', 'd']);
  const select = gradeMultiSelect(['a', 'b', 'c'], ['a', 'b'], { partial: true });
  const short = gradeShortAnswer('the cell nucleus holds dna', 'The cell nucleus holds', { partial: true });
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(gradeMultiSelect(['a', 'b', 'c'], ['a', 'b'], { partial: true }), select);
    assert.deepEqual(gradeShortAnswer('the cell nucleus holds dna', 'The cell nucleus holds', { partial: true }), short);
  }
  assert.equal(select.correct, false);
  assert.equal(select.hits, 2, 'two of the three key choices were picked');
  assert.equal(select.misses, 0);
  // Partial credit: (2 hits − 0 misses) / |correct set| = 2/3.
  assert.equal(select.score, 0.6667);
  assert.equal(select.partial, true);
  assert.equal(short.score, 0.5);
  assert.equal(short.correct, false);
});

test('a graded adaptive attempt is byte-identical when the same quiz is answered the same way', async (t) => {
  const keys = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a']; // 5 correct of 8 → 0.625, no threshold nearby
  const chosen = ['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b'];
  const build = async (name) => {
    const db = await tempDb(t, `determinism-${name}`);
    const quiz = await seedQuiz(db, { topic: 'determinism topic', difficulty: 'medium', keys });
    const result = await recordAdaptiveAttempt(db, { userId: 'default', quiz, answers: answersFor(chosen) });
    return { db, result };
  };

  const first = await build('first');
  const second = await build('second');

  assert.deepEqual(second.result, first.result, 'identical stored questions and answers → identical payload');
  assert.deepEqual(second.result.score, { correct: 5, total: 8, percent: 63 });
  assert.deepEqual(second.result.questions.map((q) => q.correct),
    [true, true, true, true, true, false, false, false]);
  assert.equal(second.result.levelUpdate.masteryBefore, null, 'first attempt: masteryBefore is null');
  assert.equal(second.result.levelUpdate.beforeLevel, null, 'first attempt: beforeLevel is null');
  // Difficulty weighting is mastery, not the naive ratio (both agree at 5/8
  // only because every question here is level 1).
  assert.ok(Math.abs(second.result.levelUpdate.masteryAfter - 0.625) < 1e-9);
  assert.equal(second.result.levelUpdate.afterLevel, first.result.levelUpdate.afterLevel);

  // The stored payload round-trips byte-identically, which is what the 409
  // replay returns.
  const stored = JSON.parse(second.db.prepare('SELECT result_json AS j FROM quiz_attempts').get().j);
  assert.deepEqual(stored, first.result);

  // A graded payload carries no wall-clock timestamp at all.
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(JSON.stringify(second.result)), false,
    'no ISO timestamp anywhere in the graded result — it must be reproducible');
});

test('the learner model uses the weighted mastery, not the naive ratio', async (t) => {
  const db = await tempDb(t, 'weighted');
  // 1/2 correct, but the correct answer was a level-4 question: weight
  // 3×4 = 12 against 3×1 = 3 for the wrong level-1 one → 12/15 = 0.8.
  const keys = ['a', 'a'];
  const quiz = await seedQuiz(db, { topic: 'weighted topic', difficulty: 'medium', keys, qDifficulty: 4 });
  db.prepare('UPDATE quiz_questions SET difficulty = 1 WHERE quiz_id = ? AND idx = 1').run(quiz.id);
  const result = await recordAdaptiveAttempt(db, { userId: 'default', quiz, answers: answersFor(['a', 'b']) });

  assert.deepEqual(result.score, { correct: 1, total: 2, percent: 50 }, 'the plain percent is still reported');
  assert.ok(Math.abs(result.levelUpdate.masteryAfter - 0.8) < 1e-9, 'mastery is difficulty weighted');

  // learner_topics keeps the plain counts the legacy surface has always read;
  // the two scales must not be confused.
  const stats = db.prepare('SELECT correct, total FROM learner_topics WHERE topic = ?').get('weighted topic');
  assert.equal(stats.correct, 1);
  assert.equal(stats.total, 2);
});

// ============================================================================
// 5. FILED DEFECT — updateMasteryLevel reads Date.now()
// ============================================================================

test('FILED DEFECT (not fixed): the omitted now reads the wall clock', async (t) => {
  // DEFECT, filed in docs/HANDOFF.md, deliberately NOT fixed here (this file
  // may not modify server code): `updateMasteryLevel(db, { userId, topic,
  // now = Date.now() })`, and services/adaptive.js#recordAdaptiveAttempt calls
  // it WITHOUT `now` — so the recompute is anchored to whatever the clock says
  // at request time instead of to the attempt being graded. This test observes
  // that dependence; the injected alternative is pinned in the next test.
  const db = await tempDb(t, 'clock-read');
  const rows = [{ key: 'a', chosen: 'a', at: BASE }];
  await seedEvidence(db, { topic: 'clock topic', rows });

  const wallBefore = Date.now();
  const result = await updateMasteryLevel(db, { userId: 'default', topic: 'clock topic' });
  const wallAfter = Date.now();

  const stamped = Date.parse(result.after.lastAssessedAt);
  assert.ok(Number.isFinite(stamped), 'an ISO timestamp was produced');
  assert.ok(stamped >= wallBefore - 1000 && stamped <= wallAfter + 1000,
    'the timestamp came from the wall clock, not from the stored evidence');

  // Evidence dated ahead of the clock is clamped to full weight, so a store
  // whose clock has drifted past its own evidence still measures correctly.
  assert.equal(decayFactor(iso(BASE + 10 * DAY_MS), BASE), 1);
});

test('FILED DEFECT (not fixed): an injected now is honoured, and a number and an ISO string agree', async (t) => {
  const db = await tempDb(t, 'inject-now');
  const rows = [
    { key: 'a', chosen: 'a', at: BASE, difficulty: 1 },
    { key: 'a', chosen: 'b', at: BASE, difficulty: 1 },
    { key: 'a', chosen: 'a', at: BASE, difficulty: 2 },
  ];
  await seedEvidence(db, { topic: 'clock topic', rows });

  const atNumber = BASE + 10 * DAY_MS;
  const byNumber = await updateMasteryLevel(db, { userId: 'default', topic: 'clock topic', now: atNumber });
  const byString = await updateMasteryLevel(db, { userId: 'default', topic: 'clock topic', now: iso(atNumber) });

  assert.deepEqual(byString.after, byNumber.after, 'number and ISO string must not disagree');
  assert.equal(byNumber.after.lastAssessedAt, iso(atNumber));
  assert.equal(byNumber.after.source, 'inferred');
  // Weights: (3×1 + 3×2) correct against (3×1) wrong, all decayed by the same
  // factor 0.5^(10/30) → (3f + 6f) / (3f + 6f + 3f) = 0.75, level 3.
  assert.ok(Math.abs(byNumber.after.mastery - 0.75) < 1e-12);
  assert.equal(byNumber.after.level, 3);
  assert.equal(byNumber.after.levelLabel, 'proficient');
  assert.equal(byNumber.topic, 'clock topic');
  assert.equal(byNumber.before.level, null, 'nothing had been assessed before');
  assert.equal(byNumber.masteryDelta, null, 'first assessment: masteryDelta is null');
});

test('FILED DEFECT (clock dependence): one millisecond of clock flips the level', async (t) => {
  // DEFECT, filed, NOT fixed. `updateMasteryLevel` passes its `now` straight
  // into the recency decay, so a topic whose mastery sits exactly on a frozen
  // boundary is reported at a DIFFERENT LEVEL depending on the instant the
  // recompute ran at.
  //
  // Construction (deterministic — no sleeping, the time is injected):
  //   one WRONG answer 30 days before BASE   (weight 3, decayed)
  //   one RIGHT answer 100 days AFTER  BASE  (weight 3, fully fresh)
  // Mastery = 1 / (1 + 0.5 ** (ageInDays / 30)), which crosses the 0.8 bound
  // exactly 60 days after the wrong answer, i.e. at BASE + 30 days.
  const rows = [
    { key: 'a', chosen: 'b', at: BASE - 30 * DAY_MS },
    { key: 'a', chosen: 'a', at: BASE + 100 * DAY_MS },
  ];

  const justBefore = await tempDb(t, 'flip-before');
  await seedEvidence(justBefore, { topic: 'edge topic', rows });
  const before = await updateMasteryLevel(justBefore, { userId: 'default', topic: 'edge topic', now: BASE + 30 * DAY_MS - 1 });
  assert.ok(before.after.mastery < 0.8, 'one millisecond earlier the value is below the bound');
  assert.equal(before.after.level, 3);
  assert.equal(before.after.levelLabel, 'proficient');

  const atBoundary = await tempDb(t, 'flip-at');
  await seedEvidence(atBoundary, { topic: 'edge topic', rows });
  const at = await updateMasteryLevel(atBoundary, { userId: 'default', topic: 'edge topic', now: BASE + 30 * DAY_MS });
  assert.equal(at.after.mastery, 0.8, 'exactly on the bound');
  assert.equal(at.after.level, 4, '>= the bound reaches the level above');
  assert.equal(at.after.levelLabel, 'advanced');

  // The two runs read the SAME stored rows. Only the clock moved.
  assert.equal(before.topic, at.topic);
  assert.equal(before.after.sampleSize, at.after.sampleSize);
});

test('FILED DEFECT (recency rounding): 80% can be reported as level 3', async (t) => {
  // DEFECT, filed, NOT fixed. The same failure shows up without any future
  // timestamp at all: 4 correct of 5 has a mathematically exact mastery of 0.8,
  // but each weight carries the decay factor, so the ratio inherits its
  // rounding. With the evidence 1ms old the raw value lands one ULP below the
  // bound and the level drops — while the reported percentage still says 80.
  // (`updateMasteryLevel` is given the evidence's own `at`, so no wall clock
  // and no sleeping is involved: only `now` is injected.)
  const rows = [
    { key: 'a', chosen: 'a', at: BASE },
    { key: 'a', chosen: 'a', at: BASE },
    { key: 'a', chosen: 'a', at: BASE },
    { key: 'a', chosen: 'a', at: BASE },
    { key: 'a', chosen: 'b', at: BASE },
  ];

  const freshDb = await tempDb(t, 'rounding-fresh');
  await seedEvidence(freshDb, { topic: 'rounding topic', rows });
  const fresh = await updateMasteryLevel(freshDb, { userId: 'default', topic: 'rounding topic', now: BASE });
  assert.equal(fresh.after.mastery, 0.8, 'zero age → the decay factor is exactly 1');
  assert.equal(fresh.after.level, 4);

  const staleDb = await tempDb(t, 'rounding-stale');
  await seedEvidence(staleDb, { topic: 'rounding topic', rows });
  const stale = await updateMasteryLevel(staleDb, { userId: 'default', topic: 'rounding topic', now: BASE + 1 });
  assert.ok(stale.after.mastery < 0.8, 'a millisecond of decay pushes it under the bound');
  assert.equal(stale.after.level, 3);

  // The inconsistency a learner would see: "80%" labelled proficient, where
  // level 3 means "below 80%".
  assert.equal(stale.after.masteryPercent, 80);
  assert.equal(stale.after.levelLabel, 'proficient');
});

// ============================================================================
// 6. FILED DEFECT — decayFactor with a non-date `now`
// ============================================================================

test('FILED DEFECT (not fixed): a non-date now makes decayFactor NaN', () => {
  // DEFECT, filed, NOT fixed. `decayFactor(at, now)` only guards `at` and the
  // half-life. When `now` is not a number the subtraction yields NaN, the
  // exponent is NaN, and every weight becomes NaN — which `inferMastery` then
  // skips as "not > 0", so the topic silently reads as unassessed.
  const at = iso(BASE);

  assert.ok(Number.isNaN(decayFactor(at, 'not a date')), 'an unparseable now → NaN');
  assert.ok(Number.isNaN(decayFactor(at, {})), 'an object now → NaN');
  assert.ok(Number.isNaN(decayFactor(at, 'yesterday')), 'a date-looking string → NaN');

  // A *parseable* ISO string is still NaN, because `now` is only subtracted —
  // never parsed. That is the part that makes the trap easy to fall into: the
  // value looks like a timestamp.
  assert.ok(Number.isNaN(decayFactor(at, iso(BASE + 5 * DAY_MS))));

  // Booleans, null and arrays coerce through the subtraction (true → 1,
  // false/null/[] → 0), so the age is a huge negative number, the clamp turns
  // it into 0 days, and the answer is silently 1 instead of an error.
  assert.equal(decayFactor(at, true), 1, 'a boolean now is silently full weight');
  assert.equal(decayFactor(at, false), 1);
  assert.equal(decayFactor(at, null), 1);
  assert.equal(decayFactor(at, []), 1);

  // The documented behaviour for `at` is unchanged: missing/unparseable `at`
  // scores 1 (unknown age counts fully), and a non-positive half-life does too.
  assert.equal(decayFactor(null, BASE), 1);
  assert.equal(decayFactor(undefined, BASE), 1);
  assert.equal(decayFactor('not a date', BASE), 1);
  assert.equal(decayFactor(at, BASE, 0), 1);
  assert.equal(decayFactor(at, BASE, -1), 1);

  // Deterministic recency: half-life 30 days, clamped at 0 for future rows.
  assert.equal(decayFactor(at, BASE), 1);
  assert.equal(decayFactor(at, BASE + 30 * DAY_MS), 0.5);
  assert.equal(decayFactor(at, BASE + 60 * DAY_MS), 0.25);
  assert.equal(decayFactor(at, BASE - 30 * DAY_MS), 1, 'a future row is clamped to full weight');
  assert.equal(decayFactor(at, BASE + 10 * DAY_MS, 10), 0.5, 'a custom half-life is honoured');
  assert.equal(decayFactor(at, BASE + 30 * DAY_MS, 10), 0.125, '3 half-lives of a custom length');
});

test('FILED DEFECT (not fixed): a non-date now hides a well-evidenced topic and deletes its cached row', async (t) => {
  // DEFECT, filed, NOT fixed. `inferMastery` is happy to be handed a bad `now`
  // (the default `Date.now()` is a number) and `updateMasteryLevel` normalises
  // its own `now` with Date.parse, so the two entry points disagree about what
  // they accept: the same ISO string that works through updateMasteryLevel
  // turns EVERY observation off through inferMastery.
  const rows = [
    { key: 'a', chosen: 'a', at: BASE },
    { key: 'a', chosen: 'a', at: BASE },
    { key: 'a', chosen: 'b', at: BASE },
  ];
  const evidence = rows.map((r) => ({
    kind: r.chosen === r.key ? 'quiz_item_correct' : 'quiz_item_incorrect',
    difficulty: 1,
    at: iso(r.at),
  }));

  // The control: a real, well-evidenced topic reports level 3 at 67% — two
  // correct against one wrong, none of it on a threshold.
  const control = await tempDb(t, 'nan-control');
  await seedEvidence(control, { topic: 'evidence topic', rows });
  const measured = await updateMasteryLevel(control, { userId: 'default', topic: 'evidence topic', now: BASE });
  assert.equal(measured.after.hasEvidence, true);
  assert.equal(measured.after.sampleSize, 3);
  assert.ok(Math.abs(measured.after.mastery - (2 / 3)) < 1e-12);
  assert.equal(measured.after.level, 3);
  const cached = control.prepare('SELECT level, mastery FROM difficulty_levels WHERE topic = ?').get('evidence topic');
  assert.equal(cached.level, 3);
  assert.ok(Math.abs(cached.mastery - (2 / 3)) < 1e-12);

  // inferMastery accepts a NUMBER; the same ISO string silently unassesses it.
  assert.equal(inferMastery(evidence, { now: BASE }).hasEvidence, true);
  const swallowed = inferMastery(evidence, { now: iso(BASE) });
  assert.deepEqual(swallowed, UNASSESSED, 'a date-string now switches every observation off');
  assert.equal(swallowed.sampleSize, 0, 'no observation was counted at all');

  // And through updateMasteryLevel with an unparseable `now`, the cached row
  // for a well-evidenced topic is DELETED and the topic is reported
  // unassessed — with levelChanged: true, i.e. a level_changed study event is
  // emitted for a level that was never measured to have moved.
  const cleared = await updateMasteryLevel(control, { userId: 'default', topic: 'evidence topic', now: 'not a date' });
  // unassessedRecord(topic) — note it carries masteryPercent/lastAssessedAt and
  // NONE of inferMastery's confidence/sampleSize fields, which is why the two
  // unassessed shapes cannot be compared to each other.
  assert.deepEqual(cleared.after, {
    topic: 'evidence topic',
    mastery: null,
    masteryPercent: null,
    level: null,
    levelLabel: 'unassessed',
    difficulty: null,
    hasEvidence: false,
    lastAssessedAt: null,
    source: 'inferred',
  });
  assert.equal(cleared.before.level, 3, 'the row that was just deleted');
  assert.equal(cleared.after.level, null);
  assert.equal(cleared.levelChanged, true, 'a spurious level_changed event');
  assert.equal(cleared.masteryDelta, null);
  assert.equal(control.prepare('SELECT COUNT(*) AS n FROM difficulty_levels').get().n, 0, 'the cached row is gone');

  // The topic reads unassessed through the public accessor from now on.
  const after = await getTopicMastery(control, { topic: 'evidence topic' });
  assert.equal(after.hasEvidence, false);
  assert.equal(after.level, null);

  // Self-healing: a real `now` recomputes the level from the stored evidence.
  const healed = await updateMasteryLevel(control, { userId: 'default', topic: 'evidence topic', now: BASE });
  assert.equal(healed.after.level, 3);
  assert.equal(healed.levelChanged, true, 'unassessed → the measured level again');
  assert.equal(healed.before.level, null, 'the row had been deleted, so "before" is unassessed');
});
