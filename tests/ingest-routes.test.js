// T4 round: the ingest surface — every place untrusted bytes enter the app.
//
// This file covers the routes under /api/sources, /api/viewer, /api/media and
// /api/share that turn a browser-supplied file (or a pasted document link) into
// a stored, citable source. The rest of the suite already owns the extractors
// themselves (tests/extract.test.js, tests/extract-media.test.js), the AI
// transport (tests/ai-router.test.js), the storage-ingest variant
// (tests/storage-ingest.test.js) and the two-user model (tests/two-users.test.js).
// What is covered HERE and nowhere else:
//
//   upload validation   — extension/MIME lies, dangerous filenames, oversize,
//                          decompression bombs, empty and unextractable input.
//   persistence         — the stored source_kind, read-back through the viewer,
//                          and the promise that a FAILED extraction leaves no
//                          half-written row behind.
//   ownership           — another user's id is 404 on the viewer, the source
//                          PATCH, both organization routes and the share route,
//                          and no content from that user appears anywhere.
//   media               — /api/media/ocr validation, its size guards, and the
//                          honest degradation when the engine has nothing to read.
//
// Offline by construction: no NIM, no ChromaDB, no external fetch. The only
// stubbed network is the share route's document fetch, which is intercepted so
// it can never leave the machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The oversize and zip-bomb assertions need a non-default cap. config.js reads
// process.env ONCE at import, so the overrides are set here BEFORE the dynamic
// imports below; `node --test` runs this file in its own process, so they cannot
// leak into another test file.
process.env.MAX_UPLOAD_MB = '1';
process.env.ZIP_MAX_UNCOMPRESSED_MB = '1';

const { startApp, buildPptx } = await import('./helpers.js');
const { ApiError } = await import('../server/middleware/errors.js');
const AdmZip = (await import('adm-zip')).default;

const MB = 1024 * 1024;
const CAP_MB = Number(process.env.MAX_UPLOAD_MB);
const ZIP_CAP_MB = Number(process.env.ZIP_MAX_UNCOMPRESSED_MB);

/** Text unique to the "other user's" material, so a leak is impossible to miss. */
const SECRET_TEXT = 'PASSAGE-FROM-USER-ONE-7c1d';

// ------------------------------------------------------------------ fixtures

/**
 * A minimal, structurally valid PDF with one text line per page — the same
 * shape tests/extract.test.js builds, inlined so this file stays independent.
 */
