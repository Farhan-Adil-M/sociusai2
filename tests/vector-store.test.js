// Vector-facade tests (T9): server/store/vectorStore.js — the Chroma facade
// that decides which passages a given user can retrieve.
//
// FULLY OFFLINE, no ChromaDB server. The real `chromadb` client runs
// unchanged; only its HTTP transport is swapped (globalThis.fetch → an
// in-process Chroma v2 REST stub). Every data operation is DELEGATED to the
// SQLite fallback store (server/store/sqlite-vector.js), so storage, cosine
// scoring and row handling are the real fallback backend's — the stub only
// translates REST ↔ store calls. Every request is also RECORDED, so the
// `where` filter this module SENDS is itself under test: checking only the
// returned rows could not see a filter that was built wrongly and then
// rescued by the post-check.
//
// Conventions follow tests/sqlite-vector.test.js (throwaway SQLite db) and
// tests/two-users.test.js (two owners, no shared state). Assertions here
// target the FACADE (filter construction, ownerId stamping/post-check,
// nResults clamping, batching, error mapping) — not the store's ranking
// internals, which tests/sqlite-vector.test.js already covers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '../server/middleware/errors.js';
import { config } from '../server/config.js';
import { openDb } from '../server/store/sqlite.js';
import { createSqliteVectorStore } from '../server/store/sqlite-vector.js';
import * as vectorStore from '../server/store/vectorStore.js';
import { toCitation } from '../server/services/retrieval.js';

// Force the local ChromaClient path (empty key → no CloudClient) and pin the
// collection name. Runtime mutation of the imported config object only — no
// source file is touched by this test.
config.chromaApiKey = '';
config.chromaTenant = '';
config.chromaDatabase = '';
config.chromaCollection = 'socius_chunks_t9';

const COLLECTION_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { tenant: 'default_tenant', databases: ['default_database'] };

// ---------------------------------------------------------------------------
// In-process Chroma v2 REST stub.
// ---------------------------------------------------------------------------

const backend = {
  mode: 'ok',          // 'ok' | 'down' (connection refused) | 'status' (HTTP fault)
  status: 0,           // used by mode 'status'
  faultBody: null,
  cannedQuery: null,   // when set, /query answers with this payload verbatim
  collectionMissing: false, // when true, DELETE of the collection answers 404
  db: null,
  store: null,         // the SQLite fallback store every data call is served from
  requests: [],        // { method, path, body } for every intercepted request
};

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Translate the facade's Chroma `where` clause into store-level scopes. */
function translateWhere(where) {
  const result = { userId: undefined, sourceIds: [], sourceId: undefined };
  if (!where || typeof where !== 'object') return result;
  const clauses = Array.isArray(where.$and) ? where.$and : [where];
  for (const clause of clauses) {
    if (!clause || typeof clause !== 'object') continue;
    if ('ownerId' in clause) result.userId = clause.ownerId;
    if (typeof clause.sourceId === 'string') {
      result.sourceId = clause.sourceId;
      result.sourceIds = [clause.sourceId];
    } else if (clause.sourceId && Array.isArray(clause.sourceId.$in)) {
      result.sourceIds = [...clause.sourceId.$in];
    }
  }
  return result;
}

function cosineDistance(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / Math.sqrt(na * nb);
}

/**
 * The leak scenario: a `where` with NO ownerId means "the backend ignored the
 * filter". Score every row of every owner and let the facade's own post-check
 * be the only thing standing between a foreign chunk and the response.
 */
