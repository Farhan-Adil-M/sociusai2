// Observed learning events (v1.4): a small append-only log of evidence the
// server records about how a learner studies (quiz results, flashcard
// reviews, teaching-approach switches, recoveries). Events never touch
// learner_topics mastery. Everything here is deterministic and pure except
// the functions that take `db`.
//
// There are TWO recorders here, and they must not be confused:
//   - `recordEvent`      → the `learning_events` table. EVIDENCE. It feeds
//                          mastery maths, so weights matter.
//   - `recordStudyEvent` → the `activity` table. HISTORY. What the learner
//                          did, newest first — the feed /api/learner/progress
//                          returns as `recentActivity`. Generating a quiz is
//                          something that happened, not evidence of knowing.

import { ApiError } from '../middleware/errors.js';
import { nowIso, parseJsonObject, logActivity } from '../store/sqlite.js';
// The learner model owns the frozen level table and the difficulty-weighted
// mastery maths; the feed imports both rather than re-deriving them. This is a
// deliberate, already-existing cycle (learner.js imports `recordStudyEvent`
// from here) and is safe because neither module reads the other's bindings at
// module-evaluation time — every reference sits inside a function body.
import { levelLabel, summarizeMastery } from './learner.js';

// Quiz answers are stronger evidence than flashcard reviews (deliberate).
export const EVENT_WEIGHTS = {
  quiz_result: 3,
  quiz_item_correct: 3,
  quiz_item_incorrect: 3,
  card_known: 1,
  card_review: 1,
  explain_again: 1,
  repeated_question: 1,
  approach_change: 1,
  recovery_success: 1,
};

// The cycle "explain differently" walks through. `simpler` and `different`
// are tutor request values, not stored styles, so they are not in the order.
export const APPROACH_ORDER = ['step-by-step', 'examples-first', 'visual', 'concise', 'guided-questions'];

/** Event topic key: lowercased/trimmed, or null when there is no usable topic. */
function cleanTopic(topic) {
  return typeof topic === 'string' && topic.trim() !== '' ? topic.trim().toLowerCase() : null;
}

export async function recordEvent(db, { kind, topic = null, detail = {}, userId = 'default' }) {
  const weight = EVENT_WEIGHTS[kind];
  if (weight === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Unknown event kind "${kind}".`);
  }
  const at = nowIso();
  await db.run('INSERT INTO learning_events (kind, topic, detail_json, weight, at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    kind, cleanTopic(topic), JSON.stringify(detail ?? {}), weight, at, userId);
  return { kind, weight, at };
}

// ---- study history (the activity feed) --------------------------------------

// The canonical study-history event types the learner model reads. One row per
// thing the learner actually did. These live in `activity`, NOT in
// `learning_events`, because generating a quiz or opening a session is history,
// not evidence — putting it in the evidence table would let it leak into
// mastery maths and into the tutor's confusion signals.
//
// Callers (one line each; see docs/HANDOFF.md for the emit sites this wave does
// not own):
//   source_uploaded — sources route, after a source is stored
//   session_opened  — sessions route, when a learner opens a study session
//   tutor_asked     — tutor route, after answering a question
//   quiz_generated  — quiz route, when a quiz is created
//   quiz_answered   — quiz route, alongside the existing quiz_result evidence
//   card_reviewed   — decks route, alongside the existing card_* evidence
//   level_changed   — adaptive route, when the difficulty level moves
export const STUDY_EVENT_TYPES = Object.freeze([
  'source_uploaded',
  'session_opened',
  'tutor_asked',
  'quiz_generated',
  'quiz_answered',
  'card_reviewed',
  'level_changed',
]);

/**
 * Record one study-history row. `detail` is a short human-readable summary
 * (the same shape every existing activity row uses, e.g. "3/3 correct"),
 * because the feed renders it as-is.
 *
 * @returns {{type: string, topic: string|null, detail: string}}
 */
export async function recordStudyEvent(db, { type, topic = null, detail = '', sessionId = null, userId = 'default' } = {}) {
  if (!STUDY_EVENT_TYPES.includes(type)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Unknown study event type "${type}".`);
  }
  const summary = typeof detail === 'string' ? detail.trim().slice(0, 300) : '';
  const key = cleanTopic(topic);
  await logActivity(db, type, key, summary, sessionId, userId);
  return { type, topic: key, detail: summary };
}