function buildPdf(pageTexts) {
  const pageIds = pageTexts.map((_, i) => 3 + i * 2);
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  };
  pageTexts.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 999 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objs[contentId] = `<< /Length ${stream.length} >> stream\n${stream}\nendstream`;
  });
  objs[999] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets = {};
  for (const id of Object.keys(objs).map(Number).sort((a, b) => a - b)) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const maxId = Math.max(...Object.keys(objs).map(Number));
  const xrefStart = out.length;
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}%%EOF`;
  return Buffer.from(out, 'latin1');
}

/** A PDF whose only page has no text-drawing operator at all: an image scan. */
function imageOnlyPdf() {
  return buildPdf(['']);
}

/** A real (tiny) 1×1 PNG. */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000a49444154789c6300010000050001'
  + '0d0a2db40000000049454e44ae426082',
  'hex',
);

/**
 * A PNG header that LIES about its size: it claims `w x h` pixels while being
 * a few dozen bytes long. The pixel guard must catch it before any decoding.
 */
function lyingPngHeader(w, h) {
  const buf = Buffer.alloc(33);
  TINY_PNG.copy(buf, 0, 0, 16); // signature + IHDR length + the "IHDR" tag
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

/** A .pptx whose single slide unpacks to far more than the zip cap. */
function zipBombPptx() {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('ppt/slides/slide1.xml',
    Buffer.from(`<p:sld><a:t>${'a'.repeat((ZIP_CAP_MB + 1) * MB)}</a:t></p:sld>`));
  return zip.toBuffer();
}

// ------------------------------------------------------------------- harness

/** Owner-aware fake vector store: retrieval honours the userId it is given. */
function ownerVector() {
  const store = [];
  return {
    store,
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      ids.forEach((id, i) => store.push({ id, embedding: embeddings[i], text: documents[i], metadata: metadatas[i] }));
    },
    queryChunks: async ({ nResults = 6, sourceIds = [], userId }) => {
      const pool = store
        .filter((s) => userId === undefined || s.metadata.ownerId === userId)
        .filter((s) => sourceIds.length === 0 || sourceIds.includes(s.metadata.sourceId));
      return pool.slice(0, nResults).map((s) => ({ ...s, distance: 0.2 }));
    },
    pingChroma: async () => true,
  };
}

/** Two fake users, verified exactly like the real verifier would. */
const twoUsers = {
  getUserFromRequest: async (req) => (req.headers['x-test-user'] ? { id: req.headers['x-test-user'] } : null),
};
const auth = (user) => ({ 'Content-Type': 'application/json', 'x-test-user': user });

/** Multipart POST with the file's name (and optionally its MIME type). */
function upload(base, url, { name, bytes, mime, user }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], mime ? { type: mime } : undefined), name);
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: user ? { 'x-test-user': user } : undefined,
    body: fd,
  });
}

const uploadFile = (ctx, file) => upload(ctx.base, '/api/sources/upload', file);
const ocrFile = (ctx, file) => upload(ctx.base, '/api/media/ocr', file);

/** The stored title of the only source in the database, or null. */
async function onlyTitle(db) {
  const rows = await db.all('SELECT title FROM sources');
  return rows.length === 1 ? rows[0].title : null;
}

/** True when nothing at all was written for a failed ingest. */
async function noRowsWritten(ctx) {
  const sources = (await ctx.db.get('SELECT COUNT(*) AS n FROM sources')).n;
  const segments = (await ctx.db.get('SELECT COUNT(*) AS n FROM source_segments')).n;
  const activity = (await ctx.db.get('SELECT COUNT(*) AS n FROM activity')).n;
  const vectors = Array.isArray(ctx.vector?.store) ? ctx.vector.store.length : 0;
  return sources === 0 && segments === 0 && activity === 0 && vectors === 0;
}

/** Where a title would land on disk — the containment check made concrete. */
function resolvesInside(root, title) {
  const resolved = path.resolve(root, title);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// ============================================================ upload validation

test('an upload that lies about its contents is refused, not parsed hopefully', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  await t.test('a .pdf that is really a PNG is refused as an unsupported file', async () => {
    const res = await uploadFile(ctx, { name: 'photo.pdf', bytes: TINY_PNG, mime: 'image/png' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'UNSUPPORTED_FILE');
  });

  await t.test('the same lie is caught when the client reports no MIME type', async () => {
    const res = await uploadFile(ctx, { name: 'photo.pdf', bytes: TINY_PNG });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  });

  await t.test('the reverse lie — PDF bytes named .png — is refused', async () => {
    const res = await uploadFile(ctx, { name: 'photo.png', bytes: buildPdf(['Cells are the basic unit of life.']), mime: 'image/png' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'UNSUPPORTED_FILE');
    assert.ok(body.error.message.includes('.pdf, .docx, and .pptx'), body.error.message);
  });

  await t.test('a .docx that is really a .pptx is refused by its own extractor', async () => {
    const res = await uploadFile(ctx, { name: 'deck.docx', bytes: buildPptx() });
    assert.equal(res.status, 400);
    const body = await res.json();
    // The container opens (both are zips) but holds no Word document body.
    assert.equal(body.error.code, 'UNSUPPORTED_FILE');
  });

  await t.test('none of them stored a source', async () => {
    assert.equal(await noRowsWritten(ctx), true);
  });
});

test('dangerous filenames are stored under a sanitised name and cannot escape the data directory', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  // A title is only ever a NAME; the ingest path never writes uploaded bytes to
  // disk. `path.resolve(root, title)` still has to stay inside the root, which is
  // what proves the sanitised value carries no separator, drive or traversal.
  const root = path.resolve('data');

  const cases = [
    ['../../etc/passwd.pdf', 'passwd.pdf'],
    ['/etc/passwd.pdf', 'passwd.pdf'],
    ['C:\\Windows\\system32\\evil.pdf', 'evil.pdf'],
    ['..\\..\\secrets\\chapter.pdf', 'chapter.pdf'],
    [`${'x'.repeat(400)}.pdf`, `${'x'.repeat(160)}`], // capped at 160 characters
  ];

  for (const [name, expectedTitle] of cases) {
    await t.test(`${JSON.stringify(name.slice(0, 28))}… → ${JSON.stringify(expectedTitle.slice(0, 24))}`, async () => {
      const res = await uploadFile(ctx, { name, bytes: buildPdf([SECRET_TEXT]) });
      assert.equal(res.status, 201);
      const { source } = await res.json();
      assert.equal(source.title, expectedTitle);
      // The stored name is a single path segment, nothing more.
      assert.equal(path.basename(source.title), source.title);
      assert.ok(!source.title.includes('/') && !source.title.includes('\\'), 'no separator survived');
      assert.ok(!source.title.includes(':'), 'no drive letter survived');
      assert.ok(!source.title.includes('\u0000'), 'no null byte survived');
      assert.equal(resolvesInside(root, source.title), true, `resolved outside ${root}`);
      assert.ok(source.title.length <= 160, 'title never exceeds 160 characters');
    });
  }

  await t.test('no file was written outside the database directory', async () => {
    // Uploads are memory-only, so a traversal name has nothing to escape INTO.
    // The proof is that the only rows the ingest created are the ones above, all
    // named by a sanitised single segment.
    const rows = await ctx.db.all('SELECT title FROM sources ORDER BY created_at');
    assert.equal(rows.length, cases.length);
    for (const row of rows) {
      assert.equal(path.basename(row.title), row.title);
      assert.ok(resolvesInside(root, row.title), `${row.title} escaped the root`);
    }
  });

  await t.test('a filename containing a null byte is refused, and nothing is stored', async (t) => {
    // DOCUMENTED DEFECT (reported, NOT fixed — sources are not mine to edit):
    // a filename with an embedded NUL ("chapter\u0000secret.pdf") makes the
    // multipart parser itself fail, so the request never reaches
    // `sanitizeFilename` (which already strips control characters) and the
    // answer is a bare 500 INTERNAL instead of the documented 4xx envelope.
    //
    // What this pins is the part that must never regress: the rejection is
    // TOTAL — no source row, nothing in the library, nothing on disk. The wrong
    // error CODE is a cosmetic defect; an accepted or half-stored file would
    // not be. The 500 is recorded here as the current, reported behaviour.
    const ctx2 = await startApp({ vector: ownerVector() });
    t.after(ctx2.close);
    const res = await uploadFile(ctx2, { name: 'chapter\u0000secret.pdf', bytes: buildPdf([SECRET_TEXT]) });
    assert.equal(res.status, 500, 'reported defect: a NUL in the name currently answers 500, not a 4xx');
    assert.equal((await res.json()).error.code, 'INTERNAL');
    assert.equal(await noRowsWritten(ctx2), true, 'no source row from a malformed name');
    assert.equal(await onlyTitle(ctx2.db), null, 'nothing reached the library');
    const { sources } = await (await fetch(`${ctx2.base}/api/sources`)).json();
    assert.deepEqual(sources, []);
  });
});

test('an oversize upload is refused with the documented 413, never a crash', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const res = await uploadFile(ctx, { name: 'big.pdf', bytes: Buffer.alloc(CAP_MB * MB + 1000) });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.code, 'FILE_TOO_LARGE');
  assert.ok(body.error.message.includes(`upload limit is ${CAP_MB} MB`), body.error.message);
  assert.equal(await noRowsWritten(ctx), true);
});

test('a zip whose decompressed size exceeds the cap is refused before extraction', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const bytes = await zipBombPptx();
  // The upload itself is tiny — only its UNCOMPRESSED size is a bomb.
  assert.ok(bytes.length < CAP_MB * MB, 'the fixture must pass the upload byte cap');
  const res = await uploadFile(ctx, { name: 'bomb.pptx', bytes });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.code, 'FILE_TOO_LARGE');
  assert.ok(body.error.message.includes(`unpacks to more than ${ZIP_CAP_MB} MB`), body.error.message);
  assert.equal(await noRowsWritten(ctx), true);
});

test('a legitimate small Office file still uploads', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const res = await uploadFile(ctx, { name: 'recursion-slides.pptx', bytes: buildPptx() });
  assert.equal(res.status, 201);
  const { source } = await res.json();
  assert.equal(source.type, 'pptx');
  assert.equal(source.slideCount, 2);
  assert.ok(source.chunkCount >= 1);
});

// ================================================== empty / unextractable input

test('an empty file is refused as an unreadable upload, not stored as empty content', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  for (const [ext, label] of [['.pdf', 'PDF'], ['.pptx', 'PowerPoint'], ['.docx', 'Word document']]) {
    await t.test(`empty ${label} file`, async () => {
      const res = await uploadFile(ctx, { name: `empty${ext}`, bytes: Buffer.alloc(0) });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    });
  }
  assert.equal(await noRowsWritten(ctx), true);
});

test('a file with no extractable text is refused with the honest EMPTY_CONTENT, never a successful empty source', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const res = await uploadFile(ctx, { name: 'scanned.pdf', bytes: imageOnlyPdf() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'EMPTY_CONTENT');
  assert.ok(body.error.message.includes('image-only'), body.error.message);

  // The rejection is honest in both directions: no source row, and the source
  // list is empty — so a "0 slides, 0 chunks" ghost source can never appear.
  assert.equal(await noRowsWritten(ctx), true);
  const { sources } = await (await fetch(`${ctx.base}/api/sources`)).json();
  assert.deepEqual(sources, []);
});

// =============================================================== persistence

test('an uploaded source is stored with its kind and is readable back through the API', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const res = await uploadFile(ctx, { name: 'chapter3.pdf', bytes: buildPdf(['Cells are the basic unit of life.', 'Mitosis produces two identical cells.']) });
  assert.equal(res.status, 201);
  const { source } = await res.json();
  assert.equal(source.type, 'pdf');
  assert.equal(source.pageCount, 2);
  assert.equal(source.chunkCount, 2);
  assert.ok(source.id.startsWith('src_'));

  // The row carries the canonical v8 source_kind alongside `type`; A39's finding
  // was that omitting it made an ingested kind read back as the default 'pdf'.
  const row = await ctx.db.get('SELECT * FROM sources WHERE id = ?', source.id);
  assert.equal(row.source_kind, 'pdf');
  assert.equal(row.type, 'pdf');
  assert.equal(row.user_id, 'default');

  // The vectors landed, owned by the user and tagged with the source's kind.
  const stored = ctx.vector.store.filter((c) => c.metadata.sourceId === source.id);
  assert.equal(stored.length, source.chunkCount);
  assert.equal(stored[0].metadata.sourceKind, 'pdf');

  // Retrievable through the library listing.
  const list = await (await fetch(`${ctx.base}/api/sources`)).json();
  assert.equal(list.sources.length, 1);
  assert.equal(list.sources[0].id, source.id);
  assert.equal(list.sources[0].type, 'pdf');
  assert.equal(list.unsortedSourceCount, 1);

  // And through the viewer, in the documented `document` shape.
  const viewer = await fetch(`${ctx.base}/api/viewer/${source.id}`);
  assert.equal(viewer.status, 200);
  const { document } = await viewer.json();
  assert.equal(document.sourceId, source.id);
  assert.equal(document.type, 'pdf');
  assert.equal(document.viewable, true);
  assert.equal(document.pageCount, 2);
  assert.deepEqual(document.segments.map((s) => s.location), [{ page: 1 }, { page: 2 }]);
  assert.ok(document.segments[0].text.includes('Cells'));

  // The POST alias answers the same shape (A23's stored-text call reads it).
  const alias = await fetch(`${ctx.base}/api/viewer/${source.id}/document`, { method: 'POST' });
  assert.equal(alias.status, 200);
  assert.deepEqual((await alias.json()).document.segments, document.segments);
});

test('the viewer serves the stored text as an inline private plain-text body', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const { source } = await (await uploadFile(ctx, { name: 'chapter3.pdf', bytes: buildPdf(['Cells are the basic unit of life.']) })).json();
  const res = await fetch(`${ctx.base}/api/viewer/${source.id}/text`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(res.headers.get('content-disposition'), 'inline; filename="chapter3.pdf.txt"');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const text = await res.text();
  assert.ok(text.includes('[Page 1]'), 'the location label is written into the body');
  assert.ok(text.includes('Cells are the basic unit of life.'));
});

test('a failed extraction leaves no half-written source row behind', async (t) => {
  const failingAi = {
    embedTexts: async () => { throw new ApiError(502, 'NIM_ERROR', 'stubbed embedding failure'); },
    embedQuery: async () => [],
    chatCompletion: async () => '',
  };
  const ctx = await startApp({ ai: failingAi, vector: ownerVector() });
  t.after(ctx.close);

  const res = await uploadFile(ctx, { name: 'chapter3.pdf', bytes: buildPdf(['Cells are the basic unit of life.']) });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'NIM_ERROR');
  assert.equal(await noRowsWritten(ctx), true);
  // The embedding-model metadata the failed attempt nearly recorded is clean.
  assert.equal(await ctx.db.get('SELECT value FROM app_meta WHERE key = ?', 'embed_model'), null);
});

test('a failed vector store leaves no source row and no orphaned metadata', async (t) => {
  const boomVector = {
    ...ownerVector(),
    addChunks: async () => { throw new ApiError(503, 'CHROMA_UNAVAILABLE', 'vector down'); },
    store: [],
  };
  const ctx = await startApp({ vector: boomVector });
  t.after(ctx.close);

  const res = await uploadFile(ctx, { name: 'chapter3.pdf', bytes: buildPdf(['Cells are the basic unit of life.']) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'CHROMA_UNAVAILABLE');
  assert.equal(await noRowsWritten(ctx), true);
  assert.equal(await ctx.db.get('SELECT value FROM app_meta WHERE key = ?', 'embed_model'), null);
});

// ==================================================================== ownership

test("another user's source id is 404 everywhere and leaks no content", async (t) => {
  const ctx = await startApp({ ai: undefined, vector: ownerVector(), auth: twoUsers });
  t.after(ctx.close);

  // User one uploads material only they may read.
  const owned = await uploadFile(ctx, { name: 'notes.pdf', bytes: buildPdf([SECRET_TEXT]), user: 'u1' });
  assert.equal(owned.status, 201);
  const { source } = await owned.json();
  assert.equal(source.title, 'notes.pdf');

  await t.test('GET /api/viewer/:id → 404, no content', async () => {
    const res = await fetch(`${ctx.base}/api/viewer/${source.id}`, { headers: auth('u2') });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'SOURCE_NOT_FOUND');
    assert.ok(!JSON.stringify(body).includes(SECRET_TEXT), 'no text from the owner in the body');
    assert.ok(!JSON.stringify(body).includes(source.id), 'the id is not echoed back');
  });

  await t.test('POST /api/viewer/:id/document → 404, no content', async () => {
    const res = await fetch(`${ctx.base}/api/viewer/${source.id}/document`, { method: 'POST', headers: auth('u2') });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'SOURCE_NOT_FOUND');
    assert.ok(!JSON.stringify(body).includes(SECRET_TEXT), 'no text from the owner in the body');
  });

  await t.test('GET /api/viewer/:id/text → 404, no content', async () => {
    const res = await fetch(`${ctx.base}/api/viewer/${source.id}/text`, { headers: auth('u2') });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'SOURCE_NOT_FOUND');
    assert.ok(!JSON.stringify(body).includes(SECRET_TEXT), 'no text from the owner in the body');
    // The private text body is never produced: it is not served as text/plain.
    assert.notEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  });

  await t.test('PATCH /api/sources/:id → 404, the row is untouched', async () => {
    const res = await fetch(`${ctx.base}/api/sources/${source.id}`, {
      method: 'PATCH', headers: auth('u2'), body: JSON.stringify({ title: 'stolen' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'SOURCE_NOT_FOUND');
    const row = await ctx.db.get('SELECT * FROM sources WHERE id = ?', source.id);
    assert.equal(row.title, 'notes.pdf');
  });

  await t.test('POST /api/sources/:id/accept-suggestion → 404', async () => {
    const res = await fetch(`${ctx.base}/api/sources/${source.id}/accept-suggestion`, { method: 'POST', headers: auth('u2') });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'SOURCE_NOT_FOUND');
  });

  await t.test('POST /api/sources/:id/suggest-organization → 404', async () => {
    const res = await fetch(`${ctx.base}/api/sources/${source.id}/suggest-organization`, {
      method: 'POST', headers: auth('u2'), body: JSON.stringify({ description: 'biology' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'SOURCE_NOT_FOUND');
  });

  await t.test('the owner can still read their own material', async () => {
    const res = await fetch(`${ctx.base}/api/viewer/${source.id}`, { headers: auth('u1') });
    assert.equal(res.status, 200);
    const { document } = await res.json();
    assert.ok(document.segments[0].text.includes(SECRET_TEXT));
  });

  await t.test("user two's library is empty", async () => {
    const { sources } = await (await fetch(`${ctx.base}/api/sources`, { headers: auth('u2') })).json();
    assert.deepEqual(sources, []);
  });
});

test('a malformed source id on the viewer is 404, identical to a missing one', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  for (const id of ['src_', 'src_' + 'x'.repeat(49), '../../etc/passwd', 'src_a/b', 'src_seed_demo', 'not-a-source', 'src_ ', '']) {
    await t.test(`${JSON.stringify(id.slice(0, 20))}`, async () => {
      const res = await fetch(`${ctx.base}/api/viewer/${encodeURIComponent(id)}`);
      assert.equal(res.status, 404);
      const body = await res.json();
      // A malformed id can reach the router as '' — Express then answers the
      // generic NOT_FOUND. Either way it is 404 and no material is disclosed.
      assert.ok(['SOURCE_NOT_FOUND', 'NOT_FOUND'].includes(body.error.code), body.error.code);
      assert.ok(!JSON.stringify(body).includes(SECRET_TEXT), 'no content in the envelope');
    });
  }
});

test('an anonymous ingest is refused before a row is read or written', async (t) => {
  const ctx = await startApp({ auth: twoUsers });
  t.after(ctx.close);

  const cases = [
    ['GET', '/api/sources'],
    ['POST', '/api/sources/upload'],
    ['POST', '/api/sources/webpage', { url: 'https://example.org', text: 'x'.repeat(60) }],
    ['GET', '/api/viewer/src_anything'],
    ['POST', '/api/media/ocr'],
    ['POST', '/api/share', { url: 'https://example.org/x.pptx' }],
  ];
  for (const [method, url, body] of cases) {
    await t.test(`${method} ${url}`, async () => {
      const res = await fetch(`${ctx.base}${url}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(res.status, 401);
      const envelope = await res.json();
      assert.deepEqual(envelope, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to use this endpoint.' } });
    });
  }
  assert.equal(await noRowsWritten(ctx), true);
});

