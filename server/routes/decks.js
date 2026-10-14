// Persistent flashcard decks: browse, open, practise with saved review status.
// Generation still lives in flashcardService; this route saves and serves decks.
// The POST /generate endpoint (flashcard deck creation) also lives here —
// (The former routes/flashcards.js file was merged into this module; the app.js
// import switch.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { recordEvent } from '../services/events.js';
import { CATEGORIES } from '../constants.js';
import { generateFlashcards } from '../services/flashcardService.js';
import { resolveRequestScope, validateSourceIds, validateTopic } from '../services/retrieval.js';
import { nowIso } from '../store/sqlite.js';

const CARD_STATUSES = new Set(['new', 'known', 'review']);

/** Stored string list (defensive: corrupt/null → empty). */
function parseStringList(json) {
  try { return JSON.parse(json) || []; } catch { return []; }
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
    const params = [req.userId];
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
      (SELECT COUNT(*) FROM deck_cards WHERE deck_id = d.id AND status = 'review') AS review_count
    `;
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
      })),
      unsortedDeckCount,
    });
  });

  router.get('/:deckId', async (req, res) => {
    const row = await db.get(`
      SELECT d.*, ss.title AS session_title, ss.category AS session_category
      FROM decks d LEFT JOIN study_sessions ss ON ss.id = d.session_id AND ss.user_id = d.user_id
      WHERE d.id = ? AND d.user_id = ?`, req.params.deckId, req.userId);
    if (!row) throw new ApiError(404, 'DECK_NOT_FOUND', 'That deck does not exist. Generate a new one.');

    const cards = (await db.all('SELECT * FROM deck_cards WHERE deck_id = ? ORDER BY idx', row.id))
      .map((card) => ({
        idx: card.idx,
        front: card.front,
        back: card.back,
        citations: JSON.parse(card.citations_json),
        status: card.status,
        reviewedAt: card.reviewed_at,
      }));

    res.json({
      deck: deckRowToApi(row, {
        sessionTitle: row.session_title ?? null,
        category: row.session_category ?? null,
        knownCount: cards.filter((c) => c.status === 'known').length,
        reviewCount: cards.filter((c) => c.status === 'review').length,
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
    const { status } = req.body ?? {};
    if (!CARD_STATUSES.has(status)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status must be new, known, or review.');
    }
    if (!(await db.get('SELECT 1 AS ok FROM deck_cards WHERE deck_id = ? AND idx = ?', deck.id, idx))) {
      throw new ApiError(404, 'DECK_NOT_FOUND', `Card ${idx} does not exist in the deck.`);
    }

    // Both writes are one transaction: a card mark never lands without the
    // deck's lastReviewedAt stamp (and vice versa). db.batch is the engine-
    // parity transaction primitive — atomic on BOTH engines.
    const now = nowIso();
    await db.batch([
      { sql: 'UPDATE deck_cards SET status = ?, reviewed_at = ? WHERE deck_id = ? AND idx = ?', args: [status, now, deck.id, idx] },
      { sql: 'UPDATE decks SET last_reviewed_at = ? WHERE id = ?', args: [now, deck.id] },
    ], 'write');

    // Observed learning event: marking a card known/reviewed is weak evidence;
    // re-marking it new is not evidence at all, so nothing is recorded.
    if (status !== 'new') {
      await recordEvent(db, {
        kind: status === 'known' ? 'card_known' : 'card_review',
        topic: deck.topic.toLowerCase().trim(),
        detail: { deckId: deck.id, idx, status },
        userId: req.userId,
      });
    }
    res.json({ deckId: deck.id, idx, status, lastReviewedAt: now });
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
