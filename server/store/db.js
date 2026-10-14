    // Local-only remains-usable shim for the tests/fixtures + admin scripts
    // that seed fixtures via sync statements. The hosted engine throws on
    // prepare() on purpose (see below) so no un-converted call site can ever
    // run against production storage.
// Uniform ASYNC database facade with two interchangeable engines:
//   node:sqlite (local files — the established engine; FKs on by default)
//   @libsql/client (local file: URLs for tests, or hosted Turso in production)
// Exposed interface on BOTH engines (all methods async):
//   get(sql, ...args) → first row or null
//   all(sql, ...args) → array of rows
//   run(sql, ...args) → { changes, lastInsertRowid: number }
//   exec(sql)         → multi-statement DDL/script
//   batch(statements, 'write'|'read'|'deferred') → atomic transaction
// The node engine additionally provides a prepare() shim so not-yet-converted
// call sites keep working locally during the migration; the hosted engine
// throws on prepare() so no site can bypass conversion before prod use.

import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import postgres from 'postgres';

/** Mirror of sqlite.js's create-block; identical shapes, idempotent CREATEs. */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sources (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT,
    page_count  INTEGER,
    slide_count INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    session_id  TEXT,
    tags_json   TEXT NOT NULL DEFAULT '[]',
    org_source  TEXT NOT NULL DEFAULT 'manual',
    manual_override INTEGER NOT NULL DEFAULT 0,
    suggestion_json TEXT
  );
  CREATE TABLE IF NOT EXISTS source_segments (
    source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    seg_index  INTEGER NOT NULL,
    location   TEXT NOT NULL,
    text       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS study_sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'subject',
    description TEXT,
    tags_json   TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quizzes (
    id             TEXT PRIMARY KEY,
    topic          TEXT NOT NULL,
    difficulty     TEXT NOT NULL,
    question_count INTEGER NOT NULL,
    created_at     TEXT NOT NULL,
    answered_at    TEXT,
    session_id     TEXT
  );
  CREATE TABLE IF NOT EXISTS quiz_questions (
    quiz_id           TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    idx               INTEGER NOT NULL,
    text              TEXT NOT NULL,
    choices_json      TEXT NOT NULL,
    correct_choice_id TEXT NOT NULL,
    explanation       TEXT NOT NULL DEFAULT '',
    citations_json    TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (quiz_id, idx)
  );
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    quiz_id      TEXT PRIMARY KEY REFERENCES quizzes(id),
    answers_json TEXT NOT NULL,
    correct      INTEGER NOT NULL,
    total        INTEGER NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS learner_topics (
    topic             TEXT PRIMARY KEY,
    correct           INTEGER NOT NULL DEFAULT 0,
    total             INTEGER NOT NULL DEFAULT 0,
    difficulty        TEXT NOT NULL DEFAULT 'medium',
    updated_at        TEXT NOT NULL,
    last_practiced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    topic      TEXT,
    detail     TEXT NOT NULL,
    at         TEXT NOT NULL,
    session_id TEXT
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decks (
    id               TEXT PRIMARY KEY,
    session_id       TEXT REFERENCES study_sessions(id),
    topic            TEXT NOT NULL,
    source_ids_json  TEXT NOT NULL DEFAULT '[]',
    card_count       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    last_reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS deck_cards (
    deck_id        TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    idx            INTEGER NOT NULL,
    front          TEXT NOT NULL,
    back           TEXT NOT NULL,
    citations_json TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'new',
    reviewed_at    TEXT,
    PRIMARY KEY (deck_id, idx)
  );

  CREATE TABLE IF NOT EXISTS learner_profile (
    id              TEXT PRIMARY KEY,
    state           TEXT NOT NULL DEFAULT 'new',
    transcript_json TEXT NOT NULL DEFAULT '[]',
    fields_json     TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS learner_subjects (
    subject     TEXT PRIMARY KEY,
    familiarity TEXT NOT NULL,
    confidence  INTEGER,
    source      TEXT NOT NULL DEFAULT 'stated',
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS learning_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    topic       TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    weight      INTEGER NOT NULL DEFAULT 1,
    at          TEXT NOT NULL
  );
`;

export const CURRENT_SCHEMA_VERSION = 7;

// ---- versioned, additive, idempotent migrations (single source of truth) ----
// One surgical mirror of stores/sqlite.js's migrate() chain (v2..v6), written
// against engine methods so BOTH engines run the identical chain.

async function readSchemaVersion(engine) {
  const row = await engine.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
  return row ? Number(row.value) : 1;
}

async function addColumnIfMissing(engine, table, column, ddl) {
  const present = new Set((await engine.all(`PRAGMA table_info(${table})`)).map((c) => c.name));
  if (!present.has(column)) await engine.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export async function runMigrations(engine, { dbPath } = {}) {
  await engine.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const version = await readSchemaVersion(engine);

  // v2 legacy safety-net copy (local node engine only — hosted dbs get a real
  // backup story from the provider).
  if (engine.kind === 'node' && version < 2 && dbPath && fs.existsSync(dbPath)
      && !fs.existsSync(`${dbPath}.v1.bak`)) {
    try { fs.copyFileSync(dbPath, `${dbPath}.v1.bak`); } catch { /* read-only fs */ }
  }

  await engine.exec(SCHEMA_SQL);

  // v2: session organisation columns
  await addColumnIfMissing(engine, 'sources', 'session_id', 'session_id TEXT');
  await addColumnIfMissing(engine, 'sources', 'tags_json', "tags_json TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing(engine, 'sources', 'org_source', "org_source TEXT NOT NULL DEFAULT 'manual'");
  await addColumnIfMissing(engine, 'sources', 'manual_override', 'manual_override INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(engine, 'sources', 'suggestion_json', 'suggestion_json TEXT');
  await addColumnIfMissing(engine, 'quizzes', 'session_id', 'session_id TEXT');
  await addColumnIfMissing(engine, 'activity', 'session_id', 'session_id TEXT');

  // v3: exact replay of the first submission
  await addColumnIfMissing(engine, 'quiz_attempts', 'result_json', 'result_json TEXT');

  // v4: dataset-ingestion pilot columns/tables (schema only — CLI-only feature)
  await addColumnIfMissing(engine, 'sources', 'license', 'license TEXT');
  await addColumnIfMissing(engine, 'sources', 'origin', "origin TEXT NOT NULL DEFAULT 'upload'");
  await engine.exec(`CREATE TABLE IF NOT EXISTS dataset_items (
    id             TEXT PRIMARY KEY,
    dataset        TEXT NOT NULL,
    split          TEXT NOT NULL,
    row_idx        INTEGER NOT NULL,
    record_key     TEXT NOT NULL UNIQUE,
    question       TEXT NOT NULL,
    correct_answer TEXT NOT NULL,
    choices_json   TEXT NOT NULL DEFAULT '[]',
    support        TEXT,
    license        TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dataset_runs (
    id           TEXT PRIMARY KEY,
    dataset      TEXT NOT NULL,
    split        TEXT NOT NULL,
    stats_json   TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'running',
    started_at   TEXT NOT NULL,
    finished_at  TEXT
  );`);

  // v5: serverless vector-fallback storage
  await engine.exec(`CREATE TABLE IF NOT EXISTS vector_chunks (
    id             TEXT PRIMARY KEY,
    source_id      TEXT,
    text           TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    metadata_json  TEXT NOT NULL DEFAULT '{}'
  );`);

  // ---- v7: per-user ownership (accounts and durable user data) --------------
  // Adds user_id to every directly-queried owner table and rebuilds the two
  // tables whose PRIMARY KEY was the natural key (topic / subject) into
  // composite (user_id, key) PKs so separate accounts can work on the same
  // topic independently. Node-side safety: one-time .v6.bak copy before any
  // drop. The Postgres engine never runs this chain (its schema lives in
  // store/pg-schema.sql and already has composite keys + user_id).
  if (engine.kind === 'node' && version < 7) {
    for (const t of ['study_sessions', 'sources', 'quizzes', 'quiz_attempts', 'decks', 'activity', 'learning_events',
                     'learner_topics', 'learner_subjects']) {
      await addColumnIfMissing(engine, t, 'user_id', "user_id TEXT NOT NULL DEFAULT 'default'");
    }
    await addColumnIfMissing(engine, 'vector_chunks', 'user_id', "user_id TEXT NOT NULL DEFAULT 'default'");

    if (dbPath && fs.existsSync(dbPath) && !fs.existsSync(`${dbPath}.v6.bak`)) {
      try { fs.copyFileSync(dbPath, `${dbPath}.v6.bak`); } catch { /* read-only fs */ }
    }

    // rebuild #1: learner_topics (user_id, topic)
    await engine.exec(`CREATE TABLE learner_topics_v7 (
      user_id TEXT NOT NULL DEFAULT 'default',
      topic TEXT NOT NULL DEFAULT '',
      correct INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      difficulty TEXT NOT NULL DEFAULT 'medium',
      updated_at TEXT NOT NULL,
      last_practiced_at TEXT,
      PRIMARY KEY (user_id, topic)
    );`);
    await engine.exec(`INSERT INTO learner_topics_v7 (user_id, topic, correct, total, difficulty, updated_at, last_practiced_at)
      SELECT user_id, topic, correct, total, difficulty, updated_at, last_practiced_at FROM learner_topics;`);
    await engine.exec('DROP TABLE learner_topics;');
    await engine.exec('ALTER TABLE learner_topics_v7 RENAME TO learner_topics;');

    // rebuild #2: learner_subjects (user_id, subject)
    await engine.exec(`CREATE TABLE learner_subjects_v7 (
      user_id TEXT NOT NULL DEFAULT 'default',
      subject TEXT NOT NULL DEFAULT '',
      familiarity TEXT NOT NULL,
      confidence INTEGER,
      source TEXT NOT NULL DEFAULT 'stated',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, subject)
    );`);
    await engine.exec(`INSERT INTO learner_subjects_v7 (user_id, subject, familiarity, confidence, source, updated_at)
      SELECT user_id, subject, familiarity, confidence, source, updated_at FROM learner_subjects;`);
    await engine.exec('DROP TABLE learner_subjects;');
    await engine.exec('ALTER TABLE learner_subjects_v7 RENAME TO learner_subjects;');

    // rebuild #3: learner_profile — its key becomes the VERIFIED user id
    // (Supabase uuid, or the prototype dev user 'default'); the legacy
    // CHECK (id = 'default') would reject every real account, so the table is
    // rebuilt row-for-row without it.
    await engine.exec(`CREATE TABLE learner_profile_v7 (
      id              TEXT PRIMARY KEY,
      state           TEXT NOT NULL DEFAULT 'new',
      transcript_json TEXT NOT NULL DEFAULT '[]',
      fields_json     TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );`);
    await engine.exec(`INSERT INTO learner_profile_v7 (id, state, transcript_json, fields_json, created_at, updated_at)
      SELECT id, state, transcript_json, fields_json, created_at, updated_at FROM learner_profile;`);
    await engine.exec('DROP TABLE learner_profile;');
    await engine.exec('ALTER TABLE learner_profile_v7 RENAME TO learner_profile;');
  }

  if (version < CURRENT_SCHEMA_VERSION) {
    await engine.run(
      "INSERT INTO app_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(CURRENT_SCHEMA_VERSION),
    );
  }
  return { from: version, to: CURRENT_SCHEMA_VERSION };
}


// The libsql local "sqlite3" client's execute() silently runs ONLY the first
// statement of a multi-statement script — so exec() must split statements and
// use batch() (verified atomic + multi-capable). Our schema never contains
// semicolons inside string literals, so a naive ';' split is safe here.
function splitStatements(sql) {
  return String(sql)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt !== '');
}

// ---- engines -----------------------------------------------------------------

export function nodeEngine(dbPath) {
  const raw = new DatabaseSync(dbPath);
  const normalize = (r) => ({
    changes: Number(r.changes ?? 0),
    lastInsertRowid: Number(r.lastInsertRowid ?? 0),
  });
  return {
    kind: 'node',
    dbPath,
    async get(sql, ...args) { return raw.prepare(sql).get(...args) ?? null; },
    async all(sql, ...args) { return raw.prepare(sql).all(...args); },
    async run(sql, ...args) { return normalize(raw.prepare(sql).run(...args)); },
    async exec(sql) { raw.exec(sql); },
    async batch(statements, _mode = 'write') {
      const results = [];
      raw.exec('BEGIN IMMEDIATE');
      try {
        for (const stmt of statements) {
          const { sql, args } = typeof stmt === 'string' ? { sql: stmt, args: [] } : stmt;
          results.push(normalize(raw.prepare(sql).run(...(args ?? []))));
        }
        raw.exec('COMMIT');
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* connection-level edge */ }
        throw err;
      }
      return { results };
    },
    // Transition shim: not-yet-converted sync call sites (tests, mid-flight
    // waves) keep working against the local engine. Deleted when the last
    // call site is converted.
    prepare(sql) { return raw.prepare(sql); },
    close() { raw.close(); },
  };
}

export function libSqlEngine(url, authToken) {
  const raw = createClient({ url, authToken });
  const normalize = (r) => ({
    changes: Number(r.rowsAffected ?? 0),
    lastInsertRowid: Number(r.lastInsertRowid ?? 0),
  });
  return {
    kind: 'libsql',
    async get(sql, ...args) { const r = await raw.execute({ sql, args }); return r.rows[0] ?? null; },
    async all(sql, ...args) { const r = await raw.execute({ sql, args }); return Array.from(r.rows); },
    async run(sql, ...args) { return normalize(await raw.execute({ sql, args })); },
    async exec(sql) {
      const statements = splitStatements(sql);
      if (statements.length <= 1) {
        await raw.execute(statements[0] ?? 'SELECT 1');
        return;
      }
      await raw.batch(statements.map((st) => ({ sql: st, args: [] })), 'write');
    },
    async batch(statements, mode = 'write') {
      const list = statements.map((stmt) => (typeof stmt === 'string' ? { sql: stmt, args: [] } : stmt));
      const results = await raw.batch(list, mode);
      return { results: results.map(normalize) };
    },
    prepare() {
      throw new Error(
        'prepare() is only available on the local node:sqlite engine. Convert this call site to the facade (get/all/run/batch in server/store/db.js).',
      );
    },
    close() { raw.close?.(); },
  };
}


// ---- Postgres (Supabase) engine — third engine behind the same facade ------
// Placeholder contract stays `?` at every call site; translated to `$n` here
// with a per-statement counter (our SQL never contains a literal '?' —
// messages with question marks live in code, not in SQL text). DDL for this
// engine lives in store/pg-schema.sql (applied by scripts/migrate-supabase.mjs).

export function pgEngine(url) {
  const raw = postgres(url, { prepare: false, max: 5 }); // pooler-safe
  const toPg = (sql) => {
    let n = 0;
    return sql.replace(/\?/g, () => '$' + (++n));
  };
  const trim = (r) => ({ changes: r.count ?? 0, lastInsertRowid: 0 });
  return {
    kind: 'pg',
    async get(sql, ...args) { const r = await raw.unsafe(toPg(sql), args); return r[0] ?? null; },
    async all(sql, ...args) { return await raw.unsafe(toPg(sql), args); },
    async run(sql, ...args) { const r = await raw.unsafe(toPg(sql), args); return trim(r); },
    async exec(sql) { await raw.unsafe(toPg(sql)); },
    async batch(statements, _mode = 'write') {
      const results = [];
      await raw.begin(async (tx) => {
        for (const stmt of statements) {
          const { sql, args } = typeof stmt === 'string' ? { sql: stmt, args: [] } : stmt;
          const r = await tx.unsafe(toPg(sql), args);
          results.push(trim(r));
        }
      });
      return { results };
    },
    prepare() {
      throw new Error(
        'prepare() is not available on the Postgres engine. Convert this call site to the facade (get/all/run/batch in server/store/db.js).'
      );
    },
    close() { raw.end({ timeout: 1 }); },
  };
}


// ---- configuration ----------------------------------------------------------

function envMissing(name) {
  return new Error(`Missing required configuration: ${name} is set but not its companion value (production stays disabled until both are configured).`);
}

/**
 * Open the application database.
 * - TURSO_DATABASE_URL set     → hosted libSQL engine. Migrations are NOT run
 *   here: the boot refuses with an instruction when the hosted schema is
 *   behind this build (use `npm run migrate` once from a trusted machine).
 *   allowRemoteMigrate=true is reserved for the migration script.
 * - otherwise                  → local node:sqlite file (auto-migrates, as
 *   `npm start` always has).
 * Never allows remote without TURSO_AUTH_TOKEN; error names the missing var
 * without leaking any value.
 */
export async function openAppDb({ dbPath, migrate = true, allowRemoteMigrate = false } = {}) {
  // SQLITE_DB_PATH is the deployment contract for the local engine (docs; also
  // used by the serverless entry). Explicit args always win.
  if (!dbPath) dbPath = process.env.SQLITE_DB_PATH || undefined;
  // NOTE: config captured env values at import time as '' — empty strings are
  // "unset", so fall through with || (?? would keep the empty string).
  // Supabase mode wins when its direct-connection URL is present.
  const supabaseDb = (config.supabaseDbUrl || process.env.SUPABASE_DB_URL || '').trim();
  const remoteUrl = (config.tursoDatabaseUrl || process.env.TURSO_DATABASE_URL || '').trim();
  const remoteToken = (config.tursoAuthToken || process.env.TURSO_AUTH_TOKEN || '').trim();

  if (supabaseDb) {
    const engine = pgEngine(supabaseDb);
    if (migrate || allowRemoteMigrate) {
      if (migrate && !allowRemoteMigrate) {
        // Hosted app_meta is created by scripts/migrate-supabase.mjs together
        // with the whole schema; refuse to boot a behind-schema hosted db.
        const row = await engine.get("SELECT value FROM public.app_meta WHERE key = 'schema_version'");
        const version = row ? Number(row.value) : 1;
        if (version < CURRENT_SCHEMA_VERSION) {
          engine.close?.();
          throw new Error(
            `The hosted database is at schema version ${version} but this build expects ${CURRENT_SCHEMA_VERSION}. Run "npm run migrate:supabase" once from a trusted machine, then start the server.`,
          );
        }
      }
      // allowRemoteMigrate → scripts/migrate-supabase.mjs applies pg-schema.sql itself.
      // (pg migrations are engine-specific and live there, not in runMigrations.)
    }
    return engine;
  }

  if (remoteUrl) {
    if (!remoteToken) throw envMissing('TURSO_AUTH_TOKEN');
    const engine = libSqlEngine(remoteUrl, remoteToken);
    if (migrate || allowRemoteMigrate) {
      if (migrate && !allowRemoteMigrate) {
        await engine.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
        const version = await readSchemaVersion(engine);
        if (version < CURRENT_SCHEMA_VERSION) {
          engine.close?.();
          throw new Error(
            `The hosted database is at schema version ${version} but this build expects ${CURRENT_SCHEMA_VERSION}. Run "npm run migrate" once from a trusted machine, then start the server.`,
          );
        }
      } else {
        await runMigrations(engine);
      }
    }
    return engine;
  }

  const engine = await openLocalDb(dbPath, { migrate });
  return engine;
}

/** Local node:sqlite engine at a given path, migrated. Tests and scripts use this directly. */
export async function openLocalDb(dbPath, { migrate = true } = {}) {
  const localPath = dbPath ?? path.join(config.dataDir, 'app.db');
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const engine = nodeEngine(localPath);
  if (migrate) await runMigrations(engine, { dbPath: localPath });
  return engine;
}