async function unownedQuery(embedding, limit, sourceIds) {
  const rows = await backend.db.all(
    'SELECT id, source_id, text, embedding_json, metadata_json FROM vector_chunks',
  );
  return rows
    .map((row) => ({
      id: row.id,
      text: row.text,
      metadata: JSON.parse(row.metadata_json),
      distance: cosineDistance(embedding, JSON.parse(row.embedding_json)),
      sourceId: row.source_id,
    }))
    .filter((hit) => sourceIds.length === 0 || sourceIds.includes(hit.sourceId))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

async function handleQuery(body) {
  if (backend.cannedQuery) return jsonResponse(200, backend.cannedQuery);
  const limit = Number.isFinite(body.n_results) && body.n_results > 0 ? body.n_results : 10;
  const { userId, sourceIds } = translateWhere(body.where);
  const groups = [];
  for (const embedding of body.query_embeddings ?? []) {
    const hits = userId === undefined
      ? await unownedQuery(embedding, limit, sourceIds)
      : await backend.store.queryChunks({ embedding, nResults: limit, sourceIds, userId });
    groups.push(hits);
  }
  return jsonResponse(200, {
    ids: groups.map((hits) => hits.map((hit) => hit.id)),
    documents: groups.map((hits) => hits.map((hit) => hit.text)),
    metadatas: groups.map((hits) => hits.map((hit) => hit.metadata)),
    distances: groups.map((hits) => hits.map((hit) => hit.distance)),
    include: body.include ?? [],
  });
}

async function handleUpsert(body) {
  // The facade stamps one ownerId over the whole batch (the request owner is
  // the authority); that stamped value is the store-level owner of the write.
  const owner = body.metadatas?.[0]?.ownerId ?? 'default';
  await backend.store.addChunks({
    ids: body.ids ?? [],
    embeddings: body.embeddings ?? [],
    documents: body.documents ?? [],
    metadatas: (body.metadatas ?? []).map((metadata) => metadata ?? {}),
    userId: owner,
  });
  return jsonResponse(200, {});
}

async function handleDelete(body) {
  if (Array.isArray(body.ids)) {
    await backend.store.deleteChunks(body.ids);
    return jsonResponse(200, { deleted: 1 });
  }
  const { sourceId, userId } = translateWhere(body.where);
  if (sourceId) await backend.store.deleteBySource(sourceId, userId);
  return jsonResponse(200, { deleted: 1 });
}

async function routeChroma(url, method, body) {
  const pathname = url.pathname;

  if (pathname.endsWith('/auth/identity')) return jsonResponse(200, IDENTITY);
  if (pathname.endsWith('/pre-flight-checks')) {
    return jsonResponse(200, { max_batch_size: 1000000, supports_base64_encoding: false });
  }
  if (method === 'POST' && pathname.endsWith('/collections')) {
    return jsonResponse(200, {
      id: COLLECTION_ID,
      name: config.chromaCollection,
      tenant: IDENTITY.tenant,
      database: IDENTITY.databases[0],
      metadata: null,
      configuration_json: { hnsw: { space: 'cosine' } },
      schema: null,
    });
  }

  const match = pathname.match(/\/collections\/([^/]+)(?:\/([a-z_]+))?$/);
  if (!match) return jsonResponse(404, { error: `no stub route for ${pathname}` });
  const [, collectionRef, operation] = match;

  if (operation === 'upsert') return handleUpsert(body ?? {});
  if (operation === 'query') return handleQuery(body ?? {});
  if (operation === 'delete') return handleDelete(body ?? {});
  if (operation === 'count') return jsonResponse(200, await backend.store.countChunks());
  if (method === 'DELETE') {
    if (backend.collectionMissing || collectionRef !== config.chromaCollection) {
      return jsonResponse(404, { error: 'collection not found' });
    }
    await backend.store.resetCollection();
    return jsonResponse(200, { ok: true });
  }
  return jsonResponse(404, { error: `no stub route for ${method} ${pathname}` });
}

const realFetch = globalThis.fetch;

globalThis.fetch = async function stubChromaFetch(input, init) {
  const rawUrl = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
  const url = new URL(rawUrl);
  // Anything that is not the Chroma API (nothing else should appear in this
  // file) keeps its real transport.
  if (!url.pathname.startsWith('/api/v2/')) return realFetch(input, init);

  const method = (input instanceof Request ? input.method : (init?.method ?? 'GET')).toUpperCase();
  let body = null;
  if (input instanceof Request) {
    const text = await input.text();
    body = text ? JSON.parse(text) : null;
  } else if (init?.body) {
    body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  }
  backend.requests.push({ method, path: url.pathname, body });

  if (backend.mode === 'down') throw new TypeError('fetch failed');
  if (backend.mode === 'status') return jsonResponse(backend.status, backend.faultBody ?? {});
  try {
    return await routeChroma(url, method, body);
  } catch (err) {
    // A stub bug must be loud, never silently swallowed as a 200.
    return jsonResponse(500, { error: `stub failure: ${err?.message ?? err}` });
  }
};

test.after(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Fresh temp database + store wired into the stub; resets request log/modes. */
async function freshBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-vstore-'));
  const db = await openDb(path.join(dir, 'app.db'));
  backend.mode = 'ok';
  backend.status = 0;
  backend.faultBody = null;
  backend.cannedQuery = null;
  backend.collectionMissing = false;
  backend.db = db;
  backend.store = createSqliteVectorStore(db);
  backend.requests = [];
  return db;
}

function requestsEnding(suffix) {
  return backend.requests.filter((request) => request.path.endsWith(suffix));
}

function lastRequest(suffix) {
  const matches = requestsEnding(suffix);
  return matches[matches.length - 1];
}

/** Seed chunks THROUGH the facade under test (never by touching the store). */
async function seedChunks({ userId, chunks }) {
  await vectorStore.addChunks({
    ids: chunks.map((chunk) => chunk.id),
    embeddings: chunks.map((chunk) => chunk.vector),
    documents: chunks.map((chunk) => chunk.text),
    metadatas: chunks.map((chunk) => ({ ...(chunk.metadata ?? {}) })),
    userId,
  });
}

const VEC_X = [1, 0, 0];
const VEC_Y = [0, 1, 0];
const VEC_Z = [0, 0, 1];
const VEC_XY = [1, 1, 0];

// ---------------------------------------------------------------------------
// Round trip: writes, reads, counts
// ---------------------------------------------------------------------------

test('smoke: addChunks → queryChunks → countChunks round trip over the stubbed transport', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'a_0', vector: VEC_X, text: 'alpha passage', metadata: { sourceId: 'src_a', title: 'Notes' } },
      { id: 'a_1', vector: VEC_Y, text: 'beta passage', metadata: { sourceId: 'src_a', title: 'Notes' } },
    ],
  });

  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' });
  assert.equal(hits.length, 2, 'both owned chunks come back');
  assert.deepEqual(hits.map((hit) => hit.id), ['a_0', 'a_1'], 'ranked nearest first');
  assert.equal(hits[0].text, 'alpha passage', 'hit carries the stored document');
  assert.equal(typeof hits[0].distance, 'number');
  assert.ok(hits[0].distance < hits[1].distance, 'identical vector outranks orthogonal one');
  assert.equal(await vectorStore.countChunks(), 2);
  assert.equal(await vectorStore.pingChroma(), true);

  // The request this module sent is itself under test.
  const query = lastRequest('/query');
  assert.equal(query.body.n_results, 5, 'clamped limit reaches the backend');
  assert.deepEqual(query.body.query_embeddings, [VEC_X]);
  assert.deepEqual(query.body.where, { ownerId: 'user-a' }, 'reads are owner-scoped');
  assert.deepEqual(query.body.include, ['documents', 'metadatas', 'distances']);
});

// ---------------------------------------------------------------------------
// Metadata fidelity (citations are built from exactly these fields)
// ---------------------------------------------------------------------------

test('metadata fidelity: citation fields survive addChunks → queryChunks unchanged', async () => {
  await freshBackend();
  const metadata = {
    sourceId: 'src_media_9',
    title: 'Lecture 9 — Membranes',
    type: 'youtube',
    sourceKind: 'youtube',
    section: 'Ch. 2 — Transport',
    charStart: 104,
    charEnd: 268,
    page: 3,
    slide: 7,
    paragraph: 2,
    timecode: '01:23',
    ordinal: 4,
    url: 'https://learn.example/lecture-9',
    verified: true,
    rating: 4.5,
    tags: ['transport', 'atp'],
  };
  await seedChunks({
    userId: 'user-a',
    chunks: [{ id: 'm_0', vector: VEC_X, text: 'Sodium-potassium pump.', metadata }],
  });

  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 3, userId: 'user-a' });
  assert.equal(hits.length, 1);
  const stored = hits[0].metadata;
  for (const [key, value] of Object.entries(metadata)) {
    assert.deepEqual(stored[key], value, `metadata.${key} must survive the round trip`);
  }
  assert.equal(stored.ownerId, 'user-a', 'ownerId stamped on write');

  // The whole point of the fidelity: retrieval.js builds citations from it.
  const citation = toCitation(hits[0]);
  assert.deepEqual(citation.location, { page: 3 }, 'page → citation location');
  assert.equal(citation.section, 'Ch. 2 — Transport');
  assert.equal(citation.charStart, 104);
  assert.equal(citation.charEnd, 268);
  assert.equal(citation.sourceId, 'src_media_9');
  assert.equal(citation.type, 'youtube');
  assert.equal(citation.excerpt, 'Sodium-potassium pump.');
});