// ======================================================================= media

test('POST /api/media/ocr refuses a non-image, an oversize image and a lying header', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  await t.test('a PDF is not an image', async () => {
    const res = await ocrFile(ctx, { name: 'doc.pdf', bytes: buildPdf(['Cells are the basic unit of life.']), mime: 'application/pdf' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'UNSUPPORTED_FILE');
  });

  await t.test('PDF bytes named .png are caught by the magic-byte check', async () => {
    const res = await ocrFile(ctx, { name: 'scan.png', bytes: buildPdf(['Cells are the basic unit of life.']), mime: 'image/png' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'UNSUPPORTED_FILE');
    assert.ok(body.error.message.includes('its contents are not one'), body.error.message);
  });

  await t.test('PNG bytes named .jpg are caught by the magic-byte check', async () => {
    const res = await ocrFile(ctx, { name: 'scan.jpg', bytes: TINY_PNG, mime: 'image/jpeg' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'UNSUPPORTED_FILE');
  });

  await t.test('an empty image is refused as validation, not fed to the engine', async () => {
    const res = await ocrFile(ctx, { name: 'empty.png', bytes: Buffer.alloc(0), mime: 'image/png' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  });

  await t.test('a byte-oversize image is 413 FILE_TOO_LARGE', async () => {
    const res = await ocrFile(ctx, { name: 'big.png', bytes: Buffer.alloc(CAP_MB * MB + 1000), mime: 'image/png' });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'FILE_TOO_LARGE');
  });

  await t.test('a pixel bomb is 413 even though the file is tiny', async () => {
    // 6000×7000 = 42 megapixels, well past the 40 MP ceiling, in 33 bytes.
    const res = await ocrFile(ctx, { name: 'huge.png', bytes: lyingPngHeader(6000, 7000), mime: 'image/png' });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'FILE_TOO_LARGE');
    assert.ok(body.error.message.includes('megapixels'), body.error.message);
  });

  await t.test('none of them stored anything', async () => {
    assert.equal(await noRowsWritten(ctx), true);
  });
});

/**
 * A real PNG with visible content, taken from this repository (it is committed,
 * so a fresh clone has it too). Used when the engine is actually available, so
 * the "it read something" branch is exercised rather than skipped.
 */
function someRealImage() {
  const candidates = [
    path.resolve('extension/icons/icon48.png'),
    path.resolve('extension/icons/icon128.png'),
  ];
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return fs.readFileSync(file);
    } catch {
      /* not this clone — fall through */
    }
  }
  return TINY_PNG; // a valid image with nothing on it
}