// ---- the activity feed (GET /api/events) ------------------------------------
//
// The same `activity` rows `GET /api/learner/progress` summarises as
// `recentActivity`, read as a complete, paginated history instead of a 10-row
// teaser. Read-only: no AI call, no vector call, no writes.
//
// Four rules this module must not lose:
//
//   1. STABLE ORDERING. `at` is NOT unique — two rows written by one request
//      share a millisecond — so the order is always `at DESC, id DESC` and the
//      cursor carries BOTH values. A timestamp-only cursor lets a row straddle
//      a page boundary and be returned twice or skipped entirely.
//
//   2. ONE ROW PER ACTION, NOT ONE ROW PER WRITER (backlog #19). A single quiz
//      submission writes TWO rows: the legacy `quiz` row the tutor log has
//      always rendered, plus the `quiz_answered` study event. The same is true
//      of a tutor ask (`question` + `tutor_asked`). See LEGACY_HISTORY_PARTNERS
//      for the diagnosed cause and the pairing rule.
//
//   3. NOTHING INVENTED. An id, a type, a timestamp and a detail are echoed
//      from the stored row. A reference to the underlying record (a quiz, a
//      source) is resolved from the real table for the SAME user and is simply
//      omitted when no single unambiguous match exists — a missing record is
//      never given a made-up title.
//
//   4. UNASSESSED IS NOT LEVEL 1. `topicMastery` comes from the imported
//      learner model (difficulty-weighted, LEVEL_THRESHOLDS frozen in
//      learner.js) and a topic with no evidence reports
//      `level: null, levelLabel: "unassessed", hasEvidence: false`.

/** Default and maximum page size for GET /api/events (contract v2.0). */
export const DEFAULT_FEED_LIMIT = 20;
export const MAX_FEED_LIMIT = 100;

// Extra raw rows read beyond the page so a legacy/study-event PAIR that
// straddles the page boundary is still recognised as one action. The two rows
// of a pair are written back-to-back by the same request, so they are adjacent
// in insert order; a few spare rows cover a stray write landing between them.
const FEED_LOOKAHEAD = 4;

// Two rows written by one request for one action are this close together.
const PAIR_WINDOW_MS = 5_000;

// A referenced record (source, quiz) is written moments before its activity
// row, so a narrow window is enough to find it — and a narrow window is what
// keeps an ambiguous "two records at once" case from being guessed at.
const REFERENCE_WINDOW_MS = 2_000;

// The history types the routes already write through logActivity() — the
// "legacy" writer that predates the study-event recorder.
const LEGACY_HISTORY_TYPES = Object.freeze([
  'upload', 'quiz', 'question', 'session', 'organize', 'deck-failed',
]);

/**
 * ROOT CAUSE of backlog #19 ("the feed shows the same event twice"):
 * TWO WRITERS, not a join and not a double insert on a retry.
 *
 * `recordStudyEvent` (A09) was added next to the pre-existing `logActivity`
 * row instead of replacing it, and `activity` has no idempotency key or unique
 * constraint that could notice. One POST /api/quiz/:id/answer therefore inserts
 * both a `quiz` row and a `quiz_answered` row with the same topic, the same
 * detail and timestamps a millisecond apart; one POST /api/tutor/ask inserts
 * `question` + `tutor_asked`. Both legacy rows must stay (tests/api.test.js and
 * tests/tutor-intents.js pin them, and tutorService reads `WHERE type =
 * 'question'`), so the honest fix available to the feed is to render ONE row
 * per action and say which two stored rows produced it.
 *
 * Map: study-event type → the legacy type that records the same action.
 * `source_uploaded` is listed because A09's emit-site list names it for the
 * sources route; until that writer lands the entry is simply inert.
 */
export const LEGACY_HISTORY_PARTNERS = Object.freeze({
  quiz_answered: 'quiz',
  tutor_asked: 'question',
  source_uploaded: 'upload',
});

/** Every type a filter may name: what the routes write today + the study events. */
export const FEED_TYPES = Object.freeze([
  ...LEGACY_HISTORY_TYPES,
  ...STUDY_EVENT_TYPES,
]);

// ---------- query validation (pure; throws the contract's 400) --------------

