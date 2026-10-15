// Round T7 — unit coverage for the two services that had ZERO direct tests:
//
//   server/services/flashcardService.js  — generation (normalizeCard /
//     generateFlashcards) + the deterministic SM-2-style scheduler.
//   server/services/topicSuggestions.js  — the abstain path's 0-4 real topic
//     suggestions (ranking, dedup, scope filtering, never invents).
//
// Everything runs offline: the AI/vector are stubbed via tests/helpers.js and
// the database is a throwaway local SQLite file (same seam other suites use).
// No network, no new dependencies: node:test + node:assert/strict only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SRS,
  REVIEW_GRADES,
  normalizeCard,
  generateFlashcards,
  clampEase,
  scheduledIntervalDays,
  gradeForStatus,
  nextIntervalDays,
  scheduleCardReview,
} from '../server/services/flashcardService.js';
import { fetchTopicSuggestions } from '../server/services/topicSuggestions.js';
import { openDb } from '../server/store/sqlite.js';
import { config } from '../server/config.js';
import { fakeVector, makeAi, EMBEDDING } from './helpers.js';

// ---------------------------------------------------------------------------
// flashcardService — SRS constants and the pure scheduling helpers
// ---------------------------------------------------------------------------

test('SRS constants and the four review grades are the frozen contract', () => {
  assert.deepEqual({ ...SRS }, {
    easeDefault: 2.5,
    easeMin: 1.3,
    easeMax: 2.8,
    maxIntervalDays: 365,
    lapseIntervalDays: 1,
  });
  assert.deepEqual([...REVIEW_GRADES], ['again', 'hard', 'good', 'easy']);
  assert.ok(Object.isFrozen(SRS));
  assert.ok(Object.isFrozen(REVIEW_GRADES));
});

test('clampEase: unset or corrupt ease falls back to the DEFAULT (2.5), never to easeMin', () => {
  // Number(null) === 0 is finite — the unset case must be caught before that.
  assert.equal(clampEase(null), SRS.easeDefault);
  assert.equal(clampEase(undefined), SRS.easeDefault);
  assert.equal(clampEase(''), SRS.easeDefault);
  assert.equal(clampEase(NaN), SRS.easeDefault);
  assert.equal(clampEase('not a number'), SRS.easeDefault);
  assert.equal(clampEase(Infinity), SRS.easeDefault);
  assert.equal(clampEase(-Infinity), SRS.easeDefault);
});

test('clampEase: clamps into [1.3, 2.8] and rounds to 3 decimals', () => {
  assert.equal(clampEase(99), 2.8);
  assert.equal(clampEase(-5), 1.3);
  assert.equal(clampEase(1.3), 1.3);
  assert.equal(clampEase(2.8), 2.8);
  assert.equal(clampEase(2.4567), 2.457); // round3
  assert.equal(clampEase(2.4564), 2.456);
  assert.equal(clampEase('2.45'), 2.45); // numeric strings are coerced
  assert.equal(clampEase(2.5), 2.5);
});

test('scheduledIntervalDays: whole and fractional days between reviewedAt and dueAt', () => {
  assert.equal(scheduledIntervalDays({
    reviewedAt: '2026-01-01T00:00:00.000Z',
    dueAt: '2026-01-07T00:00:00.000Z',
  }), 6);
  assert.equal(scheduledIntervalDays({
    reviewedAt: '2026-01-01T00:00:00.000Z',
    dueAt: '2026-01-01T12:00:00.000Z',
  }), 0.5);
});

test('scheduledIntervalDays: missing, malformed or reversed input yields null', () => {
  assert.equal(scheduledIntervalDays(), null); // no argument at all
  assert.equal(scheduledIntervalDays({}), null); // both unset (a NEW card)
  assert.equal(scheduledIntervalDays({ reviewedAt: '2026-01-01T00:00:00.000Z', dueAt: null }), null);
  assert.equal(scheduledIntervalDays({ reviewedAt: null, dueAt: '2026-01-07T00:00:00.000Z' }), null);
  assert.equal(scheduledIntervalDays({ reviewedAt: 'garbage', dueAt: '2026-01-07T00:00:00.000Z' }), null);
  assert.equal(scheduledIntervalDays({ reviewedAt: '2026-01-07T00:00:00.000Z', dueAt: '2026-01-01T00:00:00.000Z' }), null); // due before review
});

