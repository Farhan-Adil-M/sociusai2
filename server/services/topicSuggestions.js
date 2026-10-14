// Topic suggestions for the tutor's abstain path: 0-4 REAL topics the student
// could learn next, read from their own rows for the SAME source scope the
// question was asked against. Deterministic and cheap — plain database reads,
// no model or embedding call — and never invented: when nothing meaningful
// exists, the result is an empty array.
//
// Tiers, in priority order (later tiers only fill what the earlier ones left):
//   1. deck topics linked to the scope (deck source ids / study session)
//   2. quiz topics linked through the scope's study sessions
//   3. heading-like first lines of the scope's stored text (source_segments)
//   4. the scope's source titles

const MAX_SUGGESTIONS = 4;
const TOPIC_MIN = 2; // same bounds as validateTopic in retrieval.js
const TOPIC_MAX = 80;

// One usable suggestion: a real, topic-length string.
function isTopic(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length >= TOPIC_MIN && text.length <= TOPIC_MAX;
}

// Keep the first occurrence only (case-insensitive); order is untouched.
function dedupe(topics) {
  const seen = new Set();
  const kept = [];
  for (const topic of topics) {
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(topic);
  }
  return kept;
}

// decks.source_ids_json is the JSON array of source ids saved at generation time.
function parseDeckSourceIds(json) {
  try {
    const ids = JSON.parse(json || '[]');
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

// The sources the question was asked against. Empty sourceIds means "all of
// this user's material" — exactly the scope retrieval used (see resolveScope).
async function loadScope(db, sourceIds, userId) {
  const where = sourceIds.length > 0
    ? `user_id = ? AND id IN (${sourceIds.map(() => '?').join(', ')})`
    : 'user_id = ?';
  const rows = await db.all(
    `SELECT id, title, session_id FROM sources WHERE ${where} ORDER BY chunk_count DESC, title ASC`,
    userId, ...sourceIds,
  );
  return {
    rows,
    sourceIds: new Set(rows.map((row) => row.id)),
    sessionIds: new Set(rows.map((row) => row.session_id).filter((id) => id)),
    unscoped: sourceIds.length === 0,
  };
}

// Tier 1 — decks built from this material: their recorded source ids or their
// study session must intersect the question's scope.
async function deckTopics(db, userId, scope) {
  const rows = await db.all(
    'SELECT topic, source_ids_json, session_id, card_count FROM decks WHERE user_id = ? ORDER BY card_count DESC, topic ASC',
    userId,
  );
  const linked = rows.filter((row) => scope.unscoped
    || parseDeckSourceIds(row.source_ids_json).some((id) => scope.sourceIds.has(id))
    || (row.session_id != null && scope.sessionIds.has(row.session_id)));
  return linked.map((row) => row.topic);
}

// Tier 2 — quiz topics. A quiz row only records the session it belongs to, so
// it counts when that session holds one of the scoped sources.
async function quizTopics(db, userId, scope) {
  const rows = await db.all(
    'SELECT topic, session_id, question_count FROM quizzes WHERE user_id = ? ORDER BY question_count DESC, topic ASC',
    userId,
  );
  return rows
    .filter((row) => scope.unscoped || (row.session_id != null && scope.sessionIds.has(row.session_id)))
    .map((row) => row.topic);
}

// A heading-shaped candidate from stored text: the first line when it is short
// enough to read as a topic, otherwise the first complete sentence. Never a
// cut-off fragment — what we suggest must be something the material really says.
function topicFromText(text) {
  const firstLine = String(text ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '') ?? '';

  const clean = (candidate) => candidate
    .replace(/^[#>\-*•\s]+/, '') // markdown/bullet markers
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,]+$/, ''); // trailing separators read as list punctuation

  // Must contain a letter, so a stray page number or rule line never becomes a topic.
  const line = clean(firstLine);
  if (isTopic(line) && /\p{L}/u.test(line)) return line;

  const stop = firstLine.search(/[.!?]/);
  if (stop > -1) {
    const sentence = clean(firstLine.slice(0, stop + 1));
    // A sentence taken from a longer line only counts when it reads whole.
    if (isTopic(sentence) && sentence.split(' ').length >= 2 && /\p{L}/u.test(sentence)) return sentence;
  }
  return '';
}

// Tier 3 — one candidate per source: the first line of its first stored
// segment (seg_index 0 is written by every ingestion path). Sources keep the
// most-chunks-first order from the scope query.
async function headingTopics(db, scope) {
  if (scope.rows.length === 0) return [];
  const ids = scope.rows.map((row) => row.id);
  const segments = await db.all(
    `SELECT source_id, text FROM source_segments WHERE seg_index = 0 AND source_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids,
  );
  const textBySource = new Map(segments.map((seg) => [seg.source_id, seg.text]));
  return scope.rows.map((row) => topicFromText(textBySource.get(row.id))).filter((topic) => topic !== '');
}

// The suggestion list for one abstain answer: priority-ordered, deduplicated,
// capped at 4. A handful of SELECTs, so it is cheap enough for every abstain.
export async function fetchTopicSuggestions(db, sourceIds = [], userId = 'default') {
  if (!db) return [];
  const scope = await loadScope(db, sourceIds, userId);
  const topics = [
    ...(await deckTopics(db, userId, scope)),
    ...(await quizTopics(db, userId, scope)),
    ...(await headingTopics(db, scope)),
    ...scope.rows.map((row) => row.title),
  ];
  return dedupe(topics.map((topic) => topic.trim()).filter(isTopic)).slice(0, MAX_SUGGESTIONS);
}
