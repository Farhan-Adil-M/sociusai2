// Session CRUD. Sessions ARE the organisational layer — a stable workspace of
// related sources, quizzes and decks. Unassigned material lives in "Unsorted"
// and is reported every time a session list is requested.

import express from 'express';
import { CATEGORIES } from '../constants.js';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { newId, nowIso, logActivity } from '../store/sqlite.js';
import { sourceRowToApi } from './sources.js';

export async function getSessionOr404(db, id, userId = 'default') {
  // Ownership: another user's session id reads as "does not exist".
  const row = await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${id}" does not exist.`);
  return row;
}

function parseTags(value) {
  try { return JSON.parse(value) || []; } catch { return []; }
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new ApiError(400, 'VALIDATION_ERROR', 'Tags must be an array of short strings.');
  if (tags.length > 8) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 8 tags per session.');
  const clean = tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (clean.some((tag) => tag.length < 1 || tag.length > 24)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Each tag must be 1–24 characters.');
  }
  return clean;
}

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length < 2 || title.trim().length > 80) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Session title must be between 2 and 80 characters.');
  }
  return title.trim();
}

export function sessionToApi(row, extra = {}) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description ?? '',
    tags: parseTags(row.tags_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

// lastActivityAt: session updated_at plus the newest source, deck, quiz or
// logged activity that belongs to the session. Each timestamp is fetched with
// a single-argument MAX() subquery — that form works on both SQLite and
// Postgres (SQLite's scalar multi-argument MAX(a, b, …) does not exist on
// Postgres, which broke this list with a 500). The newest value is picked in
// JS by latestIso() below.
const LIST_COLUMNS = `
  s.*,
  (SELECT COUNT(*) FROM sources  WHERE session_id = s.id) AS source_count,
  (SELECT COUNT(*) FROM decks    WHERE session_id = s.id) AS deck_count,
  (SELECT MAX(created_at)       FROM sources  WHERE session_id = s.id) AS src_last,
  (SELECT MAX(created_at)       FROM decks    WHERE session_id = s.id) AS deck_last,
  (SELECT MAX(last_reviewed_at) FROM decks    WHERE session_id = s.id) AS deck_reviewed_last,
  (SELECT MAX(created_at)       FROM quizzes  WHERE session_id = s.id) AS quiz_last,
  (SELECT MAX(at)               FROM activity WHERE session_id = s.id) AS activity_last
`;

// Newest of several timestamps; NULL/undefined entries are ignored. ISO-8601
// strings from nowIso() sort correctly as plain strings.
export function latestIso(...values) {
  const present = values.filter(Boolean).sort();
  return present.length ? present[present.length - 1] : null;
}

export function sessionsRouter({ db, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.get('/', async (req, res) => {
    const { category, q, includeArchived } = req.query;
    const sort = req.query.sort ?? 'recent';
    if (!['recent', 'alpha', 'active'].includes(sort)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sort must be recent, alpha, or active.');
    }
    if (category && !CATEGORIES.has(category)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category. Use subject, research, self-study, exam-prep, or general.');
    }
    const search = typeof q === 'string' && q.trim() !== '' ? q.trim() : null;

    const filters = ['s.user_id = ?'];
    if (includeArchived !== '1') filters.push("s.status = 'active'");
    if (category) filters.push('s.category = ?');
    if (search) filters.push('(s.title LIKE ? OR s.description LIKE ? OR s.tags_json LIKE ?)');
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const params = [req.userId];
    if (category) params.push(category);
    if (search) {
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    // "active" sorts by lastActivityAt, which is computed in JS — fetch the
    // rows unsorted and sort after mapping (the list is small, no paging).
    const sqlOrder = { recent: 's.updated_at DESC', alpha: 'LOWER(s.title) ASC', active: null }[sort];
    const rows = await db.all(
      `SELECT ${LIST_COLUMNS} FROM study_sessions s ${where}${sqlOrder ? ` ORDER BY ${sqlOrder}` : ''}`,
      ...params,
    );

    const unsortedSourceCount = (await db.get('SELECT COUNT(*) AS n FROM sources WHERE user_id = ? AND session_id IS NULL', req.userId)).n;

    const sessions = rows.map((row) => sessionToApi(row, {
      sourceCount: row.source_count,
      deckCount: row.deck_count,
      lastActivityAt: latestIso(
        row.updated_at, row.src_last, row.deck_last, row.deck_reviewed_last, row.quiz_last, row.activity_last,
      ),
    }));
    if (sort === 'active') {
      sessions.sort((a, b) => String(b.lastActivityAt ?? '').localeCompare(String(a.lastActivityAt ?? '')));
    }

    res.json({ sessions, unsortedSourceCount });
  });

  router.post('/', async (req, res) => {
    const { title, category, description, tags } = req.body ?? {};
    const cleanTitle = validateTitle(title);
    if (category !== undefined && !CATEGORIES.has(category)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category. Use subject, research, self-study, exam-prep, or general.');
    }
    const cleanTags = tags === undefined ? [] : validateTags(tags);
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Description must be at most 500 characters.');
    }

    const id = newId('ses');
    const now = nowIso();
    await db.run('INSERT INTO study_sessions (id, user_id, title, category, description, tags_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, req.userId, cleanTitle, category ?? 'subject', description ?? null, JSON.stringify(cleanTags), 'active', now, now);
// session create gets logged with the session id so "active" sorting has real data
    await logActivity(db, 'session', null, `Created session "${cleanTitle}"`, id, req.userId);
    res.status(201).json({ session: sessionToApi(await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', id, req.userId)) });
  });

  router.get('/:id', async (req, res) => {
    const session = await getSessionOr404(db, req.params.id, req.userId);
    const sources = await db.all('SELECT * FROM sources WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC', session.id, req.userId);
    const decks = (await db.all('SELECT id, topic, card_count, created_at FROM decks WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC', session.id, req.userId))
      .map((row) => ({ id: row.id, topic: row.topic, cardCount: row.card_count, createdAt: row.created_at }));
    res.json({
      session: sessionToApi(session, {
        sourceCount: sources.length,
        deckCount: decks.length,
        lastActivityAt: session.updated_at,
      }),
      sources: sources.map(sourceRowToApi),
      decks,
    });
  });

  router.patch('/:id', async (req, res) => {
    const session = await getSessionOr404(db, req.params.id, req.userId);
    const { title, category, description, tags, status } = req.body ?? {};
    const updates = [];

    if (title !== undefined) updates.push(['title', validateTitle(title)]);
    if (category !== undefined) {
      if (!CATEGORIES.has(category)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category.');
      updates.push(['category', category]);
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > 500) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Description must be at most 500 characters.');
      }
      updates.push(['description', description.trim()]);
    }
    if (tags !== undefined) updates.push(['tags_json', JSON.stringify(validateTags(tags))]);
    if (status !== undefined) {
      if (!['active', 'archived'].includes(status)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'status must be active or archived.');
      }
      updates.push(['status', status]);
    }

    if (updates.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide a title, category, description, tags, or status to update.');
    }
    updates.push(['updated_at', nowIso()]);
    const setClause = updates.map(([column]) => `${column} = ?`).join(', ');
    await db.run(`UPDATE study_sessions SET ${setClause} WHERE id = ? AND user_id = ?`, ...updates.map(([, value]) => value), session.id, req.userId);

    res.json({ session: sessionToApi(await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', session.id, req.userId)) });
  });

  return router;
}
