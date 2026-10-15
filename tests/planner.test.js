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
import { startApp, makeAi } from './helpers.js';
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
