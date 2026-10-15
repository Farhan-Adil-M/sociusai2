// =============================================================================
// tests/planner.test.js — coverage for the study planner (round T6).
//
// Targets:
//   * server/services/planner.js  — computePlan (pure scheduling algorithm),
//     loadPlanEvidence (user-scoped evidence gathering), normalizeTopic.
//   * server/routes/planner.js    — GET /api/planner request/response envelope,
//     `days` validation, auth guard.
//   * server/constants.js         — shared enumerations + sanitizeFilename.
//
// Fully offline: HTTP tests use the shared in-process harness from
// tests/helpers.js (app.listen(0), temp sqlite, stubbed AI/vector). No real
// NIM/ChromaDB/Supabase call happens anywhere.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, makeAi } from './helpers.js';
import { openDb } from '../server/store/sqlite.js';
import { computePlan, loadPlanEvidence, normalizeTopic } from '../server/services/planner.js';
import { CATEGORIES, PURPOSES, EXPLANATION_STYLES, sanitizeFilename } from '../server/constants.js';

// A fixed clock so every date assertion is exact. Nothing below depends on the
// machine's local timezone — the planner prints UTC calendar dates.
const NOW = new Date('2026-10-15T12:00:00.000Z');
const TODAY = '2026-10-15';

/** A minimal well-formed evidence record; override per test. */
function ev(overrides = {}) {
  return {
    topic: 'cells',
    correct: 7,
    total: 10,
    lastPracticedAt: '2026-10-01T09:00:00.000Z',
    dueCards: 0,
    sourceIds: [],
    goal: null,
    ...overrides,
  };
}

/** The exact key set every items[i] must carry (docs/API_CONTRACT.md v2.0). */
const ITEM_KEYS = ['activity', 'date', 'day', 'estimatedMinutes', 'level', 'levelLabel', 'reason', 'sourceIds', 'topic'];

// =============================================================================
// server/constants.js
// =============================================================================

test('shared enumerations are frozen vocabularies of the documented values', () => {
  assert.ok(CATEGORIES instanceof Set);
  assert.deepEqual([...CATEGORIES].sort(), ['exam-prep', 'general', 'research', 'self-study', 'subject']);
  assert.ok(PURPOSES instanceof Set);
  assert.deepEqual([...PURPOSES].sort(), ['deep-understanding', 'exam', 'general', 'project', 'research']);
  assert.ok(EXPLANATION_STYLES instanceof Set);
  assert.deepEqual([...EXPLANATION_STYLES].sort(),
    ['concise', 'examples-first', 'guided-questions', 'step-by-step', 'visual']);
  // Unknown values must NOT be in the sets — validation rejects them elsewhere.
  assert.equal(CATEGORIES.has('homework'), false);
  assert.equal(PURPOSES.has('revision'), false);
  assert.equal(EXPLANATION_STYLES.has('verbose'), false);
});

test('sanitizeFilename trusts only the final path segment', () => {
  assert.equal(sanitizeFilename('../../etc/passwd.docx'), 'passwd.docx');
  assert.equal(sanitizeFilename('a/b/c/report.pdf'), 'report.pdf');
  assert.equal(sanitizeFilename('C:\\Windows\\evil.docx'), 'evil.docx');
  assert.equal(sanitizeFilename('a/b/../c.txt'), 'c.txt');
  assert.equal(sanitizeFilename('folder/'), 'upload', 'a directory-ish name resolves to the fallback');
});

test('sanitizeFilename strips control characters and surrounding whitespace', () => {
  assert.equal(sanitizeFilename('  notes.txt  '), 'notes.txt');
  assert.equal(sanitizeFilename('file\u0000name.txt'), 'filename.txt');
  assert.equal(sanitizeFilename('line\nbreak.txt'), 'linebreak.txt');
  assert.equal(sanitizeFilename('del\u007f.txt'), 'del.txt');
  assert.equal(sanitizeFilename('tab\tname.txt'), 'tabname.txt');
});

test('sanitizeFilename falls back for unusable names, with a caller override', () => {
  assert.equal(sanitizeFilename(''), 'upload');
  assert.equal(sanitizeFilename('   '), 'upload');
  assert.equal(sanitizeFilename('.'), 'upload');
  assert.equal(sanitizeFilename('..'), 'upload');
  assert.equal(sanitizeFilename('/'), 'upload');
  assert.equal(sanitizeFilename('C:\\'), 'upload');
  assert.equal(sanitizeFilename(null), 'upload');
  assert.equal(sanitizeFilename(undefined), 'upload');
  assert.equal(sanitizeFilename('\u0000\u0001'), 'upload', 'control-only names are unusable');
  assert.equal(sanitizeFilename('../../', 'image'), 'image', 'custom fallback honoured');
  assert.equal(sanitizeFilename('..', 'image'), 'image');
  // Valid non-string-ish input keeps its text form rather than throwing.
  assert.equal(sanitizeFilename(42), '42');
});

// =============================================================================
// services/planner.js — normalizeTopic
// =============================================================================

test('normalizeTopic trims and lower-cases strings, rejects everything else', () => {
  assert.equal(normalizeTopic('  Photosynthesis '), 'photosynthesis');
  assert.equal(normalizeTopic('CELLS'), 'cells');
  assert.equal(normalizeTopic(''), '');
  assert.equal(normalizeTopic('   '), '');
  assert.equal(normalizeTopic(null), '');
  assert.equal(normalizeTopic(undefined), '');
  assert.equal(normalizeTopic(42), '');
  assert.equal(normalizeTopic(['x']), '');
});

// =============================================================================
// services/planner.js — computePlan: horizon, shape, dates
// =============================================================================

test('computePlan: an empty account answers honestly (hasEvidence false, items [])', () => {
  const plan = computePlan([], 7, { now: NOW });
  assert.equal(plan.hasEvidence, false);
  assert.deepEqual(plan.items, []);
  assert.equal(plan.horizonDays, 7);
  assert.equal(plan.summary,
    'There is nothing to plan yet — no graded answers and no flashcards are due. '
    + 'Take a short quiz and this plan will be scheduled from your real results.');
});

test('computePlan: horizonDays accepts the 1–30 boundaries and falls back to 7 otherwise', () => {
  assert.equal(computePlan([], 1, { now: NOW }).horizonDays, 1, 'lower boundary accepted');
  assert.equal(computePlan([], 30, { now: NOW }).horizonDays, 30, 'upper boundary accepted');
  assert.equal(computePlan([], 15, { now: NOW }).horizonDays, 15);
  for (const bad of [0, -1, 31, 7.5, NaN, Infinity, -Infinity, '7', null, undefined, [], {}]) {
    assert.equal(computePlan([], bad, { now: NOW }).horizonDays, 7,
      `days=${String(bad)} must fall back to the default 7`);
  }
  assert.equal(computePlan([], 1, {}).horizonDays, 1, 'options object is optional');
  assert.equal(computePlan([]).horizonDays, 7, 'options entirely optional');
});

