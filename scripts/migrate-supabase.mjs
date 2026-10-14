// Apply the Supabase/Postgres schema (server/store/pg-schema.sql) and stamp
// app_meta.schema_version. Idempotent: CREATE IF NOT EXISTS + policies are
// dropped and recreated; never drops tables or data.
import fs from 'node:fs';
import path from 'node:path';
import { openAppDb, CURRENT_SCHEMA_VERSION } from '../server/store/db.js';

const engine = await openAppDb({ allowRemoteMigrate: true });
try {
  const ddl = fs.readFileSync(path.resolve('server/store/pg-schema.sql'), 'utf8');
  // The facade splits multi-statement scripts for the pg engine and runs them
  // in one transaction-containing pass (exec/batch wording on pg goes through
  // postgres-js directly — safe to feed the whole script to `exec`).
  await engine.exec(ddl);
  const stamp = await engine.run(
    "INSERT INTO public.app_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    String(CURRENT_SCHEMA_VERSION),
  );
  console.log('[migrate:supabase] schema applied, schema_version =', CURRENT_SCHEMA_VERSION, '(stamp changes:', stamp.changes, ')');
  const maybe = await engine.get("SELECT value FROM public.app_meta WHERE key = 'schema_version'");
  console.log('[migrate:supabase] verified version:', maybe?.value);
} finally {
  engine.close?.();
}
