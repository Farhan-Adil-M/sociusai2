// Retrieval evaluation. Two layers (mirrors the plan's M1):
//  - OFFLINE (this file): deterministic checks of the retrieval pipeline using
//    canned distances — dedupe, the evidence threshold, per-case target hits,
//    and the abstention loop. The stub encodes "which page supports the
//    question" so every assertion stays deterministic.
//  - LIVE: scripts/eval-retrieval.mjs runs the same eval set against real
//    embeddings and the real tutor, and prints an honest quality report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import evalSet from './eval-set.json' with { type: 'json' };
import { dedupeHits, filterByEvidence, hitScore, retrieve } from '../server/services/retrieval.js';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { fakeVector, makeAi } from './helpers.js';

const EVAL_CHUNKS = [
  { id: 'c1', metadata: { sourceId: 'src_eval', title: 'smoke-eval-biology.pdf', type: 'pdf', page: 1 }, text: 'Photosynthesis converts light energy into glucose in chloroplasts.' },
  { id: 'c2', metadata: { sourceId: 'src_eval', title: 'smoke-eval-biology.pdf', type: 'pdf', page: 2 }, text: 'The light-dependent reactions occur in the thylakoid membranes and produce ATP and NADPH.' },
  { id: 'c3', metadata: { sourceId: 'src_eval', title: 'smoke-eval-biology.pdf', type: 'pdf', page: 3 }, text: 'Mitochondria produce ATP through cellular respiration, consuming oxygen.' },
];

const PAGE_BY_QUESTION = Object.fromEntries(
  evalSet.cases.filter((c) => c.location).map((c) => [c.question, c.location.page]),
);
const SUPPORT_PAGE_BY_ID = Object.fromEntries(
  evalSet.cases.filter((c) => c.location).map((c) => [c.id, c.location.page]),
);

/**
 * Deterministic relevance stub: distance 0.05 (score 0.95) for the chunk whose
 * page matches the encoded target, 2.0 (score 0, filtered out) otherwise. The
 * embed stub encodes the target page so per-case behaviour varies by question —
 * clearly a plumbing rig, not a quality measurement (that is the live script).
 */
function evalVector() {
  const store = EVAL_CHUNKS.map((chunk) => ({ ...chunk, embedding: Array(8).fill(0.5) }));
  return {
    store,
    addChunks: async () => {},
    queryChunks: async ({ embedding, sourceIds = [] }) => {
      const target = Math.round(embedding[0]);
      return store
        .map((chunk) => ({
          ...chunk,
          distance: chunk.metadata.page === target ? 0.05 : 2,
        }))
        .filter((chunk) => sourceIds.length === 0 || sourceIds.includes(chunk.metadata.sourceId))
        .slice(0, 6);
    },
    pingChroma: async () => true,
    resetCollection: async () => { store.length = 0; },
  };
}

const evalAi = {
  embedQuery: async (question) => {
    const page = PAGE_BY_QUESTION[question];
    return page !== undefined ? [page, 0, 0, 0, 0, 0, 0, 0] : [99, 0, 0, 0, 0, 0, 0, 0]; // out-of-domain → no evidence
  },
};

// ── pipeline mechanics ──────────────────────────────────────────────────────

test('dedupeHits drops repeated text but keeps distinct passages', () => {
  const hits = [
    { id: 'a', text: '  The   thylakoid reactions produce ATP. ', metadata: { sourceId: 's1' } },
    { id: 'b', text: 'the thylakoid reactions produce ATP.', metadata: { sourceId: 's1' } },
    { id: 'c', text: 'Mitochondria produce ATP through respiration.', metadata: { sourceId: 's1' } },
    { id: 'd', text: 'The thylakoid reactions produce ATP.', metadata: { sourceId: 's2' } },
  ];
  assert.deepEqual(dedupeHits(hits).map((h) => h.id), ['a', 'c', 'd']);
});

test('evidence floor filters chunks below the configured similarity', () => {
  const hits = [
    { id: 'strong', distance: 0.1 }, // score 0.9
    { id: 'weak', distance: 0.9 }, // score 0.1
    { id: 'none' }, // no distance → no score
  ];
  assert.equal(hitScore(hits[0]), 0.9);
  // strongest = 0.9 → relative cutoff = max(0.25, 0.9 × 0.5) = 0.45 → strong survives
  assert.deepEqual(filterByEvidence(hits, 0.25).map((h) => h.id), ['strong']);
  // even with the absolute bound off, the relative rule keeps the strongest only
  assert.deepEqual(filterByEvidence(hits, 0).map((h) => h.id), ['strong']);
});

test('a junk question whose chunks all score near zero yields no evidence', () => {
  const hits = [{ id: 'junk', distance: 0.99 }, { id: 'junk2', distance: 0.95 }];
  assert.deepEqual(filterByEvidence(hits, 0.2), []);
});

