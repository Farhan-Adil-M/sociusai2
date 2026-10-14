// auth.js — the only module that knows how Socius AI signs people in.
//
// Configuration is discovered from the backend at run time: GET /api/health
// carries `checks.auth = { mode: 'supabase' | 'prototype', supabaseUrl,
// supabaseAnonKey }`. No Supabase URL or key is bundled into the frontend — the
// browser only ever receives the PUBLIC (anon) config.
//
// - mode 'supabase': the vendored @supabase/supabase-js bundle is lazy-loaded
//   ONCE from frontend/vendor/supabase.js (committed in the repo — no CDN, so
//   the app keeps working offline). The session lives in localStorage under the
//   library's own `sb-…-auth-token` key and is restored on every page load via
//   auth.getSession(); the library refreshes tokens itself, and api.js forces
//   one extra refresh after an UNAUTHENTICATED 401.
// - mode 'prototype' (dev without Supabase, server unreachable, or mock mode):
//   a name-only local session (`localStorage.socius_user`) with no tokens — the
//   historic visual-only login, kept so the app still runs with no auth backend.
//   It is clearly flagged everywhere (`mode`, `prototype: true`, the UI badge).
//
// Known, deliberate trade-off: the Supabase session is kept in localStorage,
// which is reachable by an XSS bug (the Supabase docs' own recommended default
// for browser SPAs). Tokens are therefore never put into URLs, logs, or HTML.
//
// Public surface (imported by shell.js and the page modules):
//   authReady, requireSignIn, getSession, currentUser, onAuthStateChange,
//   signOut, signInWithName, getAuthMode, getUserName, getHealthStatus,
//   accessToken, refreshAccessToken, redirectToLoginWithNotice, takeAuthNotice,
//   getSupabaseClient, storageUploadToStudySources.

const SUPABASE_JS_LOCAL = '../vendor/supabase.js'; // vendored — no CDN required
const USER_KEY = 'socius_user'; // prototype display name (name-only session)
const NOTICE_KEY = 'socius_auth_notice'; // message the sign-in page shows once

/** Where signing in lives. Every auth redirect (sign-out, expired session) goes
 *  here, so there is exactly one place to change it. */
export const LOGIN_PATH = 'login.html';

/** The one message used when the backend itself cannot be reached. */
const UNREACHABLE = {
  code: 'NETWORK_ERROR',
  message: 'The Socius AI server could not be reached.',
};

let client = null; // shared supabase-js browser client (created lazily)
let session = null; // cached Supabase session (kept fresh by the auth listener)
let mode = 'prototype'; // 'supabase' once the client is live, else 'prototype'
let bootPromise = null; // the one-time boot, shared by every caller
let booted = false; // true once boot() has settled (listeners can be flushed)

// Last /api/health outcome, shared with shell.js so the page makes exactly ONE
// health request, which doubles as auth-config discovery.
let health = { ok: false, error: { ...UNREACHABLE } };

// Auth-state subscribers (see onAuthStateChange).
const listeners = new Set();

/** Tell every subscriber that the session changed. A failing listener must
 *  never break the boot or another listener. */
function notify(event) {
  for (const listener of [...listeners]) {
    try {
      listener(event, getSessionSnapshot());
    } catch (error) {
      console.error('[auth] auth-state listener failed:', error?.message ?? error);
    }
  }
}

/* ------------------------------------------------- extension session handoff */

/**
 * Session handoff from the browser extension's "Open Socius AI" button.
 * The extension opens `#socius_session=<base64(JSON)>` carrying its own Supabase
 * session ({ access_token, refresh_token }). We adopt it so the visitor lands
 * signed in. The fragment never reaches any server (fragments stay in the
 * browser) and it is stripped from the URL immediately — the same pattern as an
 * OAuth implicit-flow callback.
 *
 * Runs at MODULE LOAD (not inside boot()) so that whichever page the button
 * opens — landing, study, or dashboard — the fragment is always consumed and
 * cleaned. boot() later picks the stashed tokens up and validates them.
 */
let pendingHandoff = null;

