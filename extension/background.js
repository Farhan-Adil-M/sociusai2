// background.js — MV3 service worker for the Socius AI Study Highlighter.
//
// Responsibility (one job): be the ONLY part of the extension that talks to
// the Socius AI backend. Content scripts and the toolbar popup send it
// messages; it validates every one of them, attaches the user's OWN session
// token, and relays to the server.
//
// The extension authenticates AS A USER. It never holds a provider key: the
// NVIDIA NIM key and the ChromaDB address live only in the server's
// environment (AGENTS.md), so no path here can reach an AI or vector service
// directly. Everything is one server call with one Bearer token.
//
// Message contract — every reply is one envelope:
//   { ok: true, ... }                     success
//   { ok: false, error: { code, message } }  failure, safe to show a user
//
//   IN  { type: 'relevance',   blocks: [{id, text}] }        -> { ok, matches, minScore }
//   IN  { type: 'briefing',    text, sourceIds? }           -> { ok, answer, citations,
//                                                               needsContent, suggestions, model }
//   IN  { type: 'login',       email, password }            -> { ok, email } | { ok, prototype: true }
//   IN  { type: 'logout' }                                  -> { ok }
//   IN  { type: 'openSite' }                                -> { ok }  (carries #socius_session)
//   IN  { type: 'getState' }                                -> { ok, enabled, apiUrl, siteUrl,
//                                                               auth: { signedIn, email } }
//   IN  { type: 'pageSession', session }                    -> { ok, signedIn }  (site -> extension)
//
// A content script is NOT trusted: it runs inside whatever page the visitor is
// on, so every message is validated here before it can cause a request, and no
// handler ever accepts a token, a user id or a URL from a message. Tokens come
// only from this extension's own storage.
//
// MV3 notes: the worker is ephemeral (it can be killed between any two
// messages), so NOTHING is cached in module scope — settings and the session
// are re-read from chrome.storage on every use, every listener is registered
// at the top level, and no timer is expected to survive. The one module-level
// value that does exist (the in-flight refresh) is a request-scoped lock, not
// state: if the worker dies the next message simply starts a new refresh.

/* ------------------------------------------------------------------ config */

const DEFAULT_SETTINGS = {
  enabled: true,
  apiUrl: 'https://sociusai2.vercel.app',
  // The site URL targets the app (dashboard), not the marketing landing page:
  // app pages load auth.js, which adopts the #socius_session handoff fragment
  // and lands the visitor signed in. The landing page has no auth code.
  siteUrl: 'https://sociusai2.vercel.app/dashboard.html',
};

const TIMEOUT_MS = 15000;
const SETTINGS_AREA = 'sync'; // roaming settings (no secrets)
const SESSION_AREA = 'local'; // per-device session; never `sync`, so tokens do not roam
const SESSION_KEY = 'session';
const EXPIRY_SKEW_MS = 60 * 1000; // refresh a minute before Supabase expires it

// The same limits the server enforces (server/routes/extension.js). The client
// checks them for fast, honest feedback; the server re-checks because the
// client is untrusted.
const MAX_BLOCKS = 60;
const MAX_BLOCK_ID = 64;
const MAX_BLOCK_CHARS = 600;
const MIN_BRIEFING_CHARS = 60;
const MAX_BRIEFING_CHARS = 1500;
const MAX_SOURCE_IDS = 50;
const MAX_MESSAGE_CHARS = 300; // server error text is never echoed verbatim at length

// What the panel shows when a request needs a signed-in user. One message,
// reused everywhere an UNAUTHENTICATED answer comes back.
const SIGNIN_MESSAGE = 'Sign in from the Socius AI toolbar button, then Retry.';

/* ----------------------------------------------------------------- envelopes */

function log(message) {
  // Diagnostics only: never a token, a password or a server body.
  try {
    console.debug('[socius]', message);
  } catch {
    /* a console is not always available; logging must never break a request */
  }
}

function fail(message, code) {
  return { ok: false, error: { code: code || 'VALIDATION_ERROR', message } };
}

