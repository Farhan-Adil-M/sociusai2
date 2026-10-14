// =============================================================================
// server/routes/planner.js — GET /api/planner, the server-computed study plan
// (docs/API_CONTRACT.md v2.0, `GET /api/planner`).
//
// Responsibility: the HTTP surface over services/planner.js. It validates the
// query, reads the clock exactly once, and shapes the plan onto the wire. All
// the scheduling logic (and every honesty rule) lives in the service; this file
// owns auth, validation and the response envelope, the same split every other
// private route in this server uses.
//
// Inputs:  db, auth (from the DI seam createApp({ db, ai, vector, auth })).
//          `ai` and `vector` are accepted for that seam but deliberately
//          UNUSED: a plan is a scheduling decision over stored evidence, so no
//          model call and no vector search can decide which topic lands on
//          which day.
// Outputs: { plan: { generatedAt, horizonDays, hasEvidence, items[], summary } }
//          — exactly the shape the planner page (A29) consumes:
//          items[i] = { day, date, topic, level, levelLabel, activity, reason,
//          estimatedMinutes, sourceIds }.
//
// Two invariants this route must never break:
//
//   1. PER-USER SCOPING. requireAuth derives req.userId from the verified
//      token and the service filters EVERY read on it, so one student's plan
//      can never be built from another student's rows. An unauthenticated
//      request is answered with the exact 401 UNAUTHENTICATED envelope before
//      any handler runs.
//
//   2. NO INVENTION. The plan contains only topics the learner has real
//      evidence for (graded answers, or flashcards that are due). A topic with
//      no graded answer is reported with level:null / 'unassessed' and a reason
//      that says so — never as level 1, never with a guessed mastery. An empty
//      account gets hasEvidence:false, items:[] and a summary that says what to
//      do next. `estimatedMinutes` comes from the formula documented in
//      services/planner.js, not from a guess.
//
// Determinism: the clock is read ONCE per request and injected into the service
// for both the printed dates and `generatedAt`, so a plan's dates and its
// timestamp always agree. There is no randomness and no model call, so the same
// evidence produces the same plan every run.
// =============================================================================

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { computePlan, loadPlanEvidence } from '../services/planner.js';

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 30;
const DAYS_MESSAGE = `days must be a whole number between ${MIN_DAYS} and ${MAX_DAYS}.`;

/**
 * `?days=N` — optional, default 7, otherwise an integer between 1 and 30.
 * A repeated param (Express gives an array), an empty value, a word, a
 * fraction or a negative number are all client errors carrying the stable
 * VALIDATION_ERROR contract code, with a message that says what to send.
 */
function parseDays(value) {
  if (value === undefined) return DEFAULT_DAYS;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new ApiError(400, 'VALIDATION_ERROR', DAYS_MESSAGE);
  }
  const days = Number(value.trim());
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new ApiError(400, 'VALIDATION_ERROR', DAYS_MESSAGE);
  }
  return days;
}

export function plannerRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  // Mounted first on every private router: sets req.userId (and bootstraps the
  // profile row) or answers the exact 401 UNAUTHENTICATED envelope.
  router.use(requireAuth({ auth, db }));

  router.get('/', async (req, res) => {
    // Safety net for any mounting path that skipped the middleware above: the
    // verified id is the ONLY user selector, so a missing one must never fall
    // through to a query.
    const userId = req.userId;
    if (!userId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to use this endpoint.');

    const days = parseDays(req.query.days);

    // One clock read for the whole response: the printed dates, the due-card
    // cut-off and `generatedAt` all come from this instant, so they can never
    // disagree with each other.
    const now = new Date();

    const { evidence, suggestedNext } = await loadPlanEvidence(db, { userId, now });
    const plan = computePlan(evidence, days, { now, suggestedNext });

    res.json({
      plan: {
        generatedAt: now.toISOString(),
        horizonDays: plan.horizonDays,
        hasEvidence: plan.hasEvidence,
        items: plan.items,
        summary: plan.summary,
      },
    });
  });

  return router;
}
