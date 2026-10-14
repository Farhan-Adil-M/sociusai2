// GET /api/events — the study activity feed (study history).
//
// Private: mounted behind requireAuth, so every row is filtered by the verified
// `req.userId` and one student can never see another's history. Read-only: no AI
// call, no vector call, no writes — this endpoint only reports what the app has
// already recorded in the `activity` table.
//
// The feed is honest by construction:
//   - an id, a type, a timestamp and a detail are echoed from the stored row;
//   - a reference to the underlying record (quiz, source) is resolved from the
//     real table for the SAME user and omitted when there is no single
//     unambiguous match — a removed record is never given a made-up title;
//   - the two rows some actions write (backlog #19) are shown as ONE event that
//     names both, so nothing is duplicated and nothing is hidden;
//   - ordering is `at DESC, id DESC` with a keyset cursor, so paging can never
//     repeat or skip a row;
//   - a topic's level comes from the imported learner model, and a topic with
//     no evidence reads "unassessed" — never level 1.
//
// See docs/API_CONTRACT.md § `GET /api/events` (v2.0, planned Wave 4).

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { loadActivityFeed, parseFeedQuery } from '../services/events.js';

export function eventsRouter({ db, auth }) {
  // The app factory passes the usual context { db, ai, vector, auth }; this
  // route is a pure read of stored rows, so it destructures only what it uses
  // (the house pattern in routes/learner.js).
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.get('/', async (req, res) => {
    const userId = req.userId; // the verified id — never a client-supplied one
    // Bad limit / type / since / cursor is a client error: 400 VALIDATION_ERROR
    // with the contract's stable code, thrown before any query runs.
    const query = parseFeedQuery(req.query ?? {});
    const { events, nextCursor } = await loadActivityFeed(db, { userId, ...query });
    res.json({ events, nextCursor });
  });

  return router;
}
