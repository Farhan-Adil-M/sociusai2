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
  assert.equal(scheduledIntervalDays({ // reviewed and due at the same instant → a 0-day interval
    reviewedAt: '2026-01-01T00:00:00.000Z', dueAt: '2026-01-01T00:00:00.000Z',
  }), 0);
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
  // A null card is NOT the documented `{}` default — it is a wrong type and
  // throws, rather than silently scheduling a phantom card:
  assert.throws(() => scheduleCardReview(null, 'good', NOW), TypeError);
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

// ---------------------------------------------------------------------------
// flashcardService — normalizeCard (generation half, pure part)
// ---------------------------------------------------------------------------

// Three retrieved hits as the retrieval pipeline hands them over.
const HITS = [
  { text: 'Mitosis splits one nucleus into two.', metadata: { sourceId: 'src1', title: 'Cells 101', paragraph: 1 }, distance: 0.2 },
  { text: 'Meiosis halves the chromosome number.', metadata: { sourceId: 'src1', title: 'Cells 101', paragraph: 2 }, distance: 0.25 },
  { text: 'DNA replicates before division starts.', metadata: { sourceId: 'src2', title: 'Genetics basics', page: 3 }, distance: 0.3 },
];
const VALID = { front: 'What does mitosis produce?', back: 'Two genetically identical daughter cells.', cite: [1] };

test('normalizeCard: trims fields and builds citations from the stored hit metadata', () => {
  const card = normalizeCard({ ...VALID, front: `  ${VALID.front}  `, back: `${VALID.back} ` }, HITS);
  assert.equal(card.front, VALID.front);
  assert.equal(card.back, VALID.back);
  assert.equal(card.citations.length, 1);
  assert.equal(card.citations[0].sourceId, 'src1'); // from hit metadata, never from model text
  assert.equal(card.citations[0].title, 'Cells 101');
  assert.equal(card.citations[0].excerpt, 'Mitosis splits one nucleus into two.');
  assert.equal(card.citations[0].location.paragraph, 1);
  // Third hit carries a page instead — location precedence is page:
  const pageCite = normalizeCard({ ...VALID, cite: [3] }, HITS);
  assert.equal(pageCite.citations[0].location.page, 3);
  assert.equal(pageCite.citations[0].title, 'Genetics basics');
});

test('normalizeCard: exact length boundaries — front 5..250, back 10..700', () => {
  const at = (front, back) => normalizeCard({ front, back, cite: [1] }, HITS);
  assert.equal(normalizeCard({ front: '1234', back: '0123456789', cite: [1] }, HITS), null); // front < 5
  assert.notEqual(at('12345', '0123456789'), null); // both at their minimum → kept
  assert.equal(at('1'.repeat(251), '0123456789'), null); // front > 250
  assert.notEqual(at('1'.repeat(250), '0123456789'), null); // front exactly 250
  assert.equal(at('ok front', '012345678'), null); // back < 10
  assert.notEqual(at('ok front', '0123456789'), null); // back exactly 10
  assert.equal(at('ok front', '0'.repeat(701)), null); // back > 700
  assert.notEqual(at('ok front', '0'.repeat(700)), null); // back exactly 700
});

test('normalizeCard: malformed model output is rejected outright', () => {
  for (const raw of [null, undefined, 'a plain string', 42, true, []]) {
    assert.equal(normalizeCard(raw, HITS), null, `raw ${String(raw)} must be rejected`);
  }
  // non-string fields become '' → fail the length checks:
  assert.equal(normalizeCard({ front: 12345, back: 'long enough back', cite: [1] }, HITS), null);
  assert.equal(normalizeCard({ front: 'long enough front', back: null, cite: [1] }, HITS), null);
  // whitespace-only fields trim to '' → rejected:
  assert.equal(normalizeCard({ front: '     ', back: 'long enough back', cite: [1] }, HITS), null);
});