/** base64 → JSON text, UTF-8 safe (atob alone mangles non-ASCII bytes). */
function decodeBase64Json(raw) {
  const binary = atob(raw);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function takeHandoffSession() {
  try {
    const hash = window.location.hash || '';
    if (!hash.startsWith('#')) return null;

    const params = new URLSearchParams(hash.slice(1));
    const raw = params.get('socius_session');
    if (!raw) return null;

    // Clean the URL first: the token must not stay in the address bar, history,
    // or a shared link — even if the payload turns out to be malformed.
    params.delete('socius_session');
    const rest = params.toString();
    history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + (rest ? `#${rest}` : ''),
    );

    const parsed = JSON.parse(decodeBase64Json(raw));
    if (typeof parsed?.access_token !== 'string' || typeof parsed?.refresh_token !== 'string') return null;
    const tokens = { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
    if (typeof parsed.expires_at === 'number') tokens.expires_at = parsed.expires_at;
    return tokens;
  } catch {
    return null; // malformed fragment: ignore it, never crash the boot
  }
}

pendingHandoff = takeHandoffSession();

/* --------------------------------------------------------------- booting up */

/**
 * api.js owns every network call (including the health read), but it also
 * imports THIS module — so it is imported lazily inside functions instead of at
 * the top, which keeps the two modules free of a static import cycle.
 */
async function loadApi() {
  try {
    return await import('./api.js');
  } catch (error) {
    console.error('[auth] api.js failed to load:', error?.message ?? error);
    return null;
  }
}

/** Demo mode is api.js's decision (it owns the `?mock=1` rule) — ask it. */
async function inMockMode() {
  const api = await loadApi();
  return typeof api?.isMockMode === 'function' ? api.isMockMode() : false;
}

/** Map a failed /api/health read onto the health snapshot shell.js renders. */
function healthErrorFrom(error) {
  const envelope = error?.data?.error;
  if (envelope?.code) {
    return {
      code: envelope.code,
      message: envelope.message || 'The server did not return a usable status response.',
    };
  }
  if (error?.code === 'NETWORK_ERROR') return { ...UNREACHABLE };
  return { code: 'INTERNAL', message: 'The server did not return a usable status response.' };
}

/** One raw GET /api/health. Returns the auth config, or null when unavailable. */
async function readHealth() {
  const api = await loadApi();
  if (typeof api?.anonymousGet !== 'function') return null; // health stays "unreachable"

  let data;
  try {
    data = await api.anonymousGet('/api/health');
  } catch (error) {
    health = { ok: false, error: healthErrorFrom(error) };
    return null;
  }

  if (!data || !data.checks) {
    health = { ok: false, error: { code: 'INTERNAL', message: 'The server did not return a usable status response.' } };
    return null;
  }

  health = { ok: true, data };
  const auth = data.checks.auth || {};
  const usable = auth.mode === 'supabase' && auth.supabaseUrl && auth.supabaseAnonKey;
  return usable ? auth : null; // prototype config (or no auth block) → prototype mode
}

/** Resolve the mode and (in Supabase mode) restore the saved session. */
async function boot() {
  try {
    if (await inMockMode()) {
      mode = 'prototype'; // mock pages make no network calls and need no auth
      return { mode, health };
    }

    const handoff = pendingHandoff; // stashed + cleaned at module load
    pendingHandoff = null;

    const auth = await readHealth();
    mode = 'prototype';
    if (!auth) return { mode, health };

    try {
      // Lazy load from the VENDORED file (no CDN): the bundle is ESM and
      // exports `supabase`; accept either the namespace or a createClient.
      const mod = await import(SUPABASE_JS_LOCAL);
      const createClient = mod?.createClient ?? mod?.supabase?.createClient ?? globalThis.supabase?.createClient;
      if (!createClient) throw new Error('the vendored supabase.js did not expose createClient');

      client = createClient(auth.supabaseUrl, auth.supabaseAnonKey);

      if (handoff) {
        // Extension handoff: setSession validates the tokens (and refreshes
        // them when expired). On any failure we keep whatever session this
        // device already had.
        const adopted = await client.auth.setSession(handoff);
        if (adopted?.error) console.warn('[auth] extension session handoff rejected:', adopted.error.message);
      }

      const { data } = await client.auth.getSession();
      session = data?.session ?? null;
      // Keep our cached copy in step with the library's own refresh/renew cycle.
      client.auth.onAuthStateChange((event, next) => {
        session = next || null;
        notify(event || 'TOKEN_REFRESHED');
      });
      mode = 'supabase';
    } catch (error) {
      // Vendored client missing or init failed: fall back to the no-auth
      // prototype UI instead of rendering a broken app. Health stays truthful.
      console.error(
        '[auth] Supabase sign-in unavailable — falling back to prototype mode. '
        + 'Check that frontend/vendor/supabase.js exists:',
        error?.message ?? error,
      );
      client = null;
      session = null;
      mode = 'prototype';
    }

    return { mode, health };
  } catch (error) {
    console.error('[auth] boot failed:', error?.message ?? error);
    mode = 'prototype'; // server unreachable — name-only login, as before
    return { mode, health };
  } finally {
    booted = true;
    notify('INITIAL_SESSION');
  }
}

/**
 * Boot authentication exactly once. Resolves with { mode, health } and NEVER
 * rejects, so callers can rely on a usable app no matter what failed.
 */
export function authReady() {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

/* ------------------------------------------------------------------ session */

/** The cached session object, synchronously: the Supabase session in Supabase
 *  mode, a flagged name-only session in prototype mode, null when signed out.
 *  Call after `await authReady()` (or `await requireSignIn()`). */
function getSessionSnapshot() {
  if (mode === 'supabase') return session;
  const user = readPrototypeUser();
  if (!user) return null;
  return { mode: 'prototype', prototype: true, access_token: null, refresh_token: null, user };
}

/** The active session (awaits the one-time boot first), or null. */
export async function getSession() {
  await authReady();
  return getSessionSnapshot();
}

function readPrototypeUser() {
  try {
    const name = (localStorage.getItem(USER_KEY) || '').trim();
    return name
      ? { id: 'local', email: '', name, mode: 'prototype', anonymous: true }
      : null;
  } catch {
    return null; // storage blocked (private mode) — treat as signed out
  }
}

/**
 * Who is signed in, synchronously: { id, email, name, mode } or null.
 * In Supabase mode the name is the account's display metadata, else the email
 * local-part. In prototype mode it is the name typed on the sign-in page.
 */
export function currentUser() {
  if (mode === 'supabase') {
    const user = session?.user;
    if (!user) return null;
    return { id: user.id, email: user.email || '', name: displayNameOf(user), mode: 'supabase' };
  }
  return readPrototypeUser();
}

/** Display name for a Supabase user: metadata first, then the email local-part. */
function displayNameOf(user) {
  const meta = user?.user_metadata || {};
  const named = meta.display_name || meta.full_name || meta.name || '';
  if (typeof named === 'string' && named.trim()) return named.trim();
  const email = user?.email || '';
  return email ? email.split('@')[0] : '';
}

/** The display name alone ('' when signed out) — the topbar's convenience form
 *  of currentUser(). Kept synchronous, as shell.js expects. */
export function getUserName() {
  return currentUser()?.name ?? '';
}

/** 'supabase' once the client is live; 'prototype' otherwise. */
export function getAuthMode() {
  return mode;
}

/** The shared supabase-js client, or null in prototype/mock mode. */
export function getSupabaseClient() {
  return client;
}

/** Health snapshot for shell.js (it renders from this instead of refetching). */
export function getHealthStatus() {
  return health;
}

/** Access token for api.js, or null when signed out / in prototype mode. */
export function accessToken() {
  return session?.access_token || null;
}

/** Force a token refresh; resolves to a fresh token or null when not possible. */
export async function refreshAccessToken() {
  if (!client || !session) return null;
  try {
    const { data, error } = await client.auth.refreshSession();
    if (error || !data?.session) return null;
    session = data.session;
    notify('TOKEN_REFRESHED');
    return session.access_token;
  } catch (error) {
    console.warn('[auth] token refresh failed:', error?.message ?? error);
    return null;
  }
}

/**
 * Subscribe to sign-in / sign-out / token-refresh events.
 * Returns an unsubscribe function. Once boot has finished the listener is
 * called immediately with the current state, so pages never miss an event.
 */
export function onAuthStateChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  if (booted) {
    queueMicrotask(() => {
      if (listeners.has(listener)) {
        try {
          listener('INITIAL_SESSION', getSessionSnapshot());
        } catch (error) {
          console.error('[auth] auth-state listener failed:', error?.message ?? error);
        }
      }
    });
  }
  return () => listeners.delete(listener);
}

/* -------------------------------------------------------------- signing out */

/**
 * Sign out: clear the Supabase session when one exists, always clear the
 * prototype name, tell subscribers, then go to the sign-in page.
 * Pass `{ redirect: false }` to clear the session and stay put.
 */
export async function signOut({ redirect = true } = {}) {
  try {
    if (client) await client.auth.signOut();
  } catch (error) {
    console.warn('[auth] Supabase sign-out failed — clearing locally anyway:', error?.message ?? error);
  }
  session = null;
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage blocked — the in-memory session is already cleared */
  }
  notify('SIGNED_OUT');
  if (redirect) redirectTo(LOGIN_PATH);
}