test('computePlan: one item per day, sequential days, UTC dates advancing by one calendar day', () => {
  const plan = computePlan([ev()], 5, { now: NOW });
  assert.equal(plan.items.length, 5, 'one session per requested day, no more');
  assert.deepEqual(plan.items.map((i) => i.day), [1, 2, 3, 4, 5]);
  assert.deepEqual(plan.items.map((i) => i.date),
    ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']);
  // No overlapping/duplicate sessions: every date appears exactly once and the
  // sequence is strictly increasing.
  const unique = new Set(plan.items.map((i) => i.date));
  assert.equal(unique.size, plan.items.length, 'dates never repeat (no overlapping sessions)');
});

test('computePlan: every item carries exactly the documented keys', () => {
  const plan = computePlan([ev()], 3, { now: NOW });
  for (const item of plan.items) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
  }
  const first = plan.items[0];
  assert.equal(first.topic, 'cells');
  assert.equal(first.day, 1);
  assert.equal(first.date, TODAY);
  assert.equal(typeof first.reason, 'string');
  assert.ok(first.reason.length > 0);
  assert.ok(Array.isArray(first.sourceIds));
  assert.equal(typeof first.estimatedMinutes, 'number');
  assert.ok(Number.isInteger(first.estimatedMinutes), 'minutes are whole numbers');
});