function unknownMessage() {
  return fail('Unknown message type.', 'UNKNOWN_MESSAGE');
}

function badMessage(message) {
  return fail(message || 'That message was malformed.', 'BAD_MESSAGE');
}

function networkError() {
  return fail('Could not reach the Socius AI server.', 'NETWORK_ERROR');
}

function authError() {
  return fail(SIGNIN_MESSAGE, 'UNAUTHENTICATED');
}

function internalError() {
  return fail('Something went wrong on this side. Try again.', 'INTERNAL');
}

function isAuthError(result) {
  return !result.ok && (result.error.code === 'UNAUTHENTICATED' || result.error.code === 'HTTP_401');
}

/**
 * True when a value is an error ENVELOPE. Used by handlers that receive either
 * "an error to return" or "a usable value" from a validator or a gate, so the
 * two can never be confused (a valid array is not a failure, and vice versa).
 */
function isFailure(value) {
  return isPlainObject(value) && value.ok === false;
}

/* ------------------------------------------------------------- small helpers */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A non-blank string within a length cap. */
function isShortString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasChrome() {
  return typeof chrome !== 'undefined' && Boolean(chrome);
}

/**
 * A usable http(s) backend/site address. Credentials in the URL are refused:
 * they would be sent to a host the user may not have chosen, and a token in a
 * request aimed at `https://user:pass@host/` is a token handed to `host`.
 */
function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return true;
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** base64 (UTF-8 safe) — `atob` alone mangles non-ASCII bytes. */
function base64Encode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

/* ------------------------------------------------------------------ storage */

// How each chrome.storage method is named in a log line, so the diagnostics
// read the same as they always have.
const STORAGE_VERBS = { get: 'read', set: 'write', remove: 'clear' };

/* The ONE callback-to-promise wrapper for every storage call. The API's
   lastError is logged and never thrown (a request must not crash because the
   browser refused a write), and a missing chrome.* resolves instead of
   rejecting — the worker can be asked for a session with no storage at all.
   `map` turns the outcome into the value the caller wants; `ok` is false when
   the call never completed (no storage area, a lastError, or a throw). */
function storageCall(area, method, args, map) {
  if (!hasChrome() || !chrome.storage || !chrome.storage[area]) {
    return Promise.resolve(map(false, undefined));
  }
  return new Promise((resolve) => {
    try {
      chrome.storage[area][method](...args, (result) => {
        if (chrome.runtime.lastError) {
          log(`could not ${STORAGE_VERBS[method]} ${area} storage: ${chrome.runtime.lastError.message}`);
          resolve(map(false, undefined));
          return;
        }
        resolve(map(true, result));
      });
    } catch (error) {
      log(`could not ${STORAGE_VERBS[method]} ${area} storage: ${error && error.message}`);
      resolve(map(false, undefined));
    }
  });
}

function storageGet(area, key) {
  return storageCall(area, 'get', [key], (ok, items) => (ok && items ? items[key] : undefined));
}

function storageSet(area, items) {
  return storageCall(area, 'set', [items], (ok) => ok);
}

function storageRemove(area, key) {
  return storageCall(area, 'remove', [key], () => undefined);
}

/**
 * The one read that takes a DEFAULTS object: chrome.storage.sync.get(defaults)
 * already returns the defaults with the stored values merged over them, so the
 * whole object is the answer (reading it back key-by-key would lose that).
 */
function storageGetWithDefaults(area, defaults) {
  return storageCall(area, 'get', [defaults], (ok, items) => (ok && isPlainObject(items) ? items : {}));
}

/**
 * A setting that is MISSING falls back to the default. One that is PRESENT but
 * invalid becomes '' — never silently swapped for the default, because that
 * would aim a request at a server the user did not choose. The handlers then
 * refuse it with an honest error.
 */
function usableUrl(stored, fallback) {
  if (stored === undefined || stored === null) return fallback;
  return isHttpUrl(stored) ? stored.trim() : '';
}