test('normalizeCard: citation handling — out-of-range dropped, capped at 3, fallback to the strongest hit', () => {
  // 1-based positive integers only; 0/-1/'x'/2.5 are not passage numbers:
  const weird = normalizeCard({ ...VALID, cite: [0, -1, 'x', 2.5, 2] }, HITS);
  assert.equal(weird.citations.length, 1);
  assert.equal(weird.citations[0].excerpt, HITS[1].text);
  // capped at 3 even when the model cites more:
  const many = normalizeCard({ ...VALID, cite: [1, 2, 3, 4, 5] }, HITS);
  assert.equal(many.citations.length, 3);
  // nothing resolves (out-of-range / non-array cite) → cite the top hit rather
  // than ship a "grounded" card with no source at all:
  const fallback = normalizeCard({ ...VALID, cite: [9] }, HITS);
  assert.equal(fallback.citations.length, 1);
  assert.equal(fallback.citations[0].excerpt, HITS[0].text);
  assert.equal(normalizeCard({ ...VALID, cite: 'one' }, HITS).citations[0].excerpt, HITS[0].text);
  assert.equal(normalizeCard({ ...VALID }, HITS).citations[0].excerpt, HITS[0].text); // cite missing
  // degenerate: no hits at all → no citations (nothing to ground against)…
  const ungrounded = normalizeCard({ ...VALID }, []);
  assert.deepEqual(ungrounded.citations, []);
  assert.equal(ungrounded.front, VALID.front); // but the card itself still normalizes
});

// ---------------------------------------------------------------------------
// flashcardService — generateFlashcards (offline: stub AI + vector + SQLite)
// ---------------------------------------------------------------------------

const CHUNK_TEXTS = [
  'Mitosis splits one nucleus into two identical cells.',
  'Meiosis produces four genetically varied cells.',
  'DNA replicates once before either division begins.',
];

/** Put the three fixture chunks into a vector stub (fakeVector's store). */
async function seedChunks(vector, { sourceId = 'src_gen', title = 'Cells 101' } = {}) {
  await vector.addChunks({
    ids: CHUNK_TEXTS.map((_, i) => `${sourceId}_${i + 1}`),
    embeddings: CHUNK_TEXTS.map(() => EMBEDDING),
    documents: CHUNK_TEXTS,
    metadatas: CHUNK_TEXTS.map((_, i) => ({ sourceId, title, paragraph: i + 1 })),
  });
}

/** Throwaway local SQLite file — same seam as the other suites. */
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-flash-'));
  return openDb(path.join(dir, 'app.db'));
}