test('retrieve applies dedup and the evidence floor in one pipeline', async () => {
  const ai = { embedQuery: async () => Array(8).fill(0.5) };
  const vector = {
    queryChunks: async () => [
      { id: 'dup', text: 'same text here', metadata: { sourceId: 's1' }, distance: 0.1 },
      { id: 'dup2', text: 'same text here', metadata: { sourceId: 's1' }, distance: 0.15 },
      { id: 'weak', text: 'barely related', metadata: { sourceId: 's1' }, distance: 0.95 },
    ],
  };
  const hits = await retrieve('question', { minScore: 0.25, ai, vector });
  assert.deepEqual(hits.map((h) => h.id), ['dup']);
});

// ── eval set, offline (deterministic plumbing parity with the live script) ──

test('offline eval set: every grounded case resolves to its expected title+page', async () => {
  for (const testCase of evalSet.cases.filter((c) => c.expectTitle)) {
    const hits = await retrieve(testCase.question, { minScore: 0.2, ai: evalAi, vector: evalVector() });
    assert.ok(hits.length > 0, `no hits for ${testCase.id}`);
    const top = hits[0];
    assert.equal(top.metadata.title, testCase.expectTitle, `title mismatch for ${testCase.id}`);
    assert.equal(top.metadata.page, SUPPORT_PAGE_BY_ID[testCase.id], `page mismatch for ${testCase.id}`);
    assert.equal(hitScore(top) >= 0.8, true, `weak top evidence for ${testCase.id}`);
  }
});

test('offline eval set: unsupported questions return NO evidence at all', async () => {
  for (const testCase of evalSet.cases.filter((c) => c.unsupported)) {
    const hits = await retrieve(testCase.question, { minScore: 0.2, ai: evalAi, vector: evalVector() });
    assert.deepEqual(hits, [], `out-of-domain question ${testCase.id} should have no evidence`);
  }
});

  // abstention loop: weak evidence anywhere → honest abstain, never an answer ─

test('quiz generation under weak evidence succeeds but flags it honestly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-quizweak-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const baseStore = fakeVector().store;
  const belowFloor = {
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      baseStore.push({ id: ids[0], text: documents[0], metadata: metadatas[0], embedding: embeddings[0] });
    },
    queryChunks: async ({ sourceIds = [] }) => {
      const pool = sourceIds.length ? baseStore.filter((s) => sourceIds.includes(s.metadata.sourceId)) : baseStore;
      return pool.slice(0, 6).map((c) => ({ ...c, distance: 0.97 }));
    },
    pingChroma: async () => true,
    resetCollection: async () => {},
  };
  const app = await createApp({ db, ai: makeAi(), vector: belowFloor });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  await fetch(`${base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://learn.example/cells', title: 'Cells 101', text: 'C'.repeat(90) }),
  });

  const res = await fetch(`${base}/api/quiz/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cells', count: 3 }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.weakEvidence, true);
});

// ── abstention loop: weak evidence anywhere → honest abstain, never an answer ─

test('tutor abstains when every retrieved chunk falls below the evidence floor', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-eval-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const baseStore = fakeVector().store;
  const belowFloor = {
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      baseStore.push({ id: ids[0], text: documents[0], metadata: metadatas[0], embedding: embeddings[0] });
    },
    queryChunks: async ({ sourceIds = [] }) => {
      const pool = sourceIds.length ? baseStore.filter((s) => sourceIds.includes(s.metadata.sourceId)) : baseStore;
      return pool.slice(0, 6).map((c) => ({ ...c, distance: 0.97 })); // score 0.03 → below the floor
    },
    pingChroma: async () => true,
    resetCollection: async () => {},
  };

  const app = await createApp({ db, ai: makeAi(), vector: belowFloor });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  await fetch(`${base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://learn.example/cells', title: 'Cells 101', text: 'C'.repeat(90) }),
  });

  const gen = await fetch(`${base}/api/flashcards/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cells', count: 3 }),
  });
  // Generation needs breadth, so it ignores the tutor's strict floor — but it
  // flags honestly that the evidence is weak instead of pretending otherwise.
  assert.equal(gen.status, 201);
  const genBody = await gen.json();
  assert.equal(genBody.weakEvidence, true);

  const res = await fetch(`${base}/api/tutor/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What tests did the student take last night that never appear in any material?' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needsContent, true);
  assert.deepEqual(body.citations, []);
  assert.equal(body.answer.includes('not in the material you'), true); // friendly abstain copy
  // real topics from the same scope: the deck topic first, then the source title
  assert.deepEqual(body.suggestions, ['Cells', 'Cells 101']);
});