test('metadata sanitation: unsupported values are dropped, never stored or fabricated', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [{
      id: 's_0',
      vector: VEC_X,
      text: 'half-typed metadata',
      metadata: {
        sourceId: 'src_s',
        good: 'kept',
        // unsupported on purpose (Chroma/SQLite contract: primitives + same-type arrays)
        location: { page: 3 },
        missing: null,
        broken: Number.NaN,
        mixed: [1, 'two'],
        empty: [],
        ['__proto__']: 'hostile-key', // own key (computed), not the prototype hook
      },
    }],
  });

  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 3, userId: 'user-a' });
  assert.equal(hits.length, 1);
  const stored = hits[0].metadata;
  assert.equal(stored.good, 'kept');
  assert.equal(stored.sourceId, 'src_s');
  assert.equal(stored.ownerId, 'user-a');
  for (const key of ['location', 'missing', 'broken', 'mixed', 'empty']) {
    assert.equal(key in stored, false, `metadata.${key} must be dropped, not stored`);
  }
  // Prototype safety: the hostile key must not have polluted anything.
  assert.equal(Object.prototype.hasOwnProperty.call(stored, '__proto__'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
});

// ---------------------------------------------------------------------------
// Scoring, ranking, ties, empty sets (no evidence floor at THIS layer)
// ---------------------------------------------------------------------------

test('ranking: deterministic order by distance; ties stable; no evidence floor applied here', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'e0', vector: VEC_X, text: 'identical', metadata: { sourceId: 'src_a' } },
      { id: 'd0', vector: VEC_XY, text: 'diagonal', metadata: { sourceId: 'src_a' } },
      { id: 'o0', vector: VEC_Y, text: 'orthogonal y', metadata: { sourceId: 'src_a' } },
      { id: 'o1', vector: VEC_Z, text: 'orthogonal z', metadata: { sourceId: 'src_a' } },
      { id: 'o2', vector: [0, -1, 0], text: 'opposite y', metadata: { sourceId: 'src_a' } },
    ],
  });

  const run1 = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 10, userId: 'user-a' });
  const run2 = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 10, userId: 'user-a' });

  assert.deepEqual(run1.map((hit) => hit.id), ['e0', 'd0', 'o0', 'o1', 'o2'],
    'exact < diagonal < tied far chunks (tie order = insertion order, stable sort)');
  assert.deepEqual(run2.map((hit) => hit.id), run1.map((hit) => hit.id),
    'the same query twice returns the identical order');
  assert.ok(Math.abs(run1[0].distance) < 1e-9, 'identical vector scores distance 0');
  assert.ok(Math.abs(run1[1].distance - (1 - 1 / Math.sqrt(2))) < 1e-6, 'diagonal distance');
  for (const hit of run1.slice(2)) {
    assert.ok(Math.abs(hit.distance - 1) < 1e-6, `${hit.id} is a far chunk (distance ≈ 1)`);
  }

  // The evidence floor (RAG_MIN_SIMILARITY / relative keep) lives in
  // services/retrieval.js — NOT here. The facade must still return far-below-
  // floor candidates with raw distances, or retrieval could never floor them.
  assert.ok(run1.every((hit) => hit.distance >= 0), 'raw distances pass through untouched');

  const empty = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 10, userId: 'user-c' });
  assert.deepEqual(empty, [], 'a user with no chunks gets a clean empty array');
});

// ---------------------------------------------------------------------------
// nResults clamping (top-k)
// ---------------------------------------------------------------------------

test('nResults: floored, clamped, defaulted — and 0 skips the backend entirely', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'k_0', vector: VEC_X, text: 'one', metadata: { sourceId: 'src_a' } },
      { id: 'k_1', vector: VEC_Y, text: 'two', metadata: { sourceId: 'src_a' } },
      { id: 'k_2', vector: VEC_Z, text: 'three', metadata: { sourceId: 'src_a' } },
    ],
  });

  const limited = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 2, userId: 'user-a' });
  assert.equal(limited.length, 2, 'nResults caps the result');
  assert.equal(lastRequest('/query').body.n_results, 2, 'the clamped limit reaches the backend');

  const overfetch = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 99, userId: 'user-a' });
  assert.equal(overfetch.length, 3, 'asking for more than exists returns what exists');
  assert.equal(lastRequest('/query').body.n_results, 99);

  const fractional = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 2.7, userId: 'user-a' });
  assert.equal(fractional.length, 2, 'nResults is floored to a whole number');
  assert.equal(lastRequest('/query').body.n_results, 2);

  for (const nResults of [0, -5]) {
    const before = requestsEnding('/query').length;
    const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults, userId: 'user-a' });
    assert.deepEqual(hits, [], `nResults ${nResults} yields no hits`);
    assert.equal(requestsEnding('/query').length, before, `nResults ${nResults} never reaches the backend`);
  }

  for (const nResults of [undefined, NaN, 'lots', Infinity]) {
    const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults, userId: 'user-a' });
    assert.equal(hits.length, 3, `unusable nResults (${String(nResults)}) falls back to the default of 6`);
    assert.equal(lastRequest('/query').body.n_results, 6, 'the default limit reaches the backend');
  }
});

// ---------------------------------------------------------------------------
// Ownership isolation — the boundary itself
// ---------------------------------------------------------------------------