/**
 * Prototype (no-auth) sign-in: store the typed display name as the local
 * session and flag it. Supabase-mode sign-in happens through
 * getSupabaseClient().auth.signInWithPassword (see the sign-in page).
 */
export async function signInWithName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Enter your name to continue.');
  try {
    localStorage.setItem(USER_KEY, clean);
  } catch (error) {
    console.warn('[auth] could not store the prototype name:', error?.message ?? error);
  }
  notify('SIGNED_IN');
  return getSessionSnapshot();
}

/* ------------------------------------------------------------------ gate */

/**
 * Hard gate for private pages: in Supabase mode with no session, remember why,
 * send the visitor to the sign-in page and resolve false.
 * Resolves true when the page may continue rendering.
 */
export async function requireSignIn() {
  const outcome = await authReady();
  if (outcome.mode !== 'supabase') return true; // prototype/mock: no gate
  if (session) return true;

  try {
    sessionStorage.setItem(NOTICE_KEY, 'Sign in to continue.');
  } catch {
    /* storage blocked — still redirect */
  }
  redirectTo(`${LOGIN_PATH}?next=${encodeURIComponent(window.location.pathname)}`);
  return false;
}

/** Send the browser to an app-relative page (no-op if already there). */
function redirectTo(href) {
  try {
    const target = new URL(href, window.location.href);
    if (target.href === window.location.href) return; // never reload in a loop
  } catch {
    /* fall through and navigate anyway */
  }
  window.location.href = href;
}

