// SQLite vector-store FALLBACK (v1.3).
//
// Purpose: keep Socius AI fully working where no Chroma server can run — the
// serverless deployment on Vercel, and any moment the local Chroma server is
// down. It stores the SAME chunks (text + embedding + trusted metadata) in the
// app database and searches them with cosine similarity computed in JavaScript.
// This is a genuine vector search, not a keyword substitute: identical
// interface, identical scoring semantics (distance = 1 - cosine), so every
// evidence rule keeps working unchanged.
//
// Ownership: every row carries user_id (written explicitly) AND an ownerId in
// its metadata, and every read filters on both — one student's page can never
// retrieve another student's material.
//
// Chroma remains the primary store on the laptop (local server) and on Vercel
// with Chroma Cloud credentials — see store/vectorProvider.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkSegments } from '../services/chunker.js';
import { getMeta, setMeta, parseJsonObject } from './sqlite.js';
import { ApiError } from '../middleware/errors.js';
import { config } from '../config.js';

const SEED_FILE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../data/demo-seed.json');
const SEED_SOURCE_PREFIX = 'seed_';

/** Supabase mode: a forgotten userId must fail loudly, never fall through to
 *  the shared prototype owner (audit: fail-open 'default' defaults). */
function requireOwner(userId) {
  if (config.supabaseUrl && (userId === undefined || userId === null || userId === '')) {
    throw new Error('userId is required in supabase mode (ownership filter).');
  }
  return userId ?? 'default';
}

// ---- metadata sanitation ----------------------------------------------------
// Deliberately mirrors server/store/vectorStore.js: Chroma refuses metadata
// that is not a string, a finite number, a boolean, or an array of one of
// those, so both backends drop the same values and return the same metadata.
// (A shared helper module would remove this duplication — noted in HANDOFF.)
const DROP = Symbol('drop-metadata-value');

function primitiveType(value) {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  return null;
}

function sanitizeMetadata(metadata, userId) {
  const clean = { ownerId: userId };
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (key === 'ownerId') continue;
    const type = primitiveType(value);
    if (type) { clean[key] = value; continue; }
    if (Array.isArray(value) && value.length > 0) {
      const elementType = primitiveType(value[0]);
      if (elementType && value.every((item) => primitiveType(item) === elementType)) clean[key] = value.slice();
    }
  }
  return clean;
}

/** ids / embeddings / documents / metadatas must line up, and every vector must
 *  be a non-empty array of finite numbers of ONE size — a mixed-dimension batch
 *  would corrupt cosine scoring and cannot be repaired later. */
function assertBatchShape({ ids, embeddings, documents, metadatas }) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(400, 'VECTOR_INVALID_INPUT', 'addChunks needs at least one chunk id.');
  }
  const sameLength = (list) => Array.isArray(list) && list.length === ids.length;
  if (!sameLength(embeddings) || !sameLength(documents) || !sameLength(metadatas)) {
    throw new ApiError(400, 'VECTOR_INVALID_INPUT',
      'addChunks needs ids, embeddings, documents, and metadatas of the same length.');
  }
  const dimension = embeddings[0]?.length;
  if (!dimension) throw new ApiError(400, 'VECTOR_INVALID_INPUT', 'Every embedding must be a non-empty array of numbers.');
  for (let i = 0; i < ids.length; i++) {
    const vector = embeddings[i];
    if (!Array.isArray(vector) || vector.length !== dimension
        || !vector.every((number) => typeof number === 'number' && Number.isFinite(number))) {
      throw new ApiError(400, 'VECTOR_INVALID_INPUT',
        `Embedding ${i} is not a ${dimension}-number vector — the batch mixes vector sizes or contains a bad value.`);
    }
  }
}

