// ChromaDB access. One collection of text chunks with embeddings + metadata.
// Uses Chroma Cloud when CHROMA_API_KEY is set, otherwise a local Chroma
// server (see README "Local Chroma fallback"). Callers never see the difference.
//
// Ownership: every chunk carries `ownerId` in metadata, and every read and
// write is scoped to it — one student's page can never retrieve another
// student's material. Wave-4 source kinds (youtube, image) travel as ordinary
// metadata keys (sourceKind, section, page, charStart/charEnd, ordinal,
// timecode); this module persists whatever it is given and never special-cases
// a source type.

import { ChromaClient, CloudClient } from 'chromadb';
// chromadb 3.x validates the embedding function when it creates a concrete
// collection; the guard class we hand in must satisfy the interface shape.
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';

// Chroma rejects an oversized request; splitting keeps one huge ingestion (a
// long PDF) from failing as a whole. Matches the embed side's batch habits.
const MAX_ADD_BATCH = 100;

let collectionPromise = null;

// We ALWAYS send pre-computed vectors from NVIDIA NIM, so the collection never
// needs Chroma's own embedding. The client still requires an embedding function
// handle when opening a collection, so we hand it one that refuses to run —
// catching accidental text-based calls instead of silently embedding wrongly.
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

// Collection creation is idempotent: getOrCreateCollection never throws
// "not found", and the promise is shared so concurrent requests create it once.
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
  const name = err?.name;
  return name === 'ChromaNotFoundError' || name === 'InvalidCollectionError' || name === 'NotFoundError';
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

// ---- metadata sanitation ----------------------------------------------------
// Chroma metadata accepts strings, finite numbers, booleans, and arrays of one
// of those. Anything else (null, undefined, nested objects, mixed arrays,
// NaN/Infinity) would reject the WHOLE batch, so one half-typed Wave-4 location
// field must not take a source's ingestion down: we drop the bad value and say
// so once per key. The SQLite fallback mirrors this so both backends store and
// return identical metadata.

const DROP = Symbol('drop-metadata-value');
const warnedMetadataKeys = new Set();

function primitiveType(value) {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  return null;
}

function sanitizeValue(value) {
  const type = primitiveType(value);
  if (type) return value;
  if (Array.isArray(value) && value.length > 0) {
    const elementType = primitiveType(value[0]);
    if (elementType && value.every((item) => primitiveType(item) === elementType)) return value.slice();
  }
  return DROP;
}

function sanitizeMetadata(metadata) {
  const clean = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const sanitized = sanitizeValue(value);
    if (sanitized === DROP) {
      if (!warnedMetadataKeys.has(key)) {
        warnedMetadataKeys.add(key);
        console.warn(`[chroma] dropping unsupported metadata value for key "${key}" (strings, numbers, booleans, and same-type arrays are stored).`);
      }
      continue;
    }
    clean[key] = sanitized;
  }
  return clean;
}

// ---- batch shape validation -------------------------------------------------
// Fail fast with a useful message instead of letting Chroma reject the call
// with a low-level error, and catch mismatched vector sizes before they reach
// the store (vectors from different models must never be mixed).
function assertBatchShape({ ids, embeddings, documents, metadatas }) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(400, 'VECTOR_INVALID_INPUT', 'addChunks needs at least one chunk id.');
  }
  const count = ids.length;
  const sameLength = (list) => Array.isArray(list) && list.length === count;
  if (!sameLength(embeddings) || !sameLength(documents) || !sameLength(metadatas)) {
    throw new ApiError(400, 'VECTOR_INVALID_INPUT',
      'addChunks needs ids, embeddings, documents, and metadatas of the same length.');
  }
  const dimension = embeddings[0]?.length;
  if (!dimension) {
    throw new ApiError(400, 'VECTOR_INVALID_INPUT', 'Every embedding must be a non-empty array of numbers.');
  }
  for (let i = 0; i < count; i++) {
    const vector = embeddings[i];
    if (!Array.isArray(vector) || vector.length !== dimension
        || !vector.every((number) => typeof number === 'number' && Number.isFinite(number))) {
      throw new ApiError(400, 'VECTOR_INVALID_INPUT',
        `Embedding ${i} is not a ${dimension}-number vector — the batch mixes vector sizes or contains a bad value.`);
    }
  }
}

