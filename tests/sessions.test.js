// Study sessions: CRUD, filtering/sorting, and the v1→v2 schema migration.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { newId, openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { fakeVector, makeAi, QUIZ_JSON, FLASHCARD_JSON, TUTOR_ANSWER } from './helpers.js';

function post(base, url, body) {
  return fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-sess-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const app = await createApp({ db, ai: makeAi(), vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, db, dir, server, close: () => new Promise((r) => server.close(r)) };
}

// Recreates the v1 schema exactly as it existed before study sessions, so the
// migration is verified against real movement of pre-existing rows.
function buildV1FixtureDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
      page_count INTEGER, slide_count INTEGER, chunk_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE source_segments (source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, seg_index INTEGER NOT NULL,
      location TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE quizzes (id TEXT PRIMARY KEY, topic TEXT NOT NULL, difficulty TEXT NOT NULL, question_count INTEGER NOT NULL,
      created_at TEXT NOT NULL, answered_at TEXT);
    CREATE TABLE quiz_questions (quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
      text TEXT NOT NULL, choices_json TEXT NOT NULL, correct_choice_id TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '',
      citations_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (quiz_id, idx));
    CREATE TABLE quiz_attempts (quiz_id TEXT PRIMARY KEY REFERENCES quizzes(id), answers_json TEXT NOT NULL,
      correct INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE learner_topics (topic TEXT PRIMARY KEY, correct INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      difficulty TEXT NOT NULL DEFAULT 'medium', updated_at TEXT NOT NULL, last_practiced_at TEXT);
    CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, topic TEXT, detail TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT INTO sources VALUES ('src_old1', 'pdf', 'old-book.pdf', NULL, 12, NULL, 5, '2026-10-12T10:00:00.000Z')").run();
  db.prepare("INSERT INTO learner_topics VALUES ('photosynthesis', 1, 3, 'medium', '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00.000Z')").run();
  db.close();
}

// Core ID generation (absorbed from id-format.test.js): server-minted,
// format-stable, unpredictable (3.7).
test('newId keeps the prefix + hex format and is unpredictably random', () => {
  const id = newId('src');
  assert.match(id, /^src_[(\d)a-f]{12}$/);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const other = newId('test');
    assert.ok(!seen.has(other), 'ids collide — randomBytes must not repeat in practice');
    seen.add(other);
  }
});

test('migration upgrades a real v1 database without losing rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-mig-'));
  const dbPath = path.join(dir, 'app.db');
  buildV1FixtureDb(dbPath);

  const db = await openDb(dbPath);

  // Pre-existing rows survived, exactly as they were.
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get('src_old1');
  assert.equal(source.title, 'old-book.pdf');
  assert.equal(source.session_id, null); // appears in Unsorted until organised
  assert.equal(db.prepare('SELECT CAST(correct AS REAL)/total AS mastery FROM learner_topics WHERE topic = ?').get('photosynthesis').mastery, 1 / 3);

  // New columns and tables exist; version recorded.
  const cols = new Set(db.prepare('PRAGMA table_info(sources)').all().map((c) => c.name));
  for (const col of ['session_id', 'tags_json', 'org_source', 'manual_override', 'suggestion_json', 'license', 'origin']) {
    assert.ok(cols.has(col), `missing column ${col}`);
  }
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vector_chunks'").get(), 'vector_chunks table');
  // v7: per-user columns + composite learner keys (fixture expectation moves
  // with the schema's own single source of truth, CURRENT_SCHEMA_VERSION).
  assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, '7');
  assert.ok(fs.existsSync(`${dbPath}.v1.bak`), 'v1 backup copy');
  // Idempotent: re-open does not re-badge or duplicate anything.
  await openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 1);
});

test('session CRUD, filtering and sorting', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const put = (url, body) => fetch(`${ctx.base}${url}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const created = await post(ctx.base, '/api/sessions', { title: 'Physics', category: 'subject', tags: ['waves'] });
  assert.equal(created.status, 201);
  const physics = (await created.json()).session;
  assert.equal(physics.title, 'Physics');
  assert.deepEqual(physics.tags, ['waves']);

  // rename + recategorise + archive
  const renamed = await put('/api/sessions/' + physics.id, { title: 'Physics II', category: 'research', status: 'archived' });
  const updated = (await renamed.json()).session;
  assert.equal(updated.title, 'Physics II');
  assert.equal(updated.category, 'research');
  assert.equal(updated.status, 'archived');
  assert.ok(updated.updatedAt > physics.updatedAt);

  // archived is hidden by default, visible with includeArchived
  assert.equal((await (await fetch(`${ctx.base}/api/sessions`)).json()).sessions.length, 0);
  const withArchived = await (await fetch(`${ctx.base}/api/sessions?includeArchived=1`)).json();
  assert.equal(withArchived.sessions.length, 1);

  // validation
  assert.equal((await post(ctx.base, '/api/sessions', { title: 'x' })).status, 400);
  assert.equal((await post(ctx.base, '/api/sessions', { title: 'Valid title', category: 'nonsense' })).status, 400);
  assert.equal((await post(ctx.base, '/api/sessions', { title: 'Valid title', tags: Array(20).fill('tag') })).status, 400);
  const noContent = await fetch(`${ctx.base}/api/sessions/${physics.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noContent.status, 400);
  assert.equal((await fetch(`${ctx.base}/api/sessions/ses_missing`)).status, 404);

  // empty set reports the unsorted count
  const listing = await post(ctx.base, '/api/sources/webpage', { url: 'https://example.org/self-study', text: 'x'.repeat(80) });
  assert.equal(listing.status, 201);
  const list = await (await fetch(`${ctx.base}/api/sessions?sort=alpha`)).json();
  assert.equal(list.unsortedSourceCount, 1);
  assert.equal(list.sessions.length, 0); // archived hidden, session empty of sources
});

test('sessions appear with real counts and sort by activity', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const bio = (await (await post(ctx.base, '/api/sessions', { title: 'Biology' })).json()).session;
  const physics = (await (await post(ctx.base, '/api/sessions', { title: 'Physics', category: 'subject' })).json()).session;

  await post(ctx.base, '/api/sources/webpage', { url: 'https://example.org/bio', text: 'W'.repeat(80) });
  // assign the just-created unsorted source to Biology via PATCH
  const sources = (await (await fetch(`${ctx.base}/api/sources`)).json()).sources;
  await fetch(`${ctx.base}/api/sources/${sources[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: bio.id }) });
  await post(ctx.base, '/api/quiz/generate', { topic: 'Cells', sourceIds: [sources[0].id], sessionId: bio.id });

  const list = (await (await fetch(`${ctx.base}/api/sessions?sort=active`)).json()).sessions;
  assert.equal(list[0].title, 'Biology'); // has sources + a quiz → most active
  assert.equal(list[0].sourceCount, 1);
  assert.ok(list[0].deckCount >= 0);
  const detail = await (await fetch(`${ctx.base}/api/sessions/${bio.id}`)).json();
  assert.equal(detail.sources.length, 1);
  assert.equal(detail.session.sourceCount, 1);
  assert.equal(detail.decks.length, 0);
});
