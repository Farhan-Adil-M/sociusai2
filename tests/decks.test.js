// Persistent flashcard decks + card review status + session-scoped generation.
// Flow mirrors the verified standalone smoke: upload → scope → generate →
// browse → marks → restart-check → delete.
//
// Also covers Part 8 (contract v1.5): auto practice decks during active study —
// in-memory db + stubbed AI/vector, HTTP end-to-end through POST /api/tutor/ask
// and GET /api/decks (merged from the former auto-decks.test.js). All suites
// use the shared startApp harness from helpers.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { startApp, fakeVector, makeAi, EMBEDDING, TUTOR_ANSWER } from './helpers.js';

const WEBPAGE = {
  url: 'https://learn.example/cells',
  title: 'Cells 101',
  text: 'Cells are the basic unit of life.\n\nThe nucleus stores DNA.\n\nMitosis produces two identical daughter cells.\n\nMeiosis produces four varied cells.',
};

const json = (res) => res.json();

const post = (base, body) => fetch(`${base}/api/tutor/ask`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const getDecks = async (base, query = '') => {
  const res = await fetch(`${base}/api/decks${query}`);
  return { status: res.status, decks: (await res.json()).decks ?? [] };
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn returns truthy — the deck generation is fire-and-forget. */
async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
    await tick(20);
  }
}

function seedSource(db, id, title, sessionId) {
  db.prepare(
    "INSERT INTO sources (id, type, title, chunk_count, session_id, created_at) VALUES (?, 'webpage', ?, 2, ?, ?)",
  ).run(id, title, sessionId, '2026-01-01T00:00:00Z');
}

/** A study session with `n` webpage sources (chunks embedded in the vector stub). */
async function seedSession(ctx, { title = 'Cell biology', n = 2, chunks = false } = {}) {
  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  }).then((r) => r.json())).session;
  const sourceIds = [];
  for (let i = 0; i < n; i++) {
    const id = `src_${String.fromCharCode(97 + i)}`;
    sourceIds.push(id);
    seedSource(ctx.db, id, title, session.id);
    if (chunks) {
      await ctx.vector.addChunks({
        ids: [`${id}_1`],
        embeddings: [EMBEDDING],
        documents: ['Mitosis produces two identical daughter cells.'],
        metadatas: [{ sourceId: id, title: `Doc ${id}`, paragraph: 1 }],
      });
    }
  }
  return { session, sourceIds };
}