function ownerFilterFor(userId) {
  return { ownerId: userId };
}

// ---- writes -----------------------------------------------------------------

export async function addChunks({ ids, embeddings, documents, metadatas, userId }) {
  userId = requireOwner(userId);
  assertBatchShape({ ids, embeddings, documents, metadatas });
  // Ownership lives in chunk metadata (Chroma has no user columns): every write
  // stamps ownerId. The userId argument is the AUTHORITY, so the metadata value
  // can never drift from the value queries filter on; a caller-supplied
  // ownerId that disagrees is overridden (and reported).
  const owned = metadatas.map((metadata) => {
    const clean = sanitizeMetadata(metadata);
    if (clean.ownerId !== undefined && clean.ownerId !== userId) {
      console.warn(`[chroma] overriding chunk metadata ownerId "${clean.ownerId}" with the request owner "${userId}".`);
    }
    return { ...clean, ownerId: userId };
  });

  try {
    const collection = await getCollection();
    // upsert (not add) so re-running ingestion or reindex with the same ids
    // overwrites cleanly instead of failing on a duplicate — the same
    // idempotency the SQLite fallback gets from ON CONFLICT DO UPDATE.
    for (let start = 0; start < ids.length; start += MAX_ADD_BATCH) {
      const end = start + MAX_ADD_BATCH;
      await collection.upsert({
        ids: ids.slice(start, end),
        embeddings: embeddings.slice(start, end),
        documents: documents.slice(start, end),
        metadatas: owned.slice(start, end),
      });
    }
  } catch (err) {
    throw chromaError(err);
  }
}

// ---------------------------------------------------------------------------
// Reads. A hit is only ever returned when it belongs to `userId`: Chroma's
// `where` clause does the filtering server-side, and we re-check the returned
// metadata as a second line of defence (a dropped filter must not leak rows).
// ---------------------------------------------------------------------------

function hitsFromQuery(res, userId) {
  const hits = [];
  const rowCount = res.ids?.[0]?.length ?? 0;
  for (let i = 0; i < rowCount; i++) {
    const metadata = res.metadatas?.[0]?.[i] ?? {};
    if (metadata.ownerId !== undefined && metadata.ownerId !== userId) continue;
    hits.push({
      id: res.ids[0][i],
      text: res.documents?.[0]?.[i] ?? '',
      metadata,
      distance: res.distances?.[0]?.[i],
    });
  }
  return hits;
}

export async function queryChunks({ embedding, nResults = 6, sourceIds = [], userId }) {
  userId = requireOwner(userId);
  const limit = Number.isFinite(nResults) ? Math.max(0, Math.floor(nResults)) : 6;
  if (limit === 0) return [];
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new ApiError(400, 'VECTOR_INVALID_INPUT', 'queryChunks needs a non-empty embedding array.');
  }
  // Per-user retrieval: chunks added by other users carry a different ownerId
  // metadata value and must never surface. When both owner and source filters
  // apply, Chroma wants them combined with $and.
  const ownerFilter = ownerFilterFor(userId);
  const sourceFilter = Array.isArray(sourceIds) && sourceIds.length > 0 ? { sourceId: { $in: sourceIds } } : null;
  const where = sourceFilter ? { $and: [ownerFilter, sourceFilter] } : ownerFilter;

  try {
    const collection = await getCollection();
    const res = await collection.query({
      queryEmbeddings: [embedding],
      nResults: limit,
      where,
      include: ['documents', 'metadatas', 'distances'],
    });
    return hitsFromQuery(res, userId);
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
  const limit = Number.isFinite(nResults) ? Math.max(0, Math.floor(nResults)) : 1;
  if (limit === 0) return embeddings.map(() => []);
  try {
    const collection = await getCollection();
    const res = await collection.query({
      queryEmbeddings: embeddings,
      nResults: limit,
      where: ownerFilterFor(userId),
      include: ['documents', 'metadatas', 'distances'],
    });
    // Chroma returns one nested array per query embedding.
    return (res.ids ?? []).map((ids, queryIndex) => {
      const hits = [];
      for (let i = 0; i < ids.length; i++) {
        const metadata = res.metadatas?.[queryIndex]?.[i] ?? {};
        if (metadata.ownerId !== undefined && metadata.ownerId !== userId) continue;
        hits.push({
          id: ids[i],
          text: res.documents?.[queryIndex]?.[i] ?? '',
          metadata,
          distance: res.distances?.[queryIndex]?.[i],
        });
      }
      return hits;
    });
  } catch (err) {
    throw chromaError(err);
  }
}

