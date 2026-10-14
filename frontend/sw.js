// =============================================================================
// frontend/sw.js — the Socius AI service worker.
//
// WHAT A SERVICE WORKER IS
// -----------------------
// A service worker is a small script the browser keeps alive in the background,
// even when no tab of the site is open. It has two jobs here:
//   1. intercept the app's network requests (`fetch` handler below), and
//   2. keep copies of files so a visit still works when the network does not.
//
// WHO REGISTERS IT
// ----------------
// frontend/js/components/shell.js calls, once per page load and only over
// http/https:
//
//     navigator.serviceWorker.register('sw.js')
//
// The path is relative to the page, so from every page in this folder it
// resolves to `/sw.js` and this worker's scope is the whole app. That is why
// this file must stay here: move it and everything below silently turns off.
//
// THE BUG THIS FILE FIXES
// -----------------------
// This file did not exist. The server answers every unknown non-/api path with
// index.html — see `serveFrontend()` in server/app.js and the rewrites in
// vercel.json — so the browser downloaded an HTML page where it expected
// JavaScript and logged, on every page:
//
//     The script has an unsupported MIME type ('text/html').
//
// Two things make that permanent, and the second is the important one:
//   1. this file now exists, so /sw.js is served with a JavaScript MIME type;
//   2. `isCacheable()` (below) only ever stores a response whose Content-Type
//      is on an allowlist, and text/html is only ever allowed for a page
//      navigation. A fallback page, a 404 or a 500 therefore can never be
//      written into a cache and later served as if it were a stylesheet or a
//      module — that was the exact shape of the original bug.
//
// THE THREE RULES THIS FILE LIVES BY
// ----------------------------------
//   1. NOTHING from /api/* is ever cached, and no request that carries an
//      Authorization header is ever stored — API answers are user data, and a
//      cached copy would still be served after the user signs out.
//   2. A response is only stored when it is a clean, same-origin, 200, static
//      asset. Anything else — an error page, a redirect, a partial response, a
//      third-party reply — is passed through untouched and forgotten.
//   3. When the network is gone the worker says so. It never invents an empty
//      stylesheet, a blank script, or a page that looks like the app loaded.
//
// RELEASING AN UPDATE
// -------------------
// Assets here are not fingerprinted (css/base.css stays css/base.css), so the
// browser cannot tell a changed file from an unchanged one. The versioned cache
// name does that work: when a release changes any CSS or JS, bump VERSION below
// by one. The browser re-reads this file on every page load, notices the new
// script, installs the new worker, and `activate` deletes the old cache — so a
// deploy can never leave a visitor on last month's stylesheet.
// =============================================================================

/* --------------------------------------------------------------- constants */

// Bump this by one on every release that changes CSS, JS or HTML content.
// The name changes with it, so a new version writes to a fresh cache and
// `activate` deletes the old one — that is what stops a deploy leaving a
// visitor on the previous release's stylesheet.
const VERSION = 'v1';

// The one and only cache this worker writes to.
const CACHE_NAME = `socius-shell-${VERSION}`;

// The single source of truth for what may survive an activation: every cache
// whose name is not listed here is deleted, because it was written by an
// earlier version of this worker. If a future feature needs a second bucket,
// add its name here or it will be wiped on the next activation.
const CACHE_NAMES = new Set([CACHE_NAME]);

// Pre-installed files: the design-system sheets and the modules every interior
// page needs to draw its shell. A page's own CSS and page module are cached the
// first time that page is opened. Paths are relative to this worker's scope, so
// they work on localhost, on a sub-path deployment, and on Vercel alike.
const PRECACHE_LIST = [
  'css/tokens.css',
  'css/base.css',
  'css/components.css',
  'css/shell.css',
  'js/api.js',
  'js/auth.js',
  'js/ui.js',
  'js/components/shell.js',
];

// The only response types this worker may store as a static asset. text/html is
// NOT here on purpose — it is the whole defence against caching the server's
// fallback page or an error page as if it were an asset. Add image/font types
// only when the app actually ships them; this list is a gate, not a wish list.
const CACHEABLE_CONTENT_TYPES = new Set([
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'image/gif',
  'font/woff2',
  'font/woff',
]);

// Pages are a separate, much shorter list. They get their own allowlist so
// "a page may be stored" can never widen into "HTML may be stored anywhere".
const DOCUMENT_MEDIA_TYPES = new Set(['text/html']);

// API answers are user data: never stored, never rewritten, never faked.
const API_PREFIX = '/api/';

/* ------------------------------------------------------------------ helpers */

/** Content-Type with its parameters removed and lower-cased ('text/css'). */
function mediaTypeOf(response) {
  const raw = response.headers.get('content-type') || '';
  return raw.split(';')[0].trim().toLowerCase();
}