/** study_sessions rows exist for real decks (FK enforced by node:sqlite). */
async function seedSession(db, id) {
  await db.run(
    'INSERT INTO study_sessions (id, title, category, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, 'Biology', 'subject', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  );
}

/** MakeAi whose chatCompletion is replaced but which keeps the calls log. */
function aiAnswering(ai, text) {
  ai.chatCompletion = async (messages) => { ai.calls.push(messages); return text; };
  return ai;
}

test('generateFlashcards: returns NEW cards and persists the deck + card rows', async () => {
  const db = await freshDb();
  await seedSession(db, 'ses_abc');
  const vector = fakeVector();
  await seedChunks(vector);
  const ai = makeAi(); // helpers' default stub answers with 3 valid flashcards

  const result = await generateFlashcards(
    { topic: 'Cell division', count: 3, sourceIds: [], sessionId: 'ses_abc', userId: 'default' },
    { ai, vector, db },
  );

  assert.equal(result.topic, 'Cell division');
  assert.equal(result.model, config.nimAssessModel);
  assert.equal(result.sessionId, 'ses_abc');
  assert.equal(result.cards.length, 3);
  assert.equal('weakEvidence' in result, false); // strong hits → no warning flag
  assert.match(result.deckId, /^deck_/);
  result.cards.forEach((card, i) => {
    assert.equal(card.id, `card_${i + 1}`);
    assert.equal(card.status, 'new'); // every fresh card starts NEW…
    assert.equal(card.dueAt, null); // …with no due date (NULL = due now)
    assert.ok(card.front.length >= 5 && card.back.length >= 10);
    assert.ok(card.citations.length >= 1, 'grounded cards carry citations');
    for (const citation of card.citations) {
      assert.equal(citation.sourceId, 'src_gen'); // stored metadata only
      assert.ok(CHUNK_TEXTS.includes(citation.excerpt), 'excerpt must be a real stored passage');
    }
  });

  // Persisted rows match the returned deck:
  const decks = await db.all('SELECT * FROM decks WHERE user_id = ?', 'default');
  assert.equal(decks.length, 1);
  assert.equal(decks[0].topic, 'Cell division');
  assert.equal(decks[0].card_count, 3);
  assert.equal(decks[0].session_id, 'ses_abc');
  assert.deepEqual(JSON.parse(decks[0].source_ids_json), []);
  const rows = await db.all('SELECT * FROM deck_cards WHERE deck_id = ? ORDER BY idx', decks[0].id);
  assert.equal(rows.length, 3);
  rows.forEach((row, i) => {
    assert.equal(row.idx, i);
    assert.equal(row.front, result.cards[i].front);
    assert.equal(row.back, result.cards[i].back);
    assert.equal(row.status, 'new');
    assert.equal(row.review_count, 0);
    assert.equal(row.ease, SRS.easeDefault); // the scheduler starts from the default ease
    assert.equal(row.due_at, null);
    assert.equal(JSON.parse(row.citations_json).length, result.cards[i].citations.length);
  });
});

test('generateFlashcards: without a db it still returns cards but saves nothing (deckId null)', async () => {
  const vector = fakeVector();
  await seedChunks(vector);
  const ai = makeAi();
  const result = await generateFlashcards({ topic: 'Cell division', count: 2 }, { ai, vector });
  assert.equal(result.deckId, null);
  assert.equal(result.cards.length, 2);
  assert.ok(result.cards.every((c) => c.status === 'new' && c.dueAt === null));

  // `count` defaults to 8 when the caller omits it (the model offered only 3):
  const defaultCount = makeAi();
  const defaulted = await generateFlashcards({ topic: 'Cell division' }, { ai: defaultCount, vector });
  assert.equal(defaulted.cards.length, 3);
  assert.equal(defaultCount.calls.length, 2); // asked twice, still short of 8
});

test('generateFlashcards: honours `count`, drops duplicate fronts, and retries at most twice', async () => {
  const vector = fakeVector();
  await seedChunks(vector);
  const ai = aiAnswering(makeAi(), JSON.stringify({
    cards: [
      { front: 'What is mitosis?', back: 'Cell division producing two cells.', cite: [1] },
      { front: 'WHAT IS MITOSIS?', back: 'Same front, different case — a duplicate.', cite: [2] },
      { front: 'What is meiosis?', back: 'Division producing four cells.', cite: [2] },
    ],
  }));

  const result = await generateFlashcards({ topic: 'Cells', count: 5 }, { ai, vector });
  assert.equal(ai.calls.length, 2); // count not reached → exactly MAX_ATTEMPTS calls, never more
  assert.equal(result.cards.length, 2); // case-insensitive dedupe kept the first occurrence
  assert.equal(result.cards[0].front, 'What is mitosis?');
  assert.equal(result.cards[1].front, 'What is meiosis?');

  // count is a hard ceiling: the model may offer more than asked for.
  const plenty = aiAnswering(makeAi(), JSON.stringify({
    cards: [
      { front: 'Question number one?', back: 'Answer number one here.', cite: [1] },
      { front: 'Question number two?', back: 'Answer number two here.', cite: [2] },
      { front: 'Question number three?', back: 'Answer number three here.', cite: [3] },
    ],
  }));
  const capped = await generateFlashcards({ topic: 'Cells', count: 2 }, { ai: plenty, vector });
  assert.equal(capped.cards.length, 2);
  assert.equal(plenty.calls.length, 1); // ceiling met on the first attempt
});

test('generateFlashcards: unusable model output after both attempts → 422 QUIZ_CONTENT_INVALID', async () => {
  const vector = fakeVector();
  await seedChunks(vector);
  const ai = aiAnswering(makeAi(), 'there is no json in this reply');
  await assert.rejects(
    generateFlashcards({ topic: 'Cells', count: 3 }, { ai, vector }),
    (err) => err.status === 422 && err.code === 'QUIZ_CONTENT_INVALID'
      && /could not produce valid flashcards/i.test(err.message),
  );
  assert.equal(ai.calls.length, 2); // it really did retry before giving up
});

test('generateFlashcards: cards that fail normalizeCard are dropped → 422 when none survive', async () => {
  const vector = fakeVector();
  await seedChunks(vector);
  const ai = aiAnswering(makeAi(), JSON.stringify({
    cards: [
      { front: 'x', back: 'long enough back for the check', cite: [1] }, // front too short
      { front: 'Valid enough front?', back: 'no', cite: [1] }, // back too short
      { front: 42, back: 'long enough back for the check', cite: [1] }, // non-string front
    ],
  }));
  await assert.rejects(
    generateFlashcards({ topic: 'Cells', count: 3 }, { ai, vector }),
    { status: 422, code: 'QUIZ_CONTENT_INVALID' },
  );
});

test('generateFlashcards: no material (empty store or wrong scope) → 422 before any model call', async () => {
  // Empty store:
  const empty = fakeVector();
  const ai1 = makeAi();
  await assert.rejects(
    generateFlashcards({ topic: 'Cells', count: 3 }, { ai: ai1, vector: empty }),
    (err) => err.status === 422 && err.code === 'QUIZ_CONTENT_INVALID'
      && /Not enough indexed material/.test(err.message),
  );
  assert.equal(ai1.calls.length, 0, 'the model must not be called without material');

  // Scope that matches none of the stored chunks:
  const scoped = fakeVector();
  await seedChunks(scoped);
  const ai2 = makeAi();
  await assert.rejects(
    generateFlashcards({ topic: 'Cells', count: 3, sourceIds: ['src_elsewhere'] }, { ai: ai2, vector: scoped }),
    { status: 422, code: 'QUIZ_CONTENT_INVALID' },
  );
  assert.equal(ai2.calls.length, 0);
});

test('generateFlashcards: weakEvidence is flagged when every hit is below the evidence floor', async () => {
  const base = fakeVector();
  await seedChunks(base);
  // Same chunks, but every hit comes back nearly irrelevant (distance 0.98 →
  // score 0.02 < config.ragMinSimilarity 0.1). Retrieval still returns them
  // (generation does not apply the floor), the response just warns honestly.
  const weak = {
    queryChunks: async (opts) => (await base.queryChunks(opts)).map((hit) => ({ ...hit, distance: 0.98 })),
  };
  const result = await generateFlashcards(
    { topic: 'Cell division', count: 3 },
    { ai: makeAi(), vector: weak },
  );
  assert.equal(result.weakEvidence, true);
  assert.equal(result.cards.length, 3);
});

// ---------------------------------------------------------------------------
// topicSuggestions — the abstain path's 0-4 REAL suggestions
// ---------------------------------------------------------------------------
// fetchTopicSuggestions(db, sourceIds, userId) reads only database rows
// (decks → quizzes → first-line headings → source titles), dedupes
// case-insensitively, and caps at 4. It must never invent a topic and never
// leak another user's or an out-of-scope topic.

const T0 = '2026-01-01T00:00:00.000Z';

async function topicDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-topics-'));
  return openDb(path.join(dir, 'app.db'));
}

