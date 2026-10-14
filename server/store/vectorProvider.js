// Chooses the active vector store:
//   VECTOR_STORE=sqlite          → force the SQLite fallback
//   VECTOR_STORE=chroma          → force Chroma (cloud or local per CHROMA_*)
//   default:                     → Chroma on the laptop; on Vercel without
//     Chroma Cloud keys the SQLite fallback keeps the app fully working.
//
// Resilience: when Chroma is configured but unreachable (the local Chroma
// server simply is not running), the first data operation logs one line and
// switches this process to the SQLite fallback instead of failing the request.
// The switch is sticky, so a single process never reads one store and writes
// another. Health keeps reporting Chroma honestly until that switch happens.

import { config } from '../config.js';
import { createSqliteVectorStore } from './sqlite-vector.js';
import * as chroma from './vectorStore.js';

export function resolveVectorStore(db) {
  const choice = (process.env.VECTOR_STORE ?? '').trim().toLowerCase();
  const onVercel = process.env.VERCEL === '1';
  const chromaConfigured = !!config.chromaApiKey;

  let backend;
  if (choice === 'sqlite') backend = 'sqlite';
  else if (choice === 'chroma') backend = 'chroma';
  else backend = onVercel && !chromaConfigured ? 'sqlite' : 'chroma';

  if (backend === 'sqlite') {
    return createSqliteVectorStore(db);
  }

  return createResilientChromaStore(db);
}

/**
 * A Chroma store that degrades to the SQLite fallback when — and only when —
 * Chroma cannot be reached. Validation problems (bad vectors, oversized
 * metadata, a collection built with a different embedding model) are real
 * errors and are re-thrown untouched; quietly answering from a fallback would
 * hide them.
 */
function createResilientChromaStore(db) {
  let sqliteStore = null;
  let degraded = false;

  const sqlite = () => (sqliteStore ??= createSqliteVectorStore(db));

  function degrade(operation, cause) {
    if (degraded) return;
    degraded = true;
    console.warn(`[vector] Chroma is unreachable during ${operation} (${cause?.message ?? cause}) — using the SQLite fallback for this process. Start the Chroma server and restart to go back.`);
  }

  async function through(operation, chromaCall, sqliteCall) {
    if (degraded) return sqliteCall();
    try {
      return await chromaCall();
    } catch (err) {
      // No database handle means no fallback to fall back to: surface the
      // original error instead of failing later with a confusing one.
      if (!chroma.isVectorStoreUnavailable(err) || !db) throw err;
      degrade(operation, err);
      return sqliteCall();
    }
  }

  return {
    // Read-only status. Starts as 'chroma' (the choice) and only reports
    // 'sqlite' once a call has actually proved Chroma unreachable.
    get backend() { return degraded ? 'sqlite' : 'chroma'; },

    addChunks: (args) => through('addChunks', () => chroma.addChunks(args), () => sqlite().addChunks(args)),
    queryChunks: (args) => through('queryChunks', () => chroma.queryChunks(args), () => sqlite().queryChunks(args)),
    queryChunksBatch: (args) => through('queryChunksBatch', () => chroma.queryChunksBatch(args), () => sqlite().queryChunksBatch(args)),
    deleteChunks: (ids) => through('deleteChunks', () => chroma.deleteChunks(ids), () => sqlite().deleteChunks(ids)),
    deleteBySource: (sourceId, userId) => through(
      'deleteBySource',
      () => chroma.deleteBySource(sourceId, userId),
      () => sqlite().deleteBySource(sourceId, userId),
    ),
    countChunks: () => through('countChunks', () => chroma.countChunks(), () => sqlite().countChunks()),
    resetCollection: () => through('resetCollection', () => chroma.resetCollection(), () => sqlite().resetCollection()),

    // Health asks pingChroma directly. It stays honest about Chroma: reporting
    // the reachable fallback only after a data operation has already degraded
    // this process. A failed ping must not by itself switch us to SQLite — a
    // health poll racing a Chroma cold start would otherwise strand the whole
    // process on the fallback.
    pingChroma: () => (degraded ? sqlite().pingChroma() : chroma.pingChroma()),
  };
}