/** Settings are read fresh on every use — the worker never caches them. */
async function getSettings() {
  const stored = await storageGetWithDefaults(SETTINGS_AREA, DEFAULT_SETTINGS);
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_SETTINGS.enabled,
    apiUrl: usableUrl(stored.apiUrl, DEFAULT_SETTINGS.apiUrl),
    siteUrl: usableUrl(stored.siteUrl, DEFAULT_SETTINGS.siteUrl),
  };
}

/* ------------------------------------------------------------------ session */

/**
 * Keep only the fields the extension needs, in one known shape. Anything that
 * is not a real session (a partial object, a string, junk) becomes null so the
 * rest of the worker can assume the shape.
 */
function normalizeSession(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.access_token !== 'string' || raw.access_token.trim() === '') return null;
  if (typeof raw.refresh_token !== 'string' || raw.refresh_token.trim() === '') return null;
  const user = isPlainObject(raw.user) ? raw.user : {};
  const email = typeof user.email === 'string' ? user.email : '';
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: isFiniteNumber(raw.expires_at) ? raw.expires_at : null,
    expires_in: isFiniteNumber(raw.expires_in) ? raw.expires_in : null,
    token_type: 'bearer',
    user: { id: typeof user.id === 'string' ? user.id : '', email },
    email: typeof raw.email === 'string' && raw.email ? raw.email : email,
  };
}

/** The stored session, or null. An unusable entry is dropped, never retried. */
async function readSession() {
  const stored = await storageGet(SESSION_AREA, SESSION_KEY);
  if (stored === undefined || stored === null) return null;
  const session = normalizeSession(stored);
  if (!session) {
    await storageRemove(SESSION_AREA, SESSION_KEY);
    log('the stored session was unusable and was discarded');
    return null;
  }
  return session;
}

/** Store a session that came from the server (or from the site). */
async function saveSession(raw) {
  const session = normalizeSession(raw);
  if (!session) return null; // never store a session we cannot read back
  const written = await storageSet(SESSION_AREA, { [SESSION_KEY]: session });
  return written ? session : null;
}

async function clearSession() {
  await storageRemove(SESSION_AREA, SESSION_KEY);
  return null;
}

/** True when `expires_at` (epoch seconds) is within the refresh skew. An
 *  unknown expiry is NOT treated as expired — only the server decides that. */
function sessionNeedsRefresh(session) {
  if (session.expires_at === null) return false;
  return Date.now() >= session.expires_at * 1000 - EXPIRY_SKEW_MS;
}

// One refresh at a time. Supabase rotates refresh tokens, so firing two at
// once would spend a token the session no longer holds and revoke it. This
// promise is a REQUEST-SCOPED LOCK, not state: the worker may be killed at any
// moment and the next message simply starts a fresh one.
let refreshInFlight = null;

async function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const session = await readSession();
      if (!session) return null;
      const { apiUrl } = await getSettings();
      if (!isHttpUrl(apiUrl)) return null;

      const result = await postJson(apiUrl, '/api/auth/refresh', { refresh_token: session.refresh_token });
      if (!result.ok || !isPlainObject(result.data) || !isPlainObject(result.data.session)) {
        // Only a REJECTED token kills the session. A network blip must not:
        // the stored session stays and the next request tries again.
        if (isAuthError(result)) await clearSession();
        return null;
      }

      // Per-user guard: a sign-in elsewhere may have replaced this session
      // while the request was in flight. Writing the old one back would leave
      // the extension acting as a DIFFERENT user than the person at the
      // keyboard, so the write only happens when the stored refresh token is
      // still the one we refreshed.
      const current = await readSession();
      if (!current || current.refresh_token !== session.refresh_token) return current;
      const saved = await saveSession(result.data.session);
      return saved || current;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** The stored session, refreshed first when it is (nearly) expired. */
async function getFreshSession() {
  const session = await readSession();
  if (!session) return null;
  if (!sessionNeedsRefresh(session)) return session;
  // A failed refresh keeps the stored session: only the server's 401 may
  // declare a token dead, and an unauthenticated call is answered honestly.
  return (await refreshOnce()) || session;
}