test('decks persist and review status survive a restart across instances', async (t) => {
  // startApp() cannot hand back the db file path, so this test injects its own
  // database opened over a known path (same seam other restart tests use).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-decks-'));
  const dbPath = path.join(dir, 'app.db');
  const ctx = await startApp({ db: await openDb(dbPath) });
  t.after(ctx.close);

  const webpage = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  }).then(json);
  assert.equal(webpage.source.chunkCount > 0, true);
  const sourceId = webpage.source.id;

  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Biology' }),
  }).then(json)).session;

  const moved = await fetch(`${ctx.base}/api/sources/${sourceId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }),
  }).then(json);
  assert.equal(moved.source.sessionId, session.id);

  const generated = await fetch(`${ctx.base}/api/flashcards/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cell division', sessionId: session.id, count: 3 }),
  }).then(json);
  assert.equal(generated.cards.length, 3);
  assert.ok(generated.deckId.startsWith('deck_'));

  const library = await fetch(`${ctx.base}/api/decks?sessionId=${session.id}`).then(json);
  assert.equal(library.decks.length, 1);
  const deck = library.decks[0];
  assert.equal(deck.topic, 'Cell division');
  assert.equal(deck.cardCount, 3);
  assert.equal(deck.knownCount, 0);
  assert.equal(deck.sessionTitle, 'Biology');

  // Reviewing marks real stored rows.
  await fetch(`${ctx.base}/api/decks/${deck.id}/cards/0`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  }).then(json);
  await fetch(`${ctx.base}/api/decks/${deck.id}/cards/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'review' }),
  }).then(json);
  const after = await fetch(`${ctx.base}/api/decks/${deck.id}`).then(json);
  assert.equal(after.deck.knownCount, 1);
  assert.equal(after.deck.reviewCount, 1);
  assert.ok(after.deck.lastReviewedAt);
  assert.equal(after.cards[0].status, 'known');
  assert.equal(after.cards[1].status, 'review');

  // "Restart": a genuinely separate app instance reopened over the same
  // SQLite file — no shared in-memory state with the first app.
  const db2 = await openDb(dbPath);
  const app2 = await createApp({ db: db2, ai: makeAi(), vector: fakeVector() });
  const server2 = app2.listen(0);
  await once(server2, 'listening');
  t.after(() => new Promise((r) => server2.close(r)));
  const base2 = `http://localhost:${server2.address().port}`;

  const restarted = await fetch(`${base2}/api/decks?sessionId=${session.id}`).then(json);
  assert.equal(restarted.decks.length, 1);
  assert.equal(restarted.decks[0].id, deck.id);
  assert.equal(restarted.decks[0].knownCount, 1);
  assert.equal(restarted.decks[0].reviewCount, 1);
  assert.ok(restarted.decks[0].lastReviewedAt);

  const rightAfterRestart = await fetch(`${base2}/api/decks/${deck.id}`).then(json);
  assert.equal(rightAfterRestart.cards[0].status, 'known');
  assert.equal(rightAfterRestart.cards[1].status, 'review');
  assert.equal(rightAfterRestart.cards[1].idx, 1);
  assert.ok(rightAfterRestart.cards[1].reviewedAt);
  assert.ok(rightAfterRestart.deck.lastReviewedAt);

  // Deletion is deliberate and only touches derived content.
  const deleted = await fetch(`${ctx.base}/api/decks/${deck.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal((await fetch(`${ctx.base}/api/decks/${deck.id}`)).status, 404);
  const survivingSources = await fetch(`${ctx.base}/api/sources`).then(json);
  assert.equal(survivingSources.sources.length, 1);
});

test('session scoping is enforced by the backend, not the UI', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  for (const [title, letter, url] of [['Biology material', 'B', 'https://x.example/bio'], ['Chemistry material', 'C', 'https://x.example/chem']]) {
    await fetch(`${ctx.base}/api/sources/webpage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, text: letter.repeat(80) }),
    }).then(json);
  }
  const sources = (await fetch(`${ctx.base}/api/sources`).then(json)).sources;
  const bioId = sources.find((s) => s.title.includes('Biology')).id;
  const chemId = sources.find((s) => s.title.includes('Chemistry')).id;

  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Biology only' }),
  }).then(json)).session;
  await fetch(`${ctx.base}/api/sources/${bioId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }),
  }).then(json);

  const empty = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'No material here' }),
  }).then(json)).session;
  const emptyRes = await fetch(`${ctx.base}/api/tutor/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What is mitosis?', sessionId: empty.id }),
  });
  assert.equal(emptyRes.status, 400);
  assert.equal((await emptyRes.json()).error.code, 'SESSION_EMPTY');

  // The tutor prompt lists only the session's passages — chemistry never arrives.
  await fetch(`${ctx.base}/api/tutor/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What is mitosis?', sessionId: session.id }),
  }).then(json);

  const smuggle = await fetch(`${ctx.base}/api/quiz/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Everything', sourceIds: [chemId], sessionId: session.id }),
  });
  assert.equal(smuggle.status, 400);
  assert.equal((await smuggle.json()).error.code, 'VALIDATION_ERROR');

  const unknownSession = await fetch(`${ctx.base}/api/quiz/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cell cycle', sessionId: 'ses_nope' }),
  });
  assert.equal(unknownSession.status, 404);
  assert.equal((await unknownSession.json()).error.code, 'SESSION_NOT_FOUND');
});

test('a failed review update rolls back — no half-applied card mark', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const webpage = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  }).then(json);
  const generated = await fetch(`${ctx.base}/api/flashcards/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cell division', count: 3 }),
  }).then(json);
  const deckId = generated.deckId;

  // Force the *second* UPDATE (decks.last_reviewed_at) to abort, so the
  // parked card write must be rolled back or the card row is left corrupted.
  await ctx.db.exec("CREATE TRIGGER force_deck_fail BEFORE UPDATE ON decks BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
  t.after(async () => { await ctx.db.exec('DROP TRIGGER IF EXISTS force_deck_fail'); });

  const failed = await fetch(`${ctx.base}/api/decks/${deckId}/cards/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  });
  assert.equal(failed.status >= 400, true);
  const error = (await failed.json()).error;
  assert.ok(error.code && error.message); // standard error envelope

  // The card mark must NOT have stuck: the transaction rolled back.
  const deck = await fetch(`${ctx.base}/api/decks/${deckId}`).then(json);
  assert.equal(deck.cards[1].status, 'new');
  assert.equal(deck.cards[1].reviewedAt, null);
  assert.equal(deck.cards[1].idx, 1);
  assert.equal(deck.deck.knownCount, 0);
  assert.equal(deck.deck.lastReviewedAt, null);

  // The trigger was really the cause: with it dropped, the same mark lands.
  await ctx.db.exec('DROP TRIGGER force_deck_fail');
  const ok = await fetch(`${ctx.base}/api/decks/${deckId}/cards/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  });
  assert.equal(ok.status, 200);
  const afterRecovery = await fetch(`${ctx.base}/api/decks/${deckId}`).then(json);
  assert.equal(afterRecovery.cards[1].status, 'known');
  assert.equal(afterRecovery.deck.knownCount, 1);
});

