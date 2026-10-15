// Boot + wiring regression smoke — the guard against the app silently losing
// an endpoint or crashing at startup. Four areas, all offline:
//
//   1. server/config.js          — defaults, `optional()` trimming / empty-string
//                                  handling, numeric coercion, and `assertConfig()`
//                                  exiting 1 with the documented message when
//                                  NIM_API_KEY is missing (child process, so the
//                                  test runner itself is never killed).
//   2. scripts/env-check.mjs     — run as a subprocess with a scrubbed
//                                  environment; it must FAIL honestly (exit 1,
//                                  naming the missing variable) and never print
//                                  "RESULT: PASS" while a required value is absent.
//   3. Route wiring completeness — every router mounted in server/app.js and
//                                  every endpoint documented in
//                                  docs/API_CONTRACT.md must respond. Probed with
//                                  an auth-denying stub, so each private endpoint
//                                  must answer 401 UNAUTHENTICATED with the error
//                                  envelope — an unmounted route would instead
//                                  fall through to notFoundHandler ("No route
//                                  for …"), failing the test.
//   4. Boot smoke                — the app starts against a throwaway SQLite file
//                                  on an ephemeral port (listen(0)), reports
//                                  healthy via GET /api/health, and shuts down
//                                  cleanly.
//
// No network: NIM/vector are stubbed via tests/helpers.js, auth is a stub, the
// database is a fresh temp file, and every subprocess gets a scrubbed
// environment (no .env is read).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { startApp } from './helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'server', 'config.js')).href;
const ENV_CHECK = path.join(REPO_ROOT, 'scripts', 'env-check.mjs');

// --- subprocess helpers -----------------------------------------------------

// Every child gets ONLY PATH/HOME plus the vars a test explicitly passes, so a
// developer's real .env values (or exported shell vars) can never leak into an
// assertion about defaults or missing variables.
function childEnv(extra = {}) {
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, ...extra };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

