// Embedding-model bookkeeping (v1.2): the first ingestion records the model +
// dimension; later ingests either agree silently or stop with an honest error.
// Plus ingestion compensation (absorbed from ingest-compensation.test.js):
// if structured persistence fails after the chunks were indexed, nothing
// searchable is left behind — neither a misleading source record nor orphan
// vectors.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getMeta, setMeta } from '../server/store/sqlite.js';
import { config } from '../server/config.js';
import { startApp } from './helpers.js';

/** DB proxy that lets vector-related work run, then throws on the Nth structured
 *  INSERT — mimicking a disk/DB failure right after successful indexing.
 *  (Vector calls go through the injected vector stub, not the db.)
 *  Intercepts the ASYNC facade methods (run/batch) that structured persistence
 *  uses since the async-facade conversion. */
function dbThatFailsAfterVectors(realDb, failOnInsertNumber) {
  let insertCount = 0;
  const maybeFail = (sql) => {
    if (sql.startsWith('INSERT INTO sources') || sql.startsWith('INSERT INTO source_segments')) {
      insertCount += 1;
      if (insertCount >= failOnInsertNumber) {
        throw new Error('simulated disk failure after vector indexing');
      }
    }
  };
  return new Proxy(realDb, {
    get(target, prop) {
      if (prop === 'run') {
        return (sql, ...args) => { maybeFail(sql); return target.run(sql, ...args); };
      }
      if (prop === 'batch') {
        return async (statements, mode) => {
          for (const stmt of statements) {
            maybeFail(typeof stmt === 'string' ? stmt : stmt.sql);
          }
          return target.batch(statements, mode);
        };
      }
      return Reflect.get(target, prop);
    },
  });
}

const WEBPAGE = { url: 'https://learn.example/x', text: 'X'.repeat(90) };

test('first ingestion records the embedding model and dimension', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  assert.equal(await getMeta(ctx.db, 'embed_model'), null); // fresh install: nothing recorded yet
  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  });
  assert.equal(res.status, 201);
  assert.equal(await getMeta(ctx.db, 'embed_model'), config.nimEmbedModel);

  // same-model ingest right after: no error, meta untouched
  const again = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://learn.example/y', text: 'Y'.repeat(90) }),
  });
  assert.equal(again.status, 201);
  assert.equal(await getMeta(ctx.db, 'embed_model'), config.nimEmbedModel);
});

test('mismatched configured model stops ingestion with a clear reindex instruction', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  });
  // simulate: the index was built with an older model, config now says another
  await setMeta(ctx.db, 'embed_model', 'some/older-embed-model');

  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://learn.example/z', text: 'Z'.repeat(90) }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, 'CHROMA_UNAVAILABLE');
  assert.ok(body.error.message.includes('npm run reindex'));

  // the mismatched (stale) recording must be preserved, never silently replaced
  assert.equal(await getMeta(ctx.db, 'embed_model'), 'some/older-embed-model');
});

// --- ingestion compensation (absorbed from ingest-compensation.test.js) ------

test('vector-orphan compensation runs when structured persistence fails', async (t) => {
  const indexedIds = [];
  const deleted = [];
  const vector = {
    addChunks: async ({ ids }) => { indexedIds.push(...ids); },
    deleteChunks: async (ids) => { deleted.push(...ids); },
    pingChroma: async () => true,
    queryChunks: async ({ nResults = 6, sourceIds = [] }) => [{ id: 'x', text: 't', metadata: { sourceId: 'any' }, distance: 0.1 }],
    resetCollection: async () => {},
  };

  // The db proxy throws on the FIRST sources INSERT — which happens only after
  // the vector indexing step has completed, replicating a real failure order.
  const realDb = await openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'socius-orphan2-')), 'app.db'));
  const failingDb = dbThatFailsAfterVectors(realDb, 1);
  const ctx = await startApp({ db: failingDb, vector });
  t.after(ctx.close);

  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://learn.example/unit2', text: 'V'.repeat(200) }),
  });
  assert.ok(res.status >= 500, `expected a 5xx for the simulated failure, got ${res.status}`);

  // the indexed vectors were compensated: exactly the ids that were indexed
  // were removed as compensation
  assert.ok(indexedIds.length > 0, 'vectors were indexed before the failure');
  assert.deepEqual([...deleted].sort(), [...indexedIds].sort(), 'every indexed id was removed as compensation');

  // no misleading source record exists afterwards
  const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM sources').get();
  assert.equal(rows.n, 0);
});

test('happy ingestion is unaffected by the compensation wrapper', async (t) => {
  const indexedIds = [];
  const deleted = [];
  const ctx = await startApp({
    vector: {
      addChunks: async ({ ids }) => { indexedIds.push(...ids); },
      deleteChunks: async (ids) => { deleted.push(...ids); },
      pingChroma: async () => true,
      resetCollection: async () => {},
    },
  });
  t.after(ctx.close);

  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(WEBPAGE),
  });
  assert.equal(res.status, 201);
  assert.ok(indexedIds.length > 0);
  assert.equal(deleted.length, 0); // compensation must not run on success
});