test('computePlan: a past `now` schedules past calendar dates (deterministic, no clock re-read)', () => {
  const plan = computePlan([ev()], 3, { now: new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(plan.items.map((i) => i.date),
    ['2026-01-01', '2026-01-02', '2026-01-03']);
});

test('computePlan: an unusable `now` still yields well-formed dates (defensive clock)', () => {
  const plan = computePlan([ev()], 3, { now: new Date('not a date') });
  for (const item of plan.items) {
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(Number.isNaN(Date.parse(item.date)), false, 'date must be parseable');
  }
});

test('computePlan: with no evidence the horizon still reports but nothing is invented', () => {
  const plan = computePlan([], 30, { now: NOW });
  assert.equal(plan.horizonDays, 30);
  assert.equal(plan.hasEvidence, false);
  assert.deepEqual(plan.items, []);
  assert.match(plan.summary, /nothing to plan yet/);
});

// =============================================================================
// services/planner.js — computePlan: mastery → level / activity / urgency
// =============================================================================

test('computePlan: level boundaries sit exactly on the frozen 0.4 / 0.6 / 0.8 thresholds', () => {
  // levelFor: L1 < 0.4 · L2 < 0.6 · L3 < 0.8 · L4 ≥ 0.8.
  const cases = [
    { correct: 0, total: 10, level: 1, label: 'foundation' },
    { correct: 3, total: 10, level: 1, label: 'foundation' },   // 0.399… → L1
    { correct: 4, total: 10, level: 2, label: 'developing' },   // exactly 0.4 → L2
    { correct: 5, total: 10, level: 2, label: 'developing' },   // 0.5 → L2
    { correct: 6, total: 10, level: 3, label: 'proficient' },   // exactly 0.6 → L3
    { correct: 7, total: 10, level: 3, label: 'proficient' },   // 0.7 → L3
    { correct: 8, total: 10, level: 4, label: 'advanced' },     // exactly 0.8 → L4
    { correct: 10, total: 10, level: 4, label: 'advanced' },
  ];
  for (const c of cases) {
    const item = computePlan([ev({ correct: c.correct, total: c.total })], 1, { now: NOW }).items[0];
    assert.equal(item.level, c.level, `mastery ${c.correct}/${c.total} → level ${c.level}`);
    assert.equal(item.levelLabel, c.label, `level ${c.level} label`);
  }
});

test('computePlan: activity follows the revision/target lines (0.6 and 0.8)', () => {
  const activityFor = (correct, total, dueCards = 0) =>
    computePlan([ev({ correct, total, dueCards })], 1, { now: NOW }).items[0].activity;
  assert.equal(activityFor(4, 10), 'review', 'below 0.6 → tutor-led review');
  assert.equal(activityFor(5, 10), 'review', '0.5 is still below the revision line');
  assert.equal(activityFor(59, 100), 'review', '0.59 — just below the 0.6 revision line');
  assert.equal(activityFor(60, 100), 'quiz', 'exactly 0.6 → practise, not review');
  assert.equal(activityFor(6, 10), 'quiz', 'on the 0.6 line → practise, not review');
  assert.equal(activityFor(7, 10), 'quiz', 'below target → quiz');
  assert.equal(activityFor(79, 100), 'quiz', '0.79 — just below the 0.8 target line');
  assert.equal(activityFor(8, 10), 'quiz', 'on target, no due cards → maintenance quiz');
  assert.equal(activityFor(8, 10, 3), 'flashcards', 'on target WITH due cards → keep fresh');
  assert.equal(activityFor(0, 10), 'review', 'weakest → review');
  // The 0.6 line also decides the learner-facing sentence, word for word.
  const atLine = computePlan([ev({ correct: 59, total: 100 })], 1, { now: NOW }).items[0];
  assert.match(atLine.reason, /below the 0\.6 revision line/,
    'mastery 59% must be described with the 0.6 revision line');
  const onLine = computePlan([ev({ correct: 60, total: 100 })], 1, { now: NOW }).items[0];
  assert.match(onLine.reason, /below the 0\.8 target/,
    'mastery 60% has cleared the revision line and is described with the 0.8 target');
  // Unassessed: due cards → flashcards, nothing due → diagnostic quiz.
  assert.equal(activityFor(0, 0), 'quiz', 'ungraded, nothing due → quiz');
  assert.equal(activityFor(0, 0, 4), 'flashcards', 'ungraded with due cards → flashcards');
});

test('computePlan: an unassessed topic reports level null / unassessed, never a guessed level', () => {
  const item = computePlan([ev({ correct: 0, total: 0, dueCards: 2 })], 1, { now: NOW }).items[0];
  assert.equal(item.level, null, 'no graded answers → no level (honesty rule)');
  assert.equal(item.levelLabel, 'unassessed');
  assert.equal(item.activity, 'flashcards');
  assert.match(item.reason, /No graded answers yet — 2 flashcards are due, so start there\./);
  assert.ok(!/\d+%/.test(item.reason), 'no mastery number is invented for an unassessed topic');

  const noCards = computePlan([ev({ correct: 0, total: 0 })], 1, { now: NOW }).items[0];
  assert.equal(noCards.level, null);
  assert.equal(noCards.activity, 'quiz');
  assert.match(noCards.reason, /No graded attempts yet — start with a diagnostic quiz\./);

  // Singular agreement on the empty-history path — this is the FIRST sentence a
  // brand-new account ever sees, so it has to read correctly.
  const oneCard = computePlan([ev({ correct: 0, total: 0, dueCards: 1 })], 1, { now: NOW }).items[0];
  assert.equal(oneCard.reason, 'No graded answers yet — 1 flashcard is due, so start there.');
  const manyCards = computePlan([ev({ correct: 0, total: 0, dueCards: 4 })], 1, { now: NOW }).items[0];
  assert.equal(manyCards.reason, 'No graded answers yet — 4 flashcards are due, so start there.',
    'plural still reads "flashcards are"');
});

test('computePlan: reasons are one sentence carrying the stored evidence numbers', () => {
  const weak = computePlan([ev({ correct: 4, total: 25, dueCards: 3 })], 1, { now: NOW }).items[0];
  assert.equal(weak.reason, 'Mastery 16% over 25 questions — below the 0.6 revision line. 3 cards due for review.');

  const mid = computePlan([ev({ correct: 7, total: 10 })], 1, { now: NOW }).items[0];
  assert.equal(mid.reason, 'Mastery 70% over 10 questions — below the 0.8 target.');

  const strong = computePlan([ev({ correct: 9, total: 10 })], 1, { now: NOW }).items[0];
  assert.equal(strong.reason, 'Mastery 90% over 10 questions — on target, so keep it strong with maintenance practice.');

  const one = computePlan([ev({ correct: 0, total: 1, dueCards: 1 })], 1, { now: NOW }).items[0];
  assert.equal(one.reason, 'Mastery 0% over 1 question — below the 0.6 revision line. 1 card due for review.',
    'singular "question"/"card" wording');
});

test('computePlan: mastery is clamped into 0–1 (over-count and negative counts)', () => {
  // correct > total would give >1; the clamp keeps level 4 and a sane reason.
  const over = computePlan([ev({ correct: 15, total: 10 })], 1, { now: NOW }).items[0];
  assert.equal(over.level, 4);
  assert.match(over.reason, /^Mastery 100% over 10 questions/);

  // A negative count would give <0; clamped to 0 → foundation + review activity.
  const negative = computePlan([ev({ correct: -3, total: 10 })], 1, { now: NOW }).items[0];
  assert.equal(negative.level, 1);
  assert.match(negative.reason, /^Mastery 0% over 10 questions/);

  // Non-numeric counts → mastery null → unassessed, never NaN in the output.
  const broken = computePlan([ev({ correct: NaN, total: 10 })], 1, { now: NOW }).items[0];
  assert.equal(broken.level, null);
  assert.equal(broken.levelLabel, 'unassessed');
  assert.equal(Number.isNaN(Number(broken.estimatedMinutes)), false);
  assert.ok(!broken.reason.includes('NaN'), 'no NaN leaks into learner-facing text');

  const noTotal = computePlan([ev({ correct: 5, total: 0 })], 1, { now: NOW }).items[0];
  assert.equal(noTotal.level, null, 'total 0 → nothing measurable → unassessed');
});

test('computePlan: dueCards are clamped to a non-negative integer count', () => {
  const negative = computePlan([ev({ correct: 0, total: 0, dueCards: -5 })], 1, { now: NOW }).items[0];
  // -5 due cards is nonsense: clamped to 0 → nothing due → diagnostic quiz path.
  assert.equal(negative.activity, 'quiz');
  assert.match(negative.reason, /No graded attempts yet/);

  const weird = computePlan([ev({ correct: 0, total: 0, dueCards: 'many' })], 1, { now: NOW }).items[0];
  assert.equal(weird.activity, 'quiz', 'non-numeric dueCards count as 0');

  const fractional = computePlan([ev({ correct: 0, total: 0, dueCards: 3.7 })], 1, { now: NOW }).items[0];
  assert.match(fractional.reason, /3\.7 flashcards are due/, 'whatever survives is reported verbatim');
});

// =============================================================================
// services/planner.js — computePlan: estimatedMinutes formula
// =============================================================================

test('estimatedMinutes matches the documented formula at its worked examples', () => {
  const minutes = (overrides) => computePlan([ev(overrides)], 1, { now: NOW }).items[0].estimatedMinutes;
  // From services/planner.js doc comment:
  assert.equal(minutes({ correct: 21, total: 50 }), 30, 'review at 42% → 20 × 1.38 = 27.6 → 30 min');
  assert.equal(minutes({ correct: 7, total: 10 }), 15, 'quiz at 70% → 15 × 1.10 = 16.5 → 15 min');
  assert.equal(minutes({ correct: 9, total: 10, dueCards: 2 }), 10, 'flashcards on target → 10 × 1.0 → 10 min');
  // Derived boundaries:
  assert.equal(minutes({ correct: 0, total: 10 }), 35, 'review at 0% → 20 × 1.8 = 36 → 35 min');
  assert.equal(minutes({ correct: 0, total: 10, dueCards: 1 }), 35, 'review wins over due cards below 0.6');
  assert.equal(minutes({ correct: 7, total: 0, dueCards: 4 }), 10, 'unassessed flashcards → NEED exactly 1');
  assert.equal(minutes({ correct: 0, total: 0 }), 15, 'unassessed quiz → NEED exactly 1');
  assert.equal(minutes({ correct: 9, total: 10 }), 15, 'on-target quiz never grows');
});

test('estimatedMinutes is always a positive multiple of 5 (never zero duration)', () => {
  // Sweep every 2% of mastery, graded and ungraded, with and without due cards:
  // the plan must never promise 0 minutes or a false-precision number.
  for (let correct = 0; correct <= 50; correct++) {
    for (const dueCards of [0, 1, 7]) {
      const item = computePlan([ev({ correct, total: 50, dueCards })], 1, { now: NOW }).items[0];
      const mins = item.estimatedMinutes;
      assert.ok(Number.isInteger(mins), `${correct}/50 due=${dueCards} → integer minutes, got ${mins}`);
      assert.ok(mins >= 5, `${correct}/50 due=${dueCards} → at least MIN_SESSION_MINUTES, got ${mins}`);
      assert.equal(mins % 5, 0, `${correct}/50 due=${dueCards} → multiple of 5, got ${mins}`);
      assert.ok(mins <= 40, `${correct}/50 due=${dueCards} → bounded session, got ${mins}`);
    }
  }
});

// =============================================================================
// services/planner.js — computePlan: priority order (the total order)
// =============================================================================

test('priority: urgency bands order the plan DEADLINE → REVISE → DUE_CARDS → IMPROVE → MAINTAIN', () => {
  const evidence = [
    ev({ topic: 'maintain', correct: 9, total: 10 }),
    ev({ topic: 'improve', correct: 7, total: 10 }),
    ev({ topic: 'due-cards', correct: 0, total: 0, dueCards: 2 }),
    ev({ topic: 'revise', correct: 3, total: 10 }),
    ev({ topic: 'deadline', correct: 9, total: 10, goal: { label: 'Exam', deadline: '2026-10-18' } }),
  ];
  const plan = computePlan(evidence, 5, { now: NOW });
  assert.deepEqual(plan.items.map((i) => i.topic),
    ['deadline', 'revise', 'due-cards', 'improve', 'maintain']);
});

test('priority: a stored deadline outranks a measured weakness (band 0 wins)', () => {
  const evidence = [
    ev({ topic: 'weak-but-no-deadline', correct: 0, total: 10 }),
    ev({ topic: 'strong-with-deadline', correct: 10, total: 10, goal: { label: 'Viva', deadline: '2026-10-17' } }),
  ];
  const plan = computePlan(evidence, 7, { now: NOW });
  assert.equal(plan.items[0].topic, 'strong-with-deadline');
  assert.match(plan.items[0].reason, /Your goal «Viva» is due on 2026-10-17\./);
});

test('priority: within a band, weakest mastery leads; unmeasured sorts as weakest', () => {
  const evidence = [
    ev({ topic: 'mid', correct: 5, total: 10 }),      // 0.5, REVISE band
    ev({ topic: 'worst', correct: 1, total: 10 }),    // 0.1, REVISE band
    ev({ topic: 'unmeasured', correct: 0, total: 0, dueCards: 1 }), // DUE_CARDS band
    ev({ topic: 'almost-unmeasured', correct: 2, total: 10 }),      // 0.2 REVISE
  ];
  const plan = computePlan(evidence, 3, { now: NOW });
  // REVISE band first: worst (0.1) → almost-unmeasured (0.2) → mid (0.5).
  assert.deepEqual(plan.items.map((i) => i.topic), ['worst', 'almost-unmeasured', 'mid']);
});

test('priority: suggestedNext leads its own band but never overrides another band', () => {
  const evidence = [
    ev({ topic: 'alpha', correct: 5, total: 10 }),   // REVISE 0.5
    ev({ topic: 'bravo', correct: 4, total: 10 }),   // REVISE 0.4 — weaker but not recommended
    ev({ topic: 'on-target', correct: 9, total: 10 }), // MAINTAIN — recommended
  ];
  const plan = computePlan(evidence, 3, { now: NOW, suggestedNext: { topic: 'on-target' } });
  // The recommendation leads MAINTAIN, but both REVISE topics still precede it…
  // (weakest-first inside the band: bravo 0.4 before alpha 0.5).
  assert.deepEqual(plan.items.map((i) => i.topic), ['bravo', 'alpha', 'on-target']);
  // …and inside REVISE it does NOT reorder (band 2 in the doc: never overrides).
  // With recommendation inside the band instead:
  const plan2 = computePlan(evidence, 3, { now: NOW, suggestedNext: { topic: 'alpha' } });
  assert.equal(plan2.items[0].topic, 'alpha', 'recommended leads its own band');
  assert.equal(plan2.items[1].topic, 'bravo');
});

test('priority: suggestedNext matches case- and whitespace-insensitively', () => {
  const evidence = [ev({ topic: 'photosynthesis', correct: 5, total: 10 }), ev({ topic: 'anatomy', correct: 5, total: 10 })];
  const plan = computePlan(evidence, 2, { now: NOW, suggestedNext: { topic: '  Photosynthesis ' } });
  assert.equal(plan.items[0].topic, 'photosynthesis');
});

test('priority: ties break by most due cards, then least recently practised, then topic code-units', () => {
  // Same band, same mastery → dueCards desc.
  const byCards = computePlan([
    ev({ topic: 'few', correct: 0, total: 0, dueCards: 2 }),
    ev({ topic: 'many', correct: 0, total: 0, dueCards: 9 }),
  ], 2, { now: NOW });
  assert.deepEqual(byCards.items.map((i) => i.topic), ['many', 'few']);

  // Same band, mastery, dueCards → oldest practice date first.
  const byRecency = computePlan([
    ev({ topic: 'recent', correct: 5, total: 10, lastPracticedAt: '2026-10-10T00:00:00.000Z' }),
    ev({ topic: 'stale', correct: 5, total: 10, lastPracticedAt: '2026-09-01T00:00:00.000Z' }),
  ], 2, { now: NOW });
  assert.deepEqual(byRecency.items.map((i) => i.topic), ['stale', 'recent']);

  // Never-practised (unparseable date) counts as oldest.
  const byNull = computePlan([
    ev({ topic: 'practised', correct: 5, total: 10, lastPracticedAt: '2026-10-10T00:00:00.000Z' }),
    ev({ topic: 'never', correct: 5, total: 10, lastPracticedAt: null }),
  ], 2, { now: NOW });
  assert.deepEqual(byNull.items.map((i) => i.topic), ['never', 'practised']);

  // Everything equal → plain code-unit topic order (never localeCompare).
  const byName = computePlan([
    ev({ topic: 'b-topic', correct: 5, total: 10 }),
    ev({ topic: 'a-topic', correct: 5, total: 10 }),
  ], 2, { now: NOW });
  assert.deepEqual(byName.items.map((i) => i.topic), ['a-topic', 'b-topic']);
});

// =============================================================================
// services/planner.js — computePlan: day filling, cycling, goals, summary
// =============================================================================

test('computePlan: topics cycle in priority order when the horizon outgrows the list', () => {
  const evidence = [ev({ topic: 'weak', correct: 2, total: 10 }), ev({ topic: 'less-weak', correct: 5, total: 10 })];
  const plan = computePlan(evidence, 7, { now: NOW });
  assert.equal(plan.items.length, 7, 'every day of the horizon is filled from real topics');
  assert.deepEqual(plan.items.map((i) => i.topic),
    ['weak', 'less-weak', 'weak', 'less-weak', 'weak', 'less-weak', 'weak']);
  assert.deepEqual(plan.items.map((i) => i.day), [1, 2, 3, 4, 5, 6, 7]);
  // No padding: only the two real topics ever appear.
  assert.deepEqual([...new Set(plan.items.map((i) => i.topic))].sort(), ['less-weak', 'weak']);
});

test('computePlan: unusable evidence records are dropped, never crash the plan', () => {
  const plan = computePlan([
    null,
    undefined,
    {},
    { topic: '   ' },
    { topic: 42 },
    ev(), // the one real record
  ], 2, { now: NOW });
  assert.equal(plan.hasEvidence, true);
  assert.deepEqual(plan.items.map((i) => i.topic), ['cells', 'cells']);
  // All-unusable → honest empty answer.
  const empty = computePlan([null, {}, { topic: '' }], 7, { now: NOW });
  assert.equal(empty.hasEvidence, false);
  assert.deepEqual(empty.items, []);
});

test('computePlan: non-array evidence is treated as empty rather than throwing', () => {
  for (const bad of [null, undefined, 'junk', 42, { topic: 'x' }]) {
    const plan = computePlan(bad, 7, { now: NOW });
    assert.equal(plan.hasEvidence, false, `evidence=${String(bad)} → hasEvidence false`);
    assert.deepEqual(plan.items, []);
  }
});

test('computePlan: sourceIds are deduplicated, filtered to non-empty strings, sorted', () => {
  const item = computePlan([ev({ sourceIds: ['z_src', 'a_src', 'z_src', '', null, 7], topic: 'cells' })],
    1, { now: NOW }).items[0];
  assert.deepEqual(item.sourceIds, ['a_src', 'z_src'], 'unique, string-only, code-unit sorted');
  // Non-strings and empties are dropped; a padded string survives verbatim
  // (the filter tests against '' exactly — no trimming happens in this layer,
  // and loadPlanEvidence only ever passes ids read from the sources table).
  const padded = computePlan([ev({ sourceIds: [' m ', 'a'] })], 1, { now: NOW }).items[0];
  assert.deepEqual(padded.sourceIds, [' m ', 'a']);
  assert.deepEqual(computePlan([ev({ sourceIds: 'not-an-array' })], 1, { now: NOW }).items[0].sourceIds, []);
  assert.deepEqual(computePlan([ev({ sourceIds: undefined })], 1, { now: NOW }).items[0].sourceIds, []);
});

test('computePlan: goal deadlines are honoured only inside the horizon', () => {
  // Horizon: 2026-10-15 … 2026-10-21 (7 days from NOW).
  const inside = computePlan([ev({ goal: { label: 'Exam', deadline: '2026-10-21' } })], 7, { now: NOW });
  assert.equal(inside.items[0].topic, 'cells', 'deadline on the last horizon day still schedules');
  assert.ok(inside.summary.includes('Your goal «Exam» is due on 2026-10-21.'));

  const beyond = computePlan([ev({ correct: 9, total: 10, goal: { label: 'Exam', deadline: '2026-10-22' } })],
    7, { now: NOW });
  // One day past the horizon: the goal is ignored entirely — MAINTAIN band,
  // no goal sentence anywhere in the plan.
  assert.ok(!beyond.summary.includes('Exam'), 'goal beyond the horizon never reaches the summary');
  assert.equal(beyond.items[0].topic, 'cells');
  assert.match(beyond.items[0].reason, /on target/);

  const shorter = computePlan([ev({ goal: { label: 'Exam', deadline: '2026-10-17' } })], 1, { now: NOW });
  assert.ok(!shorter.summary.includes('Exam'), 'inside a 1-day horizon, a 2-day-out goal is ignored');
});

test('computePlan: a past goal deadline is kept and phrased in the past tense', () => {
  const plan = computePlan([ev({ goal: { label: 'Mock exam', deadline: '2026-10-01' } })], 7, { now: NOW });
  assert.match(plan.items[0].reason, /Your goal «Mock exam» was due on 2026-10-01\./);
  assert.match(plan.summary, /Your goal «Mock exam» was due on 2026-10-01\./);
  // A past deadline is still ≤ horizonEnd → it wins the schedule (band 0).
  const plan2 = computePlan([
    ev({ topic: 'weak', correct: 0, total: 10 }),
    ev({ topic: 'slipped', correct: 9, total: 10, goal: { label: 'Old', deadline: '2026-01-01' } }),
  ], 7, { now: NOW });
  assert.equal(plan2.items[0].topic, 'slipped');
});

test('computePlan: malformed goals are ignored (missing/non-string deadline)', () => {
  const plan = computePlan([ev({ goal: { label: 'No deadline' } })], 7, { now: NOW });
  assert.ok(!plan.summary.includes('No deadline'), 'a goal without a deadline cannot influence the schedule');
  const plan2 = computePlan([ev({ goal: { label: 'Bad date', deadline: 12345 } })], 7, { now: NOW });
  assert.ok(!plan2.summary.includes('Bad date'), 'non-string deadline ignored');
});

test('computePlan: an EMPTY-string deadline is ignored rather than hijacking the plan', () => {
  // '' <= horizonEnd is lexicographically TRUE, so a typeof-only check let an
  // unfilled form field win the DEADLINE band over genuinely weak topics and
  // print "Your goal «X» was due on ." — a dangling date. planRecord now
  // requires the same /^\d{4}-\d{2}-\d{2}$/ shape loadPlanEvidence filters on.
  // (Filed as a defect in docs/HANDOFF.md and fixed here; the HTTP route could
  // never trigger it, so this covers the direct-call path.)
  const hijack = computePlan([
    ev({ topic: 'weak', correct: 0, total: 10 }),
    ev({ topic: 'has-empty-deadline', correct: 9, total: 10, goal: { label: 'X', deadline: '' } }),
  ], 7, { now: NOW });
  assert.equal(hijack.items[0].topic, 'weak', 'an unfilled deadline must not outrank a 0% topic');
  assert.ok(!hijack.summary.includes('was due on .'), `no dangling date, was: ${hijack.summary}`);

  // Same guarantee standing alone: no goal, no goal sentence, no crash.
  const only = computePlan([ev({ correct: 9, total: 10, goal: { label: 'X', deadline: '' } })], 7, { now: NOW });
  assert.ok(!only.summary.includes('«X»'), 'an empty deadline is not reported as a goal at all');
  assert.ok(!only.items[0].reason.includes('due on'), 'reason sentence never prints the dangling date');

  // A real deadline still works — the guard must not reject valid input, and
  // the tense has to track whether the date has passed.
  const past = computePlan([ev({ correct: 9, total: 10, goal: { label: 'Exam', deadline: '2026-10-10' } })],
    7, { now: NOW });
  assert.ok(past.summary.includes('Your goal «Exam» was due on 2026-10-10.'),
    `past deadline honoured, was: ${past.summary}`);
  const future = computePlan([ev({ correct: 9, total: 10, goal: { label: 'Exam', deadline: '2026-10-20' } })],
    7, { now: NOW });
  assert.ok(future.summary.includes('Your goal «Exam» is due on 2026-10-20.'),
    `future deadline honoured, was: ${future.summary}`);
});

test('computePlan: summary names the real counts — topics, nearest goal, due cards', () => {
  const single = computePlan([ev()], 7, { now: NOW });
  assert.equal(single.summary, 'Focus on 1 topic this week, starting with «cells».');

  const fortnight = computePlan([ev()], 14, { now: NOW });
  assert.equal(fortnight.summary, 'Focus on 1 topic over the next 14 days, starting with «cells».');

  const two = computePlan([
    ev({ topic: 'weak', correct: 1, total: 10 }),
    ev({ topic: 'cards', correct: 0, total: 0, dueCards: 4 }),
  ], 7, { now: NOW });
  assert.equal(two.summary,
    'Focus on 2 topics this week, starting with «weak». 4 flashcards are due for review.');

  const withGoals = computePlan([
    ev({ topic: 'a', goal: { label: 'Later exam', deadline: '2026-10-20' } }),
    ev({ topic: 'b', goal: { label: 'Soon exam', deadline: '2026-10-17' } }),
  ], 7, { now: NOW });
  assert.ok(withGoals.summary.includes('2 goals fall inside this plan; the nearest is due on 2026-10-17.'),
    `summary was: ${withGoals.summary}`);

  const singular = computePlan([ev({ correct: 0, total: 0, dueCards: 1 })], 7, { now: NOW });
  // Singular agreement here too — see docs/HANDOFF.md, filed and fixed.
  assert.ok(singular.summary.endsWith('1 flashcard is due for review.'),
    `summary was: ${singular.summary}`);
  const plural = computePlan([ev({ correct: 0, total: 0, dueCards: 3 })], 7, { now: NOW });
  assert.ok(plural.summary.endsWith('3 flashcards are due for review.'),
    `summary was: ${plural.summary}`);
});

test('computePlan: byte-identical output for identical input (determinism)', () => {
  const evidence = [
    ev({ topic: 'weak', correct: 2, total: 10, dueCards: 1 }),
    ev({ topic: 'mid', correct: 7, total: 10, sourceIds: ['s2', 's1'] }),
    ev({ topic: 'strong', correct: 10, total: 10, goal: { label: 'Exam', deadline: '2026-10-19' } }),
  ];
  const opts = { now: NOW, suggestedNext: { topic: 'weak' } };
  const a = computePlan(evidence, 7, opts);
  const b = computePlan(evidence, 7, opts);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // Input order must not matter either — the total order decides everything.
  const shuffled = computePlan([evidence[2], evidence[0], evidence[1]], 7, opts);
  assert.equal(JSON.stringify(a), JSON.stringify(shuffled));
});

// =============================================================================
// services/planner.js — loadPlanEvidence (real temp sqlite, no HTTP)
// =============================================================================

/** A throwaway migrated database; same pattern as events/mastery suites. */
async function tempDb(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `socius-planner-${name}-`));
  const db = await openDb(path.join(dir, 'app.db'));
  t.after(() => db.close());
  return db;
}