/**
 * 401 recovery for api.js: leave a message for the sign-in page, forget the
 * locally known session and route the user back to sign in. A no-op redirect
 * when the visitor is already on the sign-in page, so a rejected sign-in
 * attempt shows its error instead of looping.
 */
export function redirectToLoginWithNotice(message) {
  try {
    sessionStorage.setItem(NOTICE_KEY, message);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage blocked — still redirect */
  }
  session = null;
  notify('SIGNED_OUT');
  redirectTo(LOGIN_PATH);
}

/** Read (and clear) the "session expired / sign in to continue" notice. */
export function takeAuthNotice() {
  try {
    const message = sessionStorage.getItem(NOTICE_KEY) || '';
    sessionStorage.removeItem(NOTICE_KEY);
    return message;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------- Supabase Storage */

/**
 * Large-upload path (see POST /api/sources/storage-ingest): the file goes
 * DIRECTLY into the Supabase Storage bucket `study-sources`, so serverless
 * request-body limits cannot reject it. Returns the object path the backend
 * ingests. Requires the bucket + its owner-scoped RLS policy; the browser never
 * sees a service key, only the user's own session.
 */
export async function storageUploadToStudySources(file, { userId } = {}) {
  const outcome = await authReady();
  if (outcome.mode !== 'supabase' || !client) {
    throw Object.assign(new Error('Supabase Storage is not available in this mode.'), {
      code: 'STORAGE_UNAVAILABLE',
    });
  }
  const owner = userId ?? session?.user?.id ?? '';
  const safeName = String(file.name || 'upload').replace(/[\\/]+/g, '_');
  const objectPath = `${owner}/${Date.now()}_${safeName}`;

  const { error } = await client.storage.from('study-sources').upload(objectPath, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || 'application/octet-stream',
  });
  if (error) {
    const failure = new Error(error.message || 'Storage upload failed.');
    failure.code = error.status || 'STORAGE_UPLOAD_FAILED';
    throw failure;
  }
  return { storagePath: objectPath };
}

// Legacy alias kept so older call sites (and the extension sync notes) work.
export { authReady as waitForAuth };
