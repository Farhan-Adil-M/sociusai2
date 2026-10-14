// Chooses the active vector store:
//   VECTOR_STORE=sqlite          → force the SQLite fallback
//   VECTOR_STORE=chroma          → force Chroma (cloud or local per CHROMA_*)
//   default:                     → Chroma on the laptop; on Vercel without
//     Chroma Cloud keys the SQLite fallback keeps the app fully working.

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

  return {
    backend: 'chroma',
    addChunks: chroma.addChunks,
    queryChunks: chroma.queryChunks,
    queryChunksBatch: chroma.queryChunksBatch,
    pingChroma: chroma.pingChroma,
    countChunks: chroma.countChunks,
    resetCollection: chroma.resetCollection,
    deleteChunks: chroma.deleteChunks,
  };
}
