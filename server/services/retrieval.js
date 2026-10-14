// Retrieval: question → embedding → ChromaDB nearest chunks → citation-ready hits.
// Citations are built ONLY from stored metadata; the language model never
// supplies filenames, pages, or slide numbers.

import { config } from '../config.js';
import { embedQuery } from './embeddings.js';
import { queryChunks } from '../store/vectorStore.js';
import { ApiError } from '../middleware/errors.js';

const DEFAULT_K = 6;

/** Chroma cosine distance (0 = identical) → similarity in 0..1. */
export function hitScore(hit) {
  if (typeof hit?.distance !== 'number') return undefined;
  return Math.max(0, Math.min(1, Number((1 - hit.distance).toFixed(3))));
}

/** Drop chunks that repeat already-returned text (overlap between neighbours). */
export function dedupeHits(hits) {
  const seen = new Set();
  const kept = [];
  for (const hit of hits) {
    const signature = (hit.text ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 140);
    const key = hit.metadata?.sourceId ?? `nodoc_${signature.slice(0, 12)}`;
    if (seen.has(key + '|' + signature)) continue;
    seen.add(key + '|' + signature);
    kept.push(hit);
  }
  return kept;
}

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

export async function retrieve(question, { sourceIds = [], k = DEFAULT_K, minScore = config.ragMinSimilarity, ai, vector, userId } = {}) {
  // Supabase mode owns every read by user — a missing userId is a bug, not a
  // default (audit: fail-open 'default' defaults).
  if (config.supabaseUrl && !userId) throw new Error('retrieve requires a userId in supabase mode.');
  const embedFn = ai?.embedQuery ?? embedQuery;
  const queryFn = vector?.queryChunks ?? queryChunks;

  const embedding = await embedFn(question);
  let hits = await queryFn({ embedding, nResults: k, sourceIds, userId: userId ?? 'default' });
  hits = dedupeHits(hits);
  hits = filterByEvidence(hits, minScore);
  return hits;
}

// Chroma cosine distance: 0 = identical. Similarity shown to users: reuse hitScore.
export function toCitation(hit) {
  const meta = hit.metadata ?? {};
  let location = null;
  if (meta.page != null) location = { page: meta.page };
  else if (meta.slide != null) location = { slide: meta.slide };
  else if (meta.paragraph != null) location = { paragraph: meta.paragraph };

  const score = hitScore(hit);

  return {
    sourceId: meta.sourceId ?? '',
    type: meta.type ?? 'pdf',
    title: meta.title ?? 'Unknown source',
    url: meta.url ?? null,
    location,
    excerpt: (hit.text ?? '').slice(0, 300),
    ...(score !== undefined ? { score } : {}),
  };
}

export async function assertSourcesExist(db, sourceIds, userId = 'default') {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return;
  const seen = new Set();
  for (const id of sourceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    // Ownership separates "someone else's source" from "no source": both 404.
    const row = await db.get('SELECT id FROM sources WHERE id = ? AND user_id = ?', id, userId);
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
 *  - neither          → { sourceIds: [] } = all material (existing behaviour)
 */
export async function resolveScope(db, { sessionId, sourceIds = [] } = {}, userId = 'default') {
  if (!sessionId) {
    if (Array.isArray(sourceIds)) return { sourceIds: [...sourceIds], session: null };
    return { sourceIds: [], session: null };
  }

  // Sessions, like sources, are per-user rows.
  const session = await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', sessionId, userId);
  if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${sessionId}" does not exist.`);

  const owned = (await db.all('SELECT id FROM sources WHERE session_id = ? AND user_id = ?', sessionId, userId)).map((row) => row.id);
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
export async function resolveRequestScope(db, { sessionId, sourceIds = [] } = {}, userId = 'default') {
  const scope = await resolveScope(db, { sessionId, sourceIds: sourceIds ?? [] }, userId);
  if (!scope.session) {
    await assertSourcesExist(db, sourceIds ?? [], userId); // legacy path: plain source filter
  }
  return scope;
}
