// Retrieval: question → embedding → nearest stored chunks → citation-ready hits.
//
// GROUNDING CONTRACT (why this module exists)
// ---------------------------------------------------------------------------
//  1. Citations are built ONLY from stored metadata (sourceId, title, type,
//     page / slide / paragraph / timecode, section, char spans). The language
//     model never supplies a filename, page, slide number, or timestamp — it
//     is not even asked to.
//  2. Retrieved passage text is UNTRUSTED and goes into an LLM prompt. It is
//     delivered inside `<passage id="n">…</passage>` blocks by
//     server/services/prompts.js (`wrapPassages` + `UNTRUSTED_RULE`) — reuse
//     that convention, never invent a second one. This module additionally
//     neutralises forged passage delimiter tags inside the text so untrusted
//     content cannot close a block early.
//  3. Per-user isolation is enforced at the vector store AND re-checked here
//     (defence in depth): one student's question can never surface another
//     student's chunks, even if a store does not filter.
//  4. "Nothing relevant was found" is a clean empty array — never an error and
//     never a padded context — so a caller can honestly say "I don't have a
//     source for that" instead of hallucinating.

import { config } from '../config.js';
import { embedQuery } from './embeddings.js';
import { queryChunks } from '../store/vectorStore.js';
import { ApiError } from '../middleware/errors.js';

const DEFAULT_K = 6; // passages handed to the model by default (contract max)
const MAX_K = 20; // hard cap: more passages never make an answer better
const OVERFETCH = 3; // fetch k×N so dedupe + owner/kind filters still yield k
const EXCERPT_CHARS = 300; // citation excerpt length (docs/API_CONTRACT.md)
const NEAR_DUPLICATE = 0.9; // token overlap that counts as the same passage

/**
 * The acting user id. Supabase mode requires a verified one: a missing id is a
 * bug, never a shared owner (audit: fail-open 'default' defaults). Prototype
 * mode (tests, offline demo) has exactly one user, 'default'.
 */
function requireUserId(userId, action) {
  if (typeof userId === 'string' && userId.trim() !== '') return userId;
  if (config.supabaseUrl) {
    throw new ApiError(401, 'UNAUTHENTICATED', `Sign in to ${action}.`);
  }
  return 'default';
}

/** Chroma cosine distance (0 = identical) → similarity in 0..1. */
export function hitScore(hit) {
  if (typeof hit?.distance !== 'number') return undefined;
  return Math.max(0, Math.min(1, Number((1 - hit.distance).toFixed(3))));
}

// ---- dedupe ----------------------------------------------------------------

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(/[^\p{L}\p{N}]+/u).filter((token) => token !== ''));
}

