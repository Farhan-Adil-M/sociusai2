// Flashcards: source-grounded front/back pairs generated from retrieved
// passages, plus the deterministic spaced-repetition scheduler that decides
// when each card is due next.
//
// Responsibility: this ONE module owns flashcards end to end. It has two
// halves, both here because they are the same domain object (a card):
//
//   1. GENERATION  — grounded Q/A pairs from retrieved passages. This is the
//      ONLY half that calls the model. Citations are built solely from the
//      retrieved chunks' stored metadata (never from model text), and a card
//      whose citations resolve to nothing is discarded rather than presented
//      as grounded.
//   2. SCHEDULING  — a pure, deterministic SM-2-style scheduler over the
//      stored review state (`deck_cards.review_count` / `ease` / `due_at`).
//      Same review history + same clock ⇒ identical schedule, always. No
//      randomness and no model call ever influences when a card is due.
//
// Inputs (generation): { topic, count, sourceIds, sessionId, userId }.
// Inputs (scheduling): the current card state + a review grade + `now`.
// Outputs: a saved deck (generateFlashcards) / the next card state
//   (scheduleCardReview).
// Dependencies: retrieval.js (toCitation — A13, imported, never edited),
//   prompts.js, quizService (retrieveForAssessment / requireMaterial /
//   passageNumbers / parseJsonLoose — the shared assessment path, cite
//   validation and JSON parser), nimChat, config.
// Test: tests/decks.test.js + tests/events.test.js cover generation and the
//   persisted review state; determinism is proven by replaying a fixed review
//   history (see the report) as well as by the pure functions below.

import { chatCompletion } from './nimChat.js';
import { toCitation } from './retrieval.js';
import { UNTRUSTED_RULE } from './prompts.js';
import { retrieveForAssessment, requireMaterial, parseJsonLoose, passageNumbers } from './quizService.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { newId, nowIso } from '../store/sqlite.js';

const MAX_ATTEMPTS = 2;

// ---- generation -------------------------------------------------------------

export function normalizeCard(raw, hits) {
  if (!raw || typeof raw !== 'object') return null;
  const front = typeof raw.front === 'string' ? raw.front.trim() : '';
  const back = typeof raw.back === 'string' ? raw.back.trim() : '';
  if (front.length < 5 || front.length > 250) return null;
  if (back.length < 10 || back.length > 700) return null;

  // Citations come from the retrieved chunks' stored metadata only — never
  // from model text. An out-of-range `cite` (the model numbered a passage that
  // does not exist) is dropped; if nothing resolves, the strongest retrieved
  // passage is cited so the card still points at real provided material rather
  // than claiming to be grounded with no source at all.
  const cite = passageNumbers(raw.cite);
  const citations = cite.map((n) => hits[n - 1]).filter(Boolean).slice(0, 3).map(toCitation);
  if (citations.length === 0) citations.push(...hits.slice(0, 1).map(toCitation));

  return { front, back, citations };
}

