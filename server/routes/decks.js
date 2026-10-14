// Persistent flashcard decks: browse, open, practise with saved review status.
// Generation still lives in flashcardService; this route saves and serves decks.
// The POST /generate endpoint (flashcard deck creation) also lives here — the
// former routes/flashcards.js file was deliberately merged into this module in
// Wave 1 (A04 switched app.js to import both factories from here); there is no
// separate routes/flashcards.js to create.
//
// Reviewing a card runs the deterministic SRS scheduler from flashcardService
// (deck_cards.review_count / ease / due_at), records the existing card_*
// learning_events evidence, and records A09's `card_reviewed` study-history row
// — at THIS route, never as a hidden side effect inside events.js.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { recordEvent, recordStudyEvent } from '../services/events.js';
import { CATEGORIES } from '../constants.js';
import {
  generateFlashcards,
  scheduleCardReview,
  scheduledIntervalDays,
  gradeForStatus,
  REVIEW_GRADES,
  SRS,
} from '../services/flashcardService.js';
import { resolveRequestScope, validateSourceIds, validateTopic } from '../services/retrieval.js';
import { nowIso } from '../store/sqlite.js';

const CARD_STATUSES = new Set(['new', 'known', 'review']);

/** Defensive JSON array read: corrupt/NULL/object → [] (never throws). */
function parseJsonArray(json) {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Stored string list (defensive: corrupt/null → empty). */
function parseStringList(json) {
  return parseJsonArray(json).filter((value) => typeof value === 'string');
}

/** The interval a card currently carries, in whole days (0 when unscheduled). */
function intervalDays(row) {
  const days = scheduledIntervalDays({ reviewedAt: row.reviewed_at, dueAt: row.due_at });
  return days === null ? 0 : Math.round(days);
}

/** A deck_cards row → the contract card shape (SRS fields are additive). */
function cardRowToApi(card) {
  return {
    idx: card.idx,
    front: card.front,
    back: card.back,
    citations: parseJsonArray(card.citations_json),
    status: card.status,
    reviewedAt: card.reviewed_at ?? null,
    reviewCount: card.review_count ?? 0,
    ease: card.ease ?? SRS.easeDefault,
    dueAt: card.due_at ?? null,
    intervalDays: intervalDays(card),
  };
}

function deckRowToApi(row, extra = {}) {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    topic: row.topic,
    cardCount: row.card_count,
    createdAt: row.created_at,
    lastReviewedAt: row.last_reviewed_at ?? null,
    ...extra,
  };
}

/** A card is "ready to study" when it is new (no due date) or already due. */
function isReadyToStudy(dueAt, now) {
  return dueAt === null || dueAt <= now;
}