// ---- deletion ---------------------------------------------------------------

// For ingestion compensation (2.5): remove a specific set of chunk ids so a
// failed persistence never leaves searchable orphan vectors behind. An empty
// list is a no-op (the caller's compensation must never become "delete all").
export async function deleteChunks(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  try {
    const collection = await getCollection();
    await collection.delete({ ids: [...new Set(ids)] });
  } catch (err) {
    throw chromaError(err);
  }
}

// Remove every chunk of one source. Used by reindex (which rebuilds a source
// in place) — scoped by sourceId, and by ownerId too when the caller knows it,
// so a stale/forged source id can never clear another user's chunks.
// A missing sourceId is a no-op, never a full-collection delete.
export async function deleteBySource(sourceId, userId) {
  if (typeof sourceId !== 'string' || sourceId.trim() === '') return;
  const where = userId
    ? { $and: [{ sourceId }, { ownerId: userId }] }
    : { sourceId };
  try {
    const collection = await getCollection();
    await collection.delete({ where });
  } catch (err) {
    throw chromaError(err);
  }
}

export async function countChunks() {
  try {
    const collection = await getCollection();
    return await collection.count();
  } catch (err) {
    throw chromaError(err);
  }
}

export async function pingChroma() {
  try {
    const collection = await getCollection();
    await collection.count();
    return true;
  } catch (err) {
    throw chromaError(err);
  }
}

// For npm run reindex / model changes: drop the collection so it can be rebuilt
// with the currently configured embedding model. Idempotent — a missing
// collection is success, not an error.
export async function resetCollection() {
  try {
    const client = makeClient();
    await client.deleteCollection({ name: config.chromaCollection });
  } catch (err) {
    if (!isNotFound(err)) throw chromaError(err);
  }
  collectionPromise = null;
}

// ---------------------------------------------------------------------------
// Error mapping. Everything leaves this module as an ApiError with an honest
// code, and connection-type failures are marked `unavailable` so the provider
// can fall back to the SQLite store instead of crashing the request.
// ---------------------------------------------------------------------------

/** True when a CloudClient/ChromaClient failure means "cannot reach the store". */
export function isVectorStoreUnavailable(err) {
  return err?.unavailable === true;
}

function chromaError(err) {
  if (err instanceof ApiError) return err;
  const name = err?.name ?? '';
  const message = String(err?.message ?? err);
  console.error('[chroma]', message);

  // A collection bakes in the vector size: after an embedding-model change the
  // only fix is a rebuild, so say that instead of leaking the raw HTTP error.
  if (/dimension/i.test(message)) {
    return new ApiError(409, 'VECTOR_DIMENSION_MISMATCH',
      `The vector index holds ${config.nimEmbedModel} vectors of a different size than the current model produces. Run "npm run reindex" to rebuild the index.`);
  }
  if (name === 'ChromaValueError') {
    return new ApiError(400, 'VECTOR_INVALID_INPUT',
      'The vector store rejected the chunk metadata. Metadata values must be strings, numbers, booleans, or arrays of one type.');
  }
  const connectionFailure = name === 'ChromaConnectionError'
    || /failed to connect|fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
  if (connectionFailure) {
    collectionPromise = null; // re-dial on the next call
    return unavailableError();
  }
  if (name === 'ChromaClientError') {
    // A 4xx that is not a size problem: our request was wrong, so do not fall
    // back (a fallback would hide the bug behind an empty result).
    return new ApiError(400, 'VECTOR_INVALID_INPUT', 'The vector store rejected the request.');
  }
  // Server errors, timeouts, auth/quota problems: the store is not usable right
  // now. Mark it so the provider can switch to the SQLite fallback.
  return unavailableError();
}

function unavailableError() {
  const error = new ApiError(503, 'CHROMA_UNAVAILABLE',
    'The vector database is unreachable. Start the Chroma server or check CHROMA_* settings in .env.');
  error.unavailable = true;
  return error;
}
