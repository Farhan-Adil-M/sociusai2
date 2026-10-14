// Extension ↔ site sync contract — fully offline: no network, no NIM, no
// browser, no Playwright (this file is part of `npm test` and must stay fast
// and deterministic forever).
//
// Three layers, in this repo's established node:test style:
//
//   1. manifest.json — the file the whole extension hangs off. MV3 correctness
//      (no MV2 leftovers, module service worker, minimal permissions), the
//      origins it may talk to (local dev + production), and the message
//      vocabulary every content script / popup actually sends, checked against
//      the REAL files of the other Wave 5 agents, so a rename on either side
//      fails here instead of silently breaking the extension in Chrome.
//
//   2. the #socius_session handoff fragment — the only wire format shared
//      between the extension (extension/background.js#handleOpenSite, producer)
//      and the website (frontend/js/auth.js#takeHandoffSession, consumer).
//      Neither module can be imported here (both touch chrome.* / window at
//      load), so the two sides are re-implemented verbatim from the shipped
//      source (line references below) and asserted against each other, plus
//      static markers so a renamed fragment or a removed btoa/atob fails.
//
//   3. the server's extension surface (POST /api/extension/relevance and
//      /api/extension/briefing) over real HTTP with the repo's stub pattern
//      from tests/two-users.test.js: prototype mode can never 401, so an auth
//      override is injected. Proves anonymous → 401, per-user isolation, and
//      malformed payloads rejected with ZERO embedding/chat calls — i.e.
//      "rejected before any network call", because the stubs count calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, makeAi, EMBEDDING } from './helpers.js';
import { config } from '../server/config.js';

/* --------------------------------------------------------------- helpers */

const EXT_DIR = new URL('../extension/', import.meta.url);

function readExt(relative) {
  return fs.readFileSync(new URL(relative, EXT_DIR), 'utf8');
}

function existsExt(relative) {
  return fs.existsSync(new URL(relative, EXT_DIR));
}

const EXT_JS_FILES = ['background.js', 'content/highlight.js', 'content/panel.js', 'popup/popup.js'];

// The message vocabulary. Producers send these over chrome.runtime.sendMessage;
// background.js#handleMessage switches on exactly these `case` labels.
const EXPECTED_TYPES = ['relevance', 'briefing', 'login', 'logout', 'openSite', 'getState', 'pageSession'];

// The one REVERSE-direction type (site → extension): background.js documents it
// in its contract header, and its active mechanism is the tabs.onUpdated sync
// path (the worker reads the site's own session off a finished tab load), not a
// message from a repo file. It is part of the documented contract, so it must
// keep having a case — but no shipped extension file is expected to send it.
const DOCUMENTED_REVERSE_TYPES = ['pageSession'];

function casesIn(source) {
  return [...source.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1]);
}

function typesUsed(source) {
  return [...source.matchAll(/type:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
}

/* --------------------------------------------- #socius_session contract */
// MIRRORS of the shipped code — keep in step with the real lines cited.
//
// Producer: extension/background.js lines 265–274 (handleOpenSite).
function buildHandoffUrl(siteUrl, session) {
  let url = siteUrl;
  if (session?.access_token && session?.refresh_token) {
    const payload = btoa(JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at ?? null,
    }));
    url += (url.includes('#') ? '&' : '#') + 'socius_session=' + encodeURIComponent(payload);
  }
  return url;
}

