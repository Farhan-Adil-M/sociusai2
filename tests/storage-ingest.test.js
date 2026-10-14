// Direct-to-Supabase-Storage ingest (POST /api/sources/storage-ingest):
// the browser uploads big files straight to the "study-sources" bucket, then
// hands the server the object path; the server fetches the bytes back with the
// USER's own JWT and runs the normal extraction pipeline. Offline like the
// rest of the suite: a fake token-verifying auth and a stubbed global fetch
// stand in for Supabase — no real network anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';

// The storage cap is read from process.env at REQUEST time (sources.js), so
// pin it here to make the size assertions deterministic regardless of the
// machine's environment. `node --test` runs this file in its own process.
process.env.MAX_STORAGE_UPLOAD_MB = '25';

const { startApp, buildPptx } = await import('./helpers.js');

const CAP_MB = Number(process.env.MAX_STORAGE_UPLOAD_MB);
const PPTX_BYTES = buildPptx(); // real (minimal) pptx with two text slides

/** Fake supabase-mode auth: only "Bearer good-token" verifies, and like the
 *  real thing it hands back the token so requireAuth sets req.userToken. */
function fakeTokenAuth() {
  return {
    mode: 'supabase',
    getUserFromRequest: async (req) => {
      const header = req.headers?.authorization ?? '';
      if (header === 'Bearer good-token') return { id: 'user-1', token: 'good-token' };
      return null;
    },
  };
}

/** Intercept ONLY storage-object fetches (recorded in `calls`); every other
 *  fetch — e.g. the test's own HTTP calls to the app — passes through to the
 *  real fetch. The current canned reply is whatever `respond` returns, so a
 *  subtest can swap it (404, garbage bytes…) and restore. */
function stubStorageFetch() {
  const realFetch = global.fetch;
  const calls = [];
  const stub = { respond: () => new Response(PPTX_BYTES, { status: 200 }) };
  global.fetch = async (url, init) => {
    const u = typeof url === 'string' ? url : String(url?.url ?? url);
    if (u.includes('/storage/v1/object/')) {
      calls.push({ url: u, init });
      return stub.respond(u, init);
    }
    return realFetch(url, init);
  };
  stub.calls = calls;
  stub.restore = () => { global.fetch = realFetch; };
  return stub;
}

test('storage-ingest — auth, validation, size cap, and the happy path (stubbed storage fetch)', async (t) => {
  const stub = stubStorageFetch();
  t.after(stub.restore);

  const ctx = await startApp({ auth: fakeTokenAuth() });
  t.after(ctx.close);

  const post = (body, token = 'good-token') => fetch(`${ctx.base}/api/sources/storage-ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, data: await res.json() }));

  await t.test('no auth token → 401 UNAUTHENTICATED', async () => {
    const res = await post({ storagePath: 'user-1/doc.pdf', title: 'Doc' }, null);
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'UNAUTHENTICATED');
  });

  await t.test('bad token → 401 (nothing is ingested)', async () => {
    const res = await post({ storagePath: 'user-1/doc.pdf' }, 'stale-token');
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'UNAUTHENTICATED');
  });

  await t.test('invalid storagePath → 400 VALIDATION_ERROR', async () => {
    const cases = [
      {},                          // missing
      { storagePath: '' },         // empty
      { storagePath: 'doc.pdf' },  // no bucket-object path separator
      { storagePath: '../secrets.pdf' },            // path traversal
      { storagePath: 'user-1/../../etc.pdf' },      // traversal mid-path
    ];
    for (const body of cases) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.data.error.code, 'VALIDATION_ERROR', JSON.stringify(body));
    }
  });

  await t.test('unsupported extension → 400 UNSUPPORTED_FILE', async () => {
    const res = await post({ storagePath: 'user-1/notes.txt' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'UNSUPPORTED_FILE');
  });

  await t.test(`sizeBytes above the ${CAP_MB} MB cap → 413 FILE_TOO_LARGE (no fetch attempted)`, async () => {
    const before = stub.calls.length;
    const res = await post({ storagePath: 'user-1/big.pdf', sizeBytes: (CAP_MB + 1) * 1024 * 1024 });
    assert.equal(res.status, 413);
    assert.equal(res.data.error.code, 'FILE_TOO_LARGE');
    assert.ok(res.data.error.message.includes(`storage upload limit is ${CAP_MB} MB`), res.data.error.message);
    assert.equal(stub.calls.length, before); // rejected before touching storage
  });

  await t.test('storage object unreadable → 422 STORAGE_FETCH_FAILED', async () => {
    stub.respond = () => new Response('Object not found', { status: 404 });
    const res = await post({ storagePath: 'user-1/missing.pdf' });
    assert.equal(res.status, 422);
    assert.equal(res.data.error.code, 'STORAGE_FETCH_FAILED');
  });

  await t.test('happy path: stubbed pptx bytes → 201 source created via the user JWT', async () => {
    stub.respond = () => new Response(PPTX_BYTES, { status: 200 });
    const before = stub.calls.length;
    const res = await post({
      storagePath: 'user-1/recursion-slides.pptx',
      title: 'Recursion slides',
      sizeBytes: PPTX_BYTES.length,
    });
    assert.equal(res.status, 201);
    const { source } = res.data;
    assert.equal(source.type, 'pptx');
    assert.equal(source.title, 'Recursion slides');
    assert.equal(source.slideCount, 2);
    assert.equal(source.sizeLabel, '2 slides');
    assert.ok(source.chunkCount >= 1);

    // the object was fetched with the user's OWN token (RLS-safe), from the right path
    assert.equal(stub.calls.length, before + 1);
    const call = stub.calls.at(-1);
    assert.ok(call.url.includes('/storage/v1/object/study-sources/user-1/recursion-slides.pptx'), call.url);
    assert.equal(call.init.headers.Authorization, 'Bearer good-token');

    // vectors actually landed in the (fake) store, owned by the caller
    const stored = ctx.vector.store.find((c) => c.text.includes('base case'));
    assert.ok(stored, 'chunks should be embedded and stored');
    assert.equal(stored.metadata.ownerId, 'user-1');
  });

  await t.test('title omitted → falls back to the object file name', async () => {
    stub.respond = () => new Response(PPTX_BYTES, { status: 200 });
    const res = await post({ storagePath: 'user-1/recursion-slides.pptx' });
    assert.equal(res.status, 201);
    assert.equal(res.data.source.title, 'recursion-slides.pptx');
  });

  await t.test('unreadable PDF bytes → 400 with the deterministic extraction error', async () => {
    stub.respond = () => new Response(Buffer.from('%PDF-1.7 not really a pdf'), { status: 200 });
    const res = await post({ storagePath: 'user-1/notes.pdf' });
    assert.equal(res.status, 400);
    // extractPdf maps both "parser threw" and "no text extracted" onto 400s.
    assert.ok(['VALIDATION_ERROR', 'EMPTY_CONTENT'].includes(res.data.error.code), res.data.error.code);
  });
});