async function addSession(db, id, userId = 'default') {
  await db.run(
    'INSERT INTO study_sessions (id, title, category, status, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, id, 'subject', 'active', T0, T0, userId,
  );
}

async function addSource(db, { id, title, sessionId = null, chunks = 1, userId = 'default' }) {
  await db.run(
    'INSERT INTO sources (id, type, title, chunk_count, session_id, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, 'webpage', title, chunks, sessionId, T0, userId,
  );
}

async function addSegment(db, sourceId, text, idx = 0) {
  await db.run(
    'INSERT INTO source_segments (source_id, seg_index, location, text) VALUES (?, ?, ?, ?)',
    sourceId, idx, 'test', text,
  );
}

async function addDeck(db, { id, topic, sourceIds = [], sessionId = null, cards = 3, userId = 'default' }) {
  await db.run(
    'INSERT INTO decks (id, session_id, topic, source_ids_json, card_count, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, sessionId, topic, JSON.stringify(sourceIds), cards, T0, userId,
  );
}

async function addQuiz(db, { id, topic, sessionId = null, questions = 3, userId = 'default' }) {
  await db.run(
    'INSERT INTO quizzes (id, topic, difficulty, question_count, created_at, session_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, topic, 'medium', questions, T0, sessionId, userId,
  );
}

test('fetchTopicSuggestions: no database handle → [] (degenerate input)', async () => {
  assert.deepEqual(await fetchTopicSuggestions(undefined), []);
  assert.deepEqual(await fetchTopicSuggestions(null), []);
});

test('fetchTopicSuggestions: an empty database → [] — nothing meaningful exists, nothing invented', async () => {
  const db = await topicDb();
  assert.deepEqual(await fetchTopicSuggestions(db), []);
  assert.deepEqual(await fetchTopicSuggestions(db, ['src_none']), []);
});