test('ownership: user B never retrieves user A\u2019s chunks, whatever the query', async () => {
  await freshBackend();
  // Identical vectors on both sides: only the owner filter can separate them.
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'a_0', vector: VEC_X, text: 'A secret one', metadata: { sourceId: 'src_a' } },
      { id: 'a_1', vector: VEC_X, text: 'A secret two', metadata: { sourceId: 'src_a' } },
    ],
  });
  await seedChunks({
    userId: 'user-b',
    chunks: [
      { id: 'b_0', vector: VEC_X, text: 'B one', metadata: { sourceId: 'src_b' } },
      { id: 'b_1', vector: VEC_Y, text: 'B two', metadata: { sourceId: 'src_b' } },
      { id: 'b_2', vector: VEC_Z, text: 'B three', metadata: { sourceId: 'src_b' } },
    ],
  });

  const asB = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 10, userId: 'user-b' });
  assert.deepEqual(asB.map((hit) => hit.id).sort(), ['b_0', 'b_1', 'b_2'],
    'B sees exactly B\u2019s chunks and nothing of A\u2019s');
  assert.ok(asB.every((hit) => hit.metadata.ownerId === 'user-b'));
  assert.deepEqual(lastRequest('/query').body.where, { ownerId: 'user-b' },
    'the query SENT to the backend filters on B');

  const asA = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 10, userId: 'user-a' });
  assert.deepEqual(asA.map((hit) => hit.id).sort(), ['a_0', 'a_1'],
    'A sees exactly A\u2019s chunks');
  assert.deepEqual(lastRequest('/query').body.where, { ownerId: 'user-a' });

  // A foreign sourceId must not unlock foreign chunks either: the owner and
  // source filters are combined, not swapped.
  const aAskedForB = await vectorStore.queryChunks({
    embedding: VEC_X, nResults: 10, sourceIds: ['src_b'], userId: 'user-a',
  });
  assert.deepEqual(aAskedForB, [], 'A asking for B\u2019s source gets nothing');
  assert.deepEqual(lastRequest('/query').body.where,
    { $and: [{ ownerId: 'user-a' }, { sourceId: { $in: ['src_b'] } }] },
    'owner filter stays in place when a source filter is added');

  const bAskedForA = await vectorStore.queryChunks({
    embedding: VEC_X, nResults: 10, sourceIds: ['src_a'], userId: 'user-b',
  });
  assert.deepEqual(bAskedForA, [], 'B asking for A\u2019s source gets nothing');
  assert.deepEqual(lastRequest('/query').body.where,
    { $and: [{ ownerId: 'user-b' }, { sourceId: { $in: ['src_a'] } }] });

  // And the source filter still works for the owner who does have the source.
  const bOwnSource = await vectorStore.queryChunks({
    embedding: VEC_X, nResults: 10, sourceIds: ['src_b'], userId: 'user-b',
  });
  assert.deepEqual(bOwnSource.map((hit) => hit.id).sort(), ['b_0', 'b_1', 'b_2']);
});

test('ownership: a caller-supplied metadata ownerId cannot steal or leak a chunk', async () => {
  await freshBackend();
  // A route bug or forged payload claims ownerId "user-a" while writing as
  // user-b. The userId ARGUMENT is the authority (vectorStore.js:160-172).
  await seedChunks({
    userId: 'user-b',
    chunks: [{
      id: 'b_forged',
      vector: VEC_X,
      text: 'B content with forged owner',
      metadata: { sourceId: 'src_b', ownerId: 'user-a' },
    }],
  });

  const asB = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-b' });
  assert.deepEqual(asB.map((hit) => hit.id), ['b_forged'], 'the real owner still finds the chunk');
  assert.equal(asB[0].metadata.ownerId, 'user-b', 'forged ownerId was overridden by the request owner');

  const asA = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' });
  assert.deepEqual(asA, [], 'user A must NOT retrieve a chunk written by user B');

  // A write with no ownerId at all is stamped, never ownerless.
  await seedChunks({
    userId: 'user-a',
    chunks: [{ id: 'a_unowned', vector: VEC_X, text: 'A plain', metadata: { sourceId: 'src_a' } }],
  });
  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' });
  assert.equal(hits[0]?.metadata.ownerId, 'user-a', 'ownerId is stamped on write');
});

// ---------------------------------------------------------------------------
// Ownership: prototype default, empty and hostile owner ids
// ---------------------------------------------------------------------------

test('ownership: the prototype "default" owner, an empty owner, and named users never mix', async () => {
  await freshBackend();
  await seedChunks({ userId: undefined, chunks: [{ id: 'd_0', vector: VEC_X, text: 'dev default material', metadata: { sourceId: 'src_d' } }] });
  await seedChunks({ userId: '', chunks: [{ id: 'e_0', vector: VEC_X, text: 'empty-owner material', metadata: { sourceId: 'src_e' } }] });
  await seedChunks({ userId: 'user-a', chunks: [{ id: 'a_0', vector: VEC_X, text: 'named-user material', metadata: { sourceId: 'src_a' } }] });

  // Prototype mode: a missing userId resolves to the fixed dev owner.
  const asDefault = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: undefined });
  assert.deepEqual(asDefault.map((hit) => hit.id), ['d_0'], 'a missing userId reads only the default owner\u2019s rows');
  assert.deepEqual(lastRequest('/query').body.where, { ownerId: 'default' });

  // An empty owner is its own bucket — it never falls through to "default".
  const asEmpty = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: '' });
  assert.deepEqual(asEmpty.map((hit) => hit.id), ['e_0'], 'an empty userId is a distinct owner, not the default');
  assert.deepEqual(lastRequest('/query').body.where, { ownerId: '' });

  const asA = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: 'user-a' });
  assert.deepEqual(asA.map((hit) => hit.id), ['a_0']);

  const asStranger = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: 'user-x' });
  assert.deepEqual(asStranger, [], 'an unknown user finds nothing — least of all the default material');
});

