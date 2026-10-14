// Serverless vector-store fallback (v1.3): SQLite storage + cosine search in
// JS. Proves scoring parity with the Chroma path (distance = 1 - cosine, so
// every evidence rule downstream behaves identically), source filtering,
// deletion, provider selection, and idempotent demo-corpus seeding.
// Fully offline: no network, no Chroma.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getMeta } from '../server/store/sqlite.js';
import { createSqliteVectorStore, seedDemoCorpusIfEmpty } from '../server/store/sqlite-vector.js';
import { resolveVectorStore } from '../server/store/vectorProvider.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-vec-'));
  return openDb(path.join(dir, 'app.db'));
}

test('sqlite vector store: cosine ranking, filtering, nResults', async () => {
  const db = await tempDb();
  const store = createSqliteVectorStore(db);

  await store.addChunks({
    ids: ['a_0', 'b_0', 'c_0'],
    embeddings: [[1, 0], [0, 1], [0.7071, 0.7071]],
    documents: ['matches x', 'matches y', 'diagonal'],
    metadatas: [
      { sourceId: 'src_a', title: 'A' },
      { sourceId: 'src_b', title: 'B' },
      { sourceId: 'src_b', title: 'B' },
    ],
  });

  const all = await store.queryChunks({ embedding: [1, 0], nResults: 3 });
  assert.equal(all.length, 3);
  assert.equal(all[0].id, 'a_0'); // identical vector → distance 0
  assert.ok(Math.abs(all[0].distance) < 1e-9, `distance ${all[0].distance}`);
  // Ranking by cosine: exact < diagonal (≈0.293) < orthogonal (=1)
  assert.ok(all[1].id === 'c_0' && all[2].id === 'b_0', `ranked ${all.map((h) => h.id)}`);
  assert.ok(Math.abs(all[2].distance - 1) < 1e-6, 'orthogonal → distance 1');

  const scoped = await store.queryChunks({ embedding: [1, 0], nResults: 5, sourceIds: ['src_b'] });
  assert.deepEqual(scoped.map((h) => h.id).sort(), ['b_0', 'c_0'], 'source filter respected');

  const limited = await store.queryChunks({ embedding: [1, 0], nResults: 1 });
  assert.equal(limited.length, 1, 'nResults respected');

  assert.equal(await store.countChunks(), 3);
  assert.equal(await store.pingChroma(), true);
});

test('sqlite vector store: deletion by id and by source', async () => {
  const db = await tempDb();
  const store = createSqliteVectorStore(db);

  await store.addChunks({
    ids: ['a_0', 'a_1', 'b_0'],
    embeddings: [[1, 0], [1, 0.1], [0, 1]],
    documents: ['one', 'two', 'three'],
    metadatas: [{ sourceId: 'src_a' }, { sourceId: 'src_a' }, { sourceId: 'src_b' }],
  });

  await store.deleteChunks(['a_1']);
  assert.equal(await store.countChunks(), 2);

  await store.deleteBySource('src_a');
  assert.equal(await store.countChunks(), 1);
  const rest = await store.queryChunks({ embedding: [0, 1], nResults: 5 });
  assert.equal(rest[0].metadata.sourceId, 'src_b');
});

test('resolveVectorStore honors VECTOR_STORE and Vercel default', async () => {
  const db = await tempDb();
  const saved = { VECTOR_STORE: process.env.VECTOR_STORE, VERCEL: process.env.VERCEL };
  try {
    process.env.VECTOR_STORE = 'sqlite';
    assert.equal(resolveVectorStore(db).backend, 'sqlite');

    process.env.VECTOR_STORE = 'chroma';
    assert.equal(resolveVectorStore(db).backend, 'chroma');

    // No explicit choice: laptop → chroma; Vercel without cloud keys → sqlite.
    delete process.env.VECTOR_STORE;
    delete process.env.VERCEL;
    assert.equal(resolveVectorStore(db).backend, 'chroma');

    process.env.VERCEL = '1';
    assert.equal(resolveVectorStore(db).backend, 'sqlite');
  } finally {
    if (saved.VECTOR_STORE === undefined) delete process.env.VECTOR_STORE; else process.env.VECTOR_STORE = saved.VECTOR_STORE;
    if (saved.VERCEL === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.VERCEL;
  }
});

test('demo-corpus seeding: fills an empty store once, idempotently', async () => {
  const db = await tempDb();
  const store = createSqliteVectorStore(db);
  const ai = { embedTexts: async (texts) => texts.map((_, i) => (i % 2 === 0 ? [1, 0] : [0, 1])) };

  const first = await seedDemoCorpusIfEmpty({ db, vector: store, ai });
  assert.equal(first.seeded, true);
  assert.ok(first.chunks >= 3, `expected the 3 demo pages, got ${first.chunks}`);
  assert.equal(await store.countChunks(), first.chunks);

  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get('seed_default') // per-user seed id shape;
  assert.ok(source, 'demo source visible in the library');
  assert.equal(source.origin, 'seed');
  const segments = db.prepare('SELECT COUNT(*) AS n FROM source_segments WHERE source_id = ?').get('seed_default').n;
  assert.equal(segments, 3, 'page texts stored for re-chunking');
  assert.equal(await getMeta(db, 'embed_model'), 'nvidia/nemotron-3-embed-1b', 'embed model recorded');

  const second = await seedDemoCorpusIfEmpty({ db, vector: store, ai });
  assert.equal(second.seeded, false, 'no double-seed');
  assert.equal(await store.countChunks(), first.chunks, 'chunk count unchanged');
});

test('seeding is a no-op on a non-empty store', async () => {
  const db = await tempDb();
  const store = createSqliteVectorStore(db);
  await store.addChunks({
    ids: ['x_0'], embeddings: [[1, 0]], documents: ['existing'],
    metadatas: [{ sourceId: 'src_x' }],
  });
  const ai = { embedTexts: async (texts) => texts.map(() => [1, 0]) };
  const result = await seedDemoCorpusIfEmpty({ db, vector: store, ai });
  assert.equal(result.seeded, false);
  assert.match(result.reason, /already has/);
});