test('fetchTopicSuggestions: tiers in priority order, scoped to the asked-against sources', async () => {
  const db = await topicDb();
  await addSession(db, 'ses_a');
  await addSession(db, 'ses_b');
  await addSource(db, { id: 'src1', title: 'Alpha source', sessionId: 'ses_a', chunks: 4 });
  await addSource(db, { id: 'src2', title: 'Beta source', sessionId: 'ses_b', chunks: 1 });
  await addSegment(db, 'src1', '## Branching narrative structures');
  await addSegment(db, 'src2', 'Intro to beta things.');
  await addDeck(db, { id: 'deck1', topic: 'Deck alpha', sourceIds: ['src1'], cards: 5 });
  await addDeck(db, { id: 'deck2', topic: 'Deck beta', sourceIds: ['src2'], sessionId: 'ses_b', cards: 3 });
  await addQuiz(db, { id: 'quiz1', topic: 'Quiz alpha', sessionId: 'ses_a', questions: 4 });
  await addQuiz(db, { id: 'quiz2', topic: 'Quiz beta', sessionId: 'ses_b', questions: 9 });

  // Question scoped to src1: only src1's deck, quiz, heading and title qualify.
  const scoped = await fetchTopicSuggestions(db, ['src1']);
  assert.deepEqual(scoped, [
    'Deck alpha', // tier 1: deck's source ids intersect the scope
    'Quiz alpha', // tier 2: quiz's session holds the scoped source
    'Branching narrative structures', // tier 3: first line of seg 0 (## stripped)
    'Alpha source', // tier 4: the source title
  ]);
  // Explicitly: nothing from the out-of-scope source/session leaked in:
  for (const forbidden of ['Deck beta', 'Quiz beta', 'Intro to beta things.', 'Beta source']) {
    assert.equal(scoped.includes(forbidden), false, `${forbidden} is outside the scope`);
  }

  // Unscoped = "all of this user's material": the other source's rows join in.
  const unscoped = await fetchTopicSuggestions(db);
  assert.deepEqual(unscoped, [
    'Deck alpha', 'Deck beta', // decks ranked by card_count DESC (5 then 3)
    'Quiz beta', 'Quiz alpha', // quizzes ranked by question_count DESC (9 then 4)
    // ...and the cap of 4 stops before tiers 3–4.
  ]);
  assert.equal(unscoped.includes('Beta source'), false, 'cap of 4 stops the list');
});

test('fetchTopicSuggestions: deck tier ranks by card_count and the list stops at 4', async () => {
  const db = await topicDb();
  // Deliberately inserted out of order — ranking comes from the query, not insertion.
  await addDeck(db, { id: 'd1', topic: 'Turtle topics', cards: 3 });
  await addDeck(db, { id: 'd2', topic: 'Alpha decks', cards: 6 });
  await addDeck(db, { id: 'd3', topic: 'Zulu decks', cards: 4 });
  await addDeck(db, { id: 'd4', topic: 'Mike decks', cards: 5 });
  await addDeck(db, { id: 'd5', topic: 'Bravo decks', cards: 2 });
  await addDeck(db, { id: 'd6', topic: 'Yankee decks', cards: 1 });
  // Lower tiers exist but must never appear — decks already fill all four slots:
  await addSource(db, { id: 'src_t', title: 'Title evidence', chunks: 2 });
  await addSegment(db, 'src_t', 'Heading evidence line');
  await addQuiz(db, { id: 'q_t', topic: 'Quiz evidence', questions: 9 });

  assert.deepEqual(await fetchTopicSuggestions(db), [
    'Alpha decks', 'Mike decks', 'Zulu decks', 'Turtle topics',
  ]);
});

test('fetchTopicSuggestions: quiz tier fills what decks left, ranked by question_count', async () => {
  const db = await topicDb();
  await addSession(db, 'ses_q');
  await addSource(db, { id: 'src_q', title: 'Scoped source', sessionId: 'ses_q', chunks: 3 });
  await addSegment(db, 'src_q', 'Scoped heading text');
  await addDeck(db, { id: 'deck_q', topic: 'Deck only', sourceIds: ['src_q'], cards: 10 });
  await addQuiz(db, { id: 'qa', topic: 'Quiz low', sessionId: 'ses_q', questions: 2 });
  await addQuiz(db, { id: 'qb', topic: 'Quiz high', sessionId: 'ses_q', questions: 9 });
  await addQuiz(db, { id: 'qc', topic: 'Quiz mid', sessionId: 'ses_q', questions: 5 });
  // A quiz whose session holds NO scoped source must not qualify:
  await addQuiz(db, { id: 'qd', topic: 'Quiz foreign', questions: 99 });

  assert.deepEqual(await fetchTopicSuggestions(db, ['src_q']), [
    'Deck only', 'Quiz high', 'Quiz mid', 'Quiz low',
  ]);
});

