// Engine parity for server/store/db.js: the SAME interface, migrations, FK and
// transaction semantics must hold on BOTH the local node:sqlite engine and the
// hosted libSQL engine (verified offline against a local file: URL — identical
// driver code path as production, no cloud needed).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeEngine, libSqlEngine, openAppDb, openLocalDb, runMigrations, CURRENT_SCHEMA_VERSION } from '../server/store/db.js';

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'socius-eng-')), 'app.db');
}

// Run `fn(engine)` against each engine kind.
function bothEngines(fn) {
  return async () => {
    const node = nodeEngine(tempFile());
    await runMigrations(node);
    try { await fn(node); } finally { node.close(); }
    const lib = libSqlEngine(`file:${tempFile()}`);
    await runMigrations(lib); // hosted flow: migrations happen intentionally before use
    try { await fn(lib); } finally { lib.close(); }
  };
}

test('both engines: get/all/run/exec parity + null-vs-row', bothEngines(async (db) => {
  await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', 'a', '1');
  const row = await db.get('SELECT value FROM app_meta WHERE key = ?', 'a');
  assert.equal(row?.value, '1');
  const none = await db.get('SELECT value FROM app_meta WHERE key = ?', 'zz');
  assert.equal(none, null, 'missing row must be null on both engines');
  const rows = await db.all('SELECT * FROM app_meta');
  assert.equal(rows.length >= 1, true);
  assert.equal((await db.run('DELETE FROM app_meta WHERE key = ?', 'a')).changes, 1);
}));

