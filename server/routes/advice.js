// server/routes/advice.js — GET /api/advice, "what should I revise next"
// (docs/API_CONTRACT.md v2.0, `GET /api/advice`).
//
// Responsibility: turn THIS student's stored evidence into one concrete
// "revise this next — and here is why" recommendation, over HTTP. Nothing is
// invented and no model is asked: the recommendation is a pure function of the
// rows in the database. What to revise next is decided by A14's deterministic
// engine (services/studyAdvice.js#revisionAdvice); this route only shapes the
// answer onto the wire and explains it with a real, checkable reason.
//
// Inputs:   db, auth (from the DI seam createApp({ db, ai, vector, auth })).
//           auth + db via requireAuth; no ai/vector call happens here.
// Outputs:  { advice: { topic, hasEvidence, action, reason, priority, level,
//           levelLabel, evidence: { correct, total, masteryPercent,
//           lastPracticedAt }, sourceIds, alternatives: [{ topic,
//           masteryPercent }] } } — exactly the shape the planner page (A29,
//           GET /api/advice) consumes and the contract documents.
// Test:     deterministic (same rows → same advice); 401 anonymous; 400 on a
//           bad `topic`; per-user scoping (every read filters user_id = req.userId).
//
// Two invariants this route must never break, both from docs/HANDOFF.md:
//
//   1. HONESTY ABOUT EVIDENCE. A topic with no graded answer is "unassessed":
//      hasEvidence:false, evidence:null, level:null, levelLabel:'unassessed',
//      action:'start' — it is recommended to be ASSESSED, never described as
//      weak or collapsed to level 1. We therefore never pass a null mastery to
//      levelFor() (Number(null) === 0 → level 1, A20's reported edge); the
//      local levelOf() guard mirrors the one routes/learner.js uses.
//
//   2. DETERMINISM. Same evidence → same advice, three identical runs. There
//      is no clock read and no randomness in the response for graded evidence;
//      the only time-dependent step (recency) is a documented, half-life-gated
//      note derived from the stored lastPracticedAt.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { revisionAdvice } from '../services/studyAdvice.js';
import { levelFor, levelLabel, MASTERY_MODEL } from '../services/learner.js';

// The same threshold vocabulary services/planner.js uses, so the planner page
// renders the plan reasons and the advice reason in one voice: 0.6 is the
// revision line (learner.needsRevision), 0.8 is the advanced "on target" bar.
const REVISION_LINE = 0.6;
const TARGET_MASTERY = 0.8;
const MAX_ALTERNATIVES = 5;
const MIN_TOPIC = 2; // contract: topic is 2–80 chars
const MAX_TOPIC = 80;
const TOPIC_MESSAGE = 'topic must be between 2 and 80 characters.';
const DAY_MS = 86400000;

// ---------- small pure helpers ----------

