// Extension + auth routes: the two endpoints the browser extension calls
// (relevance highlighting, briefing) and the extension's login/refresh.
// Offline like the rest of the suite: stubbed AI/vector, injected auth.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startApp, makeAi, fakeVector, EMBEDDING, TUTOR_ANSWER } from './helpers.js';

const LONG_TEXT = 'Recursion solves a problem by calling itself on a smaller input until a base case stops the descent, which is why every recursive function needs a clearly defined stopping condition near the top of its definition.';

function fakeSupabaseAuth() {
  return {
    mode: 'supabase',
    getUserFromRequest: async (req) => {
      const header = req.headers?.authorization ?? '';
      if (header === 'Bearer good-token') return { id: 'user-1', token: 'good-token' };
      return null;
    },
    signInWithPassword: async ({ email, password }) => {
      if (password === 'correct-horse') {
        return {
          data: {
            session: { access_token: 'at-1', refresh_token: 'rt-1', expires_at: 123, expires_in: 3600, token_type: 'bearer' },
            user: { id: 'user-1', email },
          },
          error: null,
        };
      }
      return { data: { session: null, user: null }, error: { message: 'Invalid login credentials' } };
    },
    refreshSession: async (refreshToken) => {
      if (refreshToken === 'rt-1') {
        return {
          data: { session: { access_token: 'at-2', refresh_token: 'rt-2', expires_at: 456, expires_in: 3600, token_type: 'bearer' } },
          error: null,
        };
      }
      return { data: { session: null }, error: { message: 'invalid refresh token' } };
    },
  };
}