function seedGraded(db, { user = 'u1', topic, correct, total, at = '2026-10-10T10:00:00.000Z' }) {
  db.prepare('INSERT INTO learner_topics (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user, topic, correct, total, 'medium', at, at);
}

function seedDeck(db, { user = 'u1', deckId, topic, sourceIds = [], cards }) {
  db.prepare('INSERT INTO decks (id, user_id, topic, source_ids_json, card_count, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(deckId, user, topic, JSON.stringify(sourceIds), cards.length, '2026-10-01T00:00:00.000Z');
  cards.forEach((card, idx) => {
    db.prepare('INSERT INTO deck_cards (deck_id, idx, front, back, citations_json, status, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(deckId, idx, `front ${idx}`, `back ${idx}`, '[]', card.status, card.dueAt ?? null);
  });
}

function seedSource(db, { id, user = 'u1' }) {
  db.prepare('INSERT INTO sources (id, user_id, type, title, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, user, 'webpage', `Source ${id}`, '2026-10-01T00:00:00.000Z');
}

function seedProfile(db, { user = 'u1', fields }) {
  db.prepare('INSERT INTO learner_profile (id, state, transcript_json, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user, 'skipped', '[]', JSON.stringify(fields), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
}

function seedCitedQuiz(db, { user = 'u1', quizId, topic, citations }) {
  db.prepare('INSERT INTO quizzes (id, user_id, topic, difficulty, question_count, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(quizId, user, topic, 'medium', 1, '2026-10-01T00:00:00.000Z');
  db.prepare('INSERT INTO quiz_questions (quiz_id, idx, text, choices_json, correct_choice_id, explanation, citations_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(quizId, 0, 'A question long enough to be valid?', '[]', 'a', 'Because.', JSON.stringify(citations));
}

test('loadPlanEvidence: an empty account returns empty evidence and no recommendation', async (t) => {
  const db = await tempDb(t, 'empty');
  const out = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.deepEqual(out, { evidence: [], suggestedNext: null });
});

test('loadPlanEvidence: graded rows become evidence with counts and normalised topic', async (t) => {
  const db = await tempDb(t, 'graded');
  seedGraded(db, { topic: '  Photosynthesis ', correct: 7, total: 10 });
  seedGraded(db, { topic: 'ungraded', correct: 3, total: 0 }); // total=0 → SQL filter

  const { evidence } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.equal(evidence.length, 1, 'rows with total = 0 are not measurable evidence');
  assert.equal(evidence[0].topic, 'photosynthesis', 'topic trimmed + lower-cased');
  assert.equal(evidence[0].correct, 7);
  assert.equal(evidence[0].total, 10);
  assert.equal(evidence[0].dueCards, 0);
  assert.equal(evidence[0].goal, null);
  assert.deepEqual(evidence[0].sourceIds, []);
  assert.equal(typeof evidence[0].lastPracticedAt, 'string');
});

test('loadPlanEvidence: due flashcards are counted by the documented due rule', async (t) => {
  const db = await tempDb(t, 'due');
  seedDeck(db, {
    deckId: 'd1', topic: 'Cells', cards: [
      { status: 'new', dueAt: null },                        // never scheduled → due
      { status: 'learning', dueAt: '2026-10-10T00:00:00.000Z' }, // past → due
      { status: 'known', dueAt: '2026-10-10T00:00:00.000Z' },    // known → never due
      { status: 'learning', dueAt: '2026-12-01T00:00:00.000Z' }, // future → not due
    ],
  });
  seedDeck(db, {
    deckId: 'd2', topic: 'CELLS', cards: [                   // different casing merges
      { status: 'learning', dueAt: '2026-10-14T00:00:00.000Z' },
    ],
  });

  const { evidence } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.equal(evidence.length, 1, 'two decks written with different casing merge into one topic');
  assert.equal(evidence[0].topic, 'cells');
  assert.equal(evidence[0].dueCards, 3, 'NULL + past due, unknown status; known/future excluded');
  assert.equal(evidence[0].total, 0, 'deck-only topic has no graded answers');
});

test('loadPlanEvidence: the due cut-off is the injected `now`, not the wall clock', async (t) => {
  const db = await tempDb(t, 'cutoff');
  seedDeck(db, {
    deckId: 'd1', topic: 'Cells', cards: [{ status: 'learning', dueAt: '2026-10-15T08:00:00.000Z' }],
  });
  const before = await loadPlanEvidence(db, { userId: 'u1', now: new Date('2026-10-15T07:00:00.000Z') });
  assert.equal(before.evidence.length, 0, 'card due at 08:00 is NOT due at 07:00');
  const after = await loadPlanEvidence(db, { userId: 'u1', now: new Date('2026-10-15T09:00:00.000Z') });
  assert.equal(after.evidence.length, 1, 'the same card IS due two hours later');
  assert.equal(after.evidence[0].dueCards, 1);
});

test('loadPlanEvidence: a deck whose cards are all known and future schedules nothing', async (t) => {
  const db = await tempDb(t, 'nothing-actionable');
  seedDeck(db, {
    deckId: 'd1', topic: 'Cells', cards: [
      { status: 'known', dueAt: null },
      { status: 'learning', dueAt: '2026-12-31T00:00:00.000Z' },
    ],
  });
  const { evidence } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.deepEqual(evidence, [], 'engaged but nothing actionable → no invented session');
});

test('loadPlanEvidence: goals attach only by exact case-insensitive topic match', async (t) => {
  const db = await tempDb(t, 'goals');
  seedGraded(db, { topic: 'cells', correct: 5, total: 10 });
  seedGraded(db, { topic: 'anatomy', correct: 5, total: 10 });
  seedProfile(db, {
    fields: {
      goals: [
        { label: ' Cells ', deadline: '2026-10-18' },   // matches (trim + case)
        { label: 'cell', deadline: '2026-10-19' },       // NOT exact → ignored
        { label: 'anatomy', deadline: 'no-deadline' },   // bad format → ignored
        { label: 'anatomy', deadline: '2026-10-20' },    // first-wins is per topic; bad one above skipped
        { label: 'astronomy', deadline: '2026-10-25' },  // matches no topic → never forced
        { label: 'no-date-at-all' },                     // missing deadline → ignored
        null,                                            // junk → ignored
      ],
    },
  });

  const { evidence } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  const byTopic = Object.fromEntries(evidence.map((e) => [e.topic, e]));
  assert.deepEqual(byTopic.cells.goal, { label: 'Cells', deadline: '2026-10-18' },
    'label is preserved verbatim; the match is trim + case-insensitive');
  assert.deepEqual(byTopic.anatomy.goal, { label: 'anatomy', deadline: '2026-10-20' },
    'malformed deadline skipped, the valid one for the same topic still lands');
  assert.equal(evidence.some((e) => e.topic === 'astronomy'), false,
    'a goal matching no topic is never forced onto one');
});

test('loadPlanEvidence: source ids are merged from citations and decks, owned and sorted', async (t) => {
  const db = await tempDb(t, 'sources');
  seedGraded(db, { topic: 'cells', correct: 5, total: 10 });
  seedSource(db, { id: 'src_own' });
  seedSource(db, { id: 'src_own2' });
  seedSource(db, { id: 'src_other', user: 'u2' });
  seedCitedQuiz(db, {
    quizId: 'q1', topic: 'cells',
    citations: [{ sourceId: 'src_own' }, { source_id: 'src_other' }, { sourceId: 'src_own' }, 'not-an-object', { sourceId: '' }],
  });
  seedDeck(db, { deckId: 'd1', topic: 'cells', sourceIds: ['src_own2', 'src_other', 'src_missing'], cards: [] });

  const { evidence } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.equal(evidence.length, 1);
  // src_other belongs to u2; src_missing does not exist. Both must be filtered.
  assert.deepEqual(evidence[0].sourceIds, ['src_own', 'src_own2'],
    "only this user's own sources, deduplicated, code-unit sorted");
});

test('loadPlanEvidence: every read is scoped to the requested user', async (t) => {
  const db = await tempDb(t, 'scoping');
  seedGraded(db, { user: 'u1', topic: 'u1-topic', correct: 5, total: 10 });
  seedGraded(db, { user: 'u2', topic: 'u2-topic', correct: 1, total: 10 });
  seedDeck(db, { user: 'u2', deckId: 'd-u2', topic: 'u2-topic', cards: [{ status: 'new' }] });
  seedSource(db, { id: 'src-u2', user: 'u2' });
  seedCitedQuiz(db, { user: 'u2', quizId: 'q-u2', topic: 'u2-topic', citations: [{ sourceId: 'src-u2' }] });
  seedProfile(db, { user: 'u2', fields: { goals: [{ label: 'u1-topic', deadline: '2026-10-18' }] } });

  const { evidence } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.deepEqual(evidence.map((e) => e.topic), ['u1-topic'], "u2's rows never surface for u1");
  assert.equal(evidence[0].goal, null, "u2's profile goal never lands on u1's topic");
  assert.deepEqual(evidence[0].sourceIds, [], "u2's sources never leak into u1's evidence");
});

test('loadPlanEvidence: suggestedNext comes from the shared revision engine', async (t) => {
  const db = await tempDb(t, 'advice');
  seedGraded(db, { topic: 'strong', correct: 9, total: 10 });
  seedGraded(db, { topic: 'weak', correct: 1, total: 5 });

  const { suggestedNext } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.deepEqual(suggestedNext, { topic: 'weak', difficulty: 'easy' },
    'the weakest flagged topic, at the difficulty the learner model suggests');

  const empty = await loadPlanEvidence(await tempDb(t, 'advice-empty'), { userId: 'u1', now: NOW });
  assert.equal(empty.suggestedNext, null, 'no history → no recommendation');
});

test('loadPlanEvidence → computePlan: the full pipeline schedules only real evidence', async (t) => {
  const db = await tempDb(t, 'pipeline');
  seedGraded(db, { topic: 'weak', correct: 2, total: 10 });
  seedDeck(db, { deckId: 'd1', topic: 'Cards only', cards: [{ status: 'new' }] });
  seedProfile(db, { fields: { goals: [{ label: 'weak', deadline: '2026-10-18' }] } });
  seedDeck(db, { deckId: 'd2', topic: 'known-deck', cards: [{ status: 'known', dueAt: null }] });

  const { evidence, suggestedNext } = await loadPlanEvidence(db, { userId: 'u1', now: NOW });
  assert.deepEqual(evidence.map((e) => e.topic).sort(), ['cards only', 'weak'],
    'the all-known deck contributes nothing');

  const plan = computePlan(evidence, 7, { now: NOW, suggestedNext });
  assert.equal(plan.hasEvidence, true);
  assert.equal(plan.items.length, 7, 'two real topics fill the week by cycling');
  // 'weak' carries the deadline → band 0 → day 1; then weakest-first puts
  // 'weak' (0.2) before the unassessed deck topic.
  assert.equal(plan.items[0].topic, 'weak');
  assert.match(plan.items[0].reason, /below the 0\.6 revision line/);
  assert.match(plan.items[0].reason, /Your goal «weak» is due on 2026-10-18\./);
  const deckDay = plan.items.find((i) => i.topic === 'cards only');
  assert.ok(deckDay, 'the deck-only topic is scheduled somewhere in the horizon');
  const deckItem = computePlan(evidence, 7, { now: NOW, suggestedNext }).items
    .find((i) => i.topic === 'cards only');
  assert.equal(deckItem.level, null, 'deck-only topic stays unassessed');
  assert.equal(deckItem.activity, 'flashcards');
});

// =============================================================================
// routes/planner.js — GET /api/planner (in-process HTTP, offline)
// =============================================================================

/** Prototype-style auth override: every request is the fixed dev user. */
const PROTOTYPE_AUTH = Object.freeze({ getUserFromRequest: async () => ({ id: 'default' }) });
/** Denying auth: the exact 401 path, no network involved. */
const DENY_AUTH = Object.freeze({ getUserFromRequest: async () => null });

const DAYS_MESSAGE = 'days must be a whole number between 1 and 30.';

test('GET /api/planner without auth answers the exact 401 UNAUTHENTICATED envelope', async (t) => {
  const ctx = await startApp({ auth: DENY_AUTH });
  t.after(ctx.close);
  const res = await fetch(`${ctx.base}/api/planner`);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json();
  assert.deepEqual(body, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to use this endpoint.' } });
});

test('auth is checked before validation: anonymous + bad days still answers 401, not 400', async (t) => {
  const ctx = await startApp({ auth: DENY_AUTH });
  t.after(ctx.close);
  const res = await fetch(`${ctx.base}/api/planner?days=abc`);
  assert.equal(res.status, 401, 'requireAuth runs before parseDays');
  assert.equal((await res.json()).error.code, 'UNAUTHENTICATED');
});

test('GET /api/planner on an empty account answers the documented success envelope', async (t) => {
  const ctx = await startApp({ auth: PROTOTYPE_AUTH });
  t.after(ctx.close);
  const res = await fetch(`${ctx.base}/api/planner`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-request-id'), 'every response carries X-Request-Id');
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['plan'], 'the wire shape is exactly { plan }');
  assert.deepEqual(Object.keys(body.plan).sort(),
    ['generatedAt', 'hasEvidence', 'horizonDays', 'items', 'summary']);
  assert.equal(typeof body.plan.generatedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(body.plan.generatedAt)), false, 'generatedAt is a real ISO instant');
  assert.equal(body.plan.horizonDays, 7, 'no query → the documented default of 7');
  assert.equal(body.plan.hasEvidence, false);
  assert.deepEqual(body.plan.items, []);
  assert.match(body.plan.summary, /nothing to plan yet/);
});

test('GET /api/planner never touches the AI or the vector store', async (t) => {
  // Any call to the stubbed providers throws → the request would fail loudly.
  const ai = makeAi({
    chatCompletion: async () => { throw new Error('planner must not call chatCompletion'); },
    embedTexts: async () => { throw new Error('planner must not call embedTexts'); },
    embedQuery: async () => { throw new Error('planner must not call embedQuery'); },
  });
  const vector = {
    addChunks: async () => { throw new Error('planner must not write to the vector store'); },
    queryChunks: async () => { throw new Error('planner must not query the vector store'); },
    queryChunksBatch: async () => { throw new Error('planner must not batch-query the vector store'); },
    pingChroma: async () => true,
  };
  const ctx = await startApp({ ai, vector, auth: PROTOTYPE_AUTH });
  t.after(ctx.close);
  const res = await fetch(`${ctx.base}/api/planner`);
  assert.equal(res.status, 200, 'the plan is computed from stored evidence only');
  const { plan } = await res.json();
  assert.equal(plan.hasEvidence, false);
  assert.equal(ai.calls.length, 0, 'zero chatCompletion calls');
});

test('GET /api/planner with seeded evidence returns real items with the exact item keys', async (t) => {
  const ctx = await startApp({ auth: PROTOTYPE_AUTH });
  t.after(ctx.close);
  ctx.db.prepare("INSERT INTO learner_topics (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES ('default', 'photosynthesis', 3, 10, 'medium', ?, ?)")
    .run('2026-10-10T10:00:00.000Z', '2026-10-10T10:00:00.000Z');

  const res = await fetch(`${ctx.base}/api/planner?days=3`);
  assert.equal(res.status, 200);
  const { plan } = await res.json();
  assert.equal(plan.hasEvidence, true);
  assert.equal(plan.horizonDays, 3);
  assert.equal(plan.items.length, 3, 'one session per day of the horizon');
  for (const item of plan.items) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
  }
  assert.equal(plan.items[0].topic, 'photosynthesis');
  assert.equal(plan.items[0].level, 1, '3/10 = 0.3 → foundation');
  assert.equal(plan.items[0].activity, 'review', 'below the 0.6 revision line');
  assert.ok(Array.isArray(plan.items[0].sourceIds));
  // The clock is read once: printed dates and generatedAt must agree.
  assert.equal(plan.generatedAt.slice(0, 10), plan.items[0].date,
    'generatedAt and day-1 date come from the same instant');
  assert.ok(plan.summary.includes('photosynthesis'), `summary was: ${plan.summary}`);
});

test('GET /api/planner keeps each user\u2019s plan to that user\u2019s rows', async (t) => {
  const headerAuth = { getUserFromRequest: async (req) => (req.headers['x-test-user'] ? { id: req.headers['x-test-user'] } : null) };
  const ctx = await startApp({ auth: headerAuth });
  t.after(ctx.close);
  ctx.db.prepare("INSERT INTO learner_topics (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES ('u1', 'u1-topic', 5, 10, 'medium', ?, ?)")
    .run('2026-10-10T10:00:00.000Z', '2026-10-10T10:00:00.000Z');
  ctx.db.prepare("INSERT INTO learner_topics (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES ('u2', 'u2-topic', 1, 10, 'medium', ?, ?)")
    .run('2026-10-10T10:00:00.000Z', '2026-10-10T10:00:00.000Z');

  const forUser = async (user) => {
    const res = await fetch(`${ctx.base}/api/planner`, { headers: { 'x-test-user': user } });
    assert.equal(res.status, 200);
    return (await res.json()).plan;
  };
  const p1 = await forUser('u1');
  const p2 = await forUser('u2');
  assert.deepEqual([...new Set(p1.items.map((i) => i.topic))], ['u1-topic']);
  assert.deepEqual([...new Set(p2.items.map((i) => i.topic))], ['u2-topic']);
  assert.ok(p1.summary.includes('u1-topic'));
  assert.ok(!p1.summary.includes('u2-topic'));
});

test('GET /api/planner answers the same plan twice (deterministic over the same day)', async (t) => {
  const ctx = await startApp({ auth: PROTOTYPE_AUTH });
  t.after(ctx.close);
  ctx.db.prepare("INSERT INTO learner_topics (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES ('default', 'weak', 2, 10, 'medium', ?, ?)")
    .run('2026-10-10T10:00:00.000Z', '2026-10-10T10:00:00.000Z');
  ctx.db.prepare("INSERT INTO learner_topics (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES ('default', 'strong', 9, 10, 'medium', ?, ?)")
    .run('2026-10-11T10:00:00.000Z', '2026-10-11T10:00:00.000Z');

  const first = await (await fetch(`${ctx.base}/api/planner?days=7`)).json();
  const second = await (await fetch(`${ctx.base}/api/planner?days=7`)).json();
  assert.deepEqual(second.plan.items, first.plan.items,
    'no randomness and no model call → byte-identical items');
  assert.deepEqual(first.plan.items.map((i) => i.topic),
    ['weak', 'strong', 'weak', 'strong', 'weak', 'strong', 'weak'],
    'weakest topic cycles back first');
});

test('GET /api/planner: `days` accepts its boundaries and tolerates whitespace/leading zeros', async (t) => {
  const ctx = await startApp({ auth: PROTOTYPE_AUTH });
  t.after(ctx.close);
  const ok = async (query, horizonDays) => {
    const res = await fetch(`${ctx.base}/api/planner?${query}`);
    assert.equal(res.status, 200, `?${query} should be accepted`);
    const { plan } = await res.json();
    assert.equal(plan.horizonDays, horizonDays, `?${query} → horizonDays ${horizonDays}`);
    return plan;
  };
  await ok('days=1', 1);
  await ok('days=30', 30);
  await ok('days=%207%20', 7, 'surrounding whitespace is trimmed');
  await ok('days=007', 7, 'leading zeros parse as 7');
});

test('GET /api/planner: every bad `days` value is 400 VALIDATION_ERROR with the stable message', async (t) => {
  const ctx = await startApp({ auth: PROTOTYPE_AUTH });
  t.after(ctx.close);
  const bad = [
    ['days=', 'empty value'],
    ['days', 'flag with no value'],
    ['days=abc', 'a word'],
    ['days=-1', 'negative'],
    ['days=7.5', 'fraction'],
    ['days=0', 'below the minimum'],
    ['days=31', 'above the maximum'],
    ['days=99999999999999999999', 'astronomically large'],
    ['days=1e1', 'scientific notation'],
    ['days=%20%20', 'whitespace only'],
    ['days=7&days=8', 'repeated param (array)'],
    ['days=%2B7', 'explicit plus sign'],
    ['days=seven', 'spelled out'],
  ];
  for (const [query, why] of bad) {
    const res = await fetch(`${ctx.base}/api/planner?${query}`);
    assert.equal(res.status, 400, `?${query} (${why}) must be 400, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR', `?${query} → stable contract code`);
    assert.equal(body.error.message, DAYS_MESSAGE, `?${query} → the documented message`);
    assert.equal(typeof body.error.requestId, 'string', '400 goes through errorHandler → requestId present');
  }
});