/* ----------------------------------------------------------------- requests */

/** POST JSON to the backend. Never throws; failures come back in the
 *  envelope. `token` (optional) becomes the Bearer header. */
async function postJson(apiUrl, path, body, token) {
  let response;
  try {
    response = await fetch(apiUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return networkError();
  }

  if (!response.ok) {
    let code = 'HTTP_' + response.status;
    let message = 'The server refused that request.';
    try {
      const parsed = await response.json();
      if (isPlainObject(parsed) && isPlainObject(parsed.error)) {
        if (typeof parsed.error.code === 'string' && parsed.error.code) code = parsed.error.code;
        if (typeof parsed.error.message === 'string' && parsed.error.message) {
          message = parsed.error.message.slice(0, MAX_MESSAGE_CHARS);
        }
      }
    } catch {
      // Body was not JSON; keep the generic message (never the raw body).
    }
    return { ok: false, error: { code, message } };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return fail('The server sent a response this extension could not read.', 'BAD_RESPONSE');
  }
  return { ok: true, data };
}

/**
 * POST with the user's own token: refresh before expiry, and on a 401 refresh
 * once and retry ONCE. If the server still says no, the session is cleared and
 * the caller gets an honest UNAUTHENTICATED envelope — no retry loop, and no
 * invented answer.
 */
async function authorizedPost(apiUrl, path, body) {
  const session = await getFreshSession();
  let result = await postJson(apiUrl, path, body, session ? session.access_token : '');

  if (!result.ok && session && isAuthError(result)) {
    const refreshed = await refreshOnce(); // revoked mid-flight → one clean retry
    if (refreshed) result = await postJson(apiUrl, path, body, refreshed.access_token);
  }

  if (isAuthError(result)) {
    if (session) await clearSession();
    return authError();
  }
  return result;
}

/**
 * Shared gate for every handler: no valid server URL → no request at all.
 * Returns the URL to use, or an error envelope (see isFailure).
 */
async function requireApiUrl() {
  const { apiUrl } = await getSettings();
  return isHttpUrl(apiUrl) ? apiUrl : fail('The Socius AI server URL is not a valid http(s) address.');
}

/* --------------------------------------------------------------- validation */

// Validators return an error ENVELOPE when the input is unusable, or `null`
// when it is fine — never the value itself, so a valid array can never be
// mistaken for a failure (or the other way round).

function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 1) return fail('Expected an array of blocks.');
  if (blocks.length > MAX_BLOCKS) return fail(`Too many blocks — the limit is ${MAX_BLOCKS}.`);
  for (const block of blocks) {
    if (!isPlainObject(block) || !isShortString(block.id, MAX_BLOCK_ID) || !isShortString(block.text, MAX_BLOCK_CHARS)) {
      return fail('Every block needs a string id and between 1 and 600 characters of text.');
    }
  }
  return null;
}

function validateSourceIds(sourceIds) {
  if (!Array.isArray(sourceIds)) return fail('sourceIds must be an array of source id strings.');
  if (sourceIds.length > MAX_SOURCE_IDS) return fail(`Too many sourceIds — the limit is ${MAX_SOURCE_IDS}.`);
  if (sourceIds.some((id) => !isShortString(id, 128))) return fail('sourceIds must be an array of source id strings.');
  return null;
}

/* ----------------------------------------------------------------- handlers */

async function handleRelevance(message) {
  const problem = validateBlocks(message.blocks);
  if (problem) return problem;
  const apiUrl = await requireApiUrl();
  if (isFailure(apiUrl)) return apiUrl;

  const result = await authorizedPost(apiUrl, '/api/extension/relevance', { blocks: message.blocks });
  if (!result.ok) return result;
  const data = isPlainObject(result.data) ? result.data : {};
  return {
    ok: true,
    matches: Array.isArray(data.matches) ? data.matches : [],
    minScore: isFiniteNumber(data.minScore) ? data.minScore : undefined,
  };
}