async function post(ctx, path, body, token) {
  const res = await fetch(`${ctx.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('auth routes — prototype mode reports itself, supabase mode runs the password grant', async (t) => {
  const proto = await startApp();
  t.after(proto.close);

  await t.test('prototype: login/refresh answer { mode: prototype }', async () => {
    const login = await post(proto, '/api/auth/login', {});
    assert.equal(login.status, 200);
    assert.deepEqual(login.data, { mode: 'prototype' });
    const refresh = await post(proto, '/api/auth/refresh', {});
    assert.equal(refresh.status, 200);
    assert.deepEqual(refresh.data, { mode: 'prototype' });
  });

  const ctx = await startApp({ auth: fakeSupabaseAuth() });
  t.after(ctx.close);

  await t.test('supabase: valid credentials return the session envelope', async () => {
    const login = await post(ctx, '/api/auth/login', { email: 'learner@example.com', password: 'correct-horse' });
    assert.equal(login.status, 200);
    assert.equal(login.data.mode, 'supabase');
    assert.equal(login.data.session.access_token, 'at-1');
    assert.equal(login.data.session.refresh_token, 'rt-1');
    assert.deepEqual(login.data.session.user, { id: 'user-1', email: 'learner@example.com' });
  });

  await t.test('supabase: wrong password → 401 with an honest message', async () => {
    const login = await post(ctx, '/api/auth/login', { email: 'learner@example.com', password: 'nope' });
    assert.equal(login.status, 401);
    assert.equal(login.data.error.code, 'UNAUTHENTICATED');
    assert.equal(login.data.error.message, 'Email or password is incorrect.');
  });

  await t.test('supabase: malformed body → 400 VALIDATION_ERROR', async () => {
    const login = await post(ctx, '/api/auth/login', { email: 'not-an-email', password: 'x' });
    assert.equal(login.status, 400);
    assert.equal(login.data.error.code, 'VALIDATION_ERROR');
  });

  await t.test('supabase: refresh rotates the session; bad token → 401', async () => {
    const ok = await post(ctx, '/api/auth/refresh', { refresh_token: 'rt-1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.session.access_token, 'at-2');
    const bad = await post(ctx, '/api/auth/refresh', { refresh_token: 'stale' });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error.code, 'UNAUTHENTICATED');
  });

  await t.test('supabase mode: extension endpoints require a token (401)', async () => {
    const rel = await post(ctx, '/api/extension/relevance', { blocks: [{ id: 'e0s0', text: LONG_TEXT }] });
    assert.equal(rel.status, 401);
    assert.equal(rel.data.error.code, 'UNAUTHENTICATED');
    const brief = await post(ctx, '/api/extension/briefing', { text: LONG_TEXT });
    assert.equal(brief.status, 401);
    assert.equal(brief.data.error.code, 'UNAUTHENTICATED');
  });
});

test('extension relevance — per-user matching with citations', async (t) => {
  const embedded = [];
  const ai = { ...makeAi(), embedTexts: async (texts) => { embedded.push(...texts); return texts.map(() => EMBEDDING); } };
  const ctx = await startApp({ ai });
  t.after(ctx.close);

  await t.test('no material yet → empty matches, no embedding call', async () => {
    const res = await post(ctx, '/api/extension/relevance', { blocks: [{ id: 'e0s0', text: LONG_TEXT }] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.matches, []);
    assert.equal(typeof res.data.minScore, 'number');
    assert.equal(embedded.length, 0);
  });

  await post(ctx, '/api/sources/webpage', {
    url: 'https://learn.example/recursion',
    title: 'Recursion 101',
    text: `${LONG_TEXT}\n\nA recursive call moves toward the base case.`,
  });

  await t.test('related sentence → match with the source citation', async () => {
    const before = embedded.length; // ingestion embeds too — count only this call
    const res = await post(ctx, '/api/extension/relevance', { blocks: [{ id: 'e3s1', text: LONG_TEXT }] });
    assert.equal(res.status, 200);
    assert.equal(embedded.length, before + 1); // exactly one batched embedding call
    assert.equal(res.data.matches.length, 1);
    const [match] = res.data.matches;
    assert.equal(match.id, 'e3s1');
    assert.equal(match.score, 0.8); // fake store distance 0.2 → hitScore 0.8
    assert.equal(match.citation.title, 'Recursion 101');
    assert.ok(match.citation.excerpt.includes('Recursion'));
  });

  await t.test('below-threshold hits are filtered out', async () => {
    const far = { ...fakeVector(), queryChunksBatch: async ({ embeddings }) =>
      embeddings.map(() => [{ id: 'c1', text: 'unrelated', metadata: { sourceId: 's1', title: 'x' }, distance: 0.9 }]) };
    const farCtx = await startApp({ vector: far });
    t.after(farCtx.close);
    await post(farCtx, '/api/sources/webpage', { url: 'https://learn.example/x', title: 'X', text: LONG_TEXT });
    const res = await post(farCtx, '/api/extension/relevance', { blocks: [{ id: 'e0s0', text: LONG_TEXT }] });
    // distance 0.9 → score 0.1 < EXTENSION_MIN_SIMILARITY 0.8 → no highlight
    assert.equal(res.data.matches.length, 0);
    assert.equal(res.data.minScore, 0.8);
  });

  await t.test('stores without batch support fall back to per-block queries', async () => {
    const legacy = { ...fakeVector(), queryChunksBatch: undefined };
    const legacyCtx = await startApp({ vector: legacy });
    t.after(legacyCtx.close);
    await post(legacyCtx, '/api/sources/webpage', { url: 'https://learn.example/x', title: 'X', text: LONG_TEXT });
    const res = await post(legacyCtx, '/api/extension/relevance', {
      blocks: [{ id: 'a', text: LONG_TEXT }, { id: 'b', text: 'Another sentence long enough to be considered a block of text.' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.matches.length, 2);
  });

  await t.test('invalid blocks → 400', async () => {
    assert.equal((await post(ctx, '/api/extension/relevance', { blocks: [] })).status, 400);
    assert.equal((await post(ctx, '/api/extension/relevance', { blocks: [{ id: '', text: LONG_TEXT }] })).status, 400);
    assert.equal((await post(ctx, '/api/extension/relevance', { blocks: [{ id: 'a', text: '   ' }] })).status, 400);
    assert.equal((await post(ctx, '/api/extension/relevance', { blocks: [{ id: 'a', text: 'x'.repeat(601) }] })).status, 400);
  });
});

test('extension briefing — grounded answer in the tutor envelope', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  await t.test('without material → needsContent (honest abstain)', async () => {
    const res = await post(ctx, '/api/extension/briefing', { text: LONG_TEXT });
    assert.equal(res.status, 200);
    assert.equal(res.data.needsContent, true);
    assert.deepEqual(res.data.citations, []);
  });

  await post(ctx, '/api/sources/webpage', {
    url: 'https://learn.example/recursion',
    title: 'Recursion 101',
    text: LONG_TEXT,
  });

  await t.test('with material → answer + citations the panel can render', async () => {
    const res = await post(ctx, '/api/extension/briefing', { text: LONG_TEXT });
    assert.equal(res.status, 200);
    assert.equal(res.data.answer, TUTOR_ANSWER);
    assert.equal(res.data.needsContent, false);
    assert.equal(res.data.citations.length, 1);
    assert.equal(res.data.citations[0].title, 'Recursion 101');
    assert.equal(typeof res.data.model, 'string');
  });

  await t.test('validation: text bounds and sourceIds', async () => {
    assert.equal((await post(ctx, '/api/extension/briefing', { text: 'too short' })).status, 400);
    assert.equal((await post(ctx, '/api/extension/briefing', { text: 'x'.repeat(1501) })).status, 400);
    assert.equal((await post(ctx, '/api/extension/briefing', { text: LONG_TEXT, sourceIds: [42] })).status, 400);
  });
});