test('fetchTopicSuggestions: case-insensitive dedupe keeps the FIRST occurrence only', async () => {
  const db = await topicDb();
  await addSession(db, 'ses_d');
  await addSource(db, { id: 'src_d', title: 'Mitosis basics', sessionId: 'ses_d', chunks: 2 });
  await addSegment(db, 'src_d', 'MITOSIS BASICS');
  await addDeck(db, { id: 'deck_d', topic: 'Mitosis basics', sourceIds: ['src_d'], cards: 9 });
  await addQuiz(db, { id: 'quiz_d', topic: 'mitosis basics', sessionId: 'ses_d', questions: 7 });

  assert.deepEqual(await fetchTopicSuggestions(db, ['src_d']), ['Mitosis basics']);
  // The four tiers each produced the same topic — dedupe collapsed them into
  // the single first (tier-1) occurrence, order untouched:
  const both = await fetchTopicSuggestions(db);
  assert.deepEqual(both, ['Mitosis basics']);
});

test('fetchTopicSuggestions: topic length bounds (2..80) and trimming', async () => {
  const db = await topicDb();
  await addDeck(db, { id: 'd_pad', topic: '  padded topic  ', cards: 10 });
  await addDeck(db, { id: 'd_80', topic: 'z'.repeat(80), cards: 5 });
  await addDeck(db, { id: 'd_short', topic: 'x', cards: 4 }); // 1 char → dropped
  await addDeck(db, { id: 'd_long', topic: 'y'.repeat(81), cards: 3 }); // 81 chars → dropped
  await addDeck(db, { id: 'd_two', topic: 'ab', cards: 1 }); // exactly 2 → kept

  assert.deepEqual(await fetchTopicSuggestions(db), [
    'padded topic', 'z'.repeat(80), 'ab',
  ]);
});

test('fetchTopicSuggestions: every suggestion is traceable to a stored row — it never invents', async () => {
  const db = await topicDb();
  await addSession(db, 'ses_e');
  await addSource(db, { id: 'se1', title: 'Real title one', sessionId: 'ses_e', chunks: 3 });
  await addSource(db, { id: 'se2', title: 'Real title two', chunks: 2 });
  await addSegment(db, 'se1', '## Real heading one');
  await addSegment(db, 'se2', 'Real heading two');
  await addDeck(db, { id: 'de1', topic: 'Real deck topic', sourceIds: ['se1'], cards: 8 });
  await addQuiz(db, { id: 'qe1', topic: 'Real quiz topic', sessionId: 'ses_e', questions: 6 });

  const allowed = new Set([
    'Real deck topic', 'Real quiz topic',
    'Real heading one', 'Real heading two',
    'Real title one', 'Real title two',
  ]);
  const suggestions = await fetchTopicSuggestions(db);
  assert.ok(suggestions.length > 0, 'fixture must actually produce suggestions');
  for (const topic of suggestions) {
    assert.ok(allowed.has(topic), `suggestion "${topic}" is not present in any stored row`);
  }

  // Degenerate evidence: a source whose title and first segment are both
  // empty can yield nothing — an empty array, never a fabricated topic.
  const bare = await topicDb();
  await addSource(bare, { id: 'b1', title: '' });
  await addSegment(bare, 'b1', '');
  assert.deepEqual(await fetchTopicSuggestions(bare), []);
});

test('fetchTopicSuggestions: another user\'s rows never appear, even unscoped', async () => {
  const db = await topicDb();
  await addDeck(db, { id: 'd_mine', topic: 'Mine deck', cards: 5 });
  await addDeck(db, { id: 'd_theirs', topic: 'Theirs deck', cards: 9, userId: 'other' });
  await addSource(db, { id: 's_mine', title: 'Mine source' });
  await addSource(db, { id: 's_theirs', title: 'Theirs source', userId: 'other' });

  const mine = await fetchTopicSuggestions(db, [], 'default');
  assert.deepEqual(mine, ['Mine deck', 'Mine source']);
  assert.equal(mine.includes('Theirs deck'), false);
  assert.equal(mine.includes('Theirs source'), false);
});

