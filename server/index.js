// Server entrypoint: validate configuration, open storage (which applies the
// database migrations for the selected engine), start listening, and shut down
// cleanly on Ctrl-C / container stop.

import os from 'node:os';
import { assertConfig, config } from './config.js';
import { openAppDb } from './store/db.js';
import { createApp } from './app.js';

assertConfig();

// openAppDb() runs the migrations for whichever engine it selects:
//  - local node:sqlite file → migrated in place (openLocalDb → runMigrations);
//  - hosted libSQL/Turso   → migrated when it is behind this build;
//  - Supabase / Postgres   → only *verified*: its schema is applied once by
//    `npm run migrate:supabase`, and booting against a behind-schema database
//    is refused there on purpose.
const db = await openAppDb();
const app = await createApp({ db });

// Bind address comes from BIND_HOST (default 127.0.0.1 — loopback only).
// Set a LAN address or 0.0.0.0 to let other devices on the network connect;
// every private endpoint requires a verified user (Supabase JWT in supabase
// mode, the fixed dev user in prototype mode), but a WAN address still
// deserves firewall care.
const BIND_HOST = config.bindHost;
const isLoopback = BIND_HOST === '127.0.0.1' || BIND_HOST === '::1' || BIND_HOST === 'localhost';

// IPv4 addresses other devices can use to reach this machine (empty on loopback).
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const server = app.listen(config.port, BIND_HOST, () => {
  if (isLoopback) {
    console.log(`Socius AI server running at http://localhost:${config.port} (bound to ${BIND_HOST} — not reachable from other devices)`);
  } else {
    console.log(`Socius AI server running at http://localhost:${config.port} (bound to ${BIND_HOST})`);
    const urls = lanAddresses().map((ip) => `http://${ip}:${config.port}`);
    if (urls.length > 0) {
      console.log('  open from another device:');
      for (const url of urls) console.log(`    ${url}`);
    } else {
      console.log('  no LAN IPv4 address found for this machine');
    }
    console.log(
      config.supabaseUrl && config.supabaseAnonKey
        ? '  authentication: Supabase JWT required on every private endpoint.'
        : '  WARNING: prototype mode — no authentication (fixed dev user).\n  Do not expose this beyond a trusted network.',
    );
  }
  console.log(`  health:         http://localhost:${config.port}/api/health`);
  console.log(`  tutor model:    ${config.aiRouter.tutorModel}`);
  console.log(`  assessment:     ${config.aiRouter.assessModel}`);
  console.log(`  embedding:      ${config.aiRouter.embedModel}`);
  console.log(`  database:       ${db.kind === 'libsql' ? 'hosted (libSQL/Turso)' : db.kind === 'pg' ? 'Supabase / Postgres' : 'local SQLite (node:sqlite)'} [${db.kind}]`);
  console.log(`  vector store:   ${config.chromaApiKey ? 'Chroma Cloud' : `local (${config.chromaLocalHost}:${config.chromaLocalPort})`}`);
});

// --- graceful shutdown ------------------------------------------------------

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] shutting down…`);

  // Never hang forever on a stuck connection or a slow database close.
  const forceExit = setTimeout(() => {
    console.error('[shutdown] did not finish within 10s — exiting');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async (err) => {
    if (err) console.error('[shutdown] closing the server failed:', err.message);
    try {
      await db.close?.();
    } catch (closeErr) {
      console.error('[shutdown] closing the database failed:', closeErr.message);
    }
    clearTimeout(forceExit);
    process.exit(err ? 1 : 0);
  });
  // Stop accepting new work immediately; idle keep-alive sockets would
  // otherwise hold server.close() open.
  server.closeIdleConnections?.();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});