async function handleBriefing(message) {
  if (typeof message.text !== 'string') return fail('Expected a non-empty text string.');
  const asked = message.text.trim();
  if (asked.length < MIN_BRIEFING_CHARS || asked.length > MAX_BRIEFING_CHARS) {
    return fail(`Briefing text must be between ${MIN_BRIEFING_CHARS} and ${MAX_BRIEFING_CHARS} characters.`);
  }
  const body = { text: asked };
  if (message.sourceIds !== undefined) {
    const problem = validateSourceIds(message.sourceIds);
    if (problem) return problem;
    body.sourceIds = message.sourceIds;
  }
  const apiUrl = await requireApiUrl();
  if (isFailure(apiUrl)) return apiUrl;

  const result = await authorizedPost(apiUrl, '/api/extension/briefing', body);
  if (!result.ok) return result;
  const data = isPlainObject(result.data) ? result.data : {};
  return {
    ok: true,
    answer: typeof data.answer === 'string' ? data.answer : '',
    citations: Array.isArray(data.citations) ? data.citations : [],
    needsContent: data.needsContent === true,
    model: typeof data.model === 'string' ? data.model : '',
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
  };
}

async function handleLogin(message) {
  const email = typeof message.email === 'string' ? message.email.trim() : '';
  const password = typeof message.password === 'string' ? message.password : '';
  if (email === '' || email.length > 254 || password === '') {
    return fail('Enter a valid email and password.');
  }
  const apiUrl = await requireApiUrl();
  if (isFailure(apiUrl)) return apiUrl;

  const result = await postJson(apiUrl, '/api/auth/login', { email, password });
  if (!result.ok) {
    // The server's own credential message is safe to show; anything else
    // (e.g. a Vercel auth wall) is not — keep those generic for the popup.
    if (result.error.code === 'UNAUTHENTICATED') return result;
    if (result.error.code === 'RATE_LIMITED') return result;
    return fail('Sign-in failed. Try again.');
  }
  const data = isPlainObject(result.data) ? result.data : {};
  if (data.mode === 'prototype') {
    // A local dev server has no auth at all. Say so instead of pretending a
    // session exists, and make sure no stale one is kept either.
    await clearSession();
    return { ok: true, prototype: true };
  }
  const saved = await saveSession(data.session);
  if (!saved) return fail('Sign-in failed. Try again.', 'BAD_RESPONSE');
  return { ok: true, email: saved.email };
}

async function handleLogout() {
  // Local-only by design: the extension has no Supabase client, so it cannot
  // ask Supabase to revoke the refresh token the way the site's own sign-out
  // does. What it CAN do is forget the token immediately, so nothing here can
  // keep acting for that account. The server still refuses a revoked token.
  await clearSession();
  return { ok: true };
}

/**
 * The #socius_session handoff (docs/API_CONTRACT.md → "Extension contract").
 * The session travels in the URL FRAGMENT, which the browser never sends to
 * any server — the same pattern as an OAuth callback. auth.js on the site
 * decodes it, adopts the tokens, and strips the fragment from the address bar.
 */
function buildHandoffFragment(session) {
  const payload = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at === null ? null : session.expires_at,
  });
  // Standard base64, percent-encoded: exactly the shape the contract documents
  // and the shape decodeBase64Json() in frontend/js/auth.js expects.
  return 'socius_session=' + encodeURIComponent(base64Encode(payload));
}

async function handleOpenSite() {
  const { siteUrl } = await getSettings();
  if (!isHttpUrl(siteUrl)) return fail('The Socius AI site URL is not a valid http(s) address.');

  const session = await getFreshSession();
  const separator = siteUrl.includes('#') ? '&' : '#';
  const url = session ? `${siteUrl}${separator}${buildHandoffFragment(session)}` : siteUrl;

  if (!hasChrome() || !chrome.tabs || typeof chrome.tabs.create !== 'function') {
    return fail('Could not open a new tab.');
  }
  try {
    await chrome.tabs.create({ url });
  } catch (error) {
    log(`could not open the site: ${error && error.message}`);
    return fail('Could not open a new tab.');
  }
  return { ok: true };
}

