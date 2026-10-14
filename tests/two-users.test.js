// Two-user ownership smoke tests (v7 per-user model) — fully offline.
//
// Two fake users are produced by an auth OVERRIDE passed straight into
// createApp: requests carry an `x-test-user: u1|u2` header, and the stub
// verifies it exactly like the real Supabase verifier would (missing/unknown
// → null → the endpoint answers 401 UNAUTHENTICATED). Assertions:
//   - material is visible only to its owner (library + vector retrieval);
//   - onboarding/profile rows are per-user;
//   - anonymous requests are rejected on every private router.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeAi } from './helpers.js';

const CELL_U1 = {
  url: 'https://learn.example/cells',
  title: 'Cells 101 (u1)',
  text: 'Cells are the basic unit of life.\n\nMitosis produces two identical daughter cells.\n\nThe nucleus stores DNA.\n\nMeiosis divides twice.\n\nMitosis copies the nucleus once.',
};
const SPACE_U2 = {
  url: 'https://learn.example/space',
  title: 'Space 101 (u2)',
  text: 'Planets orbit stars.\n\nMars is the fourth planet from the Sun.\n\nA light-year is a distance measure.\n\nThe Sun is a star.\n\nEuropa orbits Jupiter.',
};

/** Owner-aware fakeVector: retrieval honours the userId it is given. */
function ownerFakeVector() {
  const store = [];
  return {
    store,
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      ids.forEach((id, i) => store.push({ id, embedding: embeddings[i], text: documents[i], metadata: metadatas[i] }));
    },
    queryChunks: async ({ embedding, nResults = 6, sourceIds = [], userId }) => {
      const pool = store
        .filter((s) => userId === undefined || s.metadata.ownerId === userId)
        .filter((s) => sourceIds.length === 0 || sourceIds.includes(s.metadata.sourceId));
      return pool.slice(0, nResults).map((s) => ({ ...s, distance: 0.2 }));
    },
    pingChroma: async () => true,
  };
}

const twoUsers = { getUserFromRequest: async (req) => (req.headers['x-test-user'] ? { id: req.headers['x-test-user'] } : null) };
const auth = (user) => ({ 'Content-Type': 'application/json', 'x-test-user': user });

function post(ctx, url, body, user) {
  return fetch(`${ctx.base}${url}`, { method: 'POST', headers: auth(user), body: JSON.stringify(body) });
}

async function addWebpage(ctx, page, user) {
  const res = await post(ctx, '/api/sources/webpage', page, user);
  assert.equal(res.status, 201, `upload for ${user} should succeed`);
  return (await res.json()).source.id;
}

test('two users cannot see or learn from each other\u2019s material', async (t) => {
  const ctx = await startApp({ ai: makeAi(), vector: ownerFakeVector(), auth: twoUsers });
  t.after(ctx.close);

  const u1Source = await addWebpage(ctx, CELL_U1, 'u1');
  const u2Source = await addWebpage(ctx, SPACE_U2, 'u2');

  await t.test('u2\u2019s library listing never shows u1\u2019s source', async () => {
    const { sources, unsortedSourceCount } = await (await fetch(`${ctx.base}/api/sources`, { headers: auth('u2') })).json();
    assert.deepEqual(sources.map((s) => s.id), [u2Source]);
    assert.equal(unsortedSourceCount, 1);
  });

  await t.test('u1\u2019s tutor answer cites only u1\u2019s material (vector owner filter)', async () => {
    // Both ask the same question with NO sourceIds: the only library scoping
    // is the verified user id → the vector store must return only owned chunks.
    const res = await post(ctx, '/api/tutor/ask', { question: 'How does mitosis work?' }, 'u1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.citations.length > 0, 'u1 gets grounded citations');
    assert.ok(body.citations.every((c) => c.sourceId === u1Source));
  });

  await t.test('u2\u2019s tutor answer never surfaces u1\u2019s chunks', async () => {
    const res = await post(ctx, '/api/tutor/ask', { question: 'What is a light-year?' }, 'u2');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.citations.length > 0);
    assert.ok(body.citations.every((c) => c.sourceId === u2Source));
  });

  await t.test('u2 asking about u1\u2019s-only topic finds nothing usable', async () => {
    // Money on "u1 chunks leak": if retrieval ignored the owner, the three
    // citations would point at the mitosis source.
    const res = await post(ctx, '/api/tutor/ask', { question: 'How does meiosis divide cells?' }, 'u2');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!body.citations.some((c) => c.sourceId === u1Source));
  });

  await t.test('u1\u2019s profile PATCH is invisible to u2 (state "new")', async () => {
    const patch = await fetch(`${ctx.base}/api/profile`, {
      method: 'PATCH', headers: auth('u1'), body: JSON.stringify({ interests: [{ label: 'msc biology research' }] }),
    });
    assert.equal(patch.status, 200);
    const u1View = (await patch.json()).profile;
    assert.equal(u1View.state, 'skipped'); // manual edit skips the intro
    assert.deepEqual(u1View.interests.map((i) => i.label), ['msc biology research']);

    const u2View = (await (await fetch(`${ctx.base}/api/profile`, { headers: auth('u2') })).json()).profile;
    assert.equal(u2View.state, 'new');
    assert.deepEqual(u2View.interests, []);
    assert.ok(u2View.updatedAt === null, 'u2 has no row at all');
  });

  await t.test('u2\u2019s quiz events never touch u1\u2019s learner history', async () => {
    const gen = await post(ctx, '/api/quiz/generate', { topic: 'Space', sourceIds: [u2Source] }, 'u2');
    assert.equal(gen.status, 201);
    const { quiz } = await gen.json();
    const res = await post(ctx, `/api/quiz/${quiz.id}/answer`, {
      answers: [{ index: 0, choiceId: 'a' }, { index: 1, choiceId: 'a' }, { index: 2, choiceId: 'b' }],
    }, 'u2');
    assert.equal(res.status, 200);

    // u2 has exactly one learner topic; u1 still has none.
    const u2Topics = (await (await fetch(`${ctx.base}/api/learner/progress`, { headers: auth('u2') })).json()).topics;
    assert.deepEqual(u2Topics.map((row) => row.topic), ['space']);
    const u1Topics = (await (await fetch(`${ctx.base}/api/learner/progress`, { headers: auth('u1') })).json()).topics;
    assert.deepEqual(u1Topics, []);
  });
});

test('anonymous requests get 401 UNAUTHENTICATED on every private router', async (t) => {
  const ctx = await startApp({ ai: makeAi(), vector: ownerFakeVector(), auth: twoUsers });
  t.after(ctx.close);

  const cases = [
    ['GET', '/api/sources'],
    ['POST', '/api/tutor/ask', { question: 'How does mitosis work?' }],
    ['POST', '/api/quiz/generate', { topic: 'Cells', questionCount: 3 }],
    ['GET', '/api/learner/progress'],
    ['GET', '/api/profile'],
    ['POST', '/api/onboarding/message', { message: null }],
    ['GET', '/api/decks'],
  ];

  for (const [method, url, body] of cases) {
    await t.test(`${method} ${url}`, async () => {
      const res = await fetch(`${ctx.base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-user': '' }, // verifier → null
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(res.status, 401);
      const enveloped = await res.json();
      assert.deepEqual(enveloped, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to use this endpoint.' } });
    });
  }

  await t.test('health stays public while everything else is guarded', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);
  });
});