test('ownership: hostile ids and owners (__proto__, constructor) stay isolated', async () => {
  await freshBackend();
  await seedChunks({ userId: '__proto__', chunks: [{ id: '__proto__', vector: VEC_X, text: 'proto-owned', metadata: { sourceId: 'src_p' } }] });
  await seedChunks({ userId: 'constructor', chunks: [{ id: 'constructor', vector: VEC_X, text: 'ctor-owned', metadata: { sourceId: 'src_c' } }] });
  await seedChunks({ userId: 'user-a', chunks: [{ id: 'a_0', vector: VEC_X, text: 'normal row', metadata: { sourceId: 'src_a' } }] });

  const asProto = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: '__proto__' });
  assert.deepEqual(asProto.map((hit) => hit.id), ['__proto__'], 'the hostile owner retrieves exactly its own row');
  assert.equal(asProto[0].metadata.ownerId, '__proto__');

  const asCtor = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: 'constructor' });
  assert.deepEqual(asCtor.map((hit) => hit.id), ['constructor'], 'a chunk id of "constructor" is just a string');

  const asA = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: 'user-a' });
  assert.deepEqual(asA.map((hit) => hit.id), ['a_0'], 'neither hostile-owned row leaks into a normal user');

  const asDefault = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, userId: undefined });
  assert.deepEqual(asDefault, [], 'hostile-owner rows never fall into the shared default bucket');

  // The round trip must not have polluted any prototype chain.
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.ownerId, undefined);
  assert.equal({}.sourceId, undefined);
  assert.equal(typeof {}.constructor, 'function');
  assert.equal(Object.getPrototypeOf(asProto[0].metadata), Object.prototype, 'stored metadata keeps a plain prototype');
});

test('ownership: a backend that drops the owner filter still cannot leak — the facade re-checks every row', async () => {
  await freshBackend();
  // Worst case simulated verbatim: the store ignored `where` entirely and
  // answered with user A's rows while user B was asking.
  backend.cannedQuery = {
    ids: [['a_0', 'a_1']],
    documents: [['A secret one', 'A secret two']],
    metadatas: [
      [{ ownerId: 'user-a', sourceId: 'src_a' }, { ownerId: 'user-a', sourceId: 'src_a' }],
    ],
    distances: [[0, 0.1]],
  };

  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-b' });
  assert.deepEqual(hits, [], 'rows owned by user-a are dropped before user-b sees them');

  const batch = await vectorStore.queryChunksBatch({ embeddings: [VEC_X], nResults: 5, userId: 'user-b' });
  assert.deepEqual(batch, [[]], 'the batch variant applies the same post-check');

  // The very same rows are fine for their actual owner.
  const asA = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' });
  assert.deepEqual(asA.map((hit) => hit.id), ['a_0', 'a_1'], 'their owner still gets them');
});

test('ownership: rows without an ownerId pass through (pinned legacy rule, mirrors retrieval.ownedBy)', async () => {
  await freshBackend();
  backend.cannedQuery = {
    ids: [['legacy_0']],
    documents: [['written before ownerId existed']],
    metadatas: [[null]],
    distances: [[0.4]],
  };
  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' });
  // Pinned, not a defect: ownerless rows are legacy single-tenant data and are
  // readable by anyone — the SAME rule services/retrieval.js ownedBy applies.
  assert.equal(hits.length, 1, 'an ownerless legacy row is not dropped for lacking an owner');
  assert.deepEqual(hits[0].metadata, {}, 'null metadata arrives as an empty object, not a crash');
  assert.equal(hits[0].text, 'written before ownerId existed');
  assert.equal(hits[0].distance, 0.4, 'the backend\u2019s raw distance passes through');
});

test('supabase mode: every read and write without a userId fails loudly', async () => {
  await freshBackend();
  const savedSupabaseUrl = config.supabaseUrl;
  try {
    config.supabaseUrl = 'https://t9-project.supabase.co';
    const required = /userId is required in supabase mode/;

    await assert.rejects(vectorStore.addChunks({ ids: ['x'], embeddings: [VEC_X], documents: ['d'], metadatas: [{}] }), required);
    await assert.rejects(vectorStore.queryChunks({ embedding: VEC_X }), required);
    await assert.rejects(vectorStore.queryChunks({ embedding: VEC_X, userId: undefined }), required);
    await assert.rejects(vectorStore.queryChunks({ embedding: VEC_X, userId: '' }), required);
    await assert.rejects(vectorStore.queryChunksBatch({ embeddings: [VEC_X], userId: null }), required);

    await assert.rejects(vectorStore.queryChunks({ embedding: VEC_X }), (err) => {
      assert.ok(err instanceof Error, 'a missing userId is a plain bug, not an envelope');
      assert.equal(vectorStore.isVectorStoreUnavailable(err), false, 'it is not misreported as a store outage');
      return true;
    });
    assert.equal(backend.requests.length, 0, 'none of those rejections reached the backend');

    // With a real id everything works exactly as before.
    await seedChunks({ userId: 'user-1', chunks: [{ id: 'u1_0', vector: VEC_X, text: 'mine', metadata: { sourceId: 'src_u1' } }] });
    const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 3, userId: 'user-1' });
    assert.deepEqual(hits.map((hit) => hit.id), ['u1_0']);
  } finally {
    config.supabaseUrl = savedSupabaseUrl;
  }
});

// ---------------------------------------------------------------------------
// Batch reads
// ---------------------------------------------------------------------------

