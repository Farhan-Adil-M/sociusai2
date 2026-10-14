// SQLite vector-store FALLBACK (v1.3).
//
// Purpose: keep Socius AI fully working where no Chroma server can run — the
// serverless deployment on Vercel. It stores the SAME chunks (text + embedding
// + trusted metadata) in the app database and searches them with cosine
// similarity computed in JavaScript. This is a genuine vector search, not a
// keyword substitute: identical interface, identical scoring semantics
// (distance = 1 - cosine), so every evidence rule keeps working unchanged.
//
// Chroma remains the primary store on the laptop (local server) and on Vercel
// with Chroma Cloud credentials — see store/vectorProvider.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkSegments } from '../services/chunker.js';
import { getMeta, setMeta } from './sqlite.js';
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

export function createSqliteVectorStore(db) {
  async function addChunks({ ids, embeddings, documents, metadatas, userId }) {
    userId = requireOwner(userId);
    // user_id is written EXPLICITLY (pg mode forbids relying on the default).
    await db.batch(ids.map((id, i) => ({
      sql: 'INSERT INTO vector_chunks (id, user_id, source_id, text, embedding_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, source_id = excluded.source_id, text = excluded.text, embedding_json = excluded.embedding_json, metadata_json = excluded.metadata_json',
      args: [id, userId, metadatas[i]?.sourceId ?? null, documents[i] ?? '', JSON.stringify(embeddings[i]), JSON.stringify(metadatas[i] ?? {})],
    })), 'write');
  }

  function cosine(a, b) {
    let dot = 0; let na = 0; let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
  }

  async function queryChunks({ embedding, nResults = 6, sourceIds = [], userId }) {
    userId = requireOwner(userId);
    const rows = await db.all('SELECT id, source_id, text, embedding_json, metadata_json FROM vector_chunks WHERE user_id = ?', userId);
    return rows
      .map((row) => ({
        id: row.id,
        text: row.text,
        metadata: JSON.parse(row.metadata_json || '{}'),
        distance: 1 - cosine(embedding, JSON.parse(row.embedding_json)),
      }))
      .filter((hit) => sourceIds.length === 0 || sourceIds.includes(hit.metadata.sourceId))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, nResults);
  }

  // Batch variant for the extension highlighter: the rows load ONCE and every
  // query embedding is scored against them in-process. Same hit shape.
  async function queryChunksBatch({ embeddings, nResults = 1, userId }) {
    userId = requireOwner(userId);
    if (!Array.isArray(embeddings) || embeddings.length === 0) return [];
    const rows = await db.all('SELECT id, source_id, text, embedding_json, metadata_json FROM vector_chunks WHERE user_id = ?', userId);
    const chunks = rows.map((row) => ({
      id: row.id,
      text: row.text,
      metadata: JSON.parse(row.metadata_json || '{}'),
      vec: JSON.parse(row.embedding_json),
    }));
    return embeddings.map((embedding) => chunks
      .map((chunk) => ({ id: chunk.id, text: chunk.text, metadata: chunk.metadata, distance: 1 - cosine(embedding, chunk.vec) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, nResults));
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
    await db.batch(ids.map((id) => ({ sql: 'DELETE FROM vector_chunks WHERE id = ?', args: [id] })), 'write');
  }

  async function deleteBySource(sourceId) {
    await db.run('DELETE FROM vector_chunks WHERE source_id = ?', sourceId);
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
  const chunks = chunkSegments(segments);
  if (chunks.length === 0) return { seeded: false, reason: 'seed file produced no chunks' };

  const vectors = await ai.embedTexts(chunks.map((c) => c.text));

  // Same embed-model bookkeeping as persistSource: record the model on first
  // write so the health drift guard sees a coherent index.
  if (!await getMeta(db, 'embed_model') && vectors[0]) {
    await setMeta(db, 'embed_model', config.nimEmbedModel);
    await setMeta(db, 'embed_dimension', String(vectors[0].length));
  }

  await vector.addChunks({
    ids: chunks.map((c) => `${SEED_SOURCE_ID}_${c.chunkIndex}`),
    embeddings: vectors,
    documents: chunks.map((c) => c.text),
    userId,
    metadatas: chunks.map((c) => ({
      sourceId: SEED_SOURCE_ID,
      ownerId: userId,
      type: seed.source?.type ?? 'pdf',
      title: seed.source?.title ?? 'Socius AI demo corpus',
      chunkIndex: c.chunkIndex,
      ...(c.location?.page != null ? { page: c.location.page } : {}),
    })),
  });

  // Make the demo source visible in the library and organisable like any other.
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO sources (id, user_id, type, title, url, page_count, slide_count, chunk_count, created_at, origin)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, 'seed') ON CONFLICT DO NOTHING`,
      args: [SEED_SOURCE_ID, userId, seed.source?.type ?? 'pdf', seed.source?.title ?? 'Socius AI demo corpus', seed.pages.length, chunks.length, now],
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