test('gradeForStatus: contract statuses map to grades; an explicit grade wins', () => {
  assert.equal(gradeForStatus('known'), 'good');
  assert.equal(gradeForStatus('review'), 'again');
  assert.equal(gradeForStatus('new'), null);
  assert.equal(gradeForStatus(undefined), null);
  assert.equal(gradeForStatus('something-else'), null);
  // explicit grade overrides the status mapping in BOTH directions:
  assert.equal(gradeForStatus('known', 'easy'), 'easy');
  assert.equal(gradeForStatus('review', 'hard'), 'hard');
  // ...but only a REAL grade is accepted:
  assert.equal(gradeForStatus('known', 'meh'), null);
  assert.equal(gradeForStatus('known', ''), null);
  assert.equal(gradeForStatus('known', 42), null);
  // null/undefined grade = "no explicit grade" → fall back to the status:
  assert.equal(gradeForStatus('known', null), 'good');
  assert.equal(gradeForStatus('known', undefined), 'good');
});

test('nextIntervalDays: `again` is always the 1-day lapse step', () => {
  assert.equal(nextIntervalDays('again'), SRS.lapseIntervalDays);
  assert.equal(nextIntervalDays('again', { prevInterval: 30, ease: 2.8 }), 1);
  assert.equal(nextIntervalDays('again', { prevInterval: 0.4 }), 1);
});

test('nextIntervalDays: brand-new card (no previous interval) — good/hard 1 day, easy 4', () => {
  assert.equal(nextIntervalDays('good', { prevInterval: 0 }), 1);
  assert.equal(nextIntervalDays('hard', { prevInterval: 0 }), 1);
  assert.equal(nextIntervalDays('easy', { prevInterval: 0 }), 4);
  assert.equal(nextIntervalDays('good'), 1); // defaults: prevInterval 0, ease 2.5
  assert.equal(nextIntervalDays('good', { prevInterval: -5 }), 1); // nonsense prev treated as new
});

test('nextIntervalDays: hard grows 1.2× but never below 1 day nor above 365', () => {
  assert.equal(nextIntervalDays('hard', { prevInterval: 5 }), 6); // 5×1.2 = 6
  assert.equal(nextIntervalDays('hard', { prevInterval: 1 }), 1); // 1.2 → rounds to 1
  assert.equal(nextIntervalDays('hard', { prevInterval: 0.4 }), 1); // sub-day clamps up to 1
  assert.equal(nextIntervalDays('hard', { prevInterval: 400 }), 365); // clamp to max
  assert.equal(nextIntervalDays('hard', { prevInterval: 365 }), 365);
});

test('nextIntervalDays: good jumps to the 6-day step, then grows by ease (clamped)', () => {
  assert.equal(nextIntervalDays('good', { prevInterval: 2, ease: 2.5 }), 6); // learning step 2
  assert.equal(nextIntervalDays('good', { prevInterval: 5, ease: 2.5 }), 6);
  assert.equal(nextIntervalDays('good', { prevInterval: 6, ease: 2.5 }), 15); // 6×2.5
  assert.equal(nextIntervalDays('good', { prevInterval: 6, ease: 1.3 }), 8); // 7.8 → 8
  assert.equal(nextIntervalDays('good', { prevInterval: 365, ease: 2.8 }), 365); // clamp
});

test('nextIntervalDays: easy multiplies prev×ease×1.3 and rounds', () => {
  assert.equal(nextIntervalDays('easy', { prevInterval: 6, ease: 2.5 }), 20); // 19.5 → 20
  assert.equal(nextIntervalDays('easy', { prevInterval: 2, ease: 2.5 }), 7); // 6.5 → 7
  assert.equal(nextIntervalDays('easy', { prevInterval: 400, ease: 2.8 }), 365); // clamp
});

test('nextIntervalDays: deterministic — identical inputs give identical days', () => {
  for (const grade of REVIEW_GRADES) {
    const a = nextIntervalDays(grade, { prevInterval: 6, ease: 2.3 });
    const b = nextIntervalDays(grade, { prevInterval: 6, ease: 2.3 });
    assert.equal(a, b, `grade ${grade} must be repeatable`);
  }
});

// ---------------------------------------------------------------------------
// flashcardService — scheduleCardReview (the state machine)
// ---------------------------------------------------------------------------

const NOW = new Date('2026-03-01T09:30:00.000Z');
const DAY_MS = 86400000;
const isoAfter = (days) => new Date(NOW.getTime() + days * DAY_MS).toISOString();