function fail(message) {
  throw new ApiError(400, 'VALIDATION_ERROR', message);
}

/** `limit`: optional whole number 1–100 (default 20). */
export function parseFeedLimit(value) {
  if (value === undefined) return DEFAULT_FEED_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    fail(`limit must be a whole number between 1 and ${MAX_FEED_LIMIT}.`);
  }
  const limit = Number(value.trim());
  if (limit < 1 || limit > MAX_FEED_LIMIT) {
    fail(`limit must be a whole number between 1 and ${MAX_FEED_LIMIT}.`);
  }
  return limit;
}

/** `type`: optional comma-separated list of known activity types. */
export function parseFeedTypes(value) {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value : [value];
  const names = raw
    .flatMap((entry) => String(entry).split(','))
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) fail('type must be a comma-separated list of activity types.');
  const unknown = names.filter((name) => !FEED_TYPES.includes(name));
  if (unknown.length > 0) {
    fail(`type must be one of: ${FEED_TYPES.join(', ')}. Unknown: ${unknown.join(', ')}.`);
  }
  return [...new Set(names)];
}

/** `since`: optional ISO-8601 timestamp, exclusive lower bound. */
export function parseFeedSince(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') fail('since must be an ISO-8601 timestamp.');
  if (!Number.isFinite(Date.parse(value.trim()))) fail('since must be an ISO-8601 timestamp.');
  return new Date(value.trim()).toISOString();
}

/**
 * `cursor`: opaque, and deliberately never inspected by a client. It carries
 * the last row's (at, id) so the next page starts strictly older than it.
 */
export function encodeFeedCursor({ at, id }) {
  return Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
}

export function decodeFeedCursor(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('cursor is not valid.');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value.trim(), 'base64url').toString('utf8'));
  } catch {
    fail('cursor is not valid.');
  }
  if (!parsed || typeof parsed !== 'object') fail('cursor is not valid.');
  const at = typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at)) ? new Date(parsed.at).toISOString() : null;
  const id = Number(parsed.id);
  if (at === null || !Number.isInteger(id) || id < 1) fail('cursor is not valid.');
  return { at, id };
}

/** The whole validated query in one place, so the route stays thin. */
export function parseFeedQuery(query = {}) {
  const types = parseFeedTypes(query.type);
  return {
    limit: parseFeedLimit(query.limit),
    types,
    since: parseFeedSince(query.since),
    cursor: query.cursor === undefined ? null : decodeFeedCursor(query.cursor),
  };
}

// ---------- row reading ------------------------------------------------------

function normalizeActivityRow(row) {
  return {
    id: Number(row?.id),
    type: typeof row?.type === 'string' ? row.type : '',
    topic: typeof row?.topic === 'string' && row.topic.trim() !== '' ? row.topic : null,
    detail: typeof row?.detail === 'string' ? row.detail : '',
    at: typeof row?.at === 'string' ? row.at : '',
    sessionId: typeof row?.session_id === 'string' ? row.session_id : null,
  };
}

async function readActivityRows(db, { userId, limit, types, since, cursor }) {
  const clauses = ['user_id = ?']; // the verified id — never a client-supplied one
  const args = [userId];
  if (since) {
    clauses.push('at > ?');
    args.push(since);
  }
  if (cursor) {
    // Keyset pagination on (at, id): strictly older than the last row seen.
    clauses.push('(at < ? OR (at = ? AND id < ?))');
    args.push(cursor.at, cursor.at, cursor.id);
  }
  if (types) {
    clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
    args.push(...types);
  }
  const rows = await db.all(
    `SELECT id, type, topic, detail, at, session_id FROM activity
     WHERE ${clauses.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`,
    ...args, limit,
  );
  return rows.map(normalizeActivityRow);
}

// ---------- pairing the two writers of one action (pure) --------------------

