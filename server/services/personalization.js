// Learner-context personalisation (v1.4, milestone M3): build a compact,
// budgeted description of what we know about this learner and turn it into
// extra tutor-prompt rules. Facts still come only from the passages — the
// learner context may shape style, examples, structure and strategy only.
//
// Everything here is deterministic; the parts that take `db` only READ from
// it (the caller records events separately in tutorService).

import { APPROACH_ORDER, questionTokens, summarizeApproaches } from './events.js';
import { parseJsonObject, loadProfileRow } from '../store/sqlite.js';

// Same normalisation as events.js question tokens (consistent repeat detection).
export function tokenize(text) {
  return questionTokens(text);
}

// Defensive parse of the profile fields_json blob happens with the shared
// parseJsonObject helper (store/sqlite.js) — a corrupt value must never
// crash the tutor. The router owns validation; this only reads saved data.

function asString(value, maxLen) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, maxLen) : null;
}

// ---- relevant topics ---------------------------------------------------------

/** True when a candidate's tokens share ≥1 token with the reference set. */
function sharesToken(candidate, reference) {
  const tokens = tokenize(candidate);
  if (tokens.length === 0) return false;
  return tokens.some((t) => reference.has(t));
}

/**
 * Topic keys that relate to the current question or study session.
 *
 * Candidates: learner_topics.topic, learner_subjects.subject, and the study
 * session title (when sessionId given). A candidate matches when its token
 * set shares at least one token with the question tokens or the session-title
 * tokens. Tokens shorter than 3 chars never match (same rule as repeat
 * detection in events.js).
 *
 * Order (deterministic, most relevant first): question-matched learner
 * topics, question-matched subjects, title-matched learner topics,
 * title-matched subjects, then the session title itself; ties alphabetical.
 * Capped at 3. Returns lowercase keys.
 */
export async function resolveRelevantTopics(db, question, sessionId = null, userId = 'default') {
  const questionSet = new Set(tokenize(question ?? ''));
  let titleSet = new Set();
  let sessionTitle = null;
  if (sessionId) {
    const session = await db.get('SELECT title, user_id FROM study_sessions WHERE id = ?', sessionId) ?? null;
    // Only the caller's session title can ever count (tutor scope already
    // verified ownership); a foreign session id is treated as nonexistent.
    if (session && session.user_id === userId) {
      sessionTitle = typeof session.title === 'string' ? session.title.trim() : null;
      titleSet = new Set(tokenize(sessionTitle ?? ''));
    }
  }

  // { name, rank } — lower rank = more relevant.
  const scored = [];
  for (const row of await db.all('SELECT topic FROM learner_topics WHERE user_id = ? ORDER BY updated_at DESC, topic ASC', userId)) {
    const name = row.topic?.trim().toLowerCase();
    if (!name) continue;
    const viaQuestion = questionSet.size > 0 && sharesToken(name, questionSet);
    const viaTitle = sharesToken(name, titleSet);
    if (viaQuestion) scored.push({ name, rank: 0 });
    else if (viaTitle) scored.push({ name, rank: 2 });
  }
  for (const row of await db.all('SELECT subject FROM learner_subjects WHERE user_id = ? ORDER BY subject ASC', userId)) {
    const name = row.subject?.trim().toLowerCase();
    if (!name) continue;
    const viaQuestion = questionSet.size > 0 && sharesToken(name, questionSet);
    const viaTitle = sharesToken(name, titleSet);
    if (viaQuestion) scored.push({ name, rank: 1 });
    else if (viaTitle) scored.push({ name, rank: 3 });
  }
  if (sessionTitle && tokenize(sessionTitle).length > 0) {
    scored.push({ name: sessionTitle.toLowerCase(), rank: 4 });
  }

  scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const seen = new Set();
  const result = [];
  for (const item of scored) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    result.push(item.name);
    if (result.length === 3) break;
  }
  return result;
}

// ---- observed confusion + approach notes (from learning_events) ---------------

function countWord(n) {
  return { 1: 'once', 2: 'twice', 3: 'three times', 4: 'four times', 5: 'five times' }[n] ?? `${n} times`;
}