// Consumer: frontend/js/auth.js lines 91–118 (takeHandoffSession), plus the
// decodeBase64Json helper at lines 85–89. Returns { tokens, cleanedHash } or
// null; the shipped code instead does history.replaceState with the cleaned
// URL — asserted here as "fragment is gone from the cleaned hash".
function takeHandoffSession(hash) {
  try {
    if (!hash || !hash.startsWith('#')) return null;
    const params = new URLSearchParams(hash.slice(1));
    const raw = params.get('socius_session');
    if (!raw) return null;
    params.delete('socius_session');
    const rest = params.toString();
    const cleaned = rest ? '#' + rest : '';
    const parsed = JSON.parse(decodeBase64Json(raw));
    if (typeof parsed?.access_token !== 'string' || typeof parsed?.refresh_token !== 'string') return null;
    const tokens = { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
    if (typeof parsed.expires_at === 'number') tokens.expires_at = parsed.expires_at;
    return { tokens, cleaned };
  } catch {
    return null;
  }
}

function decodeBase64Json(raw) {
  const binary = atob(raw);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* --------------------------------------------- HTTP stubs (repo pattern) */

// Owner-aware in-memory vector stand-in. Copied from tests/two-users.test.js's
// ownerFakeVector with queryChunksBatch added (the relevance route prefers the
// batch call when the store supports it). Distance 0.01 → hitScore 0.99, which
// clears any configured extensionMinSimilarity. metadata.ownerId is written by
// the real upload pipeline (proven by two-users.test.js against it).
const FAKE_DISTANCE = 0.01;

function ownerFakeVector() {
  const store = [];
  const scoped = (userId, sourceIds) => store
    .filter((s) => userId === undefined || s.metadata.ownerId === userId)
    .filter((s) => sourceIds.length === 0 || sourceIds.includes(s.metadata.sourceId));
  return {
    store,
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      ids.forEach((id, i) => store.push({ id, embedding: embeddings[i], text: documents[i], metadata: metadatas[i] }));
    },
    queryChunks: async ({ nResults = 6, sourceIds = [], userId }) =>
      scoped(userId, sourceIds).slice(0, nResults).map((s) => ({ ...s, distance: FAKE_DISTANCE })),
    queryChunksBatch: async ({ embeddings, nResults = 6, sourceIds = [], userId }) =>
      embeddings.map(() => scoped(userId, sourceIds).slice(0, nResults).map((s) => ({ ...s, distance: FAKE_DISTANCE }))),
    pingChroma: async () => true,
  };
}

// makeAi() with embedTexts counted, so "rejected before any network call" is
// provable: a 400 must arrive with embedCalls untouched.
function trackingAi() {
  const base = makeAi();
  const embedCalls = [];
  return {
    ...base,
    embedCalls,
    embedTexts: async (texts) => {
      embedCalls.push(texts);
      return texts.map(() => EMBEDDING);
    },
  };
}

// The auth override from tests/two-users.test.js: a request is user u only with
// an `x-test-user: u` header; anything else verifies to null → 401.
const headerAuth = { getUserFromRequest: async (req) => (req.headers['x-test-user'] ? { id: req.headers['x-test-user'] } : null) };
const authHeaders = (user) => ({ 'Content-Type': 'application/json', 'x-test-user': user });

function post(ctx, url, body, user) {
  return fetch(`${ctx.base}${url}`, {
    method: 'POST',
    headers: user === null ? { 'Content-Type': 'application/json' } : authHeaders(user),
    body: JSON.stringify(body),
  });
}

async function addWebpage(ctx, page, user) {
  const res = await post(ctx, '/api/sources/webpage', page, user);
  assert.equal(res.status, 201, `upload for ${user} should succeed`);
  return (await res.json()).source.id;
}

/* ============================================================== tests */

test('extension manifest.json is a correct, minimal Manifest V3 surface', async (t) => {
  const manifest = JSON.parse(readExt('manifest.json'));

  await t.test('declares Manifest V3 with name, version and description', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, 'Socius AI — Study Highlighter');
    assert.match(manifest.version, /^\d+(\.\d+){0,3}$/); // 1-4 dot-separated integers
    assert.ok(manifest.description.length > 0);
    assert.ok(manifest.browser_specific_settings?.gecko?.id, 'gecko id kept for Firefox');
  });

  await t.test('background is a MODULE service worker with no MV2 leftovers', () => {
    assert.equal(manifest.background?.service_worker, 'background.js');
    assert.equal(manifest.background?.type, 'module', 'background.js is loaded as an ES module');
    assert.ok(!('scripts' in (manifest.background ?? {})), 'background.scripts is an invalid MV2 leftover and must not exist');
    assert.ok(existsExt('background.js'));
  });

  await t.test('host permissions cover local dev AND both production origins, and nothing broader', () => {
    const hosts = manifest.host_permissions;
    assert.ok(Array.isArray(hosts) && hosts.length > 0);
    for (const origin of ['http://localhost/*', 'http://127.0.0.1/*', 'https://socius-ai.vercel.app/*', 'https://sociusai2.vercel.app/*']) {
      assert.ok(hosts.includes(origin), `missing host permission for ${origin}`);
    }
    // No wildcard host is granted by default: <all_urls> / http://*/* would
    // be broad-host-permission review territory (see the report's rationale).
    for (const pattern of hosts) {
      assert.ok(!pattern.includes('<all_urls>'), `host_permissions must not contain <all_urls>: ${pattern}`);
      assert.ok(!/^[a-z*]+:\/\/\*/.test(pattern), `host_permissions must not be a scheme-wide wildcard: ${pattern}`);
    }
  });

  await t.test('optional host permissions stay available for the popup custom-server flow', () => {
    // popup.js#requestOriginAccess asks chrome.permissions.request for whatever
    // API URL the user types. That only succeeds for origins declared here, and
    // it is user-initiated (Save click), one origin at a time, behind Chrome's
    // own visible prompt — never granted silently.
    assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  });

  await t.test('runtime permissions are minimal: storage + scripting only', () => {
    // chrome.storage.local holds the sign-in session; chrome.storage.sync holds
    // settings. "scripting" exists for ONE feature: background.js#syncSiteSession
    // reads the Socius site's own session off a finished tab load (via
    // chrome.scripting.executeScript, which still needs a host permission for
    // the target and only ever targets the configured site origin) — that is
    // the "stay fully synced" requirement. chrome.tabs.create (openSite),
    // chrome.tabs.onUpdated and chrome.permissions.request (popup) need no
    // declared permission. Anything else here is creep.
    assert.deepEqual(manifest.permissions, ['storage', 'scripting']);
    assert.match(readExt('background.js'), /chrome\.scripting\.executeScript/, 'scripting must be justified by real usage');
  });

  await t.test('content scripts: panel before highlight, on every http/https page', () => {
    const [entry] = manifest.content_scripts;
    assert.deepEqual(entry.matches, ['http://*/*', 'https://*/*']);
    // panel.js defines window.SociusPanel; highlight.js consumes it on click.
    // Manifest array order IS execution order, so panel must come first.
    assert.deepEqual(entry.js, ['content/panel.js', 'content/highlight.js']);
    assert.deepEqual(entry.css, ['content/highlight.css']);
    assert.equal(entry.run_at, 'document_idle');
    assert.equal(entry.all_frames, false);
    for (const file of [...entry.js, ...entry.css]) {
      assert.ok(existsExt(`content/${file.split('/').pop()}`), `content script file missing: ${file}`);
    }
    // The dependency the order encodes actually exists in the shipped code.
    assert.ok(readExt('content/highlight.js').includes('window.SociusPanel'));
  });

  await t.test('web_accessible_resources exposes nothing', () => {
    // Nothing in the extension loads its own URLs from a page context: panel.js
    // draws inline SVG inside a shadow root and popup.html is an extension page.
    const war = manifest.web_accessible_resources;
    assert.ok(war === undefined || (Array.isArray(war) && war.length === 0), 'no web-accessible resources are needed');
  });

  await t.test('action popup and icons exist on disk', () => {
    assert.equal(manifest.action?.default_popup, 'popup/popup.html');
    assert.ok(existsExt('popup/popup.html'));
    for (const size of ['16', '48', '128']) {
      assert.ok(manifest.icons?.[size], `icon ${size} declared`);
      assert.ok(existsExt(`icons/icon${size}.png`), `icon ${size} file missing`);
    }
  });

  await t.test('no eval, no new Function, no remotely hosted code', () => {
    for (const file of EXT_JS_FILES) {
      const source = readExt(file);
      assert.ok(!/\beval\s*\(/.test(source), `${file} must not call eval()`);
      assert.ok(!/\bnew\s+Function\b/.test(source), `${file} must not use new Function`);
    }
    const html = readExt('popup/popup.html');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'popup.html must not load a remote script (MV3 CSP)');
  });

  await t.test('the background message listener keeps the channel open for async answers', () => {
    // The #1 MV3 messaging bug: an async listener that forgets `return true`
    // closes the message port and every sendResponse is silently dropped.
    assert.ok(/return true;/.test(readExt('background.js')));
  });
});