/** Overlap of two token sets: 0 = unrelated, 1 = identical wording. */
function similarTokens(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Drop chunks that repeat already-returned text. Two signals, both scoped to
 * the SAME source (the same wording in two different documents is a real
 * duplicate hit, not something to merge):
 *  - identical normalised text, and
 *  - near-identical text (≥ 0.9 token overlap), which catches the overlap
 *    prefix the chunker copies from the previous chunk.
 */
export function dedupeHits(hits) {
  const kept = [];
  const seen = [];
  for (const hit of hits) {
    const text = normalizeText(hit?.text);
    const sourceKey = typeof hit?.metadata?.sourceId === 'string' ? hit.metadata.sourceId : '';
    const tokens = tokenSet(text);
    const duplicate = seen.some((other) => other.sourceKey === sourceKey
      && (other.text === text || similarTokens(other.tokens, tokens) >= NEAR_DUPLICATE));
    if (duplicate) continue;
    seen.push({ sourceKey, text, tokens });
    kept.push(hit);
  }
  return kept;
}

// ---- evidence floor --------------------------------------------------------

/** Evidence discipline (see docs/API_CONTRACT.md v1.2): a chunk counts as
 *  evidence when it is at least RAG_MIN_SIMILARITY (absolute sanity bound) AND
 *  at least ragRelativeKeep of the strongest hit. The relative rule is what
 *  actually separates relevant from tangential chunks — verified live: an
 *  unrelated question can outscore a grounded one in absolute terms on small
 *  corpora, so only a relative cut transfers across material. */
export function filterByEvidence(hits, minScore, relativeKeep = config.ragRelativeKeep) {
  if (hits.length === 0) return hits;
  const scores = hits.map((hit) => hitScore(hit) ?? -1);
  const strongest = Math.max(...scores);
  if (strongest <= minScore) return []; // nothing even close to evidence
  const cutoff = Math.max(minScore, strongest * relativeKeep);
  return hits.filter((_, i) => scores[i] >= cutoff);
}

// ---- shared helpers --------------------------------------------------------

/** The canonical source kind: the v8 `sourceKind` when present, else `type`. */
function kindOf(hit) {
  const meta = hit?.metadata ?? {};
  if (typeof meta.sourceKind === 'string' && meta.sourceKind !== '') return meta.sourceKind;
  if (typeof meta.type === 'string' && meta.type !== '') return meta.type;
  return null;
}

/**
 * Defence in depth behind the store's own owner filter. Legacy rows without an
 * ownerId are allowed through (the store already scoped them); a row that names
 * a DIFFERENT owner is dropped, never returned.
 */
function ownedBy(hit, userId) {
  const owner = hit?.metadata?.ownerId;
  return owner === undefined || owner === userId;
}

// A forged `</passage>` (or `<passage …>`) inside untrusted text could close a
// prompt block early and smuggle instructions outside it. The `<` is escaped so
// the convention stays trustworthy; the visible words are left alone.
const PASSAGE_TAG = /<\s*\/?\s*passage\b/gi;

function neutralizeDelimiters(hit) {
  if (typeof hit?.text !== 'string' || !hit.text.includes('<')) return hit;
  return { ...hit, text: hit.text.replace(PASSAGE_TAG, (tag) => `&lt;${tag.slice(1)}`) };
}

function clampK(k) {
  const number = Number(k);
  if (!Number.isFinite(number) || number < 1) return DEFAULT_K;
  return Math.min(Math.floor(number), MAX_K);
}

// ---- retrieval -------------------------------------------------------------

/**
 * Retrieve grounded passages for a question.
 *
 * @param {string} question
 * @param {object} [options]
 * @param {string[]} [options.sourceIds]  restrict to these sources ([] = any)
 * @param {string[]} [options.sourceKinds] restrict to these kinds ([] = any):
 *                                        pdf|pptx|docx|webpage|youtube|image
 * @param {number}  [options.k]           passages to return (default 6, max 20)
 * @param {number}  [options.minScore]    absolute relevance floor
 * @param {string}  [options.userId]      the owner (required in supabase mode)
 * @returns {Promise<Array>} hits, best first; `[]` when nothing is relevant
 */
export async function retrieve(question, { sourceIds = [], sourceKinds = [], k = DEFAULT_K, minScore = config.ragMinSimilarity, ai, vector, userId } = {}) {
  const owner = requireUserId(userId, 'search study material');
  const embedFn = ai?.embedQuery ?? embedQuery;
  const queryFn = vector?.queryChunks ?? queryChunks;
  const limit = clampK(k);

  const embedding = await embedFn(question);
  // Over-fetch: dedupe and the owner/kind filters below can remove candidates,
  // and padding the context with weak filler is worse than returning fewer.
  const fetched = await queryFn({
    embedding,
    nResults: limit * OVERFETCH,
    sourceIds,
    userId: owner,
  });

  let hits = (Array.isArray(fetched) ? fetched : [])
    .filter((hit) => ownedBy(hit, owner))
    .map(neutralizeDelimiters);
  if (Array.isArray(sourceKinds) && sourceKinds.length > 0) {
    hits = hits.filter((hit) => sourceKinds.includes(kindOf(hit)));
  }
  hits = dedupeHits(hits);
  hits = filterByEvidence(hits, minScore);
  return hits.slice(0, limit);
}

// ---- citations -------------------------------------------------------------

function pad(number) {
  return String(Number(number)).padStart(2, '0');
}

/** "3:12" / "00:03:12" / seconds → "hh:mm:ss"; null when unusable. */
function normalizeTimecode(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const total = Math.floor(value);
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  }
  if (typeof value !== 'string') return null;
  const match = value.replace(/[[\]]/g, '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, first, second, third] = match;
  return third === undefined ? `${pad(0)}:${pad(first)}:${second}` : `${pad(first)}:${second}:${third}`;
}

/** The transcript chunker keeps `[hh:mm:ss]` markers in the stored text; that
 *  stored marker is a legitimate fallback when metadata has no timecode. */
function timecodeFromText(text) {
  const match = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/.exec(String(text ?? ''));
  if (!match) return null;
  const [, first, second, third] = match;
  return third === undefined ? `${pad(0)}:${pad(first)}:${second}` : `${pad(first)}:${second}:${third}`;
}

/**
 * One citation, built from STORED metadata only (never model output). Every
 * field is read from `hit.metadata`; `excerpt` is the stored passage text.
 * Additive grounding fields (section, charStart, charEnd) appear only when the
 * chunker stored them, so callers can highlight a range in the in-app viewer.
 *
 * Location precedence: page → slide → timestamp (video) → paragraph.
 */
export function toCitation(hit) {
  const meta = hit?.metadata ?? {};
  const text = typeof hit?.text === 'string' ? hit.text : '';
  const kind = kindOf(hit);

  // A timestamp comes from stored data only: the metadata the store returned,
  // else the timecode marker the transcript chunker left in the stored passage.
  const storedTimecode = meta.timecode ?? meta.timestamp ?? null;
  const timecode = storedTimecode != null
    ? normalizeTimecode(storedTimecode)
    : (kind === 'youtube' ? timecodeFromText(text) : null);

  let location = null;
  if (meta.page != null) location = { page: meta.page };
  else if (meta.slide != null) location = { slide: meta.slide };
  else if (timecode) location = { timestamp: timecode };
  else if (meta.paragraph != null) location = { paragraph: meta.paragraph };

  const score = hitScore(hit);

  return {
    sourceId: typeof meta.sourceId === 'string' ? meta.sourceId : '',
    type: kind ?? 'pdf',
    title: typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : 'Unknown source',
    url: typeof meta.url === 'string' ? meta.url : null,
    location,
    excerpt: text.slice(0, EXCERPT_CHARS),
    ...(typeof meta.section === 'string' && meta.section.trim() !== '' ? { section: meta.section.trim() } : {}),
    ...(typeof meta.charStart === 'number' ? { charStart: meta.charStart } : {}),
    ...(typeof meta.charEnd === 'number' ? { charEnd: meta.charEnd } : {}),
    ...(score !== undefined ? { score } : {}),
  };
}

export async function assertSourcesExist(db, sourceIds, userId) {
  const owner = requireUserId(userId, 'load study material');
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return;
  const seen = new Set();
  for (const id of sourceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    // Ownership separates "someone else's source" from "no source": both 404.
    const row = await db.get('SELECT id FROM sources WHERE id = ? AND user_id = ?', id, owner);
    if (!row) throw new ApiError(404, 'SOURCE_NOT_FOUND', `Source "${id}" does not exist.`);
  }
}

/**
 * Session scope. Enforced HERE (server) because the UI selecting a session is
 * only an interface — retrieval must not touch sources outside it.
 *
 * Rules:
 *  - sessionId only   → the session's sources; empty session → 400 SESSION_EMPTY
 *  - sourceIds only   → passed through as-is (existing behaviour)
 *  - both             → every sourceId must belong to the session
 *  - neither          → { sourceIds: [] } = all of the user's material
 *
 * Every query pins `user_id = ?`: a session id or source id belonging to
 * another student is a 404, never a read.
 */
export async function resolveScope(db, { sessionId, sourceIds = [] } = {}, userId) {
  const owner = requireUserId(userId, 'load study scope');
  if (!sessionId) {
    if (Array.isArray(sourceIds)) return { sourceIds: [...sourceIds], session: null };
    return { sourceIds: [], session: null };
  }

  // Sessions, like sources, are per-user rows.
  const session = await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', sessionId, owner);
  if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${sessionId}" does not exist.`);

  const owned = (await db.all('SELECT id FROM sources WHERE session_id = ? AND user_id = ?', sessionId, owner)).map((row) => row.id);
  if (owned.length === 0) {
    throw new ApiError(400, 'SESSION_EMPTY', `No material in "${session.title}" yet. Add sources to this study session first.`);
  }

  const allowed = new Set(owned);
  if (Array.isArray(sourceIds) && sourceIds.length > 0) {
    for (const id of sourceIds) {
      if (!allowed.has(id)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'sourceIds must belong to the selected study session.');
      }
    }
    return { sourceIds: [...sourceIds], session };
  }

  return { sourceIds: owned, session };
}

// ---- shared request validation (used by tutor/quiz/flashcards routes) ----

/** sourceIds, when given, must be an array of strings. */
export function validateSourceIds(sourceIds) {
  if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some((s) => typeof s !== 'string'))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'sourceIds must be an array of source id strings.');
  }
}

/** A study topic must be a 2–80 character string. */
export function validateTopic(topic) {
  if (typeof topic !== 'string' || topic.trim().length < 2 || topic.trim().length > 80) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Topic must be between 2 and 80 characters.');
  }
}

/**
 * The scope every content route uses: resolve the session scope, then (only on
 * the legacy path with no session) verify the plain sourceIds actually exist.
 */
export async function resolveRequestScope(db, { sessionId, sourceIds = [] } = {}, userId) {
  const scope = await resolveScope(db, { sessionId, sourceIds: sourceIds ?? [] }, userId);
  if (!scope.session) {
    await assertSourcesExist(db, sourceIds ?? [], userId); // legacy path: plain source filter
  }
  return scope;
}