export function decksRouter({ db, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.get('/', async (req, res) => {
    const { sessionId: sessionFilter, category, q } = req.query;
    const sort = req.query.sort ?? 'recent';
    if (!['recent', 'alpha', 'active'].includes(sort)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sort must be recent, alpha, or active.');
    }
    if (category && !CATEGORIES.has(category)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category.');
    }
    const search = typeof q === 'string' && q.trim() !== '' ? q.trim() : null;

    const filters = ['d.user_id = ?'];
    // The first positional parameter belongs to the `due_count` sub-select in
    // `columns` below; facade args bind in textual order, so it goes first.
    const now = nowIso();
    const params = [now, req.userId];
    if (sessionFilter === 'unsorted') filters.push('d.session_id IS NULL');
    else if (typeof sessionFilter === 'string' && sessionFilter !== '') {
      filters.push('d.session_id = ?');
      params.push(sessionFilter);
    }
    if (category) {
      filters.push('ss.category = ?');
      params.push(category);
    }
    if (search) {
      filters.push('(d.topic LIKE ? OR ss.title LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like);
    }

    const columns = `
      d.*,
      ss.title AS session_title,
      ss.category AS session_category,
      (SELECT COUNT(*) FROM deck_cards WHERE deck_id = d.id AND status = 'known') AS known_count,
      (SELECT COUNT(*) FROM deck_cards WHERE deck_id = d.id AND status = 'review') AS review_count,
      (SELECT COUNT(*) FROM deck_cards WHERE deck_id = d.id AND (due_at IS NULL OR due_at <= ?)) AS due_count
    `;
    // NB: here `dueCount` = cards ready to study now (new + scheduled-due).
    // GET /api/decks/due splits that same total into `newCount` + `dueCount`
    // (scheduled only), so the two add up to this number.
    // The join also matches on user so a deck of user A can never borrow the
    // title/category of user B's same-id... ids are unique, but per-user rows
    // make every join explicit anyway.
    const join = 'decks d LEFT JOIN study_sessions ss ON ss.id = d.session_id AND ss.user_id = d.user_id';
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    // "active" = last studied first, never-studied decks last, newest first then.
    const orderBy = {
      recent: 'd.created_at DESC',
      alpha: 'LOWER(d.topic) ASC',
      active: `CASE WHEN d.last_reviewed_at IS NOT NULL THEN d.last_reviewed_at ELSE '' END DESC, d.created_at DESC`,
    }[sort];

    const rows = await db.all(`SELECT ${columns} FROM ${join} ${where} ORDER BY ${orderBy}`, ...params);
    const unsortedDeckCount = (await db.get('SELECT COUNT(*) AS n FROM decks WHERE user_id = ? AND session_id IS NULL', req.userId)).n;

    res.json({
      decks: rows.map((row) => deckRowToApi(row, {
        sessionTitle: row.session_title ?? null,
        category: row.session_category ?? null,
        knownCount: row.known_count,
        reviewCount: row.review_count,
        dueCount: row.due_count,
      })),
      unsortedDeckCount,
    });
  });

  // GET /api/decks/due — every card that is ready to study NOW, across the
  // user's decks (new cards first, then the most overdue). Declared BEFORE
  // /:deckId so "due" is never parsed as a deck id.
  //
  // Index-friendly: the scheduled-review query leads with `due_at <= ?`, the
  // exact shape A06's `idx_deck_cards_due` index serves; owner scoping is a
  // filter on the joined decks row, so it can only narrow the range.
  router.get('/due', async (req, res) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be a whole number between 1 and 200.');
    }
    const includeNew = req.query.includeNew !== '0';
    const now = nowIso();
    const baseSelect = `
      SELECT c.deck_id, c.idx, c.front, c.back, c.citations_json, c.status, c.reviewed_at,
             c.review_count, c.ease, c.due_at,
             d.topic, d.session_id, ss.title AS session_title
      FROM deck_cards c
      JOIN decks d ON d.id = c.deck_id
      LEFT JOIN study_sessions ss ON ss.id = d.session_id AND ss.user_id = d.user_id
    `;

    const dueRows = await db.all(`${baseSelect}
      WHERE d.user_id = ? AND c.due_at IS NOT NULL AND c.due_at <= ?
      ORDER BY c.due_at ASC, c.deck_id ASC, c.idx ASC
      LIMIT ?`, req.userId, now, limit);
    const newRows = includeNew ? await db.all(`${baseSelect}
      WHERE d.user_id = ? AND c.due_at IS NULL
      ORDER BY d.created_at ASC, c.idx ASC
      LIMIT ?`, req.userId, limit) : [];

    const counts = await db.get(`
      SELECT
        SUM(CASE WHEN c.due_at IS NULL THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN c.due_at IS NOT NULL AND c.due_at <= ? THEN 1 ELSE 0 END) AS due_count
      FROM deck_cards c JOIN decks d ON d.id = c.deck_id
      WHERE d.user_id = ?`, now, req.userId);

    const toApi = (row) => ({
      deckId: row.deck_id,
      deckTopic: row.topic,
      sessionId: row.session_id ?? null,
      sessionTitle: row.session_title ?? null,
      idx: row.idx,
      front: row.front,
      back: row.back,
      citations: parseJsonArray(row.citations_json),
      status: row.status,
      reviewedAt: row.reviewed_at ?? null,
      reviewCount: row.review_count ?? 0,
      ease: row.ease ?? SRS.easeDefault,
      dueAt: row.due_at ?? null,
      intervalDays: intervalDays(row),
    });

    res.json({
      asOf: now,
      dueCount: counts?.due_count ?? 0,
      newCount: includeNew ? (counts?.new_count ?? 0) : 0,
      cards: [...newRows, ...dueRows].slice(0, limit).map(toApi),
    });
  });

  router.get('/:deckId', async (req, res) => {
    const row = await db.get(`
      SELECT d.*, ss.title AS session_title, ss.category AS session_category
      FROM decks d LEFT JOIN study_sessions ss ON ss.id = d.session_id AND ss.user_id = d.user_id
      WHERE d.id = ? AND d.user_id = ?`, req.params.deckId, req.userId);
    if (!row) throw new ApiError(404, 'DECK_NOT_FOUND', 'That deck does not exist. Generate a new one.');

    const now = nowIso();
    const cards = (await db.all('SELECT * FROM deck_cards WHERE deck_id = ? ORDER BY idx', row.id))
      .map(cardRowToApi);

    res.json({
      deck: deckRowToApi(row, {
        sessionTitle: row.session_title ?? null,
        category: row.session_category ?? null,
        knownCount: cards.filter((c) => c.status === 'known').length,
        reviewCount: cards.filter((c) => c.status === 'review').length,
        dueCount: cards.filter((c) => isReadyToStudy(c.dueAt, now)).length,
        sourceIds: parseStringList(row.source_ids_json),
      }),
      cards,
    });
  });

  router.patch('/:deckId/cards/:idx', async (req, res) => {
    // Ownership first: another user's deck id = does not exist.
    const deck = await db.get('SELECT * FROM decks WHERE id = ? AND user_id = ?', req.params.deckId, req.userId);
    if (!deck) throw new ApiError(404, 'DECK_NOT_FOUND', 'That deck does not exist. Generate a new one.');

    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= deck.card_count) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Card index does not exist in this deck.');
    }

    // `status` is the contract field (new|known|review). `grade` is the
    // additive Anki-style button (again|hard|good|easy) that drives the SRS
    // interval; when only status is sent it maps known→good, review→again.
    const { status, grade } = req.body ?? {};
    if (status === undefined && grade === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide status (new|known|review), optionally with grade (again|hard|good|easy).');
    }
    if (status !== undefined && !CARD_STATUSES.has(status)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status must be new, known, or review.');
    }
    if (grade !== undefined && !REVIEW_GRADES.includes(grade)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `grade must be one of: ${REVIEW_GRADES.join(', ')}.`);
    }

    const card = await db.get('SELECT * FROM deck_cards WHERE deck_id = ? AND idx = ?', deck.id, idx);
    if (!card) throw new ApiError(404, 'DECK_NOT_FOUND', `Card ${idx} does not exist in the deck.`);

    let effectiveGrade;
    if (grade !== undefined) {
      if (status === 'new') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'status "new" resets a card; do not send a grade with it.');
      }
      effectiveGrade = grade;
    } else {
      effectiveGrade = status === 'new' ? null : gradeForStatus(status);
    }

    // Deterministic schedule: same (card state, grade, now) → same due date.
    const now = nowIso();
    const schedule = scheduleCardReview({
      reviewCount: card.review_count,
      ease: card.ease,
      reviewedAt: card.reviewed_at,
      dueAt: card.due_at,
    }, effectiveGrade, now);

    // Both writes are one transaction: a card mark never lands without the
    // deck's lastReviewedAt stamp (and vice versa). db.batch is the engine-
    // parity transaction primitive — atomic on BOTH engines.
    await db.batch([
      {
        sql: 'UPDATE deck_cards SET status = ?, reviewed_at = ?, review_count = ?, ease = ?, due_at = ? WHERE deck_id = ? AND idx = ?',
        args: [schedule.status, now, schedule.reviewCount, schedule.ease, schedule.dueAt, deck.id, idx],
      },
      { sql: 'UPDATE decks SET last_reviewed_at = ? WHERE id = ?', args: [now, deck.id] },
    ], 'write');

    // Observed learning event: marking a card known/reviewed is weak evidence;
    // re-marking it new is not evidence at all, so nothing is recorded.
    if (schedule.status !== 'new') {
      await recordEvent(db, {
        kind: schedule.status === 'known' ? 'card_known' : 'card_review',
        topic: deck.topic.toLowerCase().trim(),
        detail: { deckId: deck.id, idx, status: schedule.status },
        userId: req.userId,
      });

      // A09 study-history row (the `card_reviewed` type). Emitted HERE at the
      // route — explicitly, next to the card_* evidence — so the activity feed
      // and the learner model see it and the emit site stays visible/testable.
      await recordStudyEvent(db, {
        type: 'card_reviewed',
        topic: deck.topic,
        detail: `${schedule.status === 'known' ? 'Recalled' : 'Needs review'} a card${
          schedule.dueAt ? ` — next due ${schedule.dueAt.slice(0, 10)}` : ''}`,
        sessionId: deck.session_id ?? null,
        userId: req.userId,
      });
    }

    res.json({
      deckId: deck.id,
      idx,
      status: schedule.status,
      lastReviewedAt: now,
      grade: schedule.grade,
      ease: schedule.ease,
      reviewCount: schedule.reviewCount,
      intervalDays: schedule.intervalDays,
      dueAt: schedule.dueAt,
    });
  });

  router.delete('/:deckId', async (req, res) => {
    // Ownership first (404 for someone else's deck).
    const deck = await db.get('SELECT * FROM decks WHERE id = ? AND user_id = ?', req.params.deckId, req.userId);
    if (!deck) throw new ApiError(404, 'DECK_NOT_FOUND', 'That deck does not exist. Generate a new one.');
    await db.run('DELETE FROM decks WHERE id = ? AND user_id = ?', deck.id, req.userId); // cards cascade
    res.status(204).end();
  });

  return router;
}

// POST /api/flashcards/generate — generates AND persists a deck.
// Session scope is enforced server-side via resolveRequestScope (sessionId
// present) or the legacy sourceIds filter. The deck is saved and returned
// with its id. Mounted by app.js under /api/flashcards.
export function flashcardsRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.post('/generate', async (req, res) => {
    const { topic, count, sourceIds, sessionId } = req.body ?? {};
    validateTopic(topic);
    if (count !== undefined && (!Number.isInteger(count) || count < 3 || count > 12)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'count must be a whole number between 3 and 12.');
    }
    validateSourceIds(sourceIds);

    const userId = req.userId;
    const scope = await resolveRequestScope(db, { sessionId, sourceIds: sourceIds ?? [] }, userId);

    const result = await generateFlashcards(
      { topic: topic.trim(), count: count ?? 8, sourceIds: scope.sourceIds, sessionId: scope.session?.id ?? null, userId },
      { ai, vector, db },
    );
    res.status(201).json(result);
  });

  return router;
}
