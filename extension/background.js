// background.js — MV3 service worker for the Study Highlighter extension.
//
// Relays content-script and popup requests to the Socius AI backend. The
// backend holds the API keys; nothing secret lives here. It also owns the
// extension's Supabase session (chrome.storage.local — deliberately NOT sync,
// so tokens never roam across devices): every backend call carries
// `Authorization: Bearer <jwt>` and transparently refreshes an expired token
// once. Every response uses one envelope: { ok: true, ... } on success, or
// { ok: false, error: { code, message } } on failure. Stack traces and
// internal details are never forwarded.

const DEFAULT_SETTINGS = {
  enabled: true,
  apiUrl: 'https://socius-ai.vercel.app',
  // The site URL targets the app (dashboard), not the marketing landing page:
  // app pages load auth.js, which adopts the #socius_session handoff fragment
  // and lands the visitor signed in. The landing page has no auth code.
  siteUrl: 'https://socius-ai.vercel.app/dashboard.html',
};

const TIMEOUT_MS = 15000;
const SESSION_KEY = 'session'; // chrome.storage.local — per-device, never synced
const EXPIRY_SKEW_MS = 60 * 1000; // refresh a minute before Supabase expires it

// What the panel shows when a request needs a signed-in user. One message,
// reused everywhere an UNAUTHENTICATED answer comes back.
const SIGNIN_MESSAGE = 'Sign in from the Socius AI toolbar button, then Retry.';

function networkError() {
  return {
    ok: false,
    error: { code: 'NETWORK_ERROR', message: 'Could not reach the Socius AI server.' },
  };
}

function validationError(message) {
  return { ok: false, error: { code: 'VALIDATION_ERROR', message } };
}

function authError() {
  return { ok: false, error: { code: 'UNAUTHENTICATED', message: SIGNIN_MESSAGE } };
}

function isAuthError(result) {
  return !result.ok && (result.error?.code === 'UNAUTHENTICATED' || result.error?.code === 'HTTP_401');
}

/* ------------------------------------------------------------ storage */

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
    apiUrl: stored.apiUrl ?? DEFAULT_SETTINGS.apiUrl,
    siteUrl: stored.siteUrl ?? DEFAULT_SETTINGS.siteUrl,
  };
}

function localGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (items) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(items ? items[key] : undefined);
    });
  });
}

function localSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function localRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => resolve());
  });
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ requests */

// POST JSON to the backend. Never throws; failures come back in the envelope.
// `token` (optional) becomes the Bearer header.
async function postJson(apiUrl, path, body, token) {
  let res;
  try {
    res = await fetch(apiUrl + path, {
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

  if (!res.ok) {
    let code = 'HTTP_' + res.status;
    let message = 'Server error.';
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === 'object' && parsed.error) {
        code = parsed.error.code || code;
        message = parsed.error.message || message;
      }
    } catch {
      // Body was not JSON; keep the defaults.
    }
    return { ok: false, error: { code, message } };
  }

  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, error: { code: 'BAD_RESPONSE', message: 'Server error.' } };
  }
}

/* -------------------------------------------------------------- session */

async function saveSession(session, email) {
  await localSet({ [SESSION_KEY]: { ...session, email: email ?? session?.user?.email ?? '' } });
}

async function clearSession() {
  await localRemove(SESSION_KEY);
}

// One refresh at a time: parallel scans would otherwise spend the same
// refresh token twice (Supabase rotates it and would revoke the session).
let refreshInFlight = null;

async function refreshOnce() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const session = await localGet(SESSION_KEY);
      if (!session?.refresh_token) return null;
      const { apiUrl } = await getSettings();
      const result = await postJson(apiUrl, '/api/auth/refresh', { refresh_token: session.refresh_token });
      if (result.ok && result.data?.session) {
        await saveSession(result.data.session);
        return result.data.session;
      }
      // Only a rejected token kills the session — a network blip must not.
      if (isAuthError(result)) await clearSession();
      return null;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/** The stored session, refreshed first when it is (nearly) expired. */
async function getFreshSession() {
  const session = await localGet(SESSION_KEY);
  if (!session?.access_token) return null;
  const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
  if (!expiresAt || Date.now() < expiresAt - EXPIRY_SKEW_MS) return session;
  return refreshOnce();
}

