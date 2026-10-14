/**
 * e2e-extension-api.mjs — live verification of the browser extension's
 * backend: /api/auth/login + /api/auth/refresh and
 * /api/extension/relevance + /api/extension/briefing, with the two real
 * test accounts (per-user isolation included).
 *
 *   node --env-file=.env --env-file=.env.e2e scripts/e2e-extension-api.mjs
 *
 * Runs against the REAL application server (E2E_BASE_URL, default local
 * :7000). Credentials come from the env files only — never printed.
 * Created records stay in place (test accounts; journal for review).
 */
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:7000';
const U1 = { email: process.env.E2E_U1_EMAIL, password: process.env.E2E_U1_PASSWORD };
const U2 = { email: process.env.E2E_U2_EMAIL, password: process.env.E2E_U2_PASSWORD };

if (!U1.email || !U2.email) {
  console.error('missing E2E_U1_EMAIL / E2E_U2_* in the env files');
  process.exit(1);
}

const journal = { checks: [], scores: {} };
function check(name, cond, detail = '') {
  journal.checks.push({ name, pass: Boolean(cond), detail: String(detail).slice(0, 160) });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : ` — ${String(detail).slice(0, 160)}`));
  return cond;
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

const PHRASE_A = 'gamma-lyra-prism-C-4t8w';
const PHRASE_B = 'delta-maris-quill-B-8x2n';
const SENTENCE_A = `The ${PHRASE_A} diagram folds twelve recursive layers before the base case halts the descent entirely.`;
const SENTENCE_B = `A ${PHRASE_B} valve opens whenever pressure crosses the calibrated arboretum threshold suddenly.`;
const UNRELATED = 'The airport shuttle leaves the main terminal every thirty minutes during the rainy season.';

console.log(`E2E (extension API) against ${BASE}`);

/* ------ 1. login: real password grant through OUR backend --------------- */
const login = await call(null, 'POST', '/api/auth/login', { email: U1.email, password: U1.password });
check('login: valid credentials return a Supabase session',
  login.status === 200 && login.data?.mode === 'supabase'
  && typeof login.data?.session?.access_token === 'string'
  && typeof login.data?.session?.refresh_token === 'string'
  && login.data?.session?.user?.email === U1.email,
  `${login.status} ${JSON.stringify(login.data?.error ?? {}).slice(0, 80)}`);
const tok1 = login.data?.session?.access_token;

const badLogin = await call(null, 'POST', '/api/auth/login', { email: U1.email, password: 'definitely-wrong-9x' });
check('login: wrong password → 401 UNAUTHENTICATED', badLogin.status === 401 && badLogin.data?.error?.code === 'UNAUTHENTICATED');

/* ------ 2. refresh rotates the session ---------------------------------- */
const refreshed = await call(null, 'POST', '/api/auth/refresh', { refresh_token: login.data?.session?.refresh_token });
check('refresh: rotating the refresh token returns a new session',
  refreshed.status === 200 && typeof refreshed.data?.session?.access_token === 'string'
  && refreshed.data?.session?.access_token !== tok1);
const tok = refreshed.data?.session?.access_token ?? tok1;

const badRefresh = await call(null, 'POST', '/api/auth/refresh', { refresh_token: 'not-a-real-token' });
check('refresh: bogus token → 401', badRefresh.status === 401);

/* ------ 3. extension endpoints demand a token (supabase mode) ----------- */
check('relevance without a token → 401', (await call(null, 'POST', '/api/extension/relevance', { blocks: [{ id: 'a', text: SENTENCE_A }] })).status === 401);
check('briefing without a token → 401', (await call(null, 'POST', '/api/extension/briefing', { text: SENTENCE_A })).status === 401);

/* ------ 4. per-user material for both accounts -------------------------- */
const wA = await call(tok1, 'POST', '/api/sources/webpage', {
  url: `https://e2e-ext.example/a/${PHRASE_A}`, title: `E2E-ext A ${PHRASE_A.slice(0, 10)}`,
  text: `Study atom for extension checks. ${SENTENCE_A} Physics-by-proxy notes for the highlighter.`,
});
check('A: webpage source ingested (201)', wA.status === 201, `${wA.status}`);
const srcA = wA.data?.source?.id;
journal.records = { srcA };