test('both engines: run() normalizes changes + lastInsertRowid to Number', bothEngines(async (db) => {
  const r = await db.run('INSERT INTO study_sessions (id, title, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    'ses_x', 't', 'subject', 'now', 'now');
  assert.equal(typeof r.lastInsertRowid, 'number');
  assert.equal(r.changes, 1);
}));

test('both engines: batch is atomic — a failure rolls back everything', bothEngines(async (db) => {
  await db.exec('CREATE TABLE p (k TEXT PRIMARY KEY)');
  await db.exec('CREATE TABLE c (k TEXT REFERENCES p(k))');
  await db.exec("INSERT INTO p (k) VALUES ('p1')");
  await assert.rejects(() => db.batch([
    "INSERT INTO c (k) VALUES ('p1')",
    "INSERT INTO c (k) VALUES ('missing')", // FK violation → whole batch aborts
  ], 'write'));
  const n = await db.get('SELECT COUNT(*) AS n FROM c');
  assert.equal(Number(n?.n ?? n['COUNT(*)']), 0, 'batch rollback left no partial writes');
}));

test('both engines: foreign keys enforced + ON DELETE CASCADE', bothEngines(async (db) => {
  await db.run('INSERT INTO decks (id, topic, created_at) VALUES (?, ?, ?)', 'deck_1', 'T', 'now');
  await db.run('INSERT INTO deck_cards (deck_id, idx, front, back) VALUES (?, ?, ?, ?)', 'deck_1', 0, 'f', 'b');
  await db.run('DELETE FROM decks WHERE id = ?', 'deck_1');
  const left = await db.get('SELECT COUNT(*) AS n FROM deck_cards');
  assert.equal(Number(left?.n), 0, 'cascade delete works on both engines');
}));

test('both engines: exec() runs multi-statement scripts', bothEngines(async (db) => {
  await db.exec('CREATE TABLE ms1 (k INTEGER); CREATE TABLE ms2 (k INTEGER);');
  assert.ok(await db.get("SELECT name FROM sqlite_master WHERE name = 'ms2'"));
}));

test('openLocalDb migrates a fresh file to current schema version', async () => {
  const file = tempFile();
  const db = await openLocalDb(file);
  const row = await db.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
  assert.equal(Number(row?.value), CURRENT_SCHEMA_VERSION);
  for (const table of ['sources', 'study_sessions', 'decks', 'deck_cards', 'vector_chunks', 'dataset_items', 'dataset_runs', 'learner_profile', 'learner_subjects', 'learning_events']) {
    assert.ok(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", table), `table ${table} exists`);
  }
  // legacy columns present on a fresh db
  for (const col of ['session_id', 'tags_json', 'org_source', 'manual_override', 'suggestion_json', 'license', 'origin']) {
    assert.ok((await db.all(`PRAGMA table_info(sources)`)).some((c) => c.name === col), `sources.${col}`);
  }
  db.close();
});

test('openLocalDb upgrades a real legacy v1 database and preserves rows', async () => {
  // Build a deliberately OLD database: only the v1 coretables with data.
  const file = tempFile();
  const raw = nodeEngine(file);
  await raw.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
    url TEXT, page_count INTEGER, slide_count INTEGER, chunk_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    INSERT INTO sources (id, type, title, chunk_count, created_at) VALUES ('src_old', 'pdf', 'old-book.pdf', 3, '2026-01-01');`);
  raw.close();
  const db = await openLocalDb(file);
  const s = await db.get('SELECT * FROM sources WHERE id = ?', 'src_old');
  assert.equal(s?.title, 'old-book.pdf', 'row survived migration');
  assert.ok(fs.existsSync(`${file}.v1.bak`), 'v1 backup copy taken');
  const v = await db.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
  assert.equal(Number(v?.value), CURRENT_SCHEMA_VERSION);
  db.close();
  // idempotent: re-open does not break or re-badge
  const again = await openLocalDb(file);
  again.close();
});

test('repeat migrations are idempotent (run twice, version stable, data intact)', bothEngines(async (db) => {
  await db.run("INSERT INTO app_meta (key, value) VALUES ('keep', 'yes')");
  await runMigrations({ ...db, kind: db.kind }); // second pass
  await runMigrations(db);
  const keep = await db.get("SELECT value FROM app_meta WHERE key = 'keep'");
  assert.equal(keep?.value, 'yes');
  const meta = (await db.all("SELECT * FROM app_meta WHERE key = 'schema_version'")).length;
  assert.equal(meta, 1, 'no duplicate version rows');
}));

test('openAppDb picks the local engine without TURSO env', async () => {
  const saved = { u: process.env.TURSO_DATABASE_URL, t: process.env.TURSO_AUTH_TOKEN };
  delete process.env.TURSO_DATABASE_URL; delete process.env.TURSO_AUTH_TOKEN;
  try {
    const db = await openAppDb({ dbPath: tempFile() });
    assert.equal(db.kind, 'node');
    db.close();
  } finally {
    if (saved.u !== undefined) process.env.TURSO_DATABASE_URL = saved.u; else delete process.env.TURSO_DATABASE_URL;
    if (saved.t !== undefined) process.env.TURSO_AUTH_TOKEN = saved.t; else delete process.env.TURSO_AUTH_TOKEN;
  }
});

test('openAppDb: hosted file URL with pending migrations refuses boot with instructive error', async () => {
  const file = tempFile();
  const engine = libSqlEngine(`file:${file}`);
  await runMigrations(engine); // pre-create an OLD-version database
  await engine.run("INSERT INTO app_meta (key, value) VALUES ('schema_version', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  engine.close();

  const saved = { u: process.env.TURSO_DATABASE_URL, t: process.env.TURSO_AUTH_TOKEN };
  process.env.TURSO_DATABASE_URL = `file:${file}`;
  process.env.TURSO_AUTH_TOKEN = 'test-token';
  try {
    await assert.rejects(() => openAppDb(), /npm run migrate/);
    // after migrating explicitly (the script path), boot succeeds
    const db = await openAppDb({ allowRemoteMigrate: true });
    const row = await db.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
    assert.equal(Number(row?.value), CURRENT_SCHEMA_VERSION);
    db.close();
  } finally {
    if (saved.u !== undefined) process.env.TURSO_DATABASE_URL = saved.u; else delete process.env.TURSO_DATABASE_URL;
    if (saved.t !== undefined) process.env.TURSO_AUTH_TOKEN = saved.t; else delete process.env.TURSO_AUTH_TOKEN;
  }
});

test('openAppDb: TURSO_DATABASE_URL without TURSO_AUTH_TOKEN fails loudly (no values leaked)', async () => {
  const savedU = process.env.TURSO_DATABASE_URL;
  const savedT = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = 'libsql://example.turso.io';
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    await assert.rejects(() => openAppDb(), /TURSO_AUTH_TOKEN/);
  } finally {
    if (savedU !== undefined) process.env.TURSO_DATABASE_URL = savedU; else delete process.env.TURSO_DATABASE_URL;
    if (savedT !== undefined) process.env.TURSO_AUTH_TOKEN = savedT; else delete process.env.TURSO_AUTH_TOKEN;
  }
});