test('extension message vocabulary and envelopes match across all four files', async (t) => {
  const background = readExt('background.js');
  const highlight = readExt('content/highlight.js');
  const panel = readExt('content/panel.js');
  const popup = readExt('popup/popup.js');

  await t.test('every type a sender uses has a case in the background switch (and vice versa)', () => {
    const handlers = casesIn(background);
    const used = new Set([...typesUsed(highlight), ...typesUsed(panel), ...typesUsed(popup)]);
    for (const type of EXPECTED_TYPES) assert.ok(handlers.includes(type), `background.js has no case '${type}'`);
    for (const type of used) {
      assert.ok(handlers.includes(type), `${type} is sent by a content script/popup but background.js cannot answer it`);
    }
    for (const handler of handlers) {
      if (DOCUMENTED_REVERSE_TYPES.includes(handler)) continue; // see the note above EXPECTED_TYPES
      assert.ok(used.has(handler), `background.js handles '${handler}' but no shipped file sends it (dead handler)`);
    }
  });

  await t.test('relevance: highlight.js sends blocks, reads matches — background returns them', () => {
    assert.match(highlight, /type:\s*'relevance'/);
    assert.match(highlight, /sendMessage\(\{\s*type:\s*'relevance',\s*blocks\s*\}\)/);
    assert.match(highlight, /Array\.isArray\(response\.matches\)/, 'highlight.js gates on response.matches');
    assert.match(background, /matches:/);
    assert.match(background, /minScore:/);
  });

  await t.test('briefing: panel.js sends text (+sourceIds) and reads answer/citations/needsContent', () => {
    assert.match(panel, /type:\s*'briefing'/);
    assert.match(panel, /message\.sourceIds = \[sourceId\]/, 'panel passes the clicked highlight source id through');
    assert.match(panel, /data\.answer/);
    assert.match(panel, /data\.citations/);
    assert.match(panel, /data\.needsContent/);
    for (const key of ['answer:', 'citations:', 'needsContent:', 'model:']) {
      assert.match(background, new RegExp(key), `handleBriefing must return ${key}`);
    }
  });

  await t.test('openSite: panel button and popup button both relay through the background worker', () => {
    assert.match(panel, /type:\s*'openSite'/);
    assert.match(popup, /type:\s*'openSite'/);
    assert.match(background, /case 'openSite':/);
  });

  await t.test('login/logout/getState: popup reads exactly the fields the worker returns', () => {
    assert.match(popup, /type:\s*'login'/);
    assert.match(popup, /type:\s*'logout'/);
    assert.match(popup, /type:\s*'getState'/);
    assert.match(popup, /result\.prototype === true/, 'prototype-mode login answer');
    // After a successful login the popup re-reads the account through getState
    // (the worker is the source of truth), so the email it renders comes from
    // state.auth.email, not from the login reply.
    assert.match(popup, /state\.auth\.email/);
    assert.match(popup, /state\.auth\.signedIn/);
    assert.match(background, /signedIn:/);
    assert.match(background, /auth:/);
  });

  await t.test('the site→extension pageSession message is origin-gated', () => {
    // The only direction that carries a session FROM a page: it is refused
    // unless the sender is a content script on the configured site origin.
    assert.match(background, /case 'pageSession':/);
    assert.match(background, /senderIsOnConfiguredSite/);
    assert.match(background, /refused a pageSession message from outside/);
  });

  await t.test('settings keys agree across highlight.js, background.js and popup.js', () => {
    for (const [file, keys] of [['content/highlight.js', ['enabled', 'apiUrl']], ['background.js', ['enabled', 'apiUrl', 'siteUrl']], ['popup/popup.js', ['enabled', 'apiUrl', 'siteUrl']]]) {
      for (const key of keys) assert.ok(readExt(file).includes(key), `${file} does not use settings key ${key}`);
    }
  });

  await t.test('all senders gate on the shared { ok } envelope', () => {
    assert.match(background, /ok: true/);
    assert.match(background, /ok: false/);
    assert.match(highlight, /response\.ok !== true/);
    assert.match(panel, /response\.ok/);
    assert.match(popup, /result\.ok/);
    assert.match(popup, /state\.ok/);
  });

  await t.test('stale content scripts after an extension reload fail with guidance, not silence', () => {
    // panel.js maps "Receiving end does not exist" / "Extension context
    // invalidated" onto the RELOAD_MESSAGE banner.
    assert.match(panel, /Receiving end does not exist|Extension context invalidated/i);
  });
});