test('scheduleCardReview: a non-Date/non-parsable `now` throws TypeError', () => {
  assert.throws(() => scheduleCardReview({}, 'good', 'not-a-date'), TypeError);
  assert.throws(() => scheduleCardReview({}, 'good', new Date('nope')), TypeError);
  assert.throws(() => scheduleCardReview({}, 'good', null), TypeError);
  assert.throws(() => scheduleCardReview({}, 'good', 1700000000000), TypeError); // epoch number, not a Date/string
});

test('scheduleCardReview: a grade outside the four buttons RESETS the card to new', () => {
  const mature = {
    reviewCount: 5,
    ease: 1.4,
    reviewedAt: '2026-02-01T00:00:00.000Z',
    dueAt: '2026-03-03T00:00:00.000Z',
  };
  for (const grade of [null, undefined, 'unknown', 42, '']) {
    assert.deepEqual(
      scheduleCardReview(mature, grade, NOW),
      { status: 'new', grade: null, reviewCount: 0, ease: SRS.easeDefault, intervalDays: 0, dueAt: null },
      `grade ${String(grade)} must forget the schedule entirely`,
    );
  }
});

test('scheduleCardReview: new card + good → known, 1 day, reviewCount 1, ease unchanged', () => {
  const next = scheduleCardReview({}, 'good', NOW);
  assert.deepEqual(next, {
    status: 'known',
    grade: 'good',
    reviewCount: 1,
    ease: 2.5,
    intervalDays: 1,
    dueAt: isoAfter(1),
  });
  // `now` as an ISO string gives byte-identical output to the Date form:
  assert.deepEqual(scheduleCardReview({}, 'good', NOW.toISOString()), next);
});

test('scheduleCardReview: new card + easy → 4 days and ease +0.15', () => {
  const next = scheduleCardReview({}, 'easy', NOW);
  assert.equal(next.status, 'known');
  assert.equal(next.intervalDays, 4);
  assert.equal(next.ease, 2.65);
  assert.equal(next.dueAt, isoAfter(4));
});

test('scheduleCardReview: failing an IMMATURE card keeps ease (no lapse penalty)', () => {
  const next = scheduleCardReview({ reviewCount: 1, ease: 2.5 }, 'again', NOW);
  assert.deepEqual(next, {
    status: 'review',
    grade: 'again',
    reviewCount: 0, // lapse resets maturity either way
    ease: 2.5, // reviewCount < 2 → still learning: no ease penalty
    intervalDays: 1,
    dueAt: isoAfter(1),
  });
});

test('scheduleCardReview: failing a MATURE card (reviewCount ≥ 2) lapses it: ease −0.2, restart at day 1', () => {
  const next = scheduleCardReview({ reviewCount: 2, ease: 2.5 }, 'again', NOW);
  assert.deepEqual(next, {
    status: 'review',
    grade: 'again',
    reviewCount: 0,
    ease: 2.3,
    intervalDays: SRS.lapseIntervalDays,
    dueAt: isoAfter(1),
  });
  // Boundary: reviewCount 1 (just below maturity) does NOT lose ease:
  assert.equal(scheduleCardReview({ reviewCount: 1, ease: 2.5 }, 'again', NOW).ease, 2.5);
});

test('scheduleCardReview: repeated lapses never drop ease below easeMin', () => {
  const next = scheduleCardReview({ reviewCount: 9, ease: 1.35 }, 'again', NOW);
  assert.equal(next.ease, 1.3); // 1.35 − 0.2 → clamped to 1.3
  const again = scheduleCardReview({ reviewCount: 9, ease: 1.3 }, 'again', NOW);
  assert.equal(again.ease, 1.3); // and stays there
  // The other end: easy on an already-maxed ease stops at easeMax:
  assert.equal(scheduleCardReview({ reviewCount: 3, ease: 2.8 }, 'easy', NOW).ease, 2.8);
});

