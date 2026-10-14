/**
 * e2e-storage-upload.mjs — live verification of the big-file (>4 MB) upload
 * path: the browser uploads the PDF DIRECTLY to the Supabase Storage bucket
 * 'study-sources' with the user's own JWT, then POST /api/sources/storage-ingest
 * fetches the object back and runs the normal extraction pipeline.
 *
 *   node --env-file=.env --env-file=.env.e2e scripts/e2e-storage-upload.mjs
 *   E2E_BASE_URL=https://socius-ai.vercel.app node --env-file=.env --env-file=.env.e2e scripts/e2e-storage-upload.mjs
 *
 * Runs against the REAL application server (E2E_BASE_URL, default local
 * :7000). Credentials come from the env files only — never printed.
 * Requires SUPABASE_URL + SUPABASE_ANON_KEY in the env files (the same pair
 * the frontend uses). Storage cleanup is best-effort: this project's storage
 * config denies user-JWT DELETEs, so a few 2 KB test objects may remain in
 * the (test) bucket. The ingested source stays in the test account.
 */
import fs from 'node:fs';
import { buildBigPdf } from './make-big-pdf.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:7000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const U1 = { email: process.env.E2E_U1_EMAIL, password: process.env.E2E_U1_PASSWORD };
const U2 = { email: process.env.E2E_U2_EMAIL, password: process.env.E2E_U2_PASSWORD };

if (!U1.email || !U2.email) {
  console.error('missing E2E_U1_EMAIL / E2E_U2_* in the env files');
  process.exit(1);
}
if (!SUPABASE_URL || !ANON) {
  console.error('missing SUPABASE_URL / SUPABASE_ANON_KEY in the env files');
  process.exit(1);
}

const BIG_PDF_PATH = '/tmp/opencode/e2e-storage-upload-big.pdf';
const cleanupPaths = []; // [token, objectPath] pairs to DELETE at the end

const journal = { checks: [], records: {} };
function check(name, cond, detail = '') {
  journal.checks.push({ name, pass: Boolean(cond), detail: String(detail).slice(0, 160) });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : ` — ${String(detail).slice(0, 160)}`));
  return cond;
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

// Direct Supabase Storage REST, exactly what frontend/js/auth.js
// storageUploadToStudySources() does through supabase-js.
function storageObject(method, objectPath, token, body, contentType) {
  return fetch(`${SUPABASE_URL}/storage/v1/object/study-sources/${objectPath}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
  });
}

console.log(`E2E (storage upload) against ${BASE}`);

/* ------ 0. accounts ------------------------------------------------------ */
const loginA = await login(U1.email, U1.password);
check('login: test account A gets a session',
  loginA.status === 200 && typeof loginA.data?.session?.access_token === 'string',
  `${loginA.status}`);
const tokA = loginA.data?.session?.access_token;
const uidA = loginA.data?.session?.user?.id;

const loginB = await login(U2.email, U2.password);
check('login: test account B gets a session',
  loginB.status === 200 && typeof loginB.data?.session?.access_token === 'string',
  `${loginB.status}`);
const tokB = loginB.data?.session?.access_token;
const uidB = loginB.data?.session?.user?.id;

if (!tokA || !tokB) {
  fs.writeFileSync('/tmp/opencode/e2e-storage-journal.json', JSON.stringify(journal, null, 2));
  console.log('cannot continue without sessions; journal:', '/tmp/opencode/e2e-storage-journal.json');
  process.exit(1);
}

/* ------ 0b. bucket probe: upload + owner read + foreign-read denial ------- */
// Functional probe (not the /storage/v1/bucket/… metadata endpoint — that one
// is admin-gated on newer Supabase projects and 404s even for real buckets).
const probePdf = buildBigPdf({ targetBytes: 2048, pages: 1 });
const probeObject = `${uidA}/${Date.now()}_e2e-probe.pdf`;
const probeUrl = `${SUPABASE_URL}/storage/v1/object/study-sources/${probeObject}`;
const probeUp = await fetch(probeUrl, {
  method: 'POST',
  headers: { apikey: ANON, Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/pdf' },
  body: probePdf,
});
check('bucket "study-sources": tiny probe upload with user JWT → 200',
  probeUp.status === 200, `upload ${probeUp.status} ${(await probeUp.text()).slice(0, 120)}`);
const probeOwn = await fetch(probeUrl, { headers: { apikey: ANON, Authorization: `Bearer ${tokA}` } });
check('bucket: owner reads their own object back (200)', probeOwn.status === 200,
  `GET ${probeOwn.status}`);
const probeForeign = await fetch(probeUrl, { headers: { apikey: ANON, Authorization: `Bearer ${tokB}` } });
check('bucket: unrelated user CANNOT read it (4xx)',
  probeForeign.status >= 400 && probeForeign.status < 500, `GET ${probeForeign.status}`);
const probeAnon = await fetch(probeUrl, { headers: { apikey: ANON } });
check('bucket: no user token CANNOT read it (4xx)',
  probeAnon.status >= 400 && probeAnon.status < 500, `GET ${probeAnon.status}`);
// Best-effort: this project's storage config denies user-JWT DELETEs, so the
// probe object may stay behind (2 KB, test bucket) — informational only.
const probeDel = await fetch(probeUrl, { method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${tokA}` } });
console.log(`info: probe object DELETE → ${probeDel.status} (403 is expected on this project; small leftovers are harmless)`);

