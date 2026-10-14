// ChromaDB access. One collection of text chunks with embeddings + metadata.
// Uses Chroma Cloud when CHROMA_API_KEY is set, otherwise a local Chroma
// server (see README "Local Chroma fallback"). Callers never see the difference.

import { ChromaClient, CloudClient } from 'chromadb';
// chromadb 3.x validates the embedding function when it creates a concrete
// collection; the guard class we hand in must satisfy the interface shape.
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';

let collectionPromise = null;

// We ALWAYS send pre-computed vectors from NVIDIA NIM, so the collection never
// needs Chroma's own embedding. The client still requires an embedding function
// handle when opening a collection, so we hand it one that refuses to run —
// catching accidental text-based calls instead of silently embedding wrongly.
// Chroma 3.x validates the embedding function on collection creation, so we
// hand it one from its own interface family (@chroma-core/default-embed).
// Our code NEVER calls generate(): every write ships an explicit NVIDIA NIM
// vector (the old hand-rolled guard object failed the interface check).
const explicitVectorsOnly = new DefaultEmbeddingFunction({
  api_token: 'explicit-vectors-only', // value never used: we always pass vectors
  model: 'unused',
});

function makeClient() {
  if (config.chromaApiKey) {
    return new CloudClient({
      apiKey: config.chromaApiKey,
      tenant: config.chromaTenant || undefined,
      database: config.chromaDatabase || undefined,
    });
  }
  return new ChromaClient({
    host: config.chromaLocalHost,
    port: config.chromaLocalPort,
    ssl: false,
  });
}

function getCollection() {
  if (!collectionPromise) {
    collectionPromise = makeClient().getOrCreateCollection({
      name: config.chromaCollection,
      embeddingFunction: explicitVectorsOnly,
    })
      .catch((err) => {
        collectionPromise = null; // allow retry on next call
        throw err;
      });
  }
  return collectionPromise;
}

function isNotFound(err) {
  return err && (err.name === 'InvalidCollectionError' || err.name === 'NotFoundError');
}

function requireOwner(userId) {
  // Supabase mode has real accounts: a forgotten userId must fail loudly —
  // silently defaulting would write or read the shared 'default' owner.
  // Prototype mode (no SUPABASE envs) keeps the fixed dev user by design.
  if (config.supabaseUrl && (userId === undefined || userId === null || userId === '')) {
    throw new Error('userId is required in supabase mode (ownership filter).');
  }
  return userId ?? 'default';
}

export async function addChunks({ ids, embeddings, documents, metadatas, userId }) {
  userId = requireOwner(userId);
  try {
    const collection = await getCollection();
    // Ownership lives in chunk metadata (Chroma has no user columns): every
    // write stamps ownerId. Call sites that know the request's user already
    // set it (ingestion, per-user seeding); the userId parameter keeps the
    // prototype-only npm run reindex working — it re-embeds the install's
    // local store as the fixed dev user.
    const owned = metadatas.map((m) => ({ ownerId: userId, ...m }));
    await collection.add({ ids, embeddings, documents, metadatas: owned });
  } catch (err) {
    throw chromaError(err);
  }
}

export async function queryChunks({ embedding, nResults = 6, sourceIds = [], userId }) {
  userId = requireOwner(userId);
  try {
    const collection = await getCollection();
    // Per-user retrieval: chunks added by other users carry a different
    // ownerId metadata value and must never surface. When both owner and
    // source filters apply, Chroma wants them combined with $and.
    const sourceFilter = sourceIds.length > 0 ? { sourceId: { $in: sourceIds } } : null;
    const ownerFilter = userId ? { ownerId: userId } : null;
    let where = ownerFilter;
    if (sourceFilter) {
      where = ownerFilter ? { $and: [ownerFilter, sourceFilter] } : sourceFilter;
    }
    const res = await collection.query({
      queryEmbeddings: [embedding],
      nResults,
      ...(where ? { where } : {}),
      include: ['documents', 'metadatas', 'distances'],
    });
    // Flatten Chroma's nested arrays (one query → arrays of length 1).
    const hits = [];
    for (let i = 0; i < (res.ids?.[0]?.length ?? 0); i++) {
      hits.push({
        id: res.ids[0][i],
        text: res.documents[0][i],
        metadata: res.metadatas[0][i] ?? {},
        distance: res.distances?.[0]?.[i],
      });
    }
    return hits;
  } catch (err) {
    throw chromaError(err);
  }
}

// Batch variant for the extension highlighter: one collection.query call for
// MANY page sentences instead of one HTTP round-trip each. Returns one hit
// array per query embedding, same hit shape as queryChunks.
export async function queryChunksBatch({ embeddings, nResults = 1, userId }) {
  userId = requireOwner(userId);
  if (!Array.isArray(embeddings) || embeddings.length === 0) return [];
  try {
    const collection = await getCollection();
    const where = userId ? { ownerId: userId } : null;
    const res = await collection.query({
      queryEmbeddings: embeddings,
      nResults,
      ...(where ? { where } : {}),
      include: ['documents', 'metadatas', 'distances'],
    });
    // Chroma returns one nested array per query embedding.
    return (res.ids ?? []).map((ids, qi) => ids.map((id, hi) => ({
      id,
      text: res.documents[qi][hi],
      metadata: res.metadatas[qi][hi] ?? {},
      distance: res.distances?.[qi]?.[hi],
    })));
  } catch (err) {
    throw chromaError(err);
  }
}

// For ingestion compensation (2.5): remove a specific set of chunk ids so a
// failed persistence never leaves searchable orphan vectors behind.
export async function deleteChunks(ids) {
  try {
    const collection = await getCollection();
    await collection.delete({ ids });
  } catch (err) {
    throw chromaError(err);
  }
}

export async function countChunks() {
  const collection = await getCollection();
  return collection.count();
}

export async function pingChroma() {
  const collection = await getCollection();
  await collection.count();
  return true;
}

// For npm run reindex: drop the collection so it can be rebuilt with the
// currently configured embedding model.
export async function resetCollection() {
  try {
    const client = makeClient();
    await client.deleteCollection({ name: config.chromaCollection });
  } catch (err) {
    if (!isNotFound(err)) throw chromaError(err);
  }
  collectionPromise = null;
}

function chromaError(err) {
  if (err instanceof ApiError) return err;
  console.error('[chroma]', err?.message ?? err);
  return new ApiError(503, 'CHROMA_UNAVAILABLE',
    'The vector database is unreachable. Start the Chroma server or check CHROMA_* settings in .env.');
}
