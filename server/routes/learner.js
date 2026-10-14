// GET /api/learner/progress — read-only rollup for the dashboard.
// Private: every read is filtered by the verified user id set by requireAuth.

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { needsRevision, suggestNext, difficultyFor } from '../services/learner.js';

export function learnerRouter({ db, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.get('/progress', async (req, res) => {
    const topicRows = await db.all('SELECT * FROM learner_topics WHERE user_id = ? ORDER BY last_practiced_at DESC', req.userId);

    const topics = topicRows.map((row) => ({
      topic: row.topic,
      masteryPercent: row.total > 0 ? Math.round((row.correct / row.total) * 100) : 0,
      difficulty: row.total > 0 ? difficultyFor(row.correct / row.total) : row.difficulty,
      correct: row.correct,
      total: row.total,
      needsRevision: needsRevision(row),
      lastPracticedAt: row.last_practiced_at,
    }));

    const attempts = await db.all('SELECT correct, total FROM quiz_attempts WHERE user_id = ?', req.userId);
    const questionsAnswered = attempts.reduce((sum, a) => sum + a.total, 0);
    const correctAnswers = attempts.reduce((sum, a) => sum + a.correct, 0);

    const recentActivity = (await db.all('SELECT type, topic, detail, at FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 10', req.userId))
      .map((row) => ({ type: row.type, topic: row.topic, detail: row.detail, at: row.at }));

    res.json({
      topics,
      overall: {
        quizzesTaken: attempts.length,
        questionsAnswered,
        accuracyPercent: questionsAnswered > 0 ? Math.round((correctAnswers / questionsAnswered) * 100) : 0,
      },
      suggestedNext: suggestNext(topicRows),
      recentActivity,
    });
  });

  return router;
}