/** Run an ESM snippet in a fresh child process with a scrubbed environment. */
function runSnippet(code, { env = {} } = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/** Run a repo script (e.g. scripts/env-check.mjs) as a subprocess. */
function runScript(scriptPath, args = [], { env = {} } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

// === 1. server/config.js =====================================================

const CONFIG_PROBE = `
  const { config } = await import(${JSON.stringify(CONFIG_URL)});
  process.stdout.write(JSON.stringify(config));
`;

function loadConfigInChild(env = {}) {
  const result = runSnippet(CONFIG_PROBE, { env });
  assert.equal(result.status, 0, `config child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('config.js: documented defaults apply when no environment variables are set', () => {
  const config = loadConfigInChild();

  assert.equal(config.port, 3000);
  assert.equal(config.maxUploadMb, 25);
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.nimApiKey, '');
  assert.equal(config.nimBaseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(config.nimEmbedModel, 'nvidia/nemotron-3-embed-1b');
  assert.equal(config.nimChatModel, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(config.nimAssessModel, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(config.nimTimeoutMs, 45000);
  assert.equal(config.youtubeApiKey, '');
  assert.equal(config.ocrEngine, 'tesseract');
  assert.equal(config.viewerMaxMb, 25);
  assert.equal(config.ragMinSimilarity, 0.1);
  assert.equal(config.ragRelativeKeep, 0.5);
  assert.equal(config.extensionMinSimilarity, 0.8);
  assert.equal(config.chromaApiKey, '');
  assert.equal(config.chromaCollection, 'socius_chunks');
  assert.equal(config.chromaLocalHost, 'localhost');
  assert.equal(config.chromaLocalPort, 8100);
  assert.equal(config.supabaseUrl, '');
  assert.equal(config.supabaseAnonKey, '');
  assert.equal(config.supabaseDbUrl, '');
  assert.equal(config.tursoDatabaseUrl, '');
  assert.equal(config.tursoAuthToken, '');
  assert.equal(config.dataDir, 'data');
  // aiRouter defaults must mirror the canonical NIM_* models when unset.
  assert.equal(config.aiRouter.tutorModel, config.nimChatModel);
  assert.equal(config.aiRouter.assessModel, config.nimAssessModel);
  assert.equal(config.aiRouter.embedModel, config.nimEmbedModel);
});

test('config.js: optional() trims values and treats empty/whitespace-only as unset', () => {
  const config = loadConfigInChild({
    NIM_API_KEY: '  nvapi-trimmed-key  ',
    BIND_HOST: ' 0.0.0.0 ',
    SUPABASE_URL: '  https://unit.supabase.co  ',
    OCR_ENGINE: '  tesseract  ',
    // Whitespace-only must fall back to the default, not become '   '.
    NIM_TIMEOUT_MS: '   ',
    PORT: '   ',
    DATA_DIR: '   ',
  });

  assert.equal(config.nimApiKey, 'nvapi-trimmed-key');
  assert.equal(config.bindHost, '0.0.0.0');
  assert.equal(config.supabaseUrl, 'https://unit.supabase.co');
  assert.equal(config.ocrEngine, 'tesseract');
  assert.equal(config.nimTimeoutMs, 45000);
  assert.equal(config.port, 3000);
  assert.equal(config.dataDir, 'data');
});

test('config.js: numeric env values are coerced to numbers; AI_* overrides win', () => {
  const config = loadConfigInChild({
    PORT: '8080',
    MAX_UPLOAD_MB: '2',
    RAG_MIN_SIMILARITY: '0.25',
    EXTENSION_MIN_SIMILARITY: '0.9',
    CHROMA_LOCAL_PORT: '9000',
    AI_TUTOR_MODEL: 'vendor/tutor-override',
  });

  assert.equal(config.port, 8080);
  assert.equal(typeof config.port, 'number');
  assert.equal(config.maxUploadMb, 2);
  assert.equal(config.ragMinSimilarity, 0.25);
  assert.equal(config.extensionMinSimilarity, 0.9);
  assert.equal(config.chromaLocalPort, 9000);
  // The override applies to its slot only; the others keep the NIM default.
  assert.equal(config.aiRouter.tutorModel, 'vendor/tutor-override');
  assert.equal(config.aiRouter.assessModel, config.nimAssessModel);
  assert.equal(config.aiRouter.embedModel, config.nimEmbedModel);
});

// === assertConfig() ---------------------------------------------------------
// Runs in a child process because the failure path calls process.exit(1) —
// in-process it would kill the whole test runner.

const ASSERT_CONFIG_PROBE = `
  const { assertConfig } = await import(${JSON.stringify(CONFIG_URL)});
  assertConfig();
  process.stdout.write('SURVIVED');
`;

test('assertConfig: exits 1 and names NIM_API_KEY when it is missing', () => {
  for (const env of [{}, { NIM_API_KEY: '   ' }]) { // absent AND whitespace-only
    const result = runSnippet(ASSERT_CONFIG_PROBE, { env });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /Missing environment variable\(s\): NIM_API_KEY\./);
    assert.match(result.stderr, /Copy \.env\.example to \.env and fill in real values\./);
    assert.doesNotMatch(result.stdout, /SURVIVED/, 'assertConfig must exit before the server starts');
  }
});

test('assertConfig: passes (exit 0) when NIM_API_KEY is set', () => {
  const result = runSnippet(ASSERT_CONFIG_PROBE, { env: { NIM_API_KEY: 'nvapi-unit-test' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SURVIVED');
});

// === 2. scripts/env-check.mjs ===============================================

test('env-check: development without NIM_API_KEY fails honestly (exit 1, named)', () => {
  const result = runScript(ENV_CHECK, ['--no-env-file']);
  const out = result.stdout + result.stderr;
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.match(out, /RESULT: FAIL/);
  assert.doesNotMatch(out, /RESULT: PASS/, 'must not claim PASS while a required variable is absent');
  assert.match(out, /NIM_API_KEY/);
  assert.match(out, /NOT SET \(required in every environment\)/);
});

test('env-check: a whitespace-only NIM_API_KEY is not counted as set', () => {
  const result = runScript(ENV_CHECK, ['--no-env-file'], { env: { NIM_API_KEY: '   ' } });
  const out = result.stdout + result.stderr;
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.match(out, /RESULT: FAIL/);
  assert.doesNotMatch(out, /RESULT: PASS/);
  assert.match(out, /NIM_API_KEY is required but not set/);
});

test('env-check: development with a plausible key passes (exit 0)', () => {
  const result = runScript(ENV_CHECK, ['--no-env-file'], { env: { NIM_API_KEY: 'nvapi-dev-check-unit' } });
  const out = result.stdout + result.stderr;
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${out}`);
  assert.match(out, /RESULT: PASS/);
});

test('env-check: production mode names each missing production variable', () => {
  const result = runScript(ENV_CHECK, ['--no-env-file'], {
    env: { NODE_ENV: 'production', NIM_API_KEY: 'nvapi-prod-check-unit' },
  });
  const out = result.stdout + result.stderr;
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
  assert.match(out, /RESULT: FAIL/);
  assert.doesNotMatch(out, /RESULT: PASS/);
  assert.match(out, /SUPABASE_DB_URL/);
  assert.match(out, /CHROMA_API_KEY/);
  assert.match(out, /SUPABASE_URL/);
  assert.match(out, /SUPABASE_ANON_KEY/);
});

// === 3. Route wiring completeness ===========================================
//
// The endpoint table is derived from docs/API_CONTRACT.md (every endpoint
// marked shipped) plus server/app.js mounts. `documented: false` marks routes
// that exist in server/routes/*.js but are NOT in API_CONTRACT.md — they are
// probed too, so a future removal is still noticed.
//
// With the auth-denying stub every private route must answer exactly
// 401 UNAUTHENTICATED. An unmounted router falls through to notFoundHandler
// (404 "No route for …") and fails the assertion.

const DENY_AUTH = Object.freeze({
  mode: 'supabase',
  getUserFromRequest: async () => null,
});

const CONTRACT_ENDPOINTS = [
  // method, path, documented
  ['GET', '/api/health', true], // public — handled separately below
  ['POST', '/api/auth/login', true],
  ['POST', '/api/auth/refresh', true],
  // v1.0 sources
  ['POST', '/api/sources/upload', true],
  ['POST', '/api/sources/storage-ingest', true],
  ['POST', '/api/sources/webpage', true],
  ['GET', '/api/sources', true],
  // v1.0 AI features
  ['POST', '/api/tutor/ask', true],
  ['POST', '/api/extension/briefing', true],
  ['POST', '/api/flashcards/generate', true],
  ['POST', '/api/quiz/generate', true],
  ['POST', '/api/quiz/quiz_missing/answer', true],
  ['GET', '/api/learner/progress', true],
  // v1.1 sessions + organisation
  ['GET', '/api/sessions', true],
  ['POST', '/api/sessions', true],
  ['GET', '/api/sessions/ses_missing', true],
  ['PATCH', '/api/sessions/ses_missing', true],
  ['PATCH', '/api/sources/src_missing', true],
  ['POST', '/api/sources/src_missing/suggest-organization', true],
  ['POST', '/api/sources/src_missing/accept-suggestion', true],
  ['GET', '/api/decks', true],
  ['GET', '/api/decks/deck_missing', true],
  ['PATCH', '/api/decks/deck_missing/cards/0', true],
  ['DELETE', '/api/decks/deck_missing', true],
  // v1.4 profile + onboarding
  ['GET', '/api/profile', true],
  ['PATCH', '/api/profile', true],
  ['DELETE', '/api/profile', true],
  ['POST', '/api/onboarding/message', true],
  ['POST', '/api/onboarding/skip', true],
  // v1.6 extension contract (relevance covered above briefing)
  ['POST', '/api/extension/relevance', true],
  // v2.0 Wave 4
  ['POST', '/api/adaptive/generate', true],
  ['POST', '/api/adaptive/answer', true],
  ['GET', '/api/adaptive/progress', true],
  ['GET', '/api/planner', true],
  ['GET', '/api/advice', true],
  ['POST', '/api/share', true],
  ['POST', '/api/viewer/src_missing/document', true],
  ['GET', '/api/viewer/src_missing/text', true], // documented in the contract intro (text/plain)
  ['POST', '/api/media/youtube', true],
  ['POST', '/api/media/ocr', true],
  ['GET', '/api/events', true],
  // mounted in server/routes/*.js but NOT in API_CONTRACT.md (additive extras)
  ['GET', '/api/profile/preferences', false],
  ['GET', '/api/decks/due', false],
  ['GET', '/api/viewer/src_missing', false],
];

function needsBody(method) {
  return method !== 'GET' && method !== 'DELETE';
}

test('route wiring: every mounted and documented endpoint answers — none falls through to "No route"', async (t) => {
  const ctx = await startApp({ auth: DENY_AUTH });
  t.after(ctx.close);

  await t.test('GET /api/health is public even with auth denying everyone', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.status, 'string');
    assert.ok(body.checks, 'health must report dependency checks');
  });

  await t.test('POST /api/auth/login and /api/auth/refresh reject an empty body (supabase mode)', async () => {
    for (const p of ['/api/auth/login', '/api/auth/refresh']) {
      const res = await fetch(`${ctx.base}${p}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 400, `${p} should validate its body`);
      const body = await res.json();
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(typeof body.error.message, 'string');
    }
  });

  for (const [method, endpointPath, documented] of CONTRACT_ENDPOINTS) {
    if (endpointPath === '/api/health') continue; // public, checked above
    if (endpointPath.startsWith('/api/auth/')) continue; // checked above
    await t.test(`${method} ${endpointPath}${documented ? '' : ' (extra route, not in API_CONTRACT.md)'}`, async () => {
      const res = await fetch(`${ctx.base}${endpointPath}`, {
        method,
        headers: needsBody(method) ? { 'Content-Type': 'application/json' } : {},
        body: needsBody(method) ? '{}' : undefined,
      });
      // Mounted + guarded = 401. "No route for …" (unmounted) = 404 NOT_FOUND.
      assert.equal(res.status, 401, `${method} ${endpointPath} is not mounted behind auth (got ${res.status})`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.ok(res.headers.get('x-request-id'), 'every response carries X-Request-Id');
      const body = await res.json();
      assert.equal(body.error.code, 'UNAUTHENTICATED');
      assert.equal(body.error.message, 'Sign in to use this endpoint.');
      // FILED DEFECT — see docs/HANDOFF.md (2026-10-15, T10): the 401 envelope
      // is the one error path that omits `requestId` from the body, although
      // the X-Request-Id response header above is present. Pinned as current
      // behaviour, not endorsed.
      assert.equal(typeof body.error.requestId, 'undefined');
    });
  }
});

// === Handler smoke on a prototype-mode app ==================================
// A 401-only probe proves a route is mounted; these checks prove a handful of
// routers actually execute their handlers end-to-end against a fresh temp DB.

const PROTOTYPE_AUTH = Object.freeze({
  mode: 'prototype',
  getUserFromRequest: async () => ({ id: 'default' }),
});

test('mounted routers execute their handlers (prototype auth, temp DB)', async (t) => {
  const ctx = await startApp({ auth: PROTOTYPE_AUTH });
  t.after(ctx.close);

  await t.test('GET /api/health reports ok with stubbed dependencies', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.sqlite.ok, true);
    assert.equal(body.checks.nim.ok, true);
    assert.equal(body.checks.chroma.ok, true);
    assert.ok(['prototype', 'supabase'].includes(body.checks.auth.mode));
    assert.equal(typeof body.checks.limits.maxUploadMb, 'number');
  });

  const emptyLists = [
    ['GET', '/api/sources', 'sources'],
    ['GET', '/api/sessions', 'sessions'],
    ['GET', '/api/decks', 'decks'],
    ['GET', '/api/events', 'events'],
  ];
  for (const [method, p, key] of emptyLists) {
    await t.test(`${method} ${p} answers 200 with an empty ${key}[]`, async () => {
      const res = await fetch(`${ctx.base}${p}`);
      assert.equal(res.status, 200, `${p} returned ${res.status}`);
      const body = await res.json();
      assert.ok(Array.isArray(body[key]), `${p} must answer { ${key}: [...] }`);
      assert.equal(body[key].length, 0);
    });
  }

  await t.test('GET /api/learner/progress answers the documented rollup shape', async () => {
    const res = await fetch(`${ctx.base}/api/learner/progress`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.topics, []);
    assert.equal(typeof body.overall.quizzesTaken, 'number');
  });

  await t.test('GET /api/adaptive/progress answers the level rollup shape', async () => {
    const res = await fetch(`${ctx.base}/api/adaptive/progress`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.topics, []);
    assert.deepEqual(body.levelCounts, { 1: 0, 2: 0, 3: 0, 4: 0 });
  });

  await t.test('GET /api/planner and GET /api/advice answer without AI calls', async () => {
    const planner = await (await fetch(`${ctx.base}/api/planner`)).json();
    assert.ok(planner.plan, 'planner must answer { plan: … }');
    assert.equal(planner.plan.hasEvidence, false);
    const advice = await (await fetch(`${ctx.base}/api/advice`)).json();
    assert.ok(advice.advice, 'advice must answer { advice: … }');
  });

  await t.test('GET /api/profile reports state "new" for a fresh user', async () => {
    const res = await fetch(`${ctx.base}/api/profile`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.profile.state, 'new');
  });

  await t.test('POST /api/auth/login reports prototype mode instead of pretending', async () => {
    const res = await fetch(`${ctx.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'prototype');
  });
});

// === Error envelope + request-id traceability ===============================

test('error envelope carries {code, message, requestId} and echoes X-Request-Id', async (t) => {
  const ctx = await startApp({ auth: PROTOTYPE_AUTH });
  t.after(ctx.close);

  await t.test('404 envelope (missing session) includes the echoed request id', async () => {
    const res = await fetch(`${ctx.base}/api/sessions/ses_missing`, {
      headers: { 'X-Request-Id': 'bootwiring-echo-1' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-request-id'), 'bootwiring-echo-1');
    const body = await res.json();
    assert.equal(body.error.code, 'SESSION_NOT_FOUND');
    assert.equal(typeof body.error.message, 'string');
    assert.notEqual(body.error.message, '');
    assert.equal(body.error.requestId, 'bootwiring-echo-1');
  });

  await t.test('400 envelope (invalid tutor question) includes the echoed request id', async () => {
    const res = await fetch(`${ctx.base}/api/tutor/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'bootwiring-echo-2' },
      body: '{}',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.requestId, 'bootwiring-echo-2');
  });

  await t.test('an unsafe client-supplied request id is replaced, not echoed', async () => {
    const res = await fetch(`${ctx.base}/api/sessions/ses_missing`, {
      headers: { 'X-Request-Id': 'not a safe token!!' },
    });
    assert.equal(res.status, 404);
    const echoed = res.headers.get('x-request-id');
    assert.notEqual(echoed, 'not a safe token!!');
    assert.match(echoed, /^[A-Za-z0-9._-]{1,64}$/, 'a bad inbound id must be replaced by a fresh UUID');
  });
});

// === 4. Boot smoke ==========================================================

test('boot smoke: fresh app on an ephemeral port reports healthy and shuts down cleanly', async (t) => {
  const ctx = await startApp();

  const port = Number(new URL(ctx.base).port);
  assert.ok(Number.isInteger(port) && port > 0, 'listen(0) must pick an ephemeral port');
  assert.notEqual(port, 3000, 'the smoke server must not bind the fixed default port');

  await t.test('GET /api/health answers 200 ok', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.sqlite.ok, true);
  });

  await t.test('shutdown completes within 5 seconds', async () => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('server.close() did not finish within 5s')), 5000);
    });
    try {
      await Promise.race([ctx.close(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  });
});