test('fetchTopicSuggestions: corrupt deck source_ids_json never throws and never matches', async () => {
  const db = await topicDb();
  await addSource(db, { id: 'src_c', title: 'Alpha source', chunks: 2 });
  await addSegment(db, 'src_c', 'Alpha heading text');
  await db.run(
    'INSERT INTO decks (id, session_id, topic, source_ids_json, card_count, created_at, user_id) VALUES (?, NULL, ?, ?, ?, ?, ?)',
    'deck_bad', 'Corrupt link', 'not-json{{', 7, T0, 'default',
  );
  await db.run(
    'INSERT INTO decks (id, session_id, topic, source_ids_json, card_count, created_at, user_id) VALUES (?, NULL, ?, ?, ?, ?, ?)',
    'deck_obj', 'Object link', '{"a":1}', 6, T0, 'default',
  );

  // Scoped: an unreadable JSON array matches no source → the decks are out.
  assert.deepEqual(await fetchTopicSuggestions(db, ['src_c']), [
    'Alpha heading text', 'Alpha source',
  ]);
  // Unscoped: scope covers everything of this user, corrupt JSON or not.
  assert.deepEqual(await fetchTopicSuggestions(db), [
    'Corrupt link', 'Object link', 'Alpha heading text', 'Alpha source',
  ]);
});

test('fetchTopicSuggestions: heading tier reads ONLY seg_index 0, most-chunks source first', async () => {
  const db = await topicDb();
  await addSource(db, { id: 's_hi', title: 'Zeta source', chunks: 9 });
  await addSource(db, { id: 's_lo', title: 'Alpha source', chunks: 1 });
  await addSegment(db, 's_hi', 'Zeta heading');
  await addSegment(db, 's_hi', 'Secondary heading text', 1); // ignored — not seg 0
  await addSegment(db, 's_lo', 'Alpha heading');

  // Ranking is chunk_count DESC (9 then 1), NOT alphabetical by title:
  assert.deepEqual(await fetchTopicSuggestions(db), [
    'Zeta heading', 'Alpha heading', 'Zeta source', 'Alpha source',
  ]);
  const all = await fetchTopicSuggestions(db);
  assert.equal(all.includes('Secondary heading text'), false);
});

test('fetchTopicSuggestions: first-line rules — markers stripped, junk rejected, sentence fallback', async () => {
  const db = await topicDb();
  // [id, segment-0 text] — the expected suggestions are asserted below:
  const cases = [
    ['h1', '## Markdown heading'], // → 'Markdown heading'
    ['h2', '• Bullet point'], // → 'Bullet point'
    ['h3', 'Biology:'], // → 'Biology' (trailing list punctuation removed)
    ['h4', 'Photosynthesis'], // → 'Photosynthesis' (single-word heading is fine)
    ['h5', '12'], // → nothing: page number, no letter, no sentence
    ['h6', ''], // → nothing: empty segment
    ['h7', 'Wow. This continuation is long enough to push this whole first line far past the eighty character topic limit.'], // → nothing: one-word sentence
    ['h8', 'Cell theory states three core principles. The third one concerns how division and growth happen in every living organism.'], // usable heading, but 5 usable > cap 4 — see the isolated check below
  ];
  for (const [id, text] of cases) {
    await addSource(db, { id: `src_${id}`, title: `Doc ${id}` });
    await addSegment(db, `src_${id}`, text);
  }

  const withHeadings = await fetchTopicSuggestions(db);
  assert.deepEqual(withHeadings, [
    'Markdown heading', 'Bullet point', 'Biology', 'Photosynthesis',
  ], 'four usable headings fill the cap; junk sources contribute nothing');
  assert.equal(withHeadings.includes('12'), false);

  // The long-line sentence fallback in isolation (one source, no competition):
  const solo = await topicDb();
  await addSource(solo, { id: 'long1', title: 'Long doc' });
  await addSegment(solo, 'long1', 'Cell theory states three core principles. The third one concerns how division and growth happen in every living organism.');
  assert.deepEqual(await fetchTopicSuggestions(solo), [
    'Cell theory states three core principles', 'Long doc',
  ]);
});

test('fetchTopicSuggestions: scoped ids that match nothing → [], not every topic', async () => {
  const db = await topicDb();
  await addDeck(db, { id: 'd_x', topic: 'Some deck topic', cards: 4 });
  await addSource(db, { id: 's_x', title: 'Some source title' });
  assert.deepEqual(await fetchTopicSuggestions(db, ['src_ghost']), []);
});
