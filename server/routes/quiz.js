// Quiz routes: generate (no answer key in the response) and answer (grade,
// reveal, update learner model).

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { chooseDifficulty, applyAttempt } from '../services/learner.js';
import { generateQuiz, gradeAnswers } from '../services/quizService.js';
import { resolveRequestScope, validateSourceIds, validateTopic } from '../services/retrieval.js';
import { recordEvent, maybeRecordRecovery } from '../services/events.js';
import { logActivity, nowIso } from '../store/sqlite.js';

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export function quizRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.post('/generate', async (req, res) => {
    const { topic, questionCount, difficulty, sourceIds, sessionId } = req.body ?? {};
    validateTopic(topic);
    if (questionCount !== undefined && (!Number.isInteger(questionCount) || questionCount < 3 || questionCount > 10)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'questionCount must be a whole number between 3 and 10.');
    }
    if (difficulty !== undefined && !DIFFICULTIES.has(difficulty)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'difficulty must be easy, medium, or hard.');
    }
    validateSourceIds(sourceIds);

    const userId = req.userId;
    const scope = await resolveRequestScope(db, { sessionId, sourceIds: sourceIds ?? [] }, userId);

    // No difficulty given → the learner model chooses for this topic.
    const stats = await db.get('SELECT * FROM learner_topics WHERE topic = ? AND user_id = ?', topic.trim().toLowerCase(), userId);
    const chosenDifficulty = difficulty ?? chooseDifficulty(stats);

    const quiz = await generateQuiz(
      { topic: topic.trim(), questionCount: questionCount ?? 5, difficulty: chosenDifficulty, sourceIds: scope.sourceIds, userId },
      { db, ai, vector },
    );
    if (scope.session) {
      await db.run('UPDATE quizzes SET session_id = ? WHERE id = ? AND user_id = ?', scope.session.id, quiz.id, userId);
    }
    res.status(201).json({
      quiz,
      ...(quiz.weakEvidence ? { weakEvidence: true } : {}),
      sessionId: scope.session?.id ?? null,
    });
  });

  router.post('/:quizId/answer', async (req, res) => {
    const { quizId } = req.params;
    // Ownership: someone else's quiz id here reads as "does not exist".
    const quiz = await db.get('SELECT * FROM quizzes WHERE id = ? AND user_id = ?', quizId, req.userId);
    if (!quiz) throw new ApiError(404, 'QUIZ_NOT_FOUND', 'That quiz does not exist. Generate a new one.');
    const userId = req.userId;

    const existingAttempt = await db.get('SELECT * FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?', quizId, userId);
    if (existingAttempt) {
      // Idempotent retry: return the EXACT result the first submission produced
      // (stored verbatim), never a recomputed shape or a second mastery update.
      let stored = null;
      try { stored = existingAttempt.result_json ? JSON.parse(existingAttempt.result_json) : null; } catch { stored = null; }
      const result = stored ?? await buildResult(db, quiz, JSON.parse(existingAttempt.answers_json), userId);
      return res.status(409).json({ error: { code: 'QUIZ_ALREADY_ANSWERED', message: 'This quiz was already submitted.' }, result });
    }

    const questions = await db.all('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY idx', quizId);
    const { correct, total, perQuestion } = gradeAnswers(questions, req.body?.answers ?? []);
    const percent = Math.round((correct / total) * 100);

    const topicKey = quiz.topic.toLowerCase().trim();
    const topicStats = await db.get('SELECT * FROM learner_topics WHERE topic = ? AND user_id = ?', topicKey, userId);
    const update = applyAttempt(topicKey, topicStats, { correct, total });

    const now = nowIso();
    // Composite PK on BOTH engines is (user_id, topic) — the conflict target
    // and the insert both carry the verified user id explicitly.
    await db.run(`
      INSERT INTO learner_topics (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, topic) DO UPDATE SET
        correct = excluded.correct, total = excluded.total,
        difficulty = excluded.difficulty, updated_at = excluded.updated_at,
        last_practiced_at = excluded.last_practiced_at
    `, userId, update.topic, update.correct, update.total, update.difficulty, now, now);

    // Observed learning events (server-side only, never touch mastery).
    // Per-question evidence, then the quiz-level result.
    const masteryAfter = Number(update.mastery.toFixed(4));
    for (const item of perQuestion) {
      await recordEvent(db, {
        kind: item.correct ? 'quiz_item_correct' : 'quiz_item_incorrect',
        topic: topicKey,
        detail: { index: item.index, correct: item.correct },
        userId,
      });
    }
    await recordEvent(db, {
      kind: 'quiz_result',
      topic: topicKey,
      detail: { quizId: quiz.id, correct, total, masteryBefore: update.before, masteryAfter, percent },
      userId,
    });
    // Recovery check (M5): mastery improved while an approach change is still
    // open → credit that approach. 'before' null means the very first attempt,
    // so there is nothing to recover from.
    if (update.before !== null) {
      await maybeRecordRecovery(db, { topic: topicKey, masteryBefore: update.before, masteryAfter, userId });
    }

    const result = {
      score: { correct, total, percent },
      questions: perQuestion,
      masteryUpdate: {
        topic: update.topic,
        before: update.before,
        after: masteryAfter,
        ...(update.delta !== null ? { delta: update.delta } : {}),
      },
      recommendedDifficulty: update.difficulty,
    };

    // Attempt record + answered stamp belong together: one atomic write.
    await db.batch([
      {
        sql: 'INSERT INTO quiz_attempts (quiz_id, user_id, answers_json, correct, total, created_at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [quizId, userId, JSON.stringify(req.body.answers), correct, total, now, JSON.stringify(result)],
      },
      { sql: 'UPDATE quizzes SET answered_at = ? WHERE id = ? AND user_id = ?', args: [now, quizId, userId] },
    ], 'write');
    await logActivity(db, 'quiz', quiz.topic, `${correct}/${total} correct (${percent}%)`, quiz.session_id, userId);

    res.json({ result });
  });

  return router;
}

// Rebuild a result payload from stored data (used for the 409 replay).
// Caller has already verified the quiz belongs to req.userId.
async function buildResult(db, quiz, answers, userId = 'default') {
  const questions = await db.all('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY idx', quiz.id);
  const { correct, total, perQuestion } = gradeAnswers(questions, answers);
  const stats = await db.get('SELECT * FROM learner_topics WHERE topic = ? AND user_id = ?', quiz.topic.toLowerCase(), userId);
  return {
    score: { correct, total, percent: Math.round((correct / total) * 100) },
    questions: perQuestion,
    masteryUpdate: stats ? {
      topic: stats.topic,
      correct: stats.correct,
      total: stats.total,
      after: Number((stats.correct / stats.total).toFixed(4)),
    } : null,
    recommendedDifficulty: stats?.difficulty ?? 'medium',
  };
}