test('queryChunksBatch: one round trip, owner-scoped per query, degenerate inputs stay cheap', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'a_0', vector: VEC_X, text: 'A x', metadata: { sourceId: 'src_a' } },
      { id: 'a_1', vector: VEC_Y, text: 'A y', metadata: { sourceId: 'src_a' } },
    ],
  });
  await seedChunks({ userId: 'user-b', chunks: [{ id: 'b_0', vector: VEC_X, text: 'B x', metadata: { sourceId: 'src_b' } }] });

  const results = await vectorStore.queryChunksBatch({ embeddings: [VEC_X, VEC_Y], nResults: 2, userId: 'user-a' });
  assert.equal(results.length, 2, 'one hit array per query embedding');
  const flat = results.flat();
  assert.ok(flat.length > 0, 'the batch found A\u2019s material');
  assert.ok(flat.every((hit) => hit.metadata.ownerId === 'user-a'), 'every batch hit belongs to the asked-for owner');
  assert.ok(!flat.some((hit) => hit.id === 'b_0'), 'user B never appears in user A\u2019s batch');

  const query = lastRequest('/query');
  assert.equal(query.body.query_embeddings.length, 2, 'ONE request carries every embedding');
  assert.deepEqual(query.body.where, { ownerId: 'user-a' }, 'batch reads are owner-scoped');
  assert.equal(query.body.n_results, 2);

  // nResults defaults to 1 per query in the batch variant.
  await vectorStore.queryChunksBatch({ embeddings: [VEC_X], userId: 'user-a' });
  assert.equal(lastRequest('/query').body.n_results, 1);

  // Degenerate inputs answer immediately without touching the backend.
  const before = requestsEnding('/query').length;
  assert.deepEqual(await vectorStore.queryChunksBatch({ embeddings: [] }), []);
  assert.deepEqual(
    await vectorStore.queryChunksBatch({ embeddings: [VEC_X, VEC_Y], nResults: 0, userId: 'user-a' }),
    [[], []],
    'a zero-limit batch answers one empty array per embedding, without dialling the backend',
  );
  assert.equal(requestsEnding('/query').length, before, 'empty/zero batch queries skip the backend');
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test('deduplication: duplicate ids are rejected in-batch, upserted across batches, deleteChunks de-duplicates', async () => {
  await freshBackend();

  // FILED DEFECT — see docs/HANDOFF.md: rejecting the batch is correct, but
  // the 400 message blames "chunk metadata" while the real cause is the
  // duplicate id (chromadb's client-side validateIDs → ChromaValueError).
  await assert.rejects(
    seedChunks({
      userId: 'user-a',
      chunks: [
        { id: 'dup_0', vector: VEC_X, text: 'first version', metadata: { sourceId: 'src_a' } },
        { id: 'dup_0', vector: VEC_X, text: 'second version', metadata: { sourceId: 'src_a' } },
      ],
    }),
    (err) => {
      assert.ok(err instanceof ApiError, 'the duplicate-id batch is rejected as bad input');
      assert.equal(err.status, 400);
      assert.equal(err.code, 'VECTOR_INVALID_INPUT');
      assert.match(err.message, /rejected the chunk metadata/,
        'FILED DEFECT — message names metadata although the cause is a duplicate id');
      assert.equal(vectorStore.isVectorStoreUnavailable(err), false);
      return true;
    },
  );
  assert.equal(backend.requests.filter((request) => request.path.endsWith('/upsert')).length, 0,
    'the bad batch never reached a write');
  assert.equal(await vectorStore.countChunks(), 0, 'a rejected batch stored nothing');

  // The SAME id in a LATER batch is an upsert, not an error.
  await seedChunks({ userId: 'user-a', chunks: [{ id: 'dup_0', vector: VEC_X, text: 'first version', metadata: { sourceId: 'src_a' } }] });
  await seedChunks({ userId: 'user-a', chunks: [{ id: 'dup_0', vector: VEC_X, text: 'second version', metadata: { sourceId: 'src_a' } }] });
  assert.equal(await vectorStore.countChunks(), 1, 're-ingestion overwrites instead of duplicating');

  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' });
  assert.equal(hits.length, 1, 'a query never returns one row twice');
  assert.equal(hits[0].text, 'second version', 'upsert semantics: the later write wins');

  await vectorStore.deleteChunks(['dup_0', 'dup_0', 'ghost_0']);
  assert.deepEqual(lastRequest('/delete').body.ids, ['dup_0', 'ghost_0'], 'ids reach the store de-duplicated');
  assert.equal(await vectorStore.countChunks(), 0);
});

test('deduplication: rows the backend repeats are passed through (text dedupe lives in retrieval.js)', async () => {
  await freshBackend();
  backend.cannedQuery = {
    ids: [['dup', 'dup']],
    documents: [['same text', 'same text']],
    metadatas: [
      [{ ownerId: 'user-b', sourceId: 'src_b' }, { ownerId: 'user-b', sourceId: 'src_b' }],
    ],
    distances: [[0, 0]],
  };
  const hits = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-b' });
  // Pinned: this layer never drops rows — owner filtering happens first, then
  // retrieval.dedupeHits removes repeated text. Changing either order matters.
  assert.deepEqual(hits.map((hit) => hit.id), ['dup', 'dup'],
    'the facade passes backend rows through; de-duplication is retrieval\u2019s job');
});

// ---------------------------------------------------------------------------
// Deletes: owner scoping and never-delete-all guards
// ---------------------------------------------------------------------------

test('deletes: deleteBySource is owner-scoped; no-op guards never become delete-all', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'a_s1', vector: VEC_X, text: 'A page 1', metadata: { sourceId: 'shared_src' } },
      { id: 'a_s2', vector: VEC_Y, text: 'A page 2', metadata: { sourceId: 'shared_src' } },
    ],
  });
  await seedChunks({ userId: 'user-b', chunks: [{ id: 'b_s1', vector: VEC_X, text: 'B page 1', metadata: { sourceId: 'shared_src' } }] });

  await vectorStore.deleteBySource('shared_src', 'user-a');
  assert.deepEqual(lastRequest('/delete').body.where,
    { $and: [{ sourceId: 'shared_src' }, { ownerId: 'user-a' }] },
    'the delete request is scoped by source AND owner');
  assert.equal(await vectorStore.countChunks(), 1, 'only the owner\u2019s rows of that source are removed');

  const bLeft = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-b' });
  assert.deepEqual(bLeft.map((hit) => hit.id), ['b_s1'], 'user B\u2019s copy of the same sourceId survives');
  const aLeft = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' });
  assert.deepEqual(aLeft, [], 'user A\u2019s rows are gone');

  // Guards: nothing-shaped input is a no-op — never a full-collection delete.
  const before = requestsEnding('/delete').length;
  for (const bogus of ['', '   ', null, undefined, 42, {}]) {
    await vectorStore.deleteBySource(bogus, 'user-a');
  }
  await vectorStore.deleteChunks([]);
  await vectorStore.deleteChunks('not-a-list');
  assert.equal(requestsEnding('/delete').length, before, 'nothing-shaped input sends no delete request at all');
  assert.equal(await vectorStore.countChunks(), 1, 'everything is still there');

  // Pinned: without a userId the sourceId is the only scope. Callers that know
  // the owner must pass it (reindex passes source.user_id) — the guard against
  // delete-all lives here, cross-owner scoping lives in the caller.
  await vectorStore.deleteBySource('shared_src');
  assert.deepEqual(lastRequest('/delete').body.where, { sourceId: 'shared_src' });
  assert.equal(await vectorStore.countChunks(), 0, 'the unscoped call removes every owner\u2019s rows for that source');
});

