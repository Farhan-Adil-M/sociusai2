// Adaptive assessment routes — Track D#3 (owned by A31, docs/OWNERSHIP.md).
//
//   POST /api/adaptive/generate  a level-tagged quiz from the learner's material
//   POST /api/adaptive/answer    deterministic grading + the level transition
//   GET  /api/adaptive/progress  per-topic mastery rolled up to a level
//
// All three are private. requireAuth derives `req.userId` ONLY from a verified
// Bearer token; every read and write below filters `user_id = req.userId`. A
// user id supplied in a body, query string, or header is never read, so user
// B's quiz id is indistinguishable from a missing one (404) and user B's topics
// never appear in user A's roll-up.
//
// No level, difficulty, or score is decided here: the maths lives in
// services/adaptive.js on top of A18's learner.js, grading is grading.js, and
// question text comes from A17's quizService. In prototype mode (no Supabase
// envs) every request is the single fixed dev user, so the 401/two-user proofs
// in docs/HANDOFF.md are exercised with a stubbed auth, exactly like
// tests/two-users.test.js does.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { LEVELS } from '../services/learner.js';
import { generateQuiz } from '../services/quizService.js';
import { resolveRequestScope, validateSourceIds, validateTopic } from '../services/retrieval.js';
import {
  adaptiveProgress,
  recordAdaptiveAttempt,
  replayAdaptiveResult,
  resolveLevel,
} from '../services/adaptive.js';
import { recordStudyEvent } from '../services/events.js';

// A client may send an explicit `null` for any optional field to mean "not
// provided"; normalising it here keeps every check below a single shape.
const orNull = (value) => (value === null ? undefined : value);

export function adaptiveRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.post('/generate', async (req, res) => {
    const body = req.body ?? {};
    const topic = body.topic;
    const level = orNull(body.level);
    const questionCount = orNull(body.questionCount);
    const sourceIds = orNull(body.sourceIds);
    const sessionId = orNull(body.sessionId);

    validateTopic(topic);
    // LEVELS is the frozen 1–4 table, so the accepted range is read from it
    // rather than restated.
    if (level !== undefined && (!Number.isInteger(level) || !Object.hasOwn(LEVELS, level))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'level must be a whole number between 1 and 4.');
    }
    if (questionCount !== undefined && (!Number.isInteger(questionCount) || questionCount < 3 || questionCount > 10)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'questionCount must be a whole number between 3 and 10.');
    }
    validateSourceIds(sourceIds);
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sessionId must be a study session id string.');
    }

    const userId = req.userId;
    // Session scope and source ownership are enforced server-side; a session
    // the caller does not own reads as SESSION_NOT_FOUND.
    const scope = await resolveRequestScope(db, { sessionId, sourceIds: sourceIds ?? [] }, userId);
    const topicKey = topic.trim().toLowerCase();

    // The level the learner model chose for this topic — or the pinned one the
    // caller asked for (e.g. continuing a session where sequencing left it).
    const chosen = await resolveLevel(db, { userId, topic: topicKey, level });

    const quiz = await generateQuiz(
      {
        topic: topic.trim(),
        questionCount: questionCount ?? 5,
        difficulty: chosen.difficulty,
        sourceIds: scope.sourceIds,
        userId,
      },
      { db, ai, vector },
    );
    if (scope.session) {
      await db.run('UPDATE quizzes SET session_id = ? WHERE id = ? AND user_id = ?', scope.session.id, quiz.id, userId);
    }
    // Study history (A09's recordStudyEvent): this route also creates quizzes,
    // so it emits the same row the quiz route does — otherwise the feed would
    // silently miss adaptive generations.
    await recordStudyEvent(db, {
      type: 'quiz_generated',
      topic: quiz.topic,
      detail: `Generated ${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'} `
        + `(${chosen.difficulty}, level ${chosen.level ?? 'unassessed'})`,
      sessionId: scope.session?.id ?? null,
      userId,
    });

    res.status(201).json({
      // `mode` marks the adaptive variant; `level` is null for an unassessed
      // topic, which is honest and must not be flattened to 1 by a client.
      quiz: {
        ...quiz,
        mode: 'adaptive',
        level: chosen.level,
        levelLabel: chosen.levelLabel,
        difficulty: chosen.difficulty,
      },
      ...(quiz.weakEvidence ? { weakEvidence: true } : {}),
      sessionId: scope.session?.id ?? null,
    });
  });

  router.post('/answer', async (req, res) => {
    const quizId = (req.body ?? {}).quizId;
    if (typeof quizId !== 'string' || quizId.trim() === '') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'quizId must be the id of the quiz you are submitting.');
    }
    const userId = req.userId;

    // Ownership: another user's quiz id reads as "does not exist".
    const quiz = await db.get('SELECT * FROM quizzes WHERE id = ? AND user_id = ?', quizId.trim(), userId);
    if (!quiz) throw new ApiError(404, 'QUIZ_NOT_FOUND', 'That quiz does not exist. Generate a new one.');

    const existing = await db.get('SELECT * FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?', quizId.trim(), userId);
    if (existing) {
      // Idempotent retry: the EXACT stored result, never a second mastery
      // update. The fallback only exists for a row written without one.
      let stored = null;
      try { stored = existing.result_json ? JSON.parse(existing.result_json) : null; } catch { stored = null; }
      const result = stored ?? await replayAdaptiveResult(db, { quiz, answersJson: existing.answers_json, userId });
      return res.status(409).json({
        error: { code: 'QUIZ_ALREADY_ANSWERED', message: 'This quiz was already submitted.' },
        result,
      });
    }

    const result = await recordAdaptiveAttempt(db, { userId, quiz, answers: (req.body ?? {}).answers });
    res.json({ result });
  });

  router.get('/progress', async (req, res) => {
    res.json(await adaptiveProgress(db, { userId: req.userId }));
  });

  return router;
}