test('scheduleCardReview: passing increments reviewCount; malformed counts are treated as 0', () => {
  assert.equal(scheduleCardReview({ reviewCount: 1, ease: 2.5 }, 'good', NOW).reviewCount, 2);
  assert.equal(scheduleCardReview({ reviewCount: 0, ease: 2.5 }, 'good', NOW).reviewCount, 1);
  // Corrupt/foreign values (string, float, negative, NaN) are not integers > 0
  // → the card counts as never reviewed:
  assert.equal(scheduleCardReview({ reviewCount: '7', ease: 2.5 }, 'good', NOW).reviewCount, 1);
  assert.equal(scheduleCardReview({ reviewCount: 2.5, ease: 2.5 }, 'good', NOW).reviewCount, 1);
  assert.equal(scheduleCardReview({ reviewCount: -3, ease: 2.5 }, 'good', NOW).reviewCount, 1);
  assert.equal(scheduleCardReview({ reviewCount: NaN, ease: 2.5 }, 'good', NOW).reviewCount, 1);
});

test('scheduleCardReview: the stored interval is recovered from reviewedAt/dueAt', () => {
  // Card last scheduled 6 days: good grows 6×ease with the STORED ease:
  const sixDays = scheduleCardReview({
    reviewCount: 2,
    ease: 1.9,
    reviewedAt: '2026-02-20T09:30:00.000Z',
    dueAt: '2026-02-26T09:30:00.000Z',
  }, 'good', NOW);
  assert.equal(sixDays.intervalDays, 11); // 6×1.9 = 11.4 → 11
  assert.equal(sixDays.ease, 1.9); // good leaves ease alone
  assert.equal(sixDays.dueAt, isoAfter(11));
  // Same card, easy grade: 6×1.9×1.3 = 14.82 → 15:
  assert.equal(scheduleCardReview({
    reviewCount: 2,
    ease: 1.9,
    reviewedAt: '2026-02-20T09:30:00.000Z',
    dueAt: '2026-02-26T09:30:00.000Z',
  }, 'easy', NOW).intervalDays, 15);
});

test('scheduleCardReview: a numeric-string ease (corrupt row) is coerced, not NaN', () => {
  const next = scheduleCardReview({
    reviewCount: 2,
    ease: '1.9',
    reviewedAt: '2026-02-20T09:30:00.000Z',
    dueAt: '2026-02-26T09:30:00.000Z',
  }, 'good', NOW);
  assert.equal(next.ease, 1.9);
  assert.equal(next.intervalDays, 11);
  assert.ok(Number.isFinite(Date.parse(next.dueAt)));
});

test('scheduleCardReview: no card argument at all behaves like a fresh card', () => {
  assert.deepEqual(scheduleCardReview(undefined, 'good', NOW), {
    status: 'known', grade: 'good', reviewCount: 1, ease: 2.5, intervalDays: 1, dueAt: isoAfter(1),
  });
  // ...and calling it with nothing but a gradeless default resets:
  const reset = scheduleCardReview();
  assert.equal(reset.status, 'new');
  assert.equal(reset.dueAt, null);
});

test('scheduleCardReview: replaying a fixed review history is byte-identical (determinism)', () => {
  const history = ['good', 'good', 'again', 'good', 'easy'];
  const replay = () => {
    let card = {};
    const out = [];
    for (const grade of history) {
      const next = scheduleCardReview(card, grade, NOW);
      out.push(next);
      // Mirror the route: reviewed_at is stamped at the same moment due_at is.
      card = {
        reviewCount: next.reviewCount,
        ease: next.ease,
        reviewedAt: NOW.toISOString(),
        dueAt: next.dueAt,
      };
    }
    return out;
  };
  const first = replay();
  const second = replay();
  assert.deepEqual(first, second, 'same history + same clock ⇒ identical schedule');
  // Spot-check the expected progression:
  assert.equal(first[0].intervalDays, 1); // new → good
  assert.equal(first[1].intervalDays, 6); // prev 1 (<6) → learning step 2
  assert.equal(first[2].ease, 2.3); // mature lapse (reviewCount was 2)
  assert.equal(first[2].reviewCount, 0);
  assert.equal(first[3].intervalDays, 6); // back to learning step 2
  assert.equal(first[3].ease, 2.3); // good holds the post-lapse ease
  assert.equal(first[4].intervalDays, 18); // 6×2.3×1.3 = 17.94 → 18
  assert.equal(first[4].ease, 2.45); // 2.3 + 0.15
  assert.deepEqual(first.map((s) => s.dueAt), [
    isoAfter(1), isoAfter(6), isoAfter(1), isoAfter(6), isoAfter(18),
  ]);
  assert.deepEqual(first.map((s) => s.status), ['known', 'known', 'review', 'known', 'known']);
});