async function handleGetState() {
  const { enabled, apiUrl, siteUrl } = await getSettings();
  const session = await readSession();
  return {
    ok: true,
    enabled,
    apiUrl,
    siteUrl,
    // Only the facts the popup needs. Tokens are never part of a reply.
    auth: { signedIn: Boolean(session), email: session ? session.email : '' },
  };
}

/* ------------------------------------------------- site → extension sync */

/**
 * `pageSession` is the one message that carries a session, so it gets the
 * strictest gate of all: only a content script running on the Socius site's
 * OWN origin (the configured siteUrl) may hand one over. A content script on
 * any other page is refused, whatever it claims to be.
 */
async function handlePageSession(message, sender) {
  if (!(await senderIsOnConfiguredSite(sender))) {
    log('refused a pageSession message from outside the Socius site origin');
    return fail('That session was refused.', 'BAD_MESSAGE');
  }
  return adoptSiteSession(message.session === undefined ? null : message.session);
}

/** Take on (or drop) the session the site is currently holding. */
async function adoptSiteSession(raw) {
  if (raw === null || raw === undefined) {
    // The site holds no session: the visitor signed out there. The extension
    // must not keep highlighting under an identity the site no longer has.
    await clearSession();
    return { ok: true, signedIn: false };
  }
  const current = await readSession();
  if (current && current.access_token === raw.access_token) {
    return { ok: true, signedIn: true, email: current.email }; // already in step
  }
  const saved = await saveSession(raw);
  if (!saved) return fail('That session could not be read.', 'BAD_MESSAGE');
  log('adopted the session the Socius site is signed in with');
  return { ok: true, signedIn: true, email: saved.email };
}

function senderUrl(sender) {
  if (!isPlainObject(sender)) return null;
  if (typeof sender.url === 'string') return sender.url;
  if (isPlainObject(sender.tab) && typeof sender.tab.url === 'string') return sender.tab.url;
  return null;
}

async function senderIsOnConfiguredSite(sender) {
  const { siteUrl } = await getSettings();
  const siteOrigin = originOf(siteUrl);
  const from = senderUrl(sender);
  return Boolean(siteOrigin) && Boolean(from) && originOf(from) === siteOrigin;
}

/**
 * The reader that runs INSIDE the page (isolated world, same origin, so it
 * sees the site's own localStorage — the storage auth.js uses). Chrome
 * serialises this function's source and runs it in the page, so it must be
 * fully self-contained: no module-scope names, no remote code, no eval. It
 * only ever copies out the token fields and the account id/email, never the
 * whole stored object.
 */
function readSiteSessionFromPage() {
  // The key shape Supabase's own browser client uses (sb-<project-ref>-auth-token).
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key || !/^sb-[A-Za-z0-9_-]+-auth-token$/.test(key)) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object'
      && typeof parsed.access_token === 'string' && typeof parsed.refresh_token === 'string') {
      const user = parsed.user && typeof parsed.user === 'object' ? parsed.user : {};
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at: typeof parsed.expires_at === 'number' ? parsed.expires_at : null,
        user: {
          id: typeof user.id === 'string' ? user.id : '',
          email: typeof user.email === 'string' ? user.email : '',
        },
      };
    }
  }
  return null;
}

/** True when the user has granted this extension access to the origin. */
function hasHostPermission(origin) {
  if (!hasChrome() || !chrome.permissions || typeof chrome.permissions.contains !== 'function') return false;
  const pattern = origin + '/*';
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [pattern] }, (granted) => {
        resolve(Boolean(granted) && !chrome.runtime.lastError);
      });
    } catch {
      resolve(false);
    }
  });
}

async function readSiteSessionFromTab(tabId) {
  if (!hasChrome() || !chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    return undefined; // the "scripting" permission is not granted (see HANDOFF)
  }
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: readSiteSessionFromPage });
    const first = results && results[0];
    return first && first.result ? first.result : null;
  } catch {
    // chrome:// pages, a tab that closed, or a missing host permission.
    return undefined;
  }
}