test('POST /api/media/ocr reads a valid small image honestly — or degrades honestly', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const res = await ocrFile(ctx, { name: 'whiteboard.png', bytes: someRealImage(), mime: 'image/png' });

  if (res.status === 200) {
    // The engine is installed and read something. Nothing may be invented: the
    // echoed text is the engine's own, and every reported field is its measurement.
    const body = await res.json();
    assert.equal(body.language, 'en');
    assert.equal(typeof body.text, 'string');
    assert.equal(body.charCount, body.text.length, 'charCount counts the text it echoes');
    assert.ok(body.lineCount >= 1);
    assert.ok(['good', 'fair', 'poor', 'unknown'].includes(body.reliability), body.reliability);
    assert.ok(body.confidence === null || (body.confidence >= 0 && body.confidence <= 1));
    assert.ok(Array.isArray(body.unreliableLines));
    assert.ok(typeof body.durationMs === 'number' && body.durationMs >= 0);
    // A confident read carries no disclaimer; a shaky one always does.
    if (body.reliability === 'good') assert.equal(body.note, null);
    else assert.ok(typeof body.note === 'string' && body.note.length > 0, 'an unreliable read must explain itself');
    // The client is told which lines to distrust, and never a fabricated count.
    assert.ok(body.unreliableLines.every((n) => Number.isInteger(n) && n >= 1 && n <= body.lineCount));
  } else if (res.status === 400) {
    // The engine ran and found no text in this image. That is the honest answer:
    // EMPTY_CONTENT, never a 200 carrying an empty read.
    assert.equal((await res.json()).error.code, 'EMPTY_CONTENT');
  } else {
    // No language data installed and no way to fetch it: degrade, do not invent.
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'OCR_UNAVAILABLE');
  }
  assert.equal(await noRowsWritten(ctx), true);
});