test('scoping is lenient: only a non-empty sourceIds ARRAY narrows the query (pinned)', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'a_0', vector: VEC_X, text: 'A one', metadata: { sourceId: 'src_a' } },
      { id: 'a_1', vector: VEC_Y, text: 'A two', metadata: { sourceId: 'src_a' } },
    ],
  });

  const scoped = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, sourceIds: ['src_a'], userId: 'user-a' });
  assert.equal(scoped.length, 2);
  assert.deepEqual(lastRequest('/query').body.where,
    { $and: [{ ownerId: 'user-a' }, { sourceId: { $in: ['src_a'] } }] });

  const noMatch = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, sourceIds: ['nope'], userId: 'user-a' });
  assert.deepEqual(noMatch, [], 'an unknown sourceId returns nothing');

  // FILED DEFECT — see docs/HANDOFF.md: a non-array sourceIds (caller typo)
  // is ignored rather than rejected — the query still returns the owner's
  // rows, never another owner's. Upstream callers validate today
  // (retrieval.validateSourceIds), but the store itself fails open here.
  const lenient = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, sourceIds: 'src_a', userId: 'user-a' });
  assert.equal(lenient.length, 2, 'a string sourceIds does not scope the query');
  assert.deepEqual(lastRequest('/query').body.where, { ownerId: 'user-a' }, 'ownership still applies');

  const asB = await vectorStore.queryChunks({ embedding: VEC_X, nResults: 9, sourceIds: 'src_a', userId: 'user-b' });
  assert.deepEqual(asB, [], 'and it still cannot reach another owner\u2019s rows');
});

// ---------------------------------------------------------------------------
// Batch writes
// ---------------------------------------------------------------------------

test('batch writes: split at 100 chunks, every row stamped with the owner, upsert-idempotent', async () => {
  await freshBackend();
  const chunks = Array.from({ length: 250 }, (_, index) => ({
    id: `bulk_${index}`,
    vector: index % 2 === 0 ? VEC_X : VEC_Y,
    text: `bulk chunk ${index}`,
    metadata: { sourceId: 'src_bulk', ordinal: index },
  }));

  await seedChunks({ userId: 'user-a', chunks });
  const firstPass = requestsEnding('/upsert').map((request) => request.body.ids.length);
  assert.deepEqual(firstPass, [100, 100, 50], 'writes split at MAX_ADD_BATCH = 100');
  assert.equal(await vectorStore.countChunks(), 250);
  assert.ok(requestsEnding('/upsert').every((request) => request.body.metadatas.every((metadata) => metadata.ownerId === 'user-a')),
    'every chunk of every batch carries the owner stamp');

  await seedChunks({ userId: 'user-a', chunks });
  assert.deepEqual(requestsEnding('/upsert').map((request) => request.body.ids.length), [100, 100, 50, 100, 100, 50]);
  assert.equal(await vectorStore.countChunks(), 250, 're-running ingestion upserts instead of duplicating');
});

// ---------------------------------------------------------------------------
// Error honesty: an unreachable backend must surface, never fabricate results
// ---------------------------------------------------------------------------

test('error honesty: backend unreachable → 503 CHROMA_UNAVAILABLE on every operation, never empty results', async () => {
  await freshBackend();
  await seedChunks({ userId: 'user-a', chunks: [{ id: 'a_0', vector: VEC_X, text: 'still here', metadata: { sourceId: 'src_a' } }] });

  backend.mode = 'down'; // connection refused: the stub throws TypeError("fetch failed")

  const unavailable = (err) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.status, 503);
    assert.equal(err.code, 'CHROMA_UNAVAILABLE');
    assert.match(err.message, /vector database is unreachable/i, 'the message tells an operator what to do');
    assert.equal(vectorStore.isVectorStoreUnavailable(err), true, 'marked so the provider may fall back to SQLite');
    return true;
  };

  // assert.rejects fails if the call RESOLVES (e.g. with a fabricated []):
  // an outage must be an error, not "no relevant material".
  await assert.rejects(
    vectorStore.queryChunks({ embedding: VEC_X, nResults: 5, userId: 'user-a' }),
    unavailable,
    'a query outage must reject, never resolve with []',
  );
  await assert.rejects(
    vectorStore.queryChunksBatch({ embeddings: [VEC_X], userId: 'user-a' }),
    unavailable,
    'a batch outage must reject, never resolve with empty arrays',
  );
  await assert.rejects(
    vectorStore.addChunks({ ids: ['x'], embeddings: [VEC_X], documents: ['d'], metadatas: [{ sourceId: 'src_a' }], userId: 'user-a' }),
    unavailable,
    'a failed write must reject — the caller must know the chunk was not stored',
  );
  await assert.rejects(vectorStore.countChunks(), unavailable);
  await assert.rejects(vectorStore.pingChroma(), unavailable);
  await assert.rejects(vectorStore.deleteChunks(['a_0']), unavailable);
  await assert.rejects(vectorStore.deleteBySource('src_a', 'user-a'), unavailable);
  await assert.rejects(vectorStore.resetCollection(), unavailable);

  // The two guards that must NOT touch a dead backend still behave:
  assert.deepEqual(await vectorStore.queryChunks({ embedding: VEC_X, nResults: 0, userId: 'user-a' }), [],
    'a zero-limit query short-circuits before dialling the backend');
  await vectorStore.deleteChunks([]); // empty delete is a no-op, even mid-outage
});