/**
 * Keep the two halves of the same account in step: when a tab on the Socius
 * site finishes loading, look at the session the site itself holds and adopt
 * it (or drop ours). Only the configured site origin is ever read.
 */
async function syncSiteSession(tabId, url) {
  if (!isHttpUrl(url)) return;
  const { siteUrl } = await getSettings();
  const siteOrigin = originOf(siteUrl);
  const pageOrigin = originOf(url);
  if (!siteOrigin || !pageOrigin || siteOrigin !== pageOrigin) return; // never touch another site
  if (!(await hasHostPermission(siteOrigin))) return;

  const found = await readSiteSessionFromTab(tabId);
  if (found === undefined) return; // could not read the page; the server still decides
  await adoptSiteSession(found);
}

/* ------------------------------------------------------------- trust checks */

function runtimeId() {
  try {
    return hasChrome() && chrome.runtime && typeof chrome.runtime.id === 'string' ? chrome.runtime.id : '';
  } catch {
    return '';
  }
}

/** `chrome-extension://<id>` — computed on demand (the worker restarts a lot). */
function extensionOrigin() {
  try {
    const url = hasChrome() && chrome.runtime && typeof chrome.runtime.getURL === 'function'
      ? chrome.runtime.getURL('/')
      : '';
    return url ? url.replace(/\/$/, '') : '';
  } catch {
    return '';
  }
}

/**
 * Who may talk to this worker:
 *   - our own extension pages (the toolbar popup), identified by origin/URL;
 *   - a content script, which always arrives with the tab it runs in.
 * Anything else — another extension, or a web page that gained
 * `externally_connectable` access — is refused before its payload is read.
 */
function isTrustedSender(sender) {
  if (!isPlainObject(sender)) return false;
  const own = runtimeId();
  if (sender.id && own && sender.id !== own) return false; // another extension
  if (isExtensionPage(sender)) return true;
  return isPlainObject(sender.tab) && typeof sender.tab.id === 'number';
}

/** True when the sender is the extension itself (the toolbar popup). Both the
 *  `origin` and the `url` spelling are accepted, because Firefox reports one
 *  and Chrome the other. */
function isExtensionPage(sender) {
  if (!isPlainObject(sender)) return false;
  const origin = extensionOrigin();
  if (!origin) return false;
  if (typeof sender.origin === 'string' && sender.origin === origin) return true;
  return typeof sender.url === 'string' && sender.url.startsWith(origin + '/');
}

/* ------------------------------------------------------------------- router */

async function handleMessage(message, sender) {
  if (!isTrustedSender(sender)) {
    log('refused a message from an untrusted sender');
    return badMessage('That message was refused.');
  }
  if (!isPlainObject(message) || typeof message.type !== 'string') return badMessage();
  // Credentials may only arrive from our own UI, never from a page.
  if (message.type === 'login' && !isExtensionPage(sender)) {
    log(`refused a ${message.type} message from outside the extension UI`);
    return badMessage('That message was refused.');
  }

  switch (message.type) {
    case 'relevance':
      return handleRelevance(message);
    case 'briefing':
      return handleBriefing(message);
    case 'login':
      return handleLogin(message);
    case 'logout':
      return handleLogout();
    case 'openSite':
      return handleOpenSite();
    case 'getState':
      return handleGetState();
    case 'pageSession':
      return handlePageSession(message, sender);
    default:
      return unknownMessage();
  }
}

// Top-level, synchronous listener. Returns literal true so Chrome keeps the
// message channel open while the async handler answers via sendResponse.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      log(`a message failed: ${error && error.message}`);
      sendResponse(internalError());
    });
  return true;
});

// A finished load on the Socius site is the only signal that the site's own
// session changed (sign-in, sign-out, or the fragment handoff we just sent).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || changeInfo.status !== 'complete') return;
  syncSiteSession(tabId, tab && tab.url ? tab.url : changeInfo.url).catch(() => {});
});