function sameTopic(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** True when two ISO timestamps are within `ms` of each other. */
function closeInTime(a, b, ms) {
  const first = Date.parse(a);
  const second = Date.parse(b);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
  return Math.abs(first - second) <= ms;
}

/**
 * Collapse each (legacy row, study-event row) pair that describes ONE action
 * into a single event. Pure and deterministic: rows arrive newest first, a
 * study-event row may adopt at most one unconsumed legacy partner, and the
 * study event is the canonical row because it is the type the learner model
 * reads. Nothing is dropped silently — the pair is reported as `recordedAs`.
 *
 * Rows with no partner (a legacy row from an older build, or a study event
 * written on its own) are returned verbatim.
 *
 * @returns {Array<object>} merged events, each carrying `cursorAt`/`cursorId`
 *   of its OLDEST consumed raw row (the keyset position for the next page).
 */
export function mergeFeedRows(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const consumed = new Set();
  const out = [];

  for (let i = 0; i < source.length; i += 1) {
    if (consumed.has(i)) continue;
    const row = source[i];
    const partnerType = LEGACY_HISTORY_PARTNERS[row.type];
    let merged = null;

    if (partnerType) {
      const last = Math.min(i + FEED_LOOKAHEAD, source.length - 1);
      for (let j = i + 1; j <= last; j += 1) {
        const candidate = source[j];
        if (consumed.has(j)) continue;
        if (candidate.type !== partnerType) continue;
        if (!sameTopic(candidate.topic, row.topic)) continue;
        if (!closeInTime(candidate.at, row.at, PAIR_WINDOW_MS)) continue;
        consumed.add(j);
        merged = {
          ...row,
          recordedAs: [candidate.type, row.type],
          cursorAt: candidate.at,
          cursorId: candidate.id,
        };
        break;
      }
    }

    out.push(merged ?? { ...row, cursorAt: row.at, cursorId: row.id });
  }

  return out;
}

// ---------- references + mastery (real rows only) ---------------------------

/**
 * The single stored record an event is about, or null. A lookup that finds
 * nothing (the record was removed) or more than one candidate (two records
 * written in the same instant) returns null — the feed then shows the event
 * with no link rather than a guessed one.
 */
function uniqueReference(rows, kind) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  if (!row || typeof row.id !== 'string' || row.id === '') return null;
  return { kind, id: row.id, label: typeof row.label === 'string' ? row.label : null };
}

async function resolveReference(db, userId, event) {
  const at = Date.parse(event.at);
  if (!Number.isFinite(at)) return null;
  const from = new Date(at - REFERENCE_WINDOW_MS).toISOString();
  const to = new Date(at + REFERENCE_WINDOW_MS).toISOString();

  if (event.type === 'quiz' || event.type === 'quiz_answered') {
    const rows = await db.all(
      `SELECT q.id AS id, q.topic AS label FROM quiz_attempts a
       JOIN quizzes q ON q.id = a.quiz_id
       WHERE q.user_id = ? AND a.created_at >= ? AND a.created_at <= ?`,
      userId, from, to,
    );
    return uniqueReference(rows, 'quiz');
  }

  if (event.type === 'upload' || event.type === 'source_uploaded') {
    const rows = await db.all(
      'SELECT id, title AS label FROM sources WHERE user_id = ? AND created_at >= ? AND created_at <= ?',
      userId, from, to,
    );
    return uniqueReference(rows, 'source');
  }

  // A tutor question is not persisted as a record of its own (there is no
  // messages table), so there is honestly nothing to link to.
  return null;
}

/**
 * The topic's measured level NOW, from the imported learner model — not the
 * value at the time of the event. `summarizeMastery` is difficulty-weighted and
 * recency-decayed; its thresholds are frozen in learner.js and are never
 * re-typed here.
 *
 * The explicit guard is A20's `levelFor(null) === 1` trap: `Number(null)` is 0,
 * which is finite and below every threshold, so an unguarded null would be
 * reported as level 1. A topic with no evidence must read "unassessed".
 */
function topicMasteryOf(record) {
  if (!record || record.hasEvidence !== true) {
    return { masteryPercent: null, level: null, levelLabel: levelLabel(null), hasEvidence: false };
  }
  return {
    masteryPercent: Number.isFinite(record.masteryPercent) ? record.masteryPercent : null,
    level: record.level,
    levelLabel: record.levelLabel,
    hasEvidence: true,
  };
}

/** One lookup for every topic on the page — no per-event query. */
async function masteryByTopic(db, userId, events) {
  const wanted = new Set(events.map((event) => event.topic).filter((topic) => typeof topic === 'string' && topic !== ''));
  if (wanted.size === 0) return new Map();
  const summary = await summarizeMastery(db, { userId });
  const map = new Map();
  for (const topic of wanted) {
    const record = (summary?.topics ?? []).find((entry) => entry.topic === topic);
    map.set(topic, topicMasteryOf(record));
  }
  return map;
}

