// Shared fixtures for HTTP-API tests: a stubbed AI provider and an in-memory
// stand-in for ChromaDB, so the whole loop can be exercised without network.

export const EMBEDDING = Array(2048).fill(0.5);
export const TUTOR_ANSWER = 'Mitosis produces two identical daughter cells [1].';
export const QUIZ_JSON = JSON.stringify({
  questions: [
    { question: 'Which process produces two identical cells?', choices: ['Mitosis', 'Meiosis', 'Fusion', 'Diffusion'], answer: 'Mitosis', explanation: 'Mitosis copies the nucleus once.', cite: [1, 2] },
    { question: 'How many divisions does meiosis involve?', choices: ['One', 'Two', 'Three', 'None'], answer: 'Two', explanation: 'Meiosis divides twice.', cite: [2] },
    { question: 'Where does mitosis occur in the cell?', choices: ['Nucleus', 'Ribosome', 'Membrane', 'Vacuole'], answer: 'Nucleus', explanation: 'The nucleus divides.', cite: [1] },
  ],
});
export const FLASHCARD_JSON = JSON.stringify({
  cards: [
    { front: 'What does mitosis produce?', back: 'Two genetically identical daughter cells.', cite: [1] },
    { front: 'How many cells does meiosis produce?', back: 'Four.Cells each with half the chromosome number.', cite: [2] },
    { front: 'What happens during DNA replication?', back: 'The cell copies its entire genome before dividing.', cite: [3] },
  ],
});

/** In-memory stand-in for ChromaDB with the same interface we use. */
export function fakeVector() {
  const store = [];
  return {
    store,
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      ids.forEach((id, i) => store.push({ id, embedding: embeddings[i], text: documents[i], metadata: metadatas[i] }));
    },
    queryChunks: async ({ nResults = 6, sourceIds = [] }) => {
      const pool = sourceIds.length ? store.filter((s) => sourceIds.includes(s.metadata.sourceId)) : store;
      return pool.slice(0, nResults).map((s) => ({ ...s, distance: 0.2 }));
    },
    queryChunksBatch: async ({ embeddings, nResults = 6, sourceIds = [] }) => {
      const pool = sourceIds.length ? store.filter((s) => sourceIds.includes(s.metadata.sourceId)) : store;
      return embeddings.map(() => pool.slice(0, nResults).map((s) => ({ id: s.id, text: s.text, metadata: s.metadata, distance: 0.2 })));
    },
    pingChroma: async () => true,
    resetCollection: async () => { store.length = 0; },
  };
}

export function makeAi(overrides = {}) {
  const calls = [];
  return {
    calls,
    embedTexts: async (texts) => texts.map(() => EMBEDDING),
    embedQuery: async () => EMBEDDING,
    chatCompletion: async (messages) => {
      calls.push(messages);
      const system = messages[0].content;
      if (system.includes('flashcards')) return FLASHCARD_JSON;
      if (system.includes('multiple-choice')) return QUIZ_JSON;
      if (system.includes('organise') || system.includes('study sessions')) {
        return JSON.stringify({
          matchSessionId: null,
          newSession: { category: 'subject', title: 'Biology', subject: 'cell biology', tags: ['cells'] },
          confidence: 'high',
          reason: 'material matches biology',
        });
      }
      return TUTOR_ANSWER;
    },
    ...overrides,
  };
}

// --- shared HTTP test harness ----------------------------------------------
// Canonical harness used by the HTTP suites (11 files contained a copy of
// startApp; the shared one keeps the seam they all already rely on:
// createApp({ db, ai, vector }) with per-test overrides).

import AdmZip from 'adm-zip';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';

/** Minimal in-memory pptx (text-only slides) for upload/extract tests. */
export function buildPptx(pageTexts = ['Recursion uses a base case to stop.', 'A recursive call moves toward the base case.']) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  pageTexts.forEach((text, i) => zip.addFile(`ppt/slides/slide${i + 1}.xml`,
    Buffer.from(`<p:sld><a:t>${text}</a:t></p:sld>`)));
  return zip.toBuffer();
}

/**
 * startApp({ ai, vector, db, auth }) — spin a test app against a throwaway
 * sqlite file and a real HTTP port. Pass `{ db }` to inject a custom/pre-built
 * database handle (e.g. the fault-injection wrappers); otherwise one is
 * created from a fresh temp dir. `auth` flows straight into createApp's
 * auth override (used by tests/two-users.test.js to fake two users).
 * Returns `close()` for teardown.
 */
export async function startApp({ ai = makeAi(), vector = fakeVector(), db, auth } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-test-'));
  const appDb = db ?? await openDb(path.join(dir, 'app.db'));
  const app = await createApp({ db: appDb, ai, vector, auth });
  const server = app.listen(0);
  await once(server, 'listening');
  return {
    base: `http://localhost:${server.address().port}`,
    db: appDb,
    ai,
    vector,
    close: () => new Promise((r) => server.close(r)),
  };
}