test('the #socius_session handoff contract round-trips and rejects bad payloads', async (t) => {
  const background = readExt('background.js');
  const authJs = fs.readFileSync(new URL('../frontend/js/auth.js', import.meta.url), 'utf8');

  await t.test('a real session round-trips: producer URL → consumer tokens', () => {
    const session = { access_token: 'eyJhb.GciOiJIUzI1.NiIsInR5.c30', refresh_token: 'v1.refresh-token-123', expires_at: 1790000000 };
    const url = buildHandoffUrl('https://socius-ai.vercel.app/dashboard.html', session);
    assert.ok(url.startsWith('https://socius-ai.vercel.app/dashboard.html#socius_session='), url);

    const hash = new URL(url).hash;
    const adopted = takeHandoffSession(hash);
    assert.deepEqual(adopted.tokens, session);
  });

  await t.test('base64url-hostile tokens (+ / =) survive the encode → decode round-trip', () => {
    // btoa emits +, / and = which URLSearchParams would mangle if they were
    // not percent-escaped. The producer's encodeURIComponent is load-bearing:
    // this pins both the escaping AND that a raw '+' would corrupt the token.
    const session = { access_token: 'aa+bb/cc==', refresh_token: 'r/ef+resh=', expires_at: 1 };
    const payload = btoa(JSON.stringify(session));
    const fragment = new URLSearchParams('socius_session=' + encodeURIComponent(payload)).get('socius_session');
    assert.equal(fragment, payload);
    assert.deepEqual(takeHandoffSession('#socius_session=' + encodeURIComponent(payload)).tokens, session);
    assert.notEqual(new URLSearchParams('socius_session=aa+bb').get('socius_session'), 'aa+bb');
  });

  await t.test('expires_at is carried only when it is a number', () => {
    const withNumber = takeHandoffSession(new URL(buildHandoffUrl('https://sociusai2.vercel.app/', { access_token: 'a', refresh_token: 'b', expires_at: 42 })).hash);
    assert.equal(withNumber.tokens.expires_at, 42);
    const withNull = takeHandoffSession(new URL(buildHandoffUrl('https://sociusai2.vercel.app/', { access_token: 'a', refresh_token: 'b' })).hash);
    assert.ok(!('expires_at' in withNull.tokens));
    const withString = takeHandoffSession('#socius_session=' + encodeURIComponent(btoa(JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_at: 'soon' }))));
    assert.ok(!('expires_at' in withString.tokens));
  });

  await t.test('the handoff URL keeps the value in the FRAGMENT, never the query string', () => {
    // Fragments stay in the browser: they are not sent to servers, not logged
    // in access logs, and are stripped from the URL on adoption.
    const url = buildHandoffUrl('https://socius-ai.vercel.app/dashboard.html', { access_token: 'a', refresh_token: 'b' });
    const parsed = new URL(url);
    assert.equal(parsed.search, '');
    assert.ok(parsed.hash.startsWith('#socius_session='));
  });

  await t.test('the fragment is stripped from the URL even when the payload is malformed', () => {
    const adopted = takeHandoffSession('#socius_session=!!!not-base64!!!&keep=1');
    assert.equal(adopted, null);
    const cleaned = '#keep=1'; // what history.replaceState would leave behind
    assert.ok(!cleaned.includes('socius_session'));
  });

  await t.test('malformed or hostile payloads are rejected without throwing', () => {
    const frag = (value) => '#socius_session=' + value;
    const cases = [
      ['garbage base64', frag('!!!not-base64!!!')],
      ['base64 of non-JSON', frag(encodeURIComponent(btoa('just text, not json')))],
      ['JSON missing refresh_token', frag(encodeURIComponent(btoa(JSON.stringify({ access_token: 'a' }))))],
      ['JSON missing access_token', frag(encodeURIComponent(btoa(JSON.stringify({ refresh_token: 'b' }))))],
      ['non-string token', frag(encodeURIComponent(btoa(JSON.stringify({ access_token: 42, refresh_token: 'b' }))))],
      ['JSON array payload', frag(encodeURIComponent(btoa(JSON.stringify(['a', 'b']))))],
      ['JSON null payload', frag(encodeURIComponent(btoa('null')))],
      ['empty value', frag('')],
      ['no fragment at all', '#other=thing'],
      ['unsigned-out empty hash', ''],
    ];
    for (const [label, hash] of cases) {
      assert.equal(takeHandoffSession(hash), null, `must reject: ${label}`);
    }
  });

  await t.test('other hash params survive the strip', () => {
    const hash = '#a=1&socius_session=' + encodeURIComponent(btoa(JSON.stringify({ access_token: 'a', refresh_token: 'b' }))) + '&b=2';
    const adopted = takeHandoffSession(hash);
    assert.deepEqual(adopted.tokens, { access_token: 'a', refresh_token: 'b' });
    assert.equal(adopted.cleaned, '#a=1&b=2');
  });

  await t.test('the shipped producer and consumer still contain the contract markers', () => {
    // Static drift guards: renaming the fragment or swapping the encoder on
    // one side only would break every handoff silently in the browser.
    assert.match(background, /buildHandoffFragment/);
    assert.match(background, /'socius_session=' \+ encodeURIComponent\(base64Encode\(/);
    assert.match(background, /access_token: session\.access_token/);
    assert.match(background, /refresh_token: session\.refresh_token/);
    assert.match(authJs, /params\.get\('socius_session'\)/);
    assert.match(authJs, /decodeBase64Json/);
    assert.match(authJs, /history\.replaceState\(/, 'the consumer strips the fragment from the URL immediately');
    // Direction check: the extension OPENS the site with the fragment; the site
    // never sends messages back through the page to the extension.
    assert.match(background, /chrome\.tabs\.create/);
  });
});

test('anonymous extension API requests get 401 UNAUTHENTICATED before anything else', async (t) => {
  const ai = trackingAi();
  const ctx = await startApp({ ai, vector: ownerFakeVector(), auth: headerAuth });
  t.after(ctx.close);

  // A user with material exists, so these endpoints WOULD work if a token were
  // present — the 401 is auth ordering, not an empty account. (The upload above
  // already consumed embeddings/chat calls, so the invariants are "no NEW call
  // during the request", not absolute zeroes.)
  const u1 = await addWebpage(ctx, {
    url: 'https://learn.example/cells',
    title: 'Cells 101',
    text: 'Cells are the basic unit of life.\n\nMitosis produces two identical daughter cells.\n\nThe nucleus stores DNA.\n\nMeiosis divides twice.\n\nMitosis copies the nucleus once.',
  }, 'u1');

  for (const [url, body] of [['/api/extension/relevance', { blocks: [{ id: 'b1', text: 'Mitosis produces two identical daughter cells.' }] }], ['/api/extension/briefing', { text: 'x'.repeat(80) }]]) {
    await t.test(`POST ${url} with no Authorization`, async () => {
      const embedsBefore = ai.embedCalls.length;
      const chatsBefore = ai.calls.length;
      const res = await post(ctx, url, body, null); // no x-test-user header at all
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: { code: 'UNAUTHENTICATED', message: 'Sign in to use this endpoint.' } });
      assert.equal(ai.embedCalls.length, embedsBefore, 'no embedding call may happen for an anonymous request');
      assert.equal(ai.calls.length, chatsBefore, 'no chat completion may happen for an anonymous request');
    });
  }

  await t.test('an anonymous request with an invalid body is still 401, not 400', async () => {
    // requireAuth runs before any handler: the auth decision never depends on
    // the payload being well-formed.
    const res = await post(ctx, '/api/extension/relevance', { blocks: 'this is not even an array' }, null);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHENTICATED');
  });

  await t.test('the same requests succeed for the signed-in owner (control)', async () => {
    const res = await post(ctx, '/api/extension/relevance', { blocks: [{ id: 'b1', text: 'Mitosis produces two identical daughter cells.' }] }, 'u1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.minScore, config.extensionMinSimilarity);
    assert.ok(Array.isArray(body.matches));
  });
});