// ---------- the feed --------------------------------------------------------

/**
 * Read one page of the caller's study history, newest first.
 *
 * @returns {{events: Array<object>, nextCursor: string|null}}
 */
export async function loadActivityFeed(db, options = {}) {
  const { userId = 'default', limit = DEFAULT_FEED_LIMIT, types = null, since = null, cursor = null } = options;

  // Read a little past the page so a pair straddling the boundary is still
  // merged into one action instead of being split across two pages.
  const windowSize = limit + FEED_LOOKAHEAD;
  const rows = await readActivityRows(db, { userId, limit: windowSize, types, since, cursor });
  const merged = mergeFeedRows(rows);
  const page = merged.slice(0, limit);

  const mastery = await masteryByTopic(db, userId, page);

  const events = [];
  for (const event of page) {
    const reference = await resolveReference(db, userId, event);
    const shaped = {
      id: event.id,
      type: event.type,
      topic: event.topic,
      detail: event.detail,
      sessionId: event.sessionId,
      at: event.at,
      // Present only when two stored rows describe this one action: both raw
      // types, so the pairing is auditable rather than hidden.
      ...(event.recordedAs ? { recordedAs: event.recordedAs } : {}),
      ...(reference ? { ref: reference } : {}),
      ...(event.topic ? { topicMastery: mastery.get(event.topic) ?? null } : {}),
    };
    events.push(shaped);
  }

  const last = page[page.length - 1];
  // A full window means there may be more rows; a short one is the last page.
  // (A full window with nothing after it yields one empty page and a null
  // cursor — the standard keyset-pagination trade-off, and it is honest.)
  const hasMore = rows.length === windowSize && last !== undefined;
  return { events, nextCursor: hasMore ? encodeFeedCursor({ at: last.cursorAt, id: last.cursorId }) : null };
}

// ---- repeated-question detection (pure) -------------------------------------

// Lowercase, punctuation → spaces, keep words of 3+ chars ("a", "of", "to"
// carry no meaning for repeat detection).
export function questionTokens(text) {
  if (typeof text !== 'string') return [];
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3);
}

// True when the new question is near-duplicate of any recent one.
// Similarity = |intersection| / |union| (Jaccard) over token sets, threshold
// 0.6. NOTE: with pure Jaccard the canonical near-duplicate pair
// "explain photosynthesis again" vs "explain photosynthesis please" scores
// 2/4 = 0.5 and would be missed, so we take the larger of Jaccard and the
// overlap coefficient |intersection| / min(|A|,|B|) — one extra filler word
// ("please"/"again") must not hide a repeated question.
export function isRepeatedQuestion(current, recent = []) {
  const a = new Set(questionTokens(current));
  if (a.size === 0) return false;
  const items = Array.isArray(recent) ? recent.slice(0, 5) : [];
  for (const item of items) {
    const b = new Set(questionTokens(item));
    if (b.size === 0) continue;
    let shared = 0;
    for (const token of a) if (b.has(token)) shared += 1;
    if (shared === 0) continue;
    const union = a.size + b.size - shared;
    const jaccard = shared / union;
    const overlap = shared / Math.min(a.size, b.size);
    if (Math.max(jaccard, overlap) >= 0.6) return true;
  }
  return false;
}

// ---- teaching-approach memory (pure + one read) -----------------------------

// The most recently requested approach for a topic, or null.
export async function lastApproach(db, topic, userId = 'default') {
  const key = cleanTopic(topic);
  if (key === null) return null;
  const row = await db.get(
    "SELECT detail_json FROM learning_events WHERE kind = 'approach_change' AND topic = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
    key, userId,
  );
  if (!row) return null;
  const approach = parseJsonObject(row.detail_json).to;
  return typeof approach === 'string' ? approach : null;
}