/** POST with a Bearer token; refresh + retry once on 401; honest UNAUTHENTICATED. */
async function authorizedPost(apiUrl, path, body) {
  let session = await getFreshSession();
  let result = await postJson(apiUrl, path, body, session?.access_token);
  if (!result.ok && session && isAuthError(result)) {
    session = await refreshOnce(); // revoked mid-flight → one clean retry
    if (session) result = await postJson(apiUrl, path, body, session.access_token);
  }
  if (isAuthError(result)) return authError(); // friendly message for the panel
  return result;
}

/* ------------------------------------------------------------- handlers */

async function handleRelevance(message) {
  if (!Array.isArray(message.blocks)) {
    return validationError('Expected an array of blocks.');
  }
  const { apiUrl } = await getSettings();
  if (!isHttpUrl(apiUrl)) {
    return validationError('The Socius AI server URL is not a valid http(s) address.');
  }
  const result = await authorizedPost(apiUrl, '/api/extension/relevance', { blocks: message.blocks });
  if (!result.ok) return result;
  return {
    ok: true,
    matches: result.data ? result.data.matches : undefined,
    minScore: result.data ? result.data.minScore : undefined,
  };
}

async function handleBriefing(message) {
  if (typeof message.text !== 'string' || message.text.length === 0) {
    return validationError('Expected a non-empty text string.');
  }
  const { apiUrl } = await getSettings();
  if (!isHttpUrl(apiUrl)) {
    return validationError('The Socius AI server URL is not a valid http(s) address.');
  }
  const body = { text: message.text };
  if (message.sourceIds !== undefined) body.sourceIds = message.sourceIds;
  const result = await authorizedPost(apiUrl, '/api/extension/briefing', body);
  if (!result.ok) return result;
  const data = result.data || {};
  return {
    ok: true,
    answer: data.answer,
    citations: data.citations,
    needsContent: data.needsContent,
    model: data.model,
  };
}

async function handleLogin(message) {
  const { apiUrl } = await getSettings();
  if (!isHttpUrl(apiUrl)) {
    return validationError('The Socius AI server URL is not a valid http(s) address.');
  }
  const result = await postJson(apiUrl, '/api/auth/login', {
    email: typeof message.email === 'string' ? message.email.trim() : '',
    password: typeof message.password === 'string' ? message.password : '',
  });
  if (!result.ok) {
    // The server's own credential message is safe to show; anything else
    // (e.g. Vercel auth walls) is not — keep those generic for the popup.
    if (result.error?.code === 'UNAUTHENTICATED') {
      return { ok: false, error: { code: 'UNAUTHENTICATED', message: result.error.message } };
    }
    return result;
  }
  if (result.data?.mode === 'prototype') {
    return { ok: true, prototype: true }; // local dev server: no login needed
  }
  await saveSession(result.data.session);
  return { ok: true, email: result.data.session?.user?.email ?? '' };
}

async function handleLogout() {
  await clearSession();
  return { ok: true };
}

async function handleOpenSite() {
  const { siteUrl } = await getSettings();
  if (!isHttpUrl(siteUrl)) {
    return validationError('The Socius AI site URL is not a valid http(s) address.');
  }
  // Carry the session to the site: the fragment stays in the browser (never
  // sent to any server) and the website adopts it on load (frontend auth.js).
  const session = await localGet(SESSION_KEY);
  let url = siteUrl;
  if (session?.access_token && session?.refresh_token) {
    const payload = btoa(JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at ?? null,
    }));
    url += (url.includes('#') ? '&' : '#') + 'socius_session=' + encodeURIComponent(payload);
  }
  await chrome.tabs.create({ url });
  return { ok: true };
}

async function handleGetState() {
  const { enabled, apiUrl, siteUrl } = await getSettings();
  const session = await localGet(SESSION_KEY);
  return {
    ok: true,
    enabled,
    apiUrl,
    siteUrl,
    auth: { signedIn: Boolean(session?.access_token), email: session?.email ?? '' },
  };
}

async function handleMessage(message) {
  switch (message && message.type) {
    case 'relevance':
      return handleRelevance(message);
    case 'briefing':
      return handleBriefing(message);
    case 'login':
      return handleLogin(message);
    case 'logout':
      return handleLogout(message);
    case 'openSite':
      return handleOpenSite(message);
    case 'getState':
      return handleGetState(message);
    default:
      return {
        ok: false,
        error: { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type.' },
      };
  }
}

// Top-level, synchronous listener. Returns literal true so Chrome keeps the
// message channel open while the async handler answers via sendResponse.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(() => sendResponse(networkError()));
  return true;
});