export function createSqliteVectorStore(db) {
  async function addChunks({ ids, embeddings, documents, metadatas, userId }) {
    userId = requireOwner(userId);
    assertBatchShape({ ids, embeddings, documents, metadatas });
    // user_id is written EXPLICITLY (pg mode forbids relying on the default)
    // and ownerId is stamped into the metadata with the SAME value, so the
    // column and the metadata can never disagree.
    await db.batch(ids.map((id, i) => {
      const metadata = sanitizeMetadata(metadatas[i], userId);
      return {
        sql: 'INSERT INTO vector_chunks (id, user_id, source_id, text, embedding_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, source_id = excluded.source_id, text = excluded.text, embedding_json = excluded.embedding_json, metadata_json = excluded.metadata_json',
        args: [id, userId, metadata.sourceId ?? null, documents[i] ?? '', JSON.stringify(embeddings[i]), JSON.stringify(metadata)],
      };
    }), 'write');
  }

  function cosine(a, b) {
    let dot = 0; let na = 0; let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
  }

  /**
   * Load this user's rows and keep only those whose vector size matches the
   * query. Rows of another size come from a different embedding model: scoring
   * them would return confident nonsense, so they are skipped — and when that
   * leaves nothing at all, the index is stale and we say so plainly.
   */
  function usableRows(rows, queryLength) {
    const usable = [];
    let skipped = 0;
    for (const row of rows) {
      let vector;
      try { vector = JSON.parse(row.embedding_json); } catch { vector = null; }
      if (!Array.isArray(vector) || vector.length !== queryLength) { skipped++; continue; }
      usable.push({ row, vector });
    }
    if (skipped > 0 && usable.length === 0) {
      throw new ApiError(409, 'VECTOR_DIMENSION_MISMATCH',
        `The search index holds ${skipped} chunk(s) whose vector size differs from the current embedding model. Run "npm run reindex" to rebuild the index.`);
    }
    if (skipped > 0) {
      console.warn(`[vector] skipped ${skipped} chunk(s) whose vector size differs from the query (${queryLength}); run npm run reindex.`);
    }
    return usable;
  }

  function toHit({ row, vector }, embedding) {
    return {
      id: row.id,
      text: row.text,
      metadata: parseJsonObject(row.metadata_json),
      distance: 1 - cosine(embedding, vector),
    };
  }

  /** Belt and braces: the SQL WHERE already scopes by owner, and we drop any
   *  hit whose metadata names a different owner (legacy rows have no ownerId). */
  function owned(hit, userId) {
    return hit.metadata.ownerId === undefined || hit.metadata.ownerId === userId;
  }

  async function queryChunks({ embedding, nResults = 6, sourceIds = [], userId }) {
    userId = requireOwner(userId);
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new ApiError(400, 'VECTOR_INVALID_INPUT', 'queryChunks needs a non-empty embedding array.');
    }
    const limit = Number.isFinite(nResults) ? Math.max(0, Math.floor(nResults)) : 6;
    if (limit === 0) return [];

    const rows = await db.all('SELECT id, source_id, text, embedding_json, metadata_json FROM vector_chunks WHERE user_id = ?', userId);
    return usableRows(rows, embedding.length)
      .map((entry) => toHit(entry, embedding))
      .filter((hit) => owned(hit, userId))
      .filter((hit) => sourceIds.length === 0 || sourceIds.includes(hit.metadata.sourceId))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  // Batch variant for the extension highlighter: the rows load ONCE and every
  // query embedding is scored against them in-process. Same hit shape.
  async function queryChunksBatch({ embeddings, nResults = 1, userId }) {
    userId = requireOwner(userId);
    if (!Array.isArray(embeddings) || embeddings.length === 0) return [];
    const limit = Number.isFinite(nResults) ? Math.max(0, Math.floor(nResults)) : 1;
    if (limit === 0) return embeddings.map(() => []);

    const rows = await db.all('SELECT id, source_id, text, embedding_json, metadata_json FROM vector_chunks WHERE user_id = ?', userId);
    return embeddings.map((embedding) => {
      if (!Array.isArray(embedding) || embedding.length === 0) return [];
      return usableRows(rows, embedding.length)
        .map((entry) => toHit(entry, embedding))
        .filter((hit) => owned(hit, userId))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
    });
  }

  async function pingChroma() {
    await db.get('SELECT id, source_id, text, embedding_json, metadata_json FROM vector_chunks LIMIT 1'); // table readable = store healthy
    return true;
  }

  async function countChunks() {
    return (await db.get('SELECT COUNT(*) AS n FROM vector_chunks')).n;
  }

  async function resetCollection() {
    await db.run('DELETE FROM vector_chunks');
  }

  async function deleteChunks(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return; // never treat "nothing" as "everything"
    await db.batch(ids.map((id) => ({ sql: 'DELETE FROM vector_chunks WHERE id = ?', args: [id] })), 'write');
  }

  // Removes one source's rows. Scoped by user_id when the caller knows the
  // owner, so a stale source id can never clear another user's chunks.
  async function deleteBySource(sourceId, userId) {
    if (typeof sourceId !== 'string' || sourceId.trim() === '') return; // never "delete all"
    if (userId) await db.run('DELETE FROM vector_chunks WHERE source_id = ? AND user_id = ?', sourceId, userId);
    else await db.run('DELETE FROM vector_chunks WHERE source_id = ?', sourceId);
  }

  return { backend: 'sqlite', addChunks, queryChunks, queryChunksBatch, pingChroma, countChunks, resetCollection, deleteChunks, deleteBySource };
}

