// One-off schema migration for the configured database target.
//   local (default) : node --env-file=.env npm run migrate  → data/app.db (auto-migrated on boot anyway)
//   hosted (Turso)  : TURSO_DATABASE_URL/TURSO_AUTH_TOKEN set → migrates the remote schema.
//   supabase        : SUPABASE_DB_URL set → reports schema_version only; the Postgres
//                     DDL is engine-specific and applied by `npm run migrate:supabase`.
// Idempotent + additive: safe to re-run; never drops or recreates anything.

import { openAppDb, CURRENT_SCHEMA_VERSION } from '../server/store/db.js';
import { config } from '../server/config.js';

const localPath = process.env.SQLITE_DB_PATH || `${config.dataDir}/app.db`;
const target = (config.supabaseDbUrl ?? '').trim()
  ? 'supabase (SUPABASE_DB_URL) — apply the schema with npm run migrate:supabase'
  : (config.tursoDatabaseUrl ?? '').trim()
    ? 'hosted (TURSO_DATABASE_URL)'
    : `local ${localPath}`;

const engine = await openAppDb({ allowRemoteMigrate: true });
try {
  const row = await engine.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
  const version = row ? Number(row.value) : 1;
  console.log(`[migrate] target: ${target}`);
  console.log(`[migrate] schema_version now ${version} (this build expects ${CURRENT_SCHEMA_VERSION})`);
  console.log(version >= CURRENT_SCHEMA_VERSION ? '[migrate] OK — schema is current.' : '[migrate] WARN — still behind.');
} finally {
  engine.close?.();
}