// ≤2 confusion strings from observed event kinds, deterministic order:
// within a topic by kind (repeated_question → explain_again →
// quiz_item_incorrect), across topics in relevance order.
async function buildConfusion(db, matchedTopics, cap = 2, userId = 'default') {
  if (matchedTopics.length === 0) return [];
  const kinds = [
    { kind: 'repeated_question', make: (topic) => `asked a near-identical question about ${topic} before — a possible confusion signal` },
    { kind: 'explain_again', make: (topic, n) => `asked ${countWord(n)} for another explanation of ${topic}` },
    { kind: 'quiz_item_incorrect', make: (topic, n) => `answered ${n} quiz question${n === 1 ? '' : 's'} on ${topic} incorrectly` },
  ];
  const placeholders = matchedTopics.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT kind, topic FROM learning_events
     WHERE user_id = ? AND kind IN ('repeated_question','explain_again','quiz_item_incorrect') AND topic IN (${placeholders})`,
    userId, ...matchedTopics,
  );
  const counts = new Map(); // `topic|kind` → n
  for (const row of rows) counts.set(`${row.topic}|${row.kind}`, (counts.get(`${row.topic}|${row.kind}`) ?? 0) + 1);

  const strings = [];
  for (const topic of matchedTopics) {
    for (const spec of kinds) {
      const n = counts.get(`${topic}|${spec.kind}`);
      if (n) strings.push(spec.make(topic, n));
      if (strings.length === cap) return strings;
    }
  }
  return strings;
}

// ≤1 approach note from the approach-effectiveness summary for the matched
// topics ("X explanations helped on T" / "… did not help on T").
async function buildApproachNotes(db, matchedTopics, cap = 1, userId = 'default') {
  if (matchedTopics.length === 0) return [];
  const events = await db.all('SELECT id, kind, topic, detail_json FROM learning_events WHERE user_id = ?', userId);
  for (const topic of matchedTopics) {
    const summary = summarizeApproaches(events, topic);
    const helped = summary.helped[0];
    const unhelpful = summary.unhelpful[0];
    if (helped) return [`${helped} explanations helped on ${topic}`];
    if (unhelpful) return [`${unhelpful} explanations did not help on ${topic} — try a different structure`];
  }
  return [];
}

/** Any learning event recorded under one of these topics (for THIS user)? */
async function hasEventsForTopics(db, topics, userId = 'default') {
  if (topics.length === 0) return false;
  const placeholders = topics.map(() => '?').join(', ');
  return await db.get(
    `SELECT 1 FROM learning_events WHERE user_id = ? AND topic IN (${placeholders}) LIMIT 1`,
    userId, ...topics,
  ) !== undefined;
}

// ---- learner context ---------------------------------------------------------

/**
 * The learner context for one tutor answer, or null when there is nothing
 * usable: no profile row or state "new", all profile fields empty, no
 * subjects at all, and no matched learner_topics or learning events → the
 * tutor prompt stays byte-identical to the pre-personalisation version.
 */
export async function buildLearnerContext(db, { question = '', sessionId = null, userId = 'default' } = {}) {
  const topics = await resolveRelevantTopics(db, question, sessionId, userId);

  const row = await loadProfileRow(db, userId);
  const fields = row ? parseJsonObject(row.fields_json) : {};

  const goal = Array.isArray(fields.goals) && fields.goals.length > 0 ? asString(fields.goals[0]?.label, 120) : null;
  const style = APPROACH_ORDER.includes(fields.preferences?.explanationStyle?.value)
    ? fields.preferences.explanationStyle.value
    : null;
  const purpose = fields.purpose ?? null;
  const interestLabels = Array.isArray(fields.interests)
    ? fields.interests.map((i) => asString(i?.label, 40)).filter(Boolean)
    : [];

  // Question tokens PLUS the study-session title tokens: the learner is
  // working inside this session, so its topic scope counts as relevant.
  const relevantTokens = new Set(tokenize(question ?? ''));
  if (sessionId) {
    const session = await db.get('SELECT title, user_id FROM study_sessions WHERE id = ?', sessionId) ?? null;
    if (session && session.user_id === userId) {
      for (const t of tokenize(session?.title ?? '')) relevantTokens.add(t);
    }
  }

  // Interests: only the ones that relate to what we are being asked about —
  // never unrelated ones ("empty when nothing relates").
  const interests = [];
  for (const label of interestLabels) {
    if (tokenize(label).some((t) => relevantTokens.has(t))) interests.push(label);
    if (interests.length === 2) break;
  }

  // Subjects: only the matched ones, with their self-reported familiarity.
  const subjectRows = await db.all('SELECT subject, familiarity FROM learner_subjects WHERE user_id = ? ORDER BY subject ASC', userId);
  const subjects = subjectRows
    .filter((s) => topics.includes(s.subject.trim().toLowerCase()))
    .map((s) => ({ subject: s.subject, familiarity: s.familiarity }));

  // Observed mastery for matched learner_topics (this user only).
  const masteryRows = await db.all('SELECT topic, correct, total FROM learner_topics WHERE user_id = ?', userId);
  const mastery = [];
  for (const topic of topics) {
    const r = masteryRows.find((m) => m.topic === topic);
    if (!r || r.total <= 0) continue;
    mastery.push({ topic, percent: Math.round((r.correct / r.total) * 100), uncertain: r.total < 3 });
    if (mastery.length === 5) break;
  }

  const confusion = await buildConfusion(db, topics, 2, userId);
  const approachNotes = await buildApproachNotes(db, topics, 1, userId);

  // Nothing usable anywhere → tell the tutor service to keep the legacy prompt.
  // Usable self-reported data: any filled field on a row that is not "new".
  const profileMissingOrNew = !row || row.state === 'new';
  const hasSelfReported = !profileMissingOrNew
    && Boolean(goal || style || purpose || interestLabels.length > 0);
  const noSubjects = subjectRows.length === 0;
  const noMatchedObserved = mastery.length === 0 && confusion.length === 0
    && approachNotes.length === 0 && !(await hasEventsForTopics(db, topics, userId));
  if (!hasSelfReported && noSubjects && noMatchedObserved) return null;

  return { goal, style, interests, subjects, mastery, confusion, approachNotes, topics };
}

// Human phrasing for a self-reported subject familiarity.
function familiarityLabel(f) {
  return { none: 'never tried', basic: 'basics known', familiar: 'familiar', confident: 'confident' }[f] ?? 'unclear';
}

/**
 * Compact learner-context block for the tutor system prompt. Hard-capped at
 * 1200 characters (budget enforced here, server-side). Contains only the two
 * labelled sections — no transcript, no ids, nothing else.
 */
export function buildLearnerBlock(context) {
  if (!context) return '';
  const selfLines = [];
  if (context.goal) selfLines.push(`Goal: ${context.goal}`);
  if (context.style) selfLines.push(`Explanation style: ${context.style}`);
  if (context.interests.length) selfLines.push(`Interests: ${context.interests.join(', ')}`);
  if (context.subjects.length) {
    selfLines.push(`Subjects: ${context.subjects.map((s) => `${s.subject} (${familiarityLabel(s.familiarity)})`).join(', ')}`);
  }
  const observedLines = [];
  if (context.mastery.length) {
    const parts = context.mastery.map((m) => `${m.topic} ${m.percent}%${m.uncertain ? ' (uncertain)' : ''}`);
    observedLines.push(`Mastery: ${parts.join(', ')}`);
  }
  if (context.confusion.length) observedLines.push(`Confusion: ${context.confusion.join('; ')}`);
  if (context.approachNotes.length) observedLines.push(`Approach: ${context.approachNotes.join(', ')}`);

  const block = [
    'SELF-REPORTED (the student\'s own words; may shape style/examples only):',
    ...(selfLines.length > 0 ? selfLines : ['(nothing self-reported yet)']),
    '',
    'OBSERVED (from practice; uncertain = fewer than 3 attempts):',
    ...(observedLines.length > 0 ? observedLines : ['(nothing observed yet)']),
  ].join('\n');

  if (block.length <= 1200) return block;
  return `${block.slice(0, 1197)}...`;
}

// ---- teaching approach wording ------------------------------------------------

const APPROACH_INSTRUCTIONS = new Map([
  ['step-by-step', 'teach in numbered steps, one idea per step'],
  ['examples-first', 'lead with a concrete worked example, then the rule'],
  ['visual', 'describe the mental picture/spatial layout plainly (no images exist)'],
  ['concise', 'answer in at most 3–4 tight sentences before any detail'],
  ['guided-questions', 'teach by asking one guiding question at a time, revealing the answer after'],
  ['simpler', 'simplify: plain words, one concept at a time, revisit prerequisites briefly'],
  ['different', 'explain it a DIFFERENT way than before — change structure, framing, and the example; do not repeat the previous explanation'],
]);

/** Short imperative instruction for an approach value ('' for unknown). */
export function describeApproach(approach) {
  return APPROACH_INSTRUCTIONS.get(approach) ?? '';
}