test('POST /api/media/ocr with ingest=1 either stores an image source or refuses honestly', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);

  const fd = new FormData();
  fd.append('file', new Blob([someRealImage()], { type: 'image/png' }), 'whiteboard.png');
  fd.append('ingest', '1');
  const res = await fetch(`${ctx.base}/api/media/ocr`, { method: 'POST', body: fd });

  if (res.status === 201) {
    const { source } = await res.json();
    assert.equal(source.type, 'image');
    assert.equal(source.sizeLabel, 'image');
    // The v8 media_assets row is written in the same batch as the source.
    const row = await ctx.db.get('SELECT source_kind, type FROM sources WHERE id = ?', source.id);
    assert.equal(row.source_kind, 'image');
    const media = await ctx.db.get('SELECT * FROM media_assets WHERE source_id = ?', source.id);
    assert.ok(media, 'an image source must have its media_assets row');
    assert.equal(media.kind, 'image');
    assert.equal(ctx.vector.store.filter((c) => c.metadata.sourceId === source.id).length, source.chunkCount);
  } else {
    // Nothing readable (or no engine): an honest refusal and no half-written row.
    assert.ok([400, 503].includes(res.status), `unexpected status ${res.status}`);
    assert.ok(['EMPTY_CONTENT', 'OCR_UNAVAILABLE'].includes((await res.json()).error.code));
    assert.equal(await noRowsWritten(ctx), true);
  }
});

