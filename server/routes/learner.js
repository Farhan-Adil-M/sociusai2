// GET /api/learner/progress — read-only rollup for the dashboard and the
// progress page. Private: every read is filtered by the verified user id set by
// requireAuth (`user_id = req.userId`), so one student's history can never be
// mixed into another's. No AI or vector call happens here.
//
// Two rules this endpoint must not lose:
//
//   1. HONESTY ABOUT EVIDENCE. A topic with no graded answer is reported as
//      "unassessed" — `level: null`, `levelLabel: "unassessed"`,
//      `hasEvidence: false`, `masteryPercent: null` — never as level 1. Level 1
//      means "we measured this learner and they scored below 40%", which is a
//      very different statement from "we have not measured this yet". The same
//      rule lives in services/learner.js; this surface must not flatten it on
//      the way out.
//
//   2. `difficulty` stays on the shipped three-word scale (easy|medium|hard),
//      because that is the value POST /api/quiz/generate actually uses when the
//      client omits it (`learner.chooseDifficulty`). The v2.0 1–4 level is
//      reported alongside it as `level` / `levelLabel`.
//
// Topics with zero evidence can still exist: generating a quiz and never
// submitting it leaves a real topic the learner has engaged with but that has
// produced no answer. Those are listed (after the assessed topics) so the UI can
// offer "take the quiz you started" instead of hiding them.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { chooseDifficulty, levelFor, levelLabel, needsRevision } from '../services/learner.js';
import { revisionAdvice } from '../services/studyAdvice.js';
import { nowIso } from '../store/sqlite.js';

const ACTIVITY_MAX = 10; // contract: recentActivity is newest first, max 10

// ---------- query validation ----------

// `limit` (optional, 1–10) shortens the activity feed. Anything else — a
// repeated param, a word, a negative number — is a client error, and the error
// carries the stable VALIDATION_ERROR contract code.
function parseActivityLimit(value) {
  if (value === undefined) return ACTIVITY_MAX;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new ApiError(400, 'VALIDATION_ERROR', `limit must be a whole number between 1 and ${ACTIVITY_MAX}.`);
  }
  const limit = Number(value.trim());
  if (limit < 1 || limit > ACTIVITY_MAX) {
    throw new ApiError(400, 'VALIDATION_ERROR', `limit must be a whole number between 1 and ${ACTIVITY_MAX}.`);
  }
  return limit;
}

// ---------- response shaping (pure) ----------

// The level is only meaningful when at least one answer was graded. We guard
// here instead of passing `null` straight to levelFor(), because levelFor()
// coerces its argument with Number() and Number(null) is 0 — an unguarded null
// would come back as level 1 and reintroduce exactly the confusion this
// endpoint exists to avoid.
function levelOf(mastery) {
  return mastery === null ? null : levelFor(mastery);
}

/** One `topics[]` entry built from a `learner_topics` row (evidence exists). */
function topicFromStats(row) {
  const total = Number(row.total) || 0;
  const correct = Number(row.correct) || 0;
  const mastery = total > 0 ? correct / total : null;
  const level = levelOf(mastery);
  return {
    topic: row.topic,
    masteryPercent: mastery === null ? null : Math.round(mastery * 100),
    level,
    levelLabel: levelLabel(level),
    hasEvidence: level !== null,
    // What POST /api/quiz/generate will use when the client omits `difficulty`.
    difficulty: chooseDifficulty(total > 0 ? { correct, total } : null),
    correct,
    total,
    needsRevision: total > 0 ? needsRevision({ correct, total }) : false,
    lastPracticedAt: row.last_practiced_at ?? null,
  };
}

/** One `topics[]` entry for a topic with NO graded answer — explicitly unknown. */
function topicWithoutEvidence(topic) {
  return {
    topic,
    masteryPercent: null,
    level: null,
    levelLabel: levelLabel(null), // "unassessed"
    hasEvidence: false,
    difficulty: chooseDifficulty(null), // what quiz/generate uses for a new topic
    correct: 0,
    total: 0,
    needsRevision: false,
    lastPracticedAt: null,
  };
}

// ---------- the router ----------

export function learnerRouter({ db, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.get('/progress', async (req, res) => {
    const userId = req.userId; // the verified id — never a client-supplied one
    const activityLimit = parseActivityLimit(req.query.limit);

    const topicRows = await db.all(
      'SELECT * FROM learner_topics WHERE user_id = ? ORDER BY last_practiced_at DESC',
      userId,
    );

    // Quizzes the learner generated but never submitted: real, zero-evidence
    // topics. Grouped per raw topic string here and normalised (trim +
    // lowercase) below, which is the same key piece learner_topics uses.
    const pendingQuizTopics = await db.all(
      `SELECT topic, MAX(created_at) AS created_at FROM quizzes
       WHERE user_id = ? AND answered_at IS NULL
       GROUP BY topic ORDER BY MAX(created_at) DESC`,
      userId,
    );

    const topics = topicRows.map(topicFromStats);
    const seen = new Set(topics.map((entry) => entry.topic));
    for (const row of pendingQuizTopics) {
      const key = typeof row.topic === 'string' ? row.topic.trim().toLowerCase() : '';
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      topics.push(topicWithoutEvidence(key));
    }

    const attempts = await db.all('SELECT correct, total FROM quiz_attempts WHERE user_id = ?', userId);
    const questionsAnswered = attempts.reduce((sum, a) => sum + (Number(a.total) || 0), 0);
    const correctAnswers = attempts.reduce((sum, a) => sum + (Number(a.correct) || 0), 0);

    const recentActivity = (
      await db.all(
        'SELECT type, topic, detail, at FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?',
        userId, activityLimit,
      )
    ).map((row) => ({ type: row.type, topic: row.topic, detail: row.detail, at: row.at }));

    // Flashcards: how many decks the learner owns, and how many cards are still
    // waiting for a review. `known` cards are done; everything else is due
    // (a NULL due_at means "never scheduled" — spaced repetition does not exist
    // yet, so a card is due exactly until it is marked known).
    const deckCount = Number((await db.get('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?', userId)).n);
    const dueCardCount = Number((await db.get(
      `SELECT COUNT(*) AS n FROM deck_cards dc
       JOIN decks d ON d.id = dc.deck_id
       WHERE d.user_id = ? AND dc.status <> 'known' AND (dc.due_at IS NULL OR dc.due_at <= ?)`,
      userId, nowIso(),
    )).n);

    const sourceCount = Number((await db.get('SELECT COUNT(*) AS n FROM sources WHERE user_id = ?', userId)).n);

    // The next step is the study-advice service's deterministic recommendation
    // (same numbers the "what should I revise next" tutor intent reports); it is
    // imported, never re-implemented here.
    const advice = await revisionAdvice(db, userId);

    res.json({
      topics,
      overall: {
        quizzesTaken: attempts.length,
        questionsAnswered,
        accuracyPercent: questionsAnswered > 0 ? Math.round((correctAnswers / questionsAnswered) * 100) : 0,
      },
      suggestedNext: advice?.suggestedNext ?? null,
      recentActivity,
      decks: { count: deckCount, dueCards: dueCardCount },
      sources: { count: sourceCount },
    });
  });

  return router;
}
