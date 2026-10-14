// POST /api/tutor/ask — source-grounded question answering.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { answerQuestion } from '../services/tutorService.js';
import { APPROACH_ORDER, recordStudyEvent } from '../services/events.js';
import { resolveRequestScope, validateSourceIds } from '../services/retrieval.js';
import { classifyIntent, revisionAdvice, progressAdvice, importantQuestions } from '../services/studyAdvice.js';
import { generateFlashcards } from '../services/flashcardService.js';
import { logActivity } from '../store/sqlite.js';

/**
 * Part 8 (contract v1.5) — auto practice deck during active study.
 * Guards a successful session-scoped answer: the session must have material
 * (≥1 source, already resolved by resolveScope) and no deck yet.
 * Returns true when background generation was actually started.
 *
 * Duplicate prevention is the "session has no deck yet" check below — a
 * per-process guard: two asks more than milliseconds apart cannot
 * double-generate because the first deck row is committed by then. Honest
 * limitation stated in the contract: two parallel asks within milliseconds of
 * each other (or two cold serverless instances) could both pass this check
 * before either deck lands — accepted for the local demo; strict
 * cross-instance idempotency arrives with the hosted database.
 */
async function maybeStartAutoDeck({ db, ai, vector, scope, userId }) {
  const { session, sourceIds } = scope;
  if (!session || sourceIds.length === 0) return false; // unscoped answer or zero-source session: never trigger

  const deckCount = await db.get('SELECT COUNT(*) AS n FROM decks WHERE session_id = ? AND user_id = ?', session.id, userId);
  if (deckCount.n > 0) return false; // the session already has a deck

  const topic = session.title.trim().slice(0, 80);
  // Fire-and-forget, never blocking this answer: the exact saved-deck path as
  // POST /api/flashcards/generate — generateFlashcards with `db` persists the
  // deck row + cards identically (the deck later simply appears in Decks).
  void generateFlashcards({ topic, count: 8, sourceIds, sessionId: session.id, userId }, { ai, vector, db }).catch((err) => {
    // Failure is not silent (contract v1.5): written to the activity feed,
    // and never crashes the already-sent response.
    void logActivity(db, 'deck-failed', topic, `Auto deck generation failed: ${err?.message ?? err}`, session.id, userId).catch(() => {});
  });
  return true;
}

export function tutorRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  // One-off teaching approach for this answer (v1.4): stored styles plus the
  // request-only values 'simpler' and 'different'.
  const REQUESTABLE = new Set([...APPROACH_ORDER, 'simpler', 'different']);

  // Deterministic keyword routing AFTER all validation and scoping (Part 6).
  // The 'important-questions' branch passes the SAME server-enforced sourceIds
  // scope as the normal path. intent 'normal' → no handler and the answering
  // flow below is used, untouched.
  const INTENT_HANDLERS = {
    'revise-next': {
      run: (db, question, scope, { userId }) => revisionAdvice(db, userId), // deterministic, no AI call
      log: (question) => `[revision] asked what to revise: ${question.slice(0, 80)}`,
    },
    progress: {
      run: (db, question, scope, { userId }) => progressAdvice(db, userId), // deterministic roll-up, no AI call
      log: (question) => `[progress] asked how they are doing: ${question.slice(0, 80)}`,
    },
    'important-questions': {
      run: (db, question, scope, { ai, vector, userId }) =>
        importantQuestions(db, { question, sourceIds: scope.sourceIds }, { ai, vector, userId }),
      log: (question) => `[practice] asked for important questions: ${question.slice(0, 80)}`,
    },
  };

  router.post('/ask', async (req, res) => {
    const { question, sourceIds, sessionId, approach } = req.body ?? {};
    if (typeof question !== 'string' || question.trim().length < 3 || question.trim().length > 300) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Question must be between 3 and 300 characters.');
    }
    validateSourceIds(sourceIds);
    if (approach !== undefined && !REQUESTABLE.has(approach)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `approach must be one of: ${[...REQUESTABLE].join(', ')}.`);
    }

    const userId = req.userId;
    const scope = await resolveRequestScope(db, { sessionId, sourceIds: sourceIds ?? [] }, userId);

    // Study-history row (A09's `recordStudyEvent`). This is the canonical
    // `tutor_asked` entry in the activity feed the learner model reads; the
    // `logActivity('question', …)` calls below stay because they are the
    // hand-written tutor log the app already renders (and existing tests pin).
    // Recorded here at the ROUTE, never as a hidden side effect inside the
    // shared tutor service, so the emit site stays visible and testable.
    const activeSessionId = scope.session?.id ?? null;
    const recordAsked = (detail, topic = null) => recordStudyEvent(db, { type: 'tutor_asked', topic, detail, sessionId: activeSessionId, userId });

    // ---- study-planning intents (Part 6) ----
    const asked = question.trim();
    const handler = INTENT_HANDLERS[classifyIntent(asked).intent];
    if (handler) {
      const result = await handler.run(db, asked, scope, { ai, vector, userId });
      await logActivity(db, 'question', null, handler.log(asked), activeSessionId, userId);
      await recordAsked(`Asked: ${asked.slice(0, 80)} — ${result.intent} intent`, result.suggestedNext?.topic ?? null);
      return res.json({ ...result, sessionId: activeSessionId });
    }

    const result = await answerQuestion(
      { question: asked, sourceIds: scope.sourceIds, db, userId, ...(approach !== undefined ? { approach } : {}) },
      { ai, vector },
    );
    await logActivity(db, 'question', null, `Asked: ${asked.slice(0, 80)}`, activeSessionId, userId);
    await recordAsked(
      `Asked: ${asked.slice(0, 80)} — ${result.needsContent ? 'no matching material' : `grounded in ${result.citations.length} passage(s)`}`,
    );

    // ---- Part 8 (contract v1.5): auto practice deck during active study ----
    // Only on a successful grounded answer (needsContent false) inside a
    // session with material and no deck yet. The generation itself runs in the
    // background (see maybeStartAutoDeck); this handler only awaits the cheap
    // pre-guard so the response field is honest about "actually started".
    // Intent paths returned above, so generation can never start from those.
    let extra = {};
    if (!result.needsContent && await maybeStartAutoDeck({ db, ai, vector, scope, userId })) extra = { deckGeneration: 'started' };
    res.json({ ...result, ...extra, sessionId: activeSessionId });
  });

  return router;
}