const loginB = await call(null, 'POST', '/api/auth/login', { email: U2.email, password: U2.password });
check('B: password grant through our backend', loginB.status === 200 && typeof loginB.data?.session?.access_token === 'string');
const tokB = loginB.data?.session?.access_token;
const wB = await call(tokB, 'POST', '/api/sources/webpage', {
  url: `https://e2e-ext.example/b/${PHRASE_B}`, title: `E2E-ext B ${PHRASE_B.slice(0, 10)}`,
  text: `Study atom for extension checks. ${SENTENCE_B} Isolation-check opcode notes.`,
});
check('B: webpage source ingested (201)', wB.status === 201, `${wB.status}`);
const srcB = wB.data?.source?.id;
journal.records.srcB = srcB;

/* ------ 5. relevance: own sentence matches, others do not --------------- */
const relOwn = await call(tok, 'POST', '/api/extension/relevance', {
  blocks: [{ id: 'own', text: SENTENCE_A }, { id: 'noise', text: UNRELATED }, { id: 'foreign', text: SENTENCE_B }],
});
check('relevance: request accepted (200)', relOwn.status === 200, `${relOwn.status} ${JSON.stringify(relOwn.data?.error ?? {}).slice(0, 80)}`);
const byId = Object.fromEntries((relOwn.data?.matches ?? []).map((m) => [m.id, m]));
journal.scores.minScore = relOwn.data?.minScore;
check('relevance: own sentence earns a highlight with its source citation',
  byId.own && byId.own.citation?.title?.includes(PHRASE_A.slice(0, 10)) && byId.own.score >= relOwn.data?.minScore,
  JSON.stringify(byId.own ?? {}).slice(0, 120));
check('relevance: unrelated sentence earns no highlight', !byId.noise,
  byId.noise ? `score ${byId.noise.score}` : '');
check('relevance: B material never highlights for A (isolation)', !byId.foreign,
  byId.foreign ? `score ${byId.foreign.score}` : '');

/* ------ 6. briefing: grounded + isolated -------------------------------- */
// Factual questions the material itself can answer (the model honestly
// abstains when asked to "explain" gibberish study atoms — by design).
const briefOwn = await call(tok, 'POST', '/api/extension/briefing', {
  text: `${SENTENCE_A} According to this passage, what does the diagram do, and how many recursive layers does it fold?`,
});
check('briefing: grounded answer recites the phrase',
  briefOwn.status === 200 && briefOwn.data?.needsContent === false && briefOwn.data?.answer?.includes(PHRASE_A),
  `${briefOwn.status} ${String(briefOwn.data?.answer ?? '').slice(0, 80)}`);
check('briefing: citations come only from A material',
  (briefOwn.data?.citations ?? []).every((c) => c.sourceId !== srcB),
  JSON.stringify((briefOwn.data?.citations ?? []).map((c) => c.sourceId)).slice(0, 120));

const briefB = await call(tok, 'POST', '/api/extension/briefing', {
  text: `${SENTENCE_B} According to this passage, what opens the valve, and when exactly does it open?`,
});
check('briefing: B material is unreachable for A (no phrase leak)',
  briefB.status === 200 && briefB.data?.answer?.includes(PHRASE_B) === false,
  String(briefB.data?.answer ?? '').slice(0, 100));

/* ------ 7. panel validation honesty ------------------------------------- */
const tooShort = await call(tok, 'POST', '/api/extension/briefing', { text: 'tiny' });
check('briefing: too-short text → 400 VALIDATION_ERROR', tooShort.status === 400 && tooShort.data?.error?.code === 'VALIDATION_ERROR');
const badBlocks = await call(tok, 'POST', '/api/extension/relevance', { blocks: [] });
check('relevance: empty blocks → 400 VALIDATION_ERROR', badBlocks.status === 400 && badBlocks.data?.error?.code === 'VALIDATION_ERROR');

fs.writeFileSync('/tmp/opencode/e2e-extension-journal.json', JSON.stringify(journal, null, 2));
const fails = journal.checks.filter((c) => !c.pass);
console.log(`\nE2E RESULT: ${journal.checks.length - fails.length}/${journal.checks.length} checks passed`);
console.log('scores:', JSON.stringify(journal.scores));
if (fails.length) console.log('FAILURES:', JSON.stringify(fails, null, 1));
console.log('journal:', '/tmp/opencode/e2e-extension-journal.json');
process.exit(fails.length ? 1 : 0);