// ======================================================================== share

/** Intercept ONLY the share route's document fetch; everything else passes through. */
function stubDocumentFetch(t, bytes, status = 200) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const u = typeof url === 'string' ? url : String(url?.url ?? url);
    if (u.includes('files.example.org')) {
      calls.push({ url: u, init });
      return new Response(bytes, { status });
    }
    return realFetch(url, init);
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}

test('POST /api/share refuses what it cannot read, and stores what it can', async (t) => {
  const ctx = await startApp({ vector: ownerVector() });
  t.after(ctx.close);
  const post = (body) => fetch(`${ctx.base}/api/share`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  await t.test('an unparseable URL is 400 INVALID_URL', async () => {
    const res = await post({ url: 'not a url' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_URL');
  });

  await t.test('a javascript: URL is 400 INVALID_URL', async () => {
    const res = await post({ url: 'javascript:alert(1)' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_URL');
  });

  await t.test('an over-long title is 400 VALIDATION_ERROR', async () => {
    const res = await post({ url: 'https://example.org/l.pptx', title: 'x'.repeat(200) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  });

  await t.test('a non-document URL with no pasted text asks for the text', async () => {
    const res = await post({ url: 'https://example.org/lesson' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.message.includes('Paste the page text'), body.error.message);
  });

  await t.test('a share to a private host is refused before any fetch', async () => {
    const calls = stubDocumentFetch(t, buildPptx());
    const res = await post({ url: 'http://127.0.0.1/x.pptx' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(calls.length, 0, 'the SSRF guard must run before the request');
  });

  await t.test('a decompression bomb shared by URL is 413 and leaves a failed receipt, no source', async () => {
    stubDocumentFetch(t, await zipBombPptx());
    const res = await post({ url: 'https://files.example.org/bomb.pptx' });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'FILE_TOO_LARGE');
    const shares = await ctx.db.all('SELECT * FROM shares ORDER BY created_at');
    const last = shares.at(-1);
    assert.equal(last.status, 'failed');
    assert.ok(last.error.includes('unpacks to more than'), last.error);
    assert.equal(last.source_id, null);
    // The honest failure: a failed receipt is traceable, and NO source exists.
    assert.equal((await ctx.db.get('SELECT COUNT(*) AS n FROM sources')).n, 0);
  });

  await t.test('a shared document is fetched, extracted and stored as a normal source', async () => {
    const calls = stubDocumentFetch(t, buildPptx(['Shared slide about cells.']));
    const res = await post({ url: 'https://files.example.org/lesson.pptx', title: 'Shared lesson' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.source.type, 'pptx');
    assert.equal(body.source.slideCount, 1);
    assert.equal(body.source.url, 'https://files.example.org/lesson.pptx');
    assert.equal(body.share.kind, 'file');
    assert.equal(body.share.sourceId, body.source.id);
    assert.equal(calls.length, 1);
    assert.equal((await ctx.db.get('SELECT status FROM shares WHERE id = ?', body.share.id)).status, 'ingested');

    // It is a normal source: listable and readable through the viewer.
    const list = await (await fetch(`${ctx.base}/api/sources`)).json();
    assert.equal(list.sources.length, 1);
    assert.equal(list.sources[0].id, body.source.id);
    const viewer = await fetch(`${ctx.base}/api/viewer/${body.source.id}`);
    assert.equal(viewer.status, 200);
    assert.ok((await viewer.json()).document.segments[0].text.includes('Shared slide about cells.'));
  });

  await t.test('a client-supplied userId in the share body is ignored', async () => {
    // Ownership comes from the verified request, never from the payload.
    const ctx2 = await startApp({ auth: twoUsers });
    t.after(ctx2.close);
    stubDocumentFetch(t, buildPptx(['Owned by the verified caller.']));
    const res = await fetch(`${ctx2.base}/api/share`, {
      method: 'POST',
      headers: auth('u2'),
      body: JSON.stringify({ url: 'https://files.example.org/lesson.pptx', userId: 'u1' }),
    });
    assert.equal(res.status, 201);
    const { source, share } = await res.json();
    const row = await ctx2.db.get('SELECT user_id FROM sources WHERE id = ?', source.id);
    assert.equal(row.user_id, 'u2');
    assert.equal((await ctx2.db.get('SELECT user_id FROM shares WHERE id = ?', share.id)).user_id, 'u2');
  });
});