/**
 * Seed the fallback store with the demo corpus on an EMPTY store. Runs on the
 * serverless deployment in PROTOTYPE mode only: the corpus belongs to the
 * fixed dev user 'default'. Hosted (supabase) deployments skip cold-start
 * seeding entirely — per-user material is seeded at profile creation via
 * ensureUserSeeded. Embeddings are computed live (model-consistent — no
 * committed vector blobs to go stale). Idempotent: no-ops when data exists.
 */
export async function seedDemoCorpusIfEmpty({ db, vector, ai, userId = 'default', skipGlobalCheck = false }) {
  // User-qualified ids: chunk ids embed the owner so PKs cannot collide across
  // users, and the sources row is owned by this seed user, not a shared one.
  const SEED_SOURCE_ID = `${SEED_SOURCE_PREFIX}${userId}`;
  // Global emptiness is the right gate for the prototype cold start (one dev
  // user), but NOT for per-user seeding: another user's chunks must not deny
  // THIS user their first material — ensureUserSeeded passes skipGlobalCheck
  // after its own per-user check.
  if (!skipGlobalCheck) {
    const count = await vector.countChunks();
    if (count > 0) return { seeded: false, reason: `store already has ${count} chunks` };
  }
  if (!fs.existsSync(SEED_FILE)) return { seeded: false, reason: 'no seed file' };

  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const segments = seed.pages
    .map((page) => ({ text: page.text, location: { page: page.page } }));
  // Same chunker options and same metadata surface as a real ingestion, so the
  // demo corpus is shaped exactly like the user's own material. (The seed source
  // has no stored row at this point, so the sourceId is passed explicitly.)
  const sourceId = SEED_SOURCE_ID;
  const sourceType = seed.source?.type ?? 'pdf';
  const sourceTitle = seed.source?.title ?? 'Socius AI demo corpus';
  const chunks = chunkSegments(segments, { sourceId, sourceKind: sourceType });
  if (chunks.length === 0) return { seeded: false, reason: 'seed file produced no chunks' };

  const vectors = await ai.embedTexts(chunks.map((c) => c.text));

  // Same embed-model bookkeeping as persistSource: record the model on first
  // write so the health drift guard sees a coherent index.
  if (!await getMeta(db, 'embed_model') && vectors[0]) {
    await setMeta(db, 'embed_model', config.nimEmbedModel);
    await setMeta(db, 'embed_dimension', String(vectors[0].length));
  }

  await vector.addChunks({
    ids: chunks.map((c) => `${sourceId}_${c.chunkIndex}`),
    embeddings: vectors,
    documents: chunks.map((c) => c.text),
    userId,
    metadatas: chunks.map((c) => ({
      ownerId: userId,
      type: sourceType,
      title: sourceTitle,
      ...(c.metadata ?? (c.location?.page != null ? { page: c.location.page } : {})),
    })),
  });

  // Make the demo source visible in the library and organisable like any other.
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO sources (id, user_id, type, title, url, page_count, slide_count, chunk_count, created_at, origin)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, 'seed') ON CONFLICT DO NOTHING`,
      args: [SEED_SOURCE_ID, userId, sourceType, sourceTitle, seed.pages.length, chunks.length, now],
    },
    ...segments.map((segment, i) => ({
      sql: 'INSERT INTO source_segments (source_id, seg_index, location, text) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      args: [SEED_SOURCE_ID, i, JSON.stringify(segment.location ?? {}), segment.text],
    })),
  ], 'write');

  return { seeded: true, chunks: chunks.length };
}

/**
 * Per-user first-material seeding (hosted/supabase mode only). Called from
 * routes/profile.js right after a user's FIRST profile row is created. Small
 * guarded wrapper: only acts when the active vector backend is the SQLite
 * fallback (Chroma deployments keep their own shared library story) and this
 * user has no chunks yet; any failure stays non-fatal (the caller swallows).
 */
export async function ensureUserSeeded({ db, vector, ai, userId }) {
  if (!vector || vector.backend !== 'sqlite') return { seeded: false, reason: 'backend is not the sqlite fallback' };
  if (!userId) return { seeded: false, reason: 'no user id' };
  const mine = (await db.get('SELECT COUNT(*) AS n FROM vector_chunks WHERE user_id = ?', userId)).n;
  if (mine > 0) return { seeded: false, reason: `user already has ${mine} chunks` };
  // Per-user check done — the global "store already has chunks" gate would
  // wrongly deny this user whenever anyone else has data, so skip it.
  return seedDemoCorpusIfEmpty({ db, vector, ai, userId, skipGlobalCheck: true });
}
