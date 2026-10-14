// SQLite storage for application records (sources, quizzes, attempts, learner
// progress). Thin module over the uniform engine facade in db.js — schema
// creation, migrations and the two interchangeable engines (node:sqlite /
// libSQL) all live there. ChromaDB stays responsible for vectors and
// semantic search only.

// Remote (hosted Turso) selection is handled by openAppDb() in db.js — the
// server boots (`server/index.js`, `api/index.js`) use that; this module only
// opens the LOCAL node engine, exactly like the previous openDb did.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { openLocalDb, CURRENT_SCHEMA_VERSION } from './db.js';

export { CURRENT_SCHEMA_VERSION };

/** Open the local SQLite application database (node:sqlite engine, migrated). */
export function openDb(dbPath = path.join(config.dataDir, 'app.db')) {
  return openLocalDb(dbPath, { migrate: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`; // 12 unpredictable hex chars
}

/** Defensive parse of a stored JSON object column: never throws, non-object
 *  → `fallback`. Corrupt rows must not crash readers of saved data. */
export function parseJsonObject(text, fallback = {}) {
  try {
    const value = JSON.parse(text ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export async function logActivity(db, type, topic, detail, sessionId = null, userId) {
  // Supabase mode: a forgotten userId must fail loudly, never fall through to
  // the shared prototype owner (audit: fail-open defaults).
  if (config.supabaseUrl && (userId === undefined || userId === null || userId === '')) {
    throw new Error('logActivity requires a userId in supabase mode.');
  }
  await db.run('INSERT INTO activity (type, topic, detail, at, session_id, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    type, topic ?? null, detail, nowIso(), sessionId, userId ?? 'default');
}

// ---- app-level metadata (researched values that must survive restarts) ----

export async function getMeta(db, key) {
  const row = await db.get('SELECT value FROM app_meta WHERE key = ?', key);
  return row ? row.value : null;
}

export async function setMeta(db, key, value) {
  await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export async function delMeta(db, key) {
  await db.run('DELETE FROM app_meta WHERE key = ?', key);
}

// ---- per-user profile row (one row per user; id IS the verified userId) ----
//
// SQLite keeps the established learner_profile columns. Postgres mirrors the
// same data onto the Supabase `profiles` table (onboarding_state instead of
// state, onboarding_json holds the transcript, and purpose has its own
// column) so both engines surface the identical normalized row shape below.
const isPgEngine = (db) => db?.kind === 'pg';

function normalizePgProfile(row) {
  const fields = parseJsonObject(row.fields_json);
  if (row.purpose != null) fields.purpose = row.purpose; // dedicated pg column wins
  return {
    id: row.id,
    state: row.onboarding_state,
    transcript_json: row.onboarding_json,
    fields_json: JSON.stringify(fields),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function loadProfileRow(db, userId) {
  if (isPgEngine(db)) {
    const row = await db.get('SELECT * FROM public.profiles WHERE id = ?', userId);
    return row ? normalizePgProfile(row) : null;
  }
  return await db.get('SELECT * FROM learner_profile WHERE id = ?', userId) ?? null;
}

/**
 * Ownership-root bootstrap. On pg, EVERY per-user table (sessions, sources,
 * activity, subjects, decks, …) has a foreign key to profiles(id), so a
 * brand-new account cannot write anything until its profile row exists.
 * Onboarding normally creates it, but a fresh user may act first (create a
 * session) — so the auth guard ensures the row idempotently. SQLite does not
 * enforce those foreign keys, so it stays a no-op there.
 */
export async function ensureProfileRow(db, userId) {
  if (!isPgEngine(db)) return;
  await db.run(
    `INSERT INTO public.profiles (id, onboarding_state, onboarding_json, fields_json, created_at, updated_at)
     VALUES (?, 'new', '[]', '{}', ?, ?) ON CONFLICT (id) DO NOTHING`,
    userId, nowIso(), nowIso(),
  );
}

/**
 * Whole-row write (onboarding turn, skip, manual-first PATCH). `row` carries
 * the caller's already-validated values as { state, transcriptJson,
 * fieldsJson }. On pg, purpose is mirrored into its dedicated column; on
 * SQLite the purpose stays inside fields_json as before.
 */
export async function saveProfileRow(db, userId, { state = 'new', transcriptJson = '[]', fieldsJson = '{}' }) {
  const purpose = parseJsonObject(fieldsJson).purpose ?? null;
  if (isPgEngine(db)) {
    await db.run(
      `INSERT INTO public.profiles (id, onboarding_state, onboarding_json, fields_json, purpose, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         onboarding_state = excluded.onboarding_state,
         onboarding_json = excluded.onboarding_json,
         fields_json = excluded.fields_json,
         purpose = excluded.purpose,
         updated_at = excluded.updated_at`,
      userId, state, transcriptJson, fieldsJson, purpose, nowIso(), nowIso(),
    );
    return;
  }
  const existing = await db.get('SELECT id FROM learner_profile WHERE id = ?', userId);
  if (existing) {
    await db.run('UPDATE learner_profile SET state = ?, transcript_json = ?, fields_json = ?, updated_at = ? WHERE id = ?',
      state, transcriptJson, fieldsJson, nowIso(), userId);
  } else {
    await db.run('INSERT INTO learner_profile (id, state, transcript_json, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId, state, transcriptJson, fieldsJson, nowIso(), nowIso());
  }
}

export async function deleteProfileRow(db, userId) {
  if (isPgEngine(db)) {
    await db.run('DELETE FROM public.profiles WHERE id = ?', userId);
    return;
  }
  await db.run('DELETE FROM learner_profile WHERE id = ?', userId);
}