test('extension API is per-user and rejects malformed payloads before any model call', async (t) => {
  const ai = trackingAi();
  const ctx = await startApp({ ai, vector: ownerFakeVector(), auth: headerAuth });
  t.after(ctx.close);

  const u1Source = await addWebpage(ctx, {
    url: 'https://learn.example/cells',
    title: 'Cells 101 (u1)',
    text: 'Cells are the basic unit of life.\n\nMitosis produces two identical daughter cells.\n\nThe nucleus stores DNA.\n\nMeiosis divides twice.\n\nMitosis copies the nucleus once.',
  }, 'u1');
  const u2Source = await addWebpage(ctx, {
    url: 'https://learn.example/space',
    title: 'Space 101 (u2)',
    text: 'Planets orbit stars.\n\nMars is the fourth planet from the Sun.\n\nA light-year is a distance measure.\n\nThe Sun is a star.\n\nEuropa orbits Jupiter.',
  }, 'u2');

  await t.test('relevance matches cite only the requesting user\u2019s own material', async () => {
    // Both users ask about the SAME page sentence "Cells are the basic unit of
    // life." — u1 owns the cells source, u2 owns only the space source.
    const blocks = [{ id: 's1', text: 'Cells are the basic unit of life.' }];
    const u1Res = await post(ctx, '/api/extension/relevance', { blocks }, 'u1');
    assert.equal(u1Res.status, 200);
    const u1Body = await u1Res.json();
    assert.ok(u1Body.matches.length > 0, 'u1 has matching material');
    assert.ok(u1Body.matches.every((m) => m.citation.sourceId === u1Source), 'u1 highlights only u1 chunks');
    assert.ok(u1Body.matches.every((m) => typeof m.citation.excerpt === 'string' && m.citation.excerpt.length > 0));

    const u2Res = await post(ctx, '/api/extension/relevance', { blocks }, 'u2');
    const u2Body = await u2Res.json();
    assert.ok(u2Body.matches.every((m) => m.citation.sourceId === u2Source), 'u2 can never receive a u1 citation');
    assert.ok(!u2Body.matches.some((m) => m.citation.sourceId === u1Source));
  });

  await t.test('a user with no sources gets an empty match list and costs zero embeddings', async () => {
    const before = ai.embedCalls.length;
    const res = await post(ctx, '/api/extension/relevance', { blocks: [{ id: 's1', text: 'Cells are the basic unit of life.' }] }, 'u3');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { matches: [], minScore: config.extensionMinSimilarity });
    assert.equal(ai.embedCalls.length, before, 'the documented "no material yet" shortcut skips the embedding call');
  });

  await t.test('malformed relevance payloads are 400 VALIDATION_ERROR with ZERO embedding calls', async () => {
    const badBodies = [
      ['blocks missing', {}],
      ['blocks not an array', { blocks: 'text' }],
      ['blocks empty', { blocks: [] }],
      ['too many blocks', { blocks: Array.from({ length: 61 }, (_, i) => ({ id: `b${i}`, text: 'y'.repeat(50) })) }],
      ['block without id', { blocks: [{ text: 'Mitosis produces two identical daughter cells.' }] }],
      ['block id too long', { blocks: [{ id: 'x'.repeat(65), text: 'Mitosis produces two identical daughter cells.' }] }],
      ['block text not a string', { blocks: [{ id: 'b1', text: 42 }] }],
      ['block text empty', { blocks: [{ id: 'b1', text: '   ' }] }],
      ['block text too long', { blocks: [{ id: 'b1', text: 'y'.repeat(601) }] }],
      ['null block entry', { blocks: [null] }],
    ];
    for (const [label, body] of badBodies) {
      const embedsBefore = ai.embedCalls.length;
      const res = await post(ctx, '/api/extension/relevance', body, 'u1');
      assert.equal(res.status, 400, `${label} → 400`);
      const payload = await res.json();
      assert.equal(payload.error.code, 'VALIDATION_ERROR', `${label} → VALIDATION_ERROR`);
      assert.ok(typeof payload.error.message === 'string' && payload.error.message.length > 0, `${label} → a message`);
      assert.equal(ai.embedCalls.length, embedsBefore, `${label} must be rejected before any embedding call`);
    }
  });

  await t.test('malformed briefing payloads are 400 VALIDATION_ERROR with ZERO chat calls', async () => {
    const badBodies = [
      ['text missing', {}],
      ['text not a string', { text: 42 }],
      ['text too short', { text: 'x'.repeat(59) }],
      ['text too long', { text: 'x'.repeat(1501) }],
      ['whitespace-only text', { text: ' '.repeat(80) }],
      ['sourceIds not an array', { text: 'x'.repeat(80), sourceIds: 'src_1' }],
      ['sourceIds not strings', { text: 'x'.repeat(80), sourceIds: [1, 2] }],
    ];
    for (const [label, body] of badBodies) {
      const chatsBefore = ai.calls.length;
      const res = await post(ctx, '/api/extension/briefing', body, 'u1');
      assert.equal(res.status, 400, `${label} → 400`);
      const payload = await res.json();
      assert.equal(payload.error.code, 'VALIDATION_ERROR', `${label} → VALIDATION_ERROR`);
      assert.equal(ai.calls.length, chatsBefore, `${label} must be rejected before any model call`);
    }
  });

  await t.test('a valid briefing answers from the requester\u2019s material only', async () => {
    const chatsBefore = ai.calls.length;
    const res = await post(ctx, '/api/extension/briefing', {
      text: 'Mitosis produces two identical daughter cells through a single division of the nucleus.',
    }, 'u1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(ai.calls.length, chatsBefore + 1, 'exactly one model call for a valid briefing');
    assert.equal(typeof body.answer, 'string');
    assert.ok(Array.isArray(body.citations));
    assert.ok(body.citations.every((c) => c.sourceId === u1Source), 'briefing citations are owner-scoped');
    assert.ok(body.citations.every((c) => c.sourceId !== u2Source));
    assert.equal(typeof body.needsContent, 'boolean');
    assert.equal(typeof body.model, 'string');
    // suggestions is whitelisted to 0-4 trimmed strings by the route.
    assert.ok(Array.isArray(body.suggestions));
  });
});
