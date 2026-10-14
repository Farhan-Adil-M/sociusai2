// Observed learning events (v1.4): a small append-only log of evidence the
// server records about how a learner studies (quiz results, flashcard
// reviews, teaching-approach switches, recoveries). Events never touch
// learner_topics mastery. Everything here is deterministic and pure except
// the three functions that take `db`.

import { ApiError } from '../middleware/errors.js';
import { nowIso, parseJsonObject } from '../store/sqlite.js';

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