function isApiUrl(url) {
  return new URL(url, self.location.href).pathname.startsWith(API_PREFIX);
}

/**
 * May this response be stored?
 *
 * The answer is no unless every check passes, so an unknown response is
 * discarded by default rather than trusted by default. Deliberately rejected:
 * an error status, a non-200, a redirect, a partial (206/Range) response, an
 * opaque cross-origin reply, a response that sets a cookie, a response the
 * server asked us not to store, and any Content-Type not in `allowedTypes`.
 */
function isCacheable(response, allowedTypes) {
  if (!response || response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  if (response.status !== 200 || !response.ok) return false;
  if (response.redirected) return false;
  if (response.headers.has('content-range')) return false;
  if (response.headers.has('set-cookie')) return false;

  const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
  if (/(^|[,\s])(no-store|no-cache|private)([,\s]|$)/.test(cacheControl)) return false;

  return allowedTypes.has(mediaTypeOf(response));
}

/** Store one response, ignoring quota errors and TypeErrors. */
async function store(cache, request, response) {
  try {
    await cache.put(request, response);
    return true;
  } catch {
    // Quota, or a response the Cache API refuses. Losing a cache entry is never
    // worth breaking a page load, so this is swallowed on purpose.
    return false;
  }
}

/* ------------------------------------------------------------- html routes */

/**
 * A page navigation. Network-first: the visitor gets the real page whenever the
 * network answers, and only falls back to what was stored when it does not.
 * Cache-first would be wrong here — it is how an app ends up showing a stale
 * page weeks after a deploy.
 */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  try {
    const response = await fetch(request);
    if (cache && isDocumentCacheable(request, response)) {
      await store(cache, request, response.clone());
    }
    return response;
  } catch {
    const cached = cache ? await cache.match(request).catch(() => undefined) : undefined;
    if (cached) return cached;
    return offlinePage(request.url);
  }
}

/**
 * Which navigations are worth storing for the offline fallback: same-origin,
 * a clean 200 text/html, and no query string (`?mock=1` is different content).
 *
 * This server answers /anything with index.html, so a stored page cannot be
 * told apart from a real one. That is why a cached page is only ever handed
 * back when the network has already failed: online, the network answer always
 * wins, and nothing stale is ever served.
 *
 * It is safe to keep a page because the served HTML holds no account data —
 * tokens and the signed-in name live in localStorage and are drawn in by
 * shell.js at runtime — and because no /api response is ever stored here. So
 * an offline copy of a private page shows the shell with its sign-in gate
 * failing honestly, rather than another visitor's data.
 */
function isDocumentCacheable(request, response) {
  if (!isCacheable(response, DOCUMENT_MEDIA_TYPES)) return false;
  const url = new URL(request.url, self.location.href);
  if (url.search) return false; // ?mock=1 and friends are different content
  return true;
}

/* ----------------------------------------------------------- static assets */

/**
 * CSS, JS, images and fonts. Stale-while-revalidate: the stored copy answers
 * immediately, and a network copy refreshes it in the background so the next
 * load is current. Every stored copy is still content-type checked, so an HTML
 * error page cannot sneak in here either.
 */
async function handleAsset(event, request) {
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  const cached = cache ? await cache.match(request).catch(() => undefined) : undefined;

  let networkError = null;
  const refreshed = fetch(request)
    .then((response) => {
      if (!cache || !isCacheable(response, CACHEABLE_CONTENT_TYPES)) return response;
      return store(cache, request, response.clone()).then(() => response);
    })
    .catch((error) => {
      networkError = error;
      return null;
    });

  if (cached) {
    // Keep the background refresh alive even though this handler has returned.
    event.waitUntil(refreshed);
    return cached;
  }

  const fresh = await refreshed;
  if (fresh) return fresh;

  // Nothing stored and no network. Fail exactly as the browser would have
  // without a worker: an empty CSS or JS file would be a lie the page cannot
  // detect, and a fake 200 would hide a real outage.
  throw networkError || new Error(`Service worker could not reach ${request.url}`);
}

/* --------------------------------------------------------- api and writes */

/**
 * API traffic travels straight through and is never stored. When the network
 * is gone it gets a 503 in the same { error: { code, message } } envelope
 * api.js already knows how to read, so the app shows an honest "this failed"
 * message instead of hanging or retrying against nothing.
 */
async function handleApi(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({
        error: {
          code: 'OFFLINE',
          message: 'No connection to the Socius AI server, so this request could not be sent. Nothing was saved locally — try again when you are back online.',
        },
      }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      },
    );
  }
}

/* ----------------------------------------------------------------- offline */