/* ------ 1. generate the ~8 MB text-based PDF ----------------------------- */
const bigPdf = buildBigPdf({ targetBytes: 8 * 1024 * 1024, pages: 16 });
fs.writeFileSync(BIG_PDF_PATH, bigPdf);
check(`big PDF generated (${(bigPdf.length / 1048576).toFixed(2)} MB, text-based)`, bigPdf.length >= 7.5 * 1024 * 1024);

/* ------ 2. upload it straight to storage with A's JWT -------------------- */
const bigObject = `${uidA}/${Date.now()}_e2e-big.pdf`;
cleanupPaths.push([tokA, bigObject]);
const up = await storageObject('POST', bigObject, tokA, bigPdf, 'application/pdf');
const upBody = await up.text().catch(() => '');
check('storage upload: 8 MB PDF accepted by bucket (200)', up.status === 200, `upload ${up.status} ${upBody.slice(0, 120)}`);
journal.records.bigObject = { path: bigObject, uploadStatus: up.status, sizeBytes: bigPdf.length };

/* ------ 3. storage-ingest fetches it back and ingests -------------------- */
const ing = await call(tokA, 'POST', '/api/sources/storage-ingest', {
  storagePath: bigObject, title: 'E2E storage big upload', sizeBytes: bigPdf.length,
});
check('storage-ingest: 8 MB object → 201 with a source',
  ing.status === 201 && typeof ing.data?.source?.id === 'string',
  `${ing.status} ${JSON.stringify(ing.data?.error ?? ing.data?.source ?? {}).slice(0, 120)}`);
check('storage-ingest: extracted text produced chunks',
  (ing.data?.source?.chunkCount ?? 0) >= 1 && (ing.data?.source?.pageCount ?? 0) >= 1,
  `chunkCount=${ing.data?.source?.chunkCount} pageCount=${ing.data?.source?.pageCount}`);
journal.records.ingest = { status: ing.status, sourceId: ing.data?.source?.id ?? null, chunkCount: ing.data?.source?.chunkCount ?? null };

/* ------ 4. oversize guard: declared 26 MB → 413 -------------------------- */
const smallPdf = buildBigPdf({ targetBytes: 2048, pages: 1 });
const smallObject = `${uidA}/${Date.now()}_e2e-small.pdf`;
cleanupPaths.push([tokA, smallObject]);
const upSmall = await storageObject('POST', smallObject, tokA, smallPdf, 'application/pdf');
check('small companion object uploaded (200)', upSmall.status === 200, `upload ${upSmall.status}`);

const oversize = await call(tokA, 'POST', '/api/sources/storage-ingest', {
  storagePath: smallObject, title: 'E2E oversize declaration', sizeBytes: 26 * 1024 * 1024,
});
check('oversize: declared 26 MB → 413 FILE_TOO_LARGE',
  oversize.status === 413 && oversize.data?.error?.code === 'FILE_TOO_LARGE',
  `${oversize.status} ${oversize.data?.error?.code ?? ''}`);

/* ------ 5. path validation + foreign object ------------------------------ */
const noSlash = await call(tokA, 'POST', '/api/sources/storage-ingest', { storagePath: 'no-slash.pdf', sizeBytes: 1000 });
check('bad storagePath (no folder) → 400 VALIDATION_ERROR',
  noSlash.status === 400 && noSlash.data?.error?.code === 'VALIDATION_ERROR', `${noSlash.status}`);

const foreignObject = `${uidB}/${Date.now()}_e2e-b.pdf`;
cleanupPaths.push([tokB, foreignObject]);
const upForeign = await storageObject('POST', foreignObject, tokB, smallPdf, 'application/pdf');
check('B uploads its own small object (200)', upForeign.status === 200, `upload ${upForeign.status}`);
const foreignIngest = await call(tokA, 'POST', '/api/sources/storage-ingest', {
  storagePath: foreignObject, title: 'E2E foreign path', sizeBytes: smallPdf.length,
});
check('foreign storagePath (B\'s object, A\'s token) → 4xx',
  foreignIngest.status >= 400 && foreignIngest.status < 500 && foreignIngest.status !== 401,
  `${foreignIngest.status} ${foreignIngest.data?.error?.code ?? ''}`);

/* ------ 6. no token → 401 ------------------------------------------------ */
const noTok = await call(null, 'POST', '/api/sources/storage-ingest', { storagePath: bigObject, sizeBytes: bigPdf.length });
check('no token → 401', noTok.status === 401, `${noTok.status}`);

/* ------ 7. best-effort storage cleanup (DELETE often denied here) --------- */
for (const [token, objectPath] of cleanupPaths) {
  const res = await storageObject('DELETE', objectPath, token);
  console.log(`cleanup ${objectPath}: DELETE ${res.status} (403 expected on this project)`);
}

fs.writeFileSync('/tmp/opencode/e2e-storage-journal.json', JSON.stringify(journal, null, 2));
const fails = journal.checks.filter((c) => !c.pass);
console.log(`\nE2E RESULT: ${journal.checks.length - fails.length}/${journal.checks.length} checks passed`);
if (fails.length) console.log('FAILURES:', JSON.stringify(fails, null, 1));
console.log('journal: /tmp/opencode/e2e-storage-journal.json');
process.exit(fails.length ? 1 : 0);