/** The same topic key learner_topics / quizzes store: trimmed and lower-cased. */
function normalizeTopic(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** A stored JSON array column, or [] when it is missing/malformed. */
function parseJsonArray(json) {
  try {
    const value = JSON.parse(json ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Level only when mastery was actually measured. Guard here rather than pass
// null straight to levelFor(): Number(null) is 0, which is finite and would come
// back as level 1 — exactly the confusion the honest "unassessed" rule exists to
// avoid (see the file header and A20's HANDOFF entry).
function levelOf(mastery) {
  return mastery === null ? null : levelFor(mastery);
}

/** The UTC date (YYYY-MM-DD) stored in an ISO timestamp, for a readable reason. */
function dateOnly(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

/**
 * True when a graded topic was last practised longer ago than the learner
 * model's half-life (MASTERY_MODEL.halfLifeDays). Stale evidence counts less,
 * so a graded-but-neglected topic should rise one priority step.
 */
function isStale(lastPracticedAt) {
  if (!lastPracticedAt) return false;
  const at = Date.parse(lastPracticedAt);
  if (!Number.isFinite(at)) return false;
  return (Date.now() - at) / DAY_MS > MASTERY_MODEL.halfLifeDays;
}

const PRIORITY_STEP = { low: 'medium', medium: 'high', high: 'high' };
function bumpPriority(priority) {
  return PRIORITY_STEP[priority] ?? priority;
}

/**
 * Weakest-mastery-first order for the alternatives list; ties broken by
 * least-recently practised, then by topic name in code-unit order. Pure string
 * comparison (not localeCompare) so two machines build the same list.
 */
function byWeakness(a, b) {
  if (a.mastery !== b.mastery) return a.mastery - b.mastery;
  const at = Date.parse(a.lastPracticedAt ?? '') || 0;
  const bt = Date.parse(b.lastPracticedAt ?? '') || 0;
  if (at !== bt) return at - bt;
  if (a.topic === b.topic) return 0;
  return a.topic < b.topic ? -1 : 1;
}

// ---------- query parsing ----------

/**
 * `?topic=` — optional. Omitted (undefined) → the overall recommendation.
 * A present-but-invalid value (empty after trim, out of bounds, or repeated as
 * an array) is a client error carrying the stable VALIDATION_ERROR code, the
 * same rule the learner/planner routes apply to their query params.
 */
function parseTopic(value) {
  if (value === undefined) return { mode: 'overall' };
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', TOPIC_MESSAGE);
  const trimmed = value.trim();
  if (trimmed.length < MIN_TOPIC || trimmed.length > MAX_TOPIC) {
    throw new ApiError(400, 'VALIDATION_ERROR', TOPIC_MESSAGE);
  }
  return { mode: 'topic', topic: normalizeTopic(trimmed) };
}

// ---------- source gathering (stored evidence only, no vector/AI call) ------

/**
 * The user's OWN source ids that cover one topic: the sources cited by their
 * quiz questions on it, plus the sources their deck for it was generated from.
 * Every id is verified against `sources` (`user_id = ?`) before it is reported,
 * so a cross-account id can never leak through. Same provenance as the planner.
 */
async function sourceIdsForTopic(db, userId, topicKey) {
  if (!topicKey) return [];
  const found = new Set();

  const citationRows = await db.all(
    `SELECT qq.citations_json AS citations_json
     FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.id
     WHERE q.user_id = ? AND lower(trim(q.topic)) = ? AND qq.citations_json <> '[]'`,
    userId, topicKey,
  );
  for (const row of citationRows) {
    for (const citation of parseJsonArray(row.citations_json)) {
      const id = citation && typeof citation === 'object' ? (citation.sourceId ?? citation.source_id) : null;
      if (typeof id === 'string' && id !== '') found.add(id);
    }
  }

  const deckRows = await db.all(
    'SELECT source_ids_json FROM decks WHERE user_id = ? AND lower(trim(topic)) = ?',
    userId, topicKey,
  );
  for (const row of deckRows) {
    for (const id of parseJsonArray(row.source_ids_json)) {
      if (typeof id === 'string' && id !== '') found.add(id);
    }
  }

  if (found.size === 0) return [];
  const wanted = [...found];
  const placeholders = wanted.map(() => '?').join(', ');
  const own = await db.all(
    `SELECT id FROM sources WHERE user_id = ? AND id IN (${placeholders})`,
    userId, ...wanted,
  );
  return own.map((row) => row.id).sort();
}

// ---------- response shaping ----------

/** Shortlist of the student's OTHER assessed topics, weakest first. */
function buildAlternatives(byTopic, excludeKey) {
  const list = [];
  for (const [key, row] of byTopic) {
    if (key === excludeKey) continue;
    const total = Number(row.total) || 0;
    const correct = Number(row.correct) || 0;
    if (total <= 0) continue;
    list.push({
      topic: key,
      mastery: correct / total,
      masteryPercent: Math.round((correct / total) * 100),
      lastPracticedAt: row.last_practiced_at ?? null,
    });
  }
  return list
    .sort(byWeakness)
    .slice(0, MAX_ALTERNATIVES)
    .map((item) => ({ topic: item.topic, masteryPercent: item.masteryPercent }));
}

/** Advice for a topic the learner has actually been graded on (total > 0). */
function adviceFromGraded(topicKey, row, { sourceIds, alternatives }) {
  const correct = Number(row.correct) || 0;
  const total = Number(row.total) || 0;
  const mastery = total > 0 ? correct / total : null;
  const pct = mastery === null ? null : Math.round(mastery * 100);
  const level = levelOf(mastery);
  const questions = `${total} question${total === 1 ? '' : 's'}`;
  const lastPracticedAt = row.last_practiced_at ?? null;

  let action;
  let reason;
  let priority;
  if (mastery === null) {
    action = 'start';
    reason = 'No graded attempts on this topic yet — take a quiz to assess it.';
    priority = 'medium';
  } else if (mastery < REVISION_LINE) {
    action = 'revise';
    reason = `Mastery ${pct}% over ${questions} — below the 0.6 revision line.`;
    priority = 'high';
  } else if (mastery < TARGET_MASTERY) {
    action = 'practise';
    reason = `Mastery ${pct}% over ${questions} — below the 0.8 target.`;
    priority = 'medium';
  } else {
    action = 'practise';
    reason = `Mastery ${pct}% over ${questions} — on target, so keep it strong with maintenance practice.`;
    priority = 'low';
  }

  // Recency grounding: a graded topic not touched for longer than the model's
  // half-life has faded evidence — raise urgency one step and say when it was
  // practised (the stored date, so the sentence is stable across runs).
  if (isStale(lastPracticedAt)) {
    priority = bumpPriority(priority);
    reason += ` You last practised it on ${dateOnly(lastPracticedAt)}, so it has faded — revisit soon.`;
  }

  return {
    topic: topicKey,
    hasEvidence: true,
    action,
    reason,
    priority,
    level,
    levelLabel: levelLabel(level),
    evidence: { correct, total, masteryPercent: pct, lastPracticedAt },
    sourceIds,
    alternatives,
  };
}

/**
 * Advice for a topic with no graded answer. Honest "assess it" guidance — the
 * instruction is to take a quiz to measure it, never that the learner is weak
 * or that it sits at level 1. level stays null / 'unassessed', evidence null.
 */
function unassessedAdvice(topicKey, { sourceIds = [], alternatives = [] }) {
  return {
    topic: topicKey,
    hasEvidence: false,
    action: 'start',
    reason: 'No graded attempts on this topic yet — take a quiz to assess it.',
    priority: 'medium',
    level: null,
    levelLabel: levelLabel(null), // 'unassessed'
    evidence: null,
    sourceIds,
    alternatives,
  };
}

// ---------- the router ----------

export function adviceRouter({ db, auth }) {
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

    const query = parseTopic(req.query.topic);

    // Every graded topic for this user, read once: the main topic's row and the
    // alternatives list. Filtered by user_id so one student's history can never
    // shape another's advice.
    const rows = await db.all(
      'SELECT topic, correct, total, last_practiced_at FROM learner_topics '
      + 'WHERE user_id = ? AND total > 0 ORDER BY last_practiced_at DESC',
      userId,
    );
    const byTopic = new Map(rows.map((row) => [normalizeTopic(row.topic), row]));

    if (query.mode === 'topic') {
      const alternatives = buildAlternatives(byTopic, query.topic);
      const sourceIds = await sourceIdsForTopic(db, userId, query.topic);
      const row = byTopic.get(query.topic);
      const advice = row
        ? adviceFromGraded(query.topic, row, { sourceIds, alternatives })
        : unassessedAdvice(query.topic, { sourceIds, alternatives });
      return res.json({ advice });
    }

    // Overall recommendation: A14's deterministic engine names the topic. It
    // returns { suggestedNext: { topic, difficulty } } or null when there is no
    // graded history at all — we never re-derive the pick here.
    const planner = await revisionAdvice(db, userId);
    if (!planner || !planner.suggestedNext || !planner.suggestedNext.topic) {
      return res.json({
        advice: {
          topic: null,
          hasEvidence: false,
          action: 'start',
          reason: 'No graded quizzes yet — take a diagnostic quiz on any topic and your advice will build from real results.',
          priority: 'medium',
          level: null,
          levelLabel: levelLabel(null), // 'unassessed'
          evidence: null,
          sourceIds: [],
          alternatives: [],
        },
      });
    }

    const topicKey = normalizeTopic(planner.suggestedNext.topic);
    const alternatives = buildAlternatives(byTopic, topicKey);
    const sourceIds = await sourceIdsForTopic(db, userId, topicKey);
    const row = byTopic.get(topicKey);
    const advice = row
      ? adviceFromGraded(topicKey, row, { sourceIds, alternatives })
      : unassessedAdvice(topicKey, { sourceIds, alternatives });
    return res.json({ advice });
  });

  return router;
}