// ---------- Part 8 (contract v1.5): auto decks through POST /api/tutor/ask ----------

test('first scoped ask starts one auto deck from NO deck', async (t) => {
  const ai = makeAi();
  const ctx = await startApp({ ai });
  t.after(ctx.close);
  const { session, sourceIds } = await seedSession(ctx, { chunks: true });

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needsContent, false);
  assert.equal(body.answer, TUTOR_ANSWER); // the grounded answer is unchanged
  assert.equal(body.deckGeneration, 'started');

  const decks = await waitFor(async () => {
    const list = await getDecks(ctx.base, `?sessionId=${session.id}`);
    return list.decks.length === 1 ? list.decks : null;
  });
  assert.equal(decks[0].topic, 'Cell biology'); // topic = session title
  assert.equal(decks[0].sessionId, session.id);
  assert.equal(decks[0].cardCount, 3); // FLASHCARD_JSON cards, persisted deck

  // Scoped to the session's sources, exactly as a manual /generate would be.
  const detail = await fetch(`${ctx.base}/api/decks/${decks[0].id}`).then((r) => r.json());
  assert.deepEqual([...detail.deck.sourceIds].sort(), [...sourceIds].sort());
});

test('second ask in the same session is a no-op: deckGeneration absent, still one deck', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  const { session } = await seedSession(ctx, { chunks: true });

  const first = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal((await first.json()).deckGeneration, 'started');
  await waitFor(async () => {
    const list = await getDecks(ctx.base, `?sessionId=${session.id}`);
    return list.decks.length === 1 ? list.decks : null;
  });

  const second = await post(ctx.base, { question: 'What is meiosis?', sessionId: session.id });
  assert.equal(second.status, 200);
  const body2 = await second.json();
  assert.equal(body2.needsContent, false);
  assert.equal(body2.deckGeneration, undefined, 'no field when the session already has a deck');
  assert.equal((await getDecks(ctx.base)).decks.length, 1, 'no second deck was created');
});

test('unscoped ask answers normally with NO deckGeneration field and NO deck', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  await seedSession(ctx, { chunks: true }); // material exists, but the ask is not session-scoped

  const res = await post(ctx.base, { question: 'How does mitosis work?', sourceIds: ['src_a'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needsContent, false);
  assert.equal(body.deckGeneration, undefined);
  assert.equal((await getDecks(ctx.base)).decks.length, 0);
});

test('abstain path (needsContent) does not start auto generation', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  const { session } = await seedSession(ctx, { chunks: false }); // registered source, empty vector store

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needsContent, true, 'an empty vector store yields the honest abstain');
  assert.equal(body.deckGeneration, undefined);
  assert.equal((await getDecks(ctx.base)).decks.length, 0);
});

test('background generation failure is non-fatal: answer still 200, deck-failed logged, no deck rows', async (t) => {
  const ai = makeAi();
  const baseChat = ai.chatCompletion;
  ai.chatCompletion = async (messages, opts) => {
    if (messages[0].content.includes('flashcards')) throw new Error('flashcard model exploded'); // only the deck call fails
    return baseChat(messages, opts);
  };
  const ctx = await startApp({ ai });
  t.after(ctx.close);
  const { session } = await seedSession(ctx, { chunks: true });

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 200, 'a failed background deck never breaks the answer');
  const body = await res.json();
  assert.equal(body.answer, TUTOR_ANSWER);
  assert.equal(body.deckGeneration, 'started');

  const failure = await waitFor(async () => {
    const rows = await ctx.db.all("SELECT topic, detail FROM activity WHERE type = 'deck-failed'");
    return rows.length === 1 ? rows : null;
  });
  assert.match(failure[0].detail, /Auto deck generation failed: flashcard model exploded/);
  assert.equal(failure[0].topic, 'Cell biology');
  assert.equal((await getDecks(ctx.base)).decks.length, 0, 'no deck rows on failure');
});

test('zero-source session answers SESSION_EMPTY before any deck logic', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Empty unit' }),
  }).then((r) => r.json())).session;

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 400); // existing behaviour unchanged
  assert.equal((await res.json()).error.code, 'SESSION_EMPTY');
  const rows = await ctx.db.get('SELECT COUNT(*) AS n FROM decks');
  assert.equal(rows.n, 0);
});