test('error honesty: fault mapping separates "store down" from "our request was wrong"', async () => {
  await freshBackend();
  const query = (userId = 'user-a') => vectorStore.queryChunks({ embedding: VEC_X, nResults: 3, userId });

  // HTTP 500 → the store is not usable right now: unavailable (fallback signal).
  backend.mode = 'status';
  backend.status = 500;
  backend.faultBody = { error: 'internal' };
  await assert.rejects(query(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 503);
    assert.equal(err.code, 'CHROMA_UNAVAILABLE');
    assert.equal(vectorStore.isVectorStoreUnavailable(err), true);
    return true;
  });

  // HTTP 400 complaining about vector size → rebuild instructions, NOT a
  // silent fallback (a fallback would hide the stale index).
  backend.status = 400;
  backend.faultBody = { message: 'expected dimension 1024 but got 2048' };
  await assert.rejects(query(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'VECTOR_DIMENSION_MISMATCH');
    assert.match(err.message, /reindex/, 'the message says how to fix it');
    assert.equal(vectorStore.isVectorStoreUnavailable(err), false, 'a config problem must not look like an outage');
    return true;
  });

  // Plain HTTP 400 → our request was wrong: surfaced as bad input, never as
  // an empty result that would hide the bug.
  backend.status = 400;
  backend.faultBody = { message: 'malformed request' };
  await assert.rejects(query(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'VECTOR_INVALID_INPUT');
    assert.equal(vectorStore.isVectorStoreUnavailable(err), false, 'no fallback for a client-side bug');
    return true;
  });

  // HTTP 404 (collection vanished) → honestly unavailable, not "no results".
  backend.status = 404;
  backend.faultBody = { error: 'not found' };
  await assert.rejects(query(), (err) => {
    assert.equal(err.status, 503);
    assert.equal(vectorStore.isVectorStoreUnavailable(err), true);
    return true;
  });

  // And once the backend is healthy again, results flow normally.
  await freshBackend();
  await seedChunks({ userId: 'user-a', chunks: [{ id: 'a_0', vector: VEC_X, text: 'back online', metadata: { sourceId: 'src_a' } }] });
  const hits = await query();
  assert.deepEqual(hits.map((hit) => hit.id), ['a_0'], 'recovery works after the fault clears');
});

// ---------------------------------------------------------------------------
// Input validation: fail fast, before the backend sees anything
// ---------------------------------------------------------------------------

test('validation: malformed batches and queries are rejected with 400 VECTOR_INVALID_INPUT, offline', async () => {
  await freshBackend();
  const before = backend.requests.length;

  const badBatches = [
    [{ ids: [], embeddings: [], documents: [], metadatas: [] }, /at least one chunk id/],
    [{ ids: ['x'], embeddings: [VEC_X], documents: ['d'], metadatas: [{}, {}] }, /same length/],
    [{ ids: ['x', 'y'], embeddings: [VEC_X], documents: ['d'], metadatas: [{}, {}] }, /same length/],
    [{ ids: ['x', 'y'], embeddings: [VEC_X, [1, 0]], documents: ['d', 'e'], metadatas: [{}, {}] },
      /Embedding 1 is not a 3-number vector/],
    [{ ids: ['x'], embeddings: [[1, Number.NaN]], documents: ['d'], metadatas: [{}] },
      /Embedding 0 is not a 2-number vector/],
    [{ ids: ['x'], embeddings: [[]], documents: ['d'], metadatas: [{}] }, /non-empty array of numbers/],
    [{ ids: ['x'], embeddings: 'not-vectors', documents: ['d'], metadatas: [{}] }, /same length/],
  ];

  for (const [payload, messagePattern] of badBatches) {
    await assert.rejects(
      vectorStore.addChunks({ ...payload, userId: 'user-a' }),
      (err) => {
        assert.ok(err instanceof ApiError, `expected ApiError for ${JSON.stringify(payload?.ids)}`);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'VECTOR_INVALID_INPUT');
        assert.match(err.message, messagePattern);
        assert.equal(vectorStore.isVectorStoreUnavailable(err), false, 'validation is never an outage');
        return true;
      },
    );
  }

  for (const embedding of [[], 'not-a-vector', null, { 0: 1 }]) {
    await assert.rejects(
      vectorStore.queryChunks({ embedding, userId: 'user-a' }),
      (err) => err instanceof ApiError && err.status === 400
        && err.code === 'VECTOR_INVALID_INPUT' && /non-empty embedding array/.test(err.message),
    );
  }

  assert.equal(backend.requests.length, before, 'not one of those rejections reached the backend');

  // Pinned ordering: the zero-limit short-circuit runs BEFORE input
  // validation, so "give me nothing" with a bad embedding answers [].
  assert.deepEqual(
    await vectorStore.queryChunks({ embedding: [], nResults: 0, userId: 'user-a' }),
    [],
    'nResults 0 skips validation too (documented order of operations)',
  );
});

// ---------------------------------------------------------------------------
// Lifecycle: count / ping / resetCollection / error classification
// ---------------------------------------------------------------------------

test('lifecycle: countChunks, pingChroma and resetCollection report the real store state', async () => {
  await freshBackend();
  await seedChunks({
    userId: 'user-a',
    chunks: [
      { id: 'l_0', vector: VEC_X, text: 'one', metadata: { sourceId: 'src_l' } },
      { id: 'l_1', vector: VEC_Y, text: 'two', metadata: { sourceId: 'src_l' } },
      { id: 'l_2', vector: VEC_Z, text: 'three', metadata: { sourceId: 'src_l' } },
    ],
  });
  assert.equal(await vectorStore.countChunks(), 3, 'count is read from the store, never invented');
  assert.equal(await vectorStore.pingChroma(), true);

  await vectorStore.resetCollection();
  assert.equal(await vectorStore.countChunks(), 0, 'reset clears the collection');

  // The module re-dials after a reset (its cached collection handle is gone).
  await seedChunks({ userId: 'user-a', chunks: [{ id: 'l_0', vector: VEC_X, text: 'again', metadata: { sourceId: 'src_l' } }] });
  assert.equal(await vectorStore.countChunks(), 1, 'the store works again after a reset');

  // Idempotent: a missing collection is success, not an error.
  backend.collectionMissing = true;
  await vectorStore.resetCollection(); // must resolve despite the 404
  assert.equal(await vectorStore.countChunks(), 1, 'a failed reset removed nothing');

  // Error classification is explicit, not inferred from the status code.
  assert.equal(vectorStore.isVectorStoreUnavailable(null), false);
  assert.equal(vectorStore.isVectorStoreUnavailable(undefined), false);
  assert.equal(vectorStore.isVectorStoreUnavailable(new Error('boom')), false);
  assert.equal(vectorStore.isVectorStoreUnavailable(new ApiError(503, 'CHROMA_UNAVAILABLE', 'x')), false,
    'the unavailable flag is set deliberately, not read off the status');
  const flagged = Object.assign(new ApiError(503, 'CHROMA_UNAVAILABLE', 'y'), { unavailable: true });
  assert.equal(vectorStore.isVectorStoreUnavailable(flagged), true);
});