export async function generateFlashcards({ topic, count = 8, sourceIds = [], sessionId = null, userId = 'default' }, { ai, vector, db } = {}) {
  const chat = ai?.chatCompletion ?? chatCompletion;
  // Generation retrieves without the evidence floor, but records
  // `weakEvidence` when every hit is below it, so the frontend can warn
  // honestly. The retrieval itself is quizService's shared assessment path.
  const { hits, weakEvidence, evidence } = await retrieveForAssessment(topic, { sourceIds, ai, vector, userId });
  requireMaterial(hits);
  const systemPrompt = [
    'You create study flashcards strictly from the passages provided.',
    UNTRUSTED_RULE,
    `Topic: ${topic}.`,
    'Return ONLY JSON, no other text: {"cards":[{"front":"question or concept","back":"concise answer or explanation","cite":[1,2]}]}',
    '"front" is what the student sees first; "back" reveals the answer. "cite" lists supporting passage numbers (1-based).',
    'Never mention facts that are not in the passages. Every card must cite at least one passage.',
  ].join('\n');

  const cards = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS && cards.length < count; attempt++) {
    const content = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Passages:\n\n${evidence}\n\nWrite ${count} flashcards.` },
    ], { model: config.nimAssessModel, maxTokens: 2500 });

    const parsed = parseJsonLoose(content);
    for (const raw of parsed?.cards ?? []) {
      if (cards.length >= count) break;
      const card = normalizeCard(raw, hits);
      if (card && !cards.some((c) => c.front.toLowerCase() === card.front.toLowerCase())) cards.push(card);
    }
  }

  if (cards.length === 0) {
    throw new ApiError(422, 'QUIZ_CONTENT_INVALID',
      'The model could not produce valid flashcards from this material. Try another topic or add more material.');
  }

  // Every freshly generated card starts as a NEW card: no review history, the
  // default ease, and no due date (NULL = due now) — the scheduler takes over
  // from the first review onwards.
  const newCards = cards.map((card, i) => ({ id: `card_${i + 1}`, status: 'new', dueAt: null, ...card }));

  // Persisted: flashcards become browseable study resources, not one-shot responses.
  let deckId = null;
  if (db) {
    deckId = newId('deck');
    await db.batch([
      {
        sql: 'INSERT INTO decks (id, user_id, session_id, topic, source_ids_json, card_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [deckId, userId, sessionId, topic, JSON.stringify(sourceIds), cards.length, nowIso()],
      },
      ...newCards.map((card, idx) => ({
        sql: `INSERT INTO deck_cards (deck_id, idx, front, back, citations_json, status, reviewed_at, review_count, ease, due_at)
              VALUES (?, ?, ?, ?, ?, 'new', NULL, 0, ?, NULL)`,
        args: [deckId, idx, card.front, card.back, JSON.stringify(card.citations), SRS.easeDefault],
      })),
    ], 'write');
  }
  return {
    topic,
    model: config.nimAssessModel,
    cards: newCards,
    ...(weakEvidence ? { weakEvidence: true } : {}),
    deckId,
    sessionId,
  };
}

// ---- spaced repetition (pure + deterministic) -------------------------------
//
// SM-2-style, day-granularity scheduling. The stored state is exactly the three
// v8 columns:
//   review_count — successful reviews since the last lapse (drives maturity)
//   ease         — the ease factor, clamped to [easeMin, easeMax]
//   due_at       — ISO timestamp the card is next due (NULL = new / due now)
// The interval that was LAST scheduled is recoverable from (reviewed_at,
// due_at) — `reviewed_at` is stamped at the same moment `due_at` is computed —
// so no extra column is needed to evolve the interval like real SM-2.

export const SRS = Object.freeze({
  easeDefault: 2.5,
  easeMin: 1.3,
  easeMax: 2.8,
  maxIntervalDays: 365,
  lapseIntervalDays: 1, // a failed card returns tomorrow (day-granularity)
});

/** The four review buttons, Anki-style. `again` is a lapse; the rest pass. */
export const REVIEW_GRADES = Object.freeze(['again', 'hard', 'good', 'easy']);

// Ease deltas (Anki defaults): failures pull ease down, `easy` pushes it up,
// `good` holds it steady. Clamping happens in clampEase().
const EASE_DELTA = { again: -0.2, hard: -0.15, good: 0, easy: 0.15 };

// The contract (v1.1) only knows three card statuses; map them to a grade so a
// plain PATCH {status} keeps working while an explicit {grade} can be richer.
const GRADE_FOR_STATUS = { known: 'good', review: 'again' };

// A card has left the learning steps once it has passed the 1-day and 6-day
// intervals; only then does a failure count as a "lapse" (ease penalty).
const MATURE_REVIEW_COUNT = 2;

const DAY_MS = 86400000;

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Clamp an ease factor into the sane band; corrupt values fall back to default. */
export function clampEase(value) {
  // NOTE: Number(null) === 0 (finite!), so an unset ease must be caught first —
  // a brand-new card (ease NULL) starts at the default, never at easeMin.
  if (value === null || value === undefined || value === '') return SRS.easeDefault;
  const n = Number(value);
  if (!Number.isFinite(n)) return SRS.easeDefault;
  return Math.min(SRS.easeMax, Math.max(SRS.easeMin, round3(n)));
}

function clampInterval(days) {
  return Math.min(SRS.maxIntervalDays, Math.max(1, Math.round(days)));
}

/** The interval that was scheduled at the last review, in days (null if unknown). */
export function scheduledIntervalDays({ reviewedAt, dueAt } = {}) {
  const from = Date.parse(reviewedAt ?? '');
  const to = Date.parse(dueAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return (to - from) / DAY_MS;
}

/** Resolve the SRS grade from a contract status and/or an explicit grade. */
export function gradeForStatus(status, grade) {
  if (grade !== undefined && grade !== null) return REVIEW_GRADES.includes(grade) ? grade : null;
  return GRADE_FOR_STATUS[status] ?? null;
}

/**
 * The next interval for a passing grade. Deterministic function of the previous
 * interval and the current ease, so the same inputs always give the same days.
 */
export function nextIntervalDays(grade, { prevInterval = 0, ease = SRS.easeDefault } = {}) {
  if (grade === 'again') return SRS.lapseIntervalDays;
  if (prevInterval <= 0) return grade === 'easy' ? 4 : 1; // brand-new card
  if (grade === 'hard') return clampInterval(prevInterval * 1.2);
  if (grade === 'easy') return clampInterval(prevInterval * ease * 1.3);
  // good
  if (prevInterval < 6) return 6; // second step of the learning phase
  return clampInterval(prevInterval * ease);
}

/**
 * The scheduler. Pure: given the current card state and a review grade it
 * returns the next state. `now` is injectable so a replay yields byte-identical
 * `dueAt` values — determinism is the requirement.
 *
 * @param {{reviewCount?:number, ease?:number, reviewedAt?:string|null, dueAt?:string|null}} card
 * @param {'again'|'hard'|'good'|'easy'|null} grade
 * @param {Date|string} now
 * @returns {{status:string, grade:string|null, reviewCount:number, ease:number, intervalDays:number, dueAt:string|null}}
 */
export function scheduleCardReview(card = {}, grade, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('scheduleCardReview requires a valid `now`.');

  // Reset to new: forget the schedule entirely, no due date until studied again.
  if (!REVIEW_GRADES.includes(grade)) {
    return { status: 'new', grade: null, reviewCount: 0, ease: SRS.easeDefault, intervalDays: 0, dueAt: null };
  }

  const reviewCount = Number.isInteger(card.reviewCount) && card.reviewCount > 0 ? card.reviewCount : 0;
  const ease = clampEase(card.ease);
  const prevInterval = scheduledIntervalDays(card) ?? 0;

  if (grade === 'again') {
    // Lapse: a mature card loses ease and drops back to the start of the
    // learning steps; a brand-new card that fails simply tries again tomorrow.
    const wasMature = reviewCount >= MATURE_REVIEW_COUNT;
    const nextEase = clampEase(ease + (wasMature ? EASE_DELTA.again : 0));
    const intervalDays = SRS.lapseIntervalDays;
    return { status: 'review', grade, reviewCount: 0, ease: nextEase, intervalDays, dueAt: dueAtFrom(nowMs, intervalDays) };
  }

  const nextEase = clampEase(ease + EASE_DELTA[grade]);
  const intervalDays = nextIntervalDays(grade, { prevInterval, ease });
  return { status: 'known', grade, reviewCount: reviewCount + 1, ease: nextEase, intervalDays, dueAt: dueAtFrom(nowMs, intervalDays) };
}

function dueAtFrom(nowMs, intervalDays) {
  // Whole-day steps keep due dates stable and readable across replays.
  return new Date(nowMs + intervalDays * DAY_MS).toISOString();
}