// Pick the approach to teach with.
// - explicit request (except 'different') always wins, even if it repeats
//   the previous approach;
// - 'different' advances cyclically from previous (or the preferred style as
//   a fallback) and never returns the previous one;
// - with no explicit request the saved preference applies (must be a real
//   style, else null); `previous` is ignored;
// - null only when there is nothing to go on at all.
export function chooseApproach({ explicit = null, previous = null, preferred = null } = {}) {
  const pref = APPROACH_ORDER.includes(preferred) ? preferred : null;

  if (explicit === null || explicit === undefined || explicit === '') return pref;
  if (explicit !== 'different') return explicit;

  if (previous === null && pref === null) return APPROACH_ORDER[0];
  const base = previous ?? pref;
  const idx = APPROACH_ORDER.indexOf(base);
  // Unknown previous values (e.g. 'simpler') have no "next" — start the cycle.
  let next = APPROACH_ORDER[(idx + 1) % APPROACH_ORDER.length];
  if (next === previous) next = APPROACH_ORDER[(idx + 2) % APPROACH_ORDER.length];
  return next;
}

// ---- approach effectiveness (pure; caller supplies the rows) ----------------
//
// Rule (simple and deterministic): each approach_change row opens a segment
// that runs until the next approach_change row (or the end). Within a
// segment, the approach is:
//   helped   — a recovery_success row with the same approach in its detail
//              appears in the segment;
//   unhelpful— a quiz_result row whose detail.masteryAfter <= masteryBefore
//              appears in the segment before any recovery;
//   neither  — the segment contains no such evidence.
// An approach that ever helped is never also listed as unhelpful.

export function summarizeApproaches(events, topic) {
  const topicKey = cleanTopic(topic) ?? '';
  const rows = (Array.isArray(events) ? events : [])
    .filter((row) => row && (topicKey === '' || row.topic === null || row.topic === topicKey))
    .slice()
    .sort((a, b) => a.id - b.id);

  const helped = [];
  const unhelpful = [];
  let last = null;
  let current = null; // approach of the open segment
  let sawRecovery = false;
  let sawDrop = false;

  const closeSegment = () => {
    if (current === null) return;
    if (sawRecovery) {
      if (!helped.includes(current)) helped.push(current);
    } else if (sawDrop && !unhelpful.includes(current)) {
      unhelpful.push(current);
    }
  };

  for (const row of rows) {
    const detail = parseJsonObject(row.detail_json);
    if (row.kind === 'approach_change') {
      closeSegment();
      current = typeof detail.to === 'string' ? detail.to : null;
      last = current;
      sawRecovery = false;
      sawDrop = false;
      continue;
    }
    if (current === null) continue; // no approach active yet
    if (row.kind === 'recovery_success') {
      if (detail.approach === current) sawRecovery = true;
    } else if (row.kind === 'quiz_result' && !sawRecovery && !sawDrop) {
      const before = detail.masteryBefore;
      const after = detail.masteryAfter;
      if (typeof before === 'number' && typeof after === 'number' && after <= before) sawDrop = true;
    }
  }
  closeSegment();

  return {
    last,
    helped,
    unhelpful: unhelpful.filter((approach) => !helped.includes(approach)),
  };
}

// ---- recovery recording (db) ------------------------------------------------

// If the learner's mastery just improved while an approach_change is still
// "open" (no later approach_change, no later recovery_success for the topic),
// record a recovery_success event attributed to that approach. Returns the
// event, or null when there is nothing open or no improvement happened.
// A second call after success finds the recorded recovery and returns null.
export async function maybeRecordRecovery(db, { topic, masteryBefore, masteryAfter, userId = 'default' }) {
  const key = cleanTopic(topic);
  if (key === null) return null;

  const lastChange = await db.get(
    "SELECT id, detail_json FROM learning_events WHERE kind = 'approach_change' AND topic = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
    key, userId,
  );
  if (!lastChange) return null;

  const laterRecovery = await db.get(
    "SELECT id FROM learning_events WHERE kind = 'recovery_success' AND topic = ? AND id > ? AND user_id = ? LIMIT 1",
    key, lastChange.id, userId,
  );
  if (laterRecovery) return null; // this approach change already has its outcome

  const approach = parseJsonObject(lastChange.detail_json).to;
  if (typeof approach !== 'string' || approach === '') return null;
  if (!(masteryAfter > masteryBefore)) return null;

  return recordEvent(db, {
    kind: 'recovery_success',
    topic: key,
    detail: { approach, before: masteryBefore, after: masteryAfter },
    userId,
  });
}