/**
 * The honest offline page. It must not look like the app loaded successfully,
 * and it must not claim a single cause: the worker cannot tell a dropped
 * connection from an unreachable server, because both fail the same way from
 * in here. So it says both, and offers one button that tries again.
 *
 * The retry link points at the URL that failed. CSS colours are the literal
 * values of frontend/css/tokens.css (--blue, --ink, --ink-3, --canvas, --line)
 * so the page is recognisably ours without loading a stylesheet that may not
 * be cached.
 */
function offlinePage(requestUrl) {
  const raw = String(requestUrl || '');
  const retryHref = raw ? raw.replace(/"/g, '%22') : './';
  const cause = self.navigator && self.navigator.onLine === false
    ? 'Your device reports that it is offline, so this page could not be downloaded.'
    : 'Either your connection dropped, or the Socius AI server could not be reached. If you are online, the server is the more likely of the two.';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>No connection — Socius AI</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:24px; background:#F4F6F8; color:#39424E;
         font:16px/1.6 "IBM Plex Sans", system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .card { max-width:34rem; background:#fff; border:1px solid #DEE2E8; border-radius:12px; padding:28px 32px 32px; }
  h1 { margin:0 0 4px; font-size:1.5rem; color:#101418; }
  p { margin:12px 0 0; }
  .cause { color:#6B7480; }
  .btn { display:inline-block; margin-top:24px; padding:12px 20px; border-radius:8px;
         background:#1D4ED8; color:#fff; font-weight:600; text-decoration:none; }
  .btn:hover { background:#1740B4; }
  .note { margin-top:20px; font-size:.8125rem; color:#6B7480; }
</style>
</head>
<body>
  <main class="card">
    <h1>This page did not load</h1>
    <p class="cause">${cause}</p>
    <p>Socius AI needs a connection to reach your material, your progress and the AI tutor.</p>
    <p><strong>Nothing was lost.</strong> Your library, quizzes and flashcards live on the server; nothing here was written while you were offline.</p>
    <a class="btn" href="${retryHref}">Try again</a>
    <p class="note">Socius AI is a study companion. AI answers can be wrong — always check them against the page each citation points to.</p>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', // never keep the offline page itself
    },
  });
}

/* ------------------------------------------------------------ install prep */

/** Pre-install the shared shell, checking every response like any other. */
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const base = self.registration.scope;
  await Promise.all(PRECACHE_LIST.map(async (path) => {
    try {
      const url = new URL(path, base).href;
      const response = await fetch(url);
      if (!isCacheable(response, CACHEABLE_CONTENT_TYPES)) {
        throw new Error(`${url} answered ${response.status} ${mediaTypeOf(response) || 'without a content type'}`);
      }
      await store(cache, url, response);
    } catch {
      // One missing file must not fail the install: the worker is still valid,
      // that file is simply fetched on demand next time it is needed.
    }
  }));
}

/* ------------------------------------------------------------------ events */

// Installed: pre-load the shared shell, then take over. `skipWaiting()` is
// called on purpose — no page sends SKIP_WAITING (shell.js only registers this
// file), so without it the new worker would sit in "waiting" until the last tab
// of the origin is closed and a visitor who never closes a tab would keep last
// release's CSS and JS. Swapping workers never reloads a page, so a half-typed
// tutor message is not affected; only the network path changes underneath it.
self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting().catch(() => {})));
});

// Activated: drop every cache that is not the current one. This is the step
// that stops a new deploy serving old CSS or old JS forever.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => !CACHE_NAMES.has(name)).map((name) => caches.delete(name)));
    // Take over already-open tabs so a reload is not needed to get the worker.
    await self.clients.claim();
  })().catch(() => {}));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Only plain GET/HEAD page loads and asset fetches cross this path.
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  // A request that demands a cached-only answer cannot be served from the
  // network — answering it would throw and break the page.
  if (request.cache === 'only-if-cached') return;
  // Third-party requests (Google Fonts, and so on) are not ours to store.
  if (new URL(request.url, self.location.href).origin !== self.location.origin) return;
  // A request carrying a token or a session cookie is private: never store it,
  // and never rewrite it. Unknown safety means no caching.
  if (request.headers.get('authorization') || request.headers.get('cookie')) return;

  try {
    if (isApiUrl(request.url)) {
      event.respondWith(handleApi(request));
      return;
    }
    if (!('caches' in self)) return; // no Cache Storage: stay out of the way

    if (request.mode === 'navigate' || request.destination === 'document') {
      event.respondWith(handleNavigation(request));
      return;
    }
    event.respondWith(handleAsset(event, request));
  } catch {
    // If anything above fails to even start, let the request go to the network
    // untouched rather than failing it. The page must never break because of
    // the worker that was supposed to help it.
  }
});

// A page asks for the waiting worker to take over now.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting().catch(() => {});
  }
});
