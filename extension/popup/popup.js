/* Popup logic for the Socius AI Study Highlighter toolbar popup.
   ==========================================================================
   Vanilla JS, no imports, no build step. This file owns exactly three jobs:

     1. Show the real connection state of the Socius AI server
        (GET /api/health, with a timeout and the actual reason on failure).
     2. Show who is signed in — or state plainly that nobody is — and sign out.
     3. Read, validate and save the three real settings in chrome.storage.sync.

   Everything else belongs to the background worker (extension/background.js):
   it owns the Supabase session and the API calls. This popup never holds a
   token and never puts one in the DOM — the worker answers `getState` with
   { signedIn, email } and nothing more. Every dynamic string is written with
   textContent, never innerHTML, so no value can become markup.
   ========================================================================== */

'use strict';

/* ------------------------------------------------------------- constants -- */

const DEFAULTS = Object.freeze({
  enabled: true,
  siteUrl: 'https://sociusai2.vercel.app/dashboard.html',
  apiUrl: 'https://sociusai2.vercel.app',
});

/** How long the health probe may take before we call it unreachable. */
const HEALTH_TIMEOUT_MS = 5000;

/** How long we wait for the background worker before calling it silent. */
const WORKER_TIMEOUT_MS = 6000;

/** Human labels for the server's own check names (server/routes/health.js). */
const CHECK_LABELS = {
  sqlite: 'database',
  chroma: 'vector search',
  nim: 'AI provider',
};

/* A popup is destroyed the instant it loses focus. Any async work still in
   flight must not touch the document afterwards, and the health probe should
   be aborted so it does not hold the socket open for nothing. */
let popupClosed = false;
let healthController = null;

window.addEventListener('pagehide', () => {
  popupClosed = true;
  if (healthController) healthController.abort();
});

/** False once the popup is gone — every DOM write checks this first. */
function stillOpen() {
  return !popupClosed;
}

/* ------------------------------------------------- storage (chrome only) -- */

function storageGet(items) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(items, (stored) => {
      if (chrome.runtime.lastError) {
        console.error('Could not read settings:', chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      resolve(stored || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * Merge stored settings over the defaults, one validated value per key.
 * A stored value of the wrong type is ignored rather than rendered, so a
 * corrupt entry can never break the popup or reach the server.
 */
async function loadSettings() {
  const stored = await storageGet(DEFAULTS);
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULTS.enabled,
    siteUrl: isStoredUrl(stored.siteUrl) ? stored.siteUrl : DEFAULTS.siteUrl,
    apiUrl: isStoredUrl(stored.apiUrl) ? stored.apiUrl : DEFAULTS.apiUrl,
  };
}

function isStoredUrl(value) {
  return typeof value === 'string' && parseUrl(value).ok;
}

/** Parse + validate an http(s) address. Returns { ok, url?, message? }. */
function parseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, message: 'This field is required.' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      message: 'That is not a web address. Enter the full http:// or https:// address.',
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'The address must start with http:// or https://.' };
  }
  return { ok: true, url, value: url.href.replace(/\/+$/, '') };
}

/* ------------------------------------------------------ background worker -- */

/**
 * Ask the background worker for something. Resolves null when the worker does
 * not answer in time or the extension context is orphaned — callers must treat
 * null as "unknown", never as success.
 */
function sendRuntime(message) {
  return new Promise((resolve) => {
    if (popupClosed) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), WORKER_TIMEOUT_MS);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) finish(null);
        else finish(response ?? null);
      });
    } catch {
      clearTimeout(timer);
      finish(null); // context gone (extension reloaded) — nothing to talk to
    }
  });
}

/* ------------------------------------------------------------- elements -- */

const els = {};

function cacheElements() {
  els.statusSpinner = document.getElementById('status-spinner');
  els.statusDot = document.getElementById('status-dot');
  els.statusText = document.getElementById('status-text');
  els.statusDetail = document.getElementById('status-detail');
  els.statusRetry = document.getElementById('status-retry');

  els.accountSignedOut = document.getElementById('account-signed-out');
  els.accountSignedIn = document.getElementById('account-signed-in');
  els.accountNote = document.getElementById('account-note');
  els.accountEmail = document.getElementById('account-email');
  els.accountUnreachableNote = document.getElementById('account-unreachable-note');
  els.accountPrototypeNote = document.getElementById('account-prototype-note');
  els.accountWorkerNote = document.getElementById('account-worker-note');

  els.loginForm = document.getElementById('login-form');
  els.loginEmail = document.getElementById('login-email');
  els.loginPassword = document.getElementById('login-password');
  els.loginError = document.getElementById('login-error');
  els.loginBtn = document.getElementById('login-btn');
  els.logoutBtn = document.getElementById('logout-btn');

  els.toggle = document.getElementById('enabled-toggle');
  els.settingsForm = document.getElementById('settings-form');
  els.apiInput = document.getElementById('api-url');
  els.apiError = document.getElementById('api-url-error');
  els.siteInput = document.getElementById('site-url');
  els.siteError = document.getElementById('site-url-error');
  els.saveBtn = document.getElementById('save-btn');
  els.resetBtn = document.getElementById('reset-btn');
  els.saveFeedback = document.getElementById('save-feedback');

  els.openBtn = document.getElementById('open-app-btn');
  els.openFeedback = document.getElementById('open-feedback');
}

/* --------------------------------------------------- 1 · connection state -- */

// Per-state appearance for the status line. `tone` classes are added to the
// dot and the text; 'checking' is handled separately (spinner, no tone).
const STATUS_STATES = {
  ok: { text: 'Connected' },
  degraded: { text: 'Reachable, but degraded', tone: 'is-warn' },
  unreachable: { text: 'Unreachable', tone: 'is-down' },
  error: { text: 'Error', tone: 'is-down' },
};

/**
 * Paint the probe outcome. `state` is one of
 *   checking | ok | degraded | unreachable | error
 * and `detail` is the actual reason, always non-empty for a non-ok state.
 */
function renderStatus(state, detail) {
  if (!stillOpen()) return;

  els.statusSpinner.hidden = state !== 'checking';
  els.statusDot.hidden = state === 'checking';

  els.statusDot.className = 'status-dot';
  els.statusText.className = 'status-text';

  if (state === 'checking') {
    els.statusText.textContent = 'Checking connection…';
    els.statusDetail.hidden = true;
    els.statusDetail.textContent = '';
    return;
  }

  const appearance = STATUS_STATES[state];
  els.statusText.textContent = appearance.text;
  if (appearance.tone) {
    els.statusDot.classList.add(appearance.tone);
    els.statusText.classList.add(appearance.tone);
  }
  els.statusDetail.hidden = false;
  els.statusDetail.textContent = detail;
}

/** The server's own check names turned into a sentence, failures first. */
function describeChecks(checks) {
  const failed = [];
  const passed = [];
  for (const [key, label] of Object.entries(CHECK_LABELS)) {
    const check = checks ? checks[key] : null;
    if (!check) continue;
    if (check.ok) passed.push(label);
    else failed.push(`${label}${check.message ? ` — ${check.message}` : ''}`);
  }
  return { failed, passed };
}

/** The one thing the server caches for 10 minutes, stated out loud. */
const CACHE_NOTE = 'The server reuses its own last probe for up to 10 minutes, '
  + 'so a recovery can appear late here.';

/** Turn the health report into a status verdict: state, detail sentence, and
 *  whether that server has accounts. A reply that is not a health report at
 *  all is an error, never a guess. */
function evaluateHealth(report) {
  if (!report || typeof report !== 'object' || !report.checks || typeof report.checks !== 'object') {
    return { state: 'error', authMode: null, detail: 'The server answered, but the reply was not a health report (no "checks" object).' };
  }

  const authMode = report.checks.auth && report.checks.auth.mode === 'supabase' ? 'supabase' : 'prototype';
  const { failed, passed } = describeChecks(report.checks);
  const suffix = ` ${CACHE_NOTE}`;

  if (report.status === 'ok' && failed.length === 0) {
    return { state: 'ok', authMode, detail: `Every check reported OK (${passed.join(', ') || 'none reported'}).${suffix}` };
  }

  return { state: 'degraded', authMode, detail: `The server is answering but reports: ${failed.join('; ')}.${suffix}` };
}

async function checkConnection(apiUrl) {
  renderStatus('checking');

  const parsed = parseUrl(apiUrl);
  if (!parsed.ok) {
    renderStatus('error', `The saved API URL is not usable, so no request was sent: ${parsed.message}`);
    return { state: 'error', authMode: null };
  }

  if (healthController) healthController.abort();
  healthController = new AbortController();
  const controller = healthController;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HEALTH_TIMEOUT_MS);

  const healthUrl = `${parsed.value}/api/health`;

  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      renderStatus('error', `The server answered HTTP ${response.status} for ${healthUrl}. A healthy Socius AI server always answers 200 here.`);
      return { state: 'error', authMode: null };
    }

    const report = await response.json().catch(() => null);
    const verdict = evaluateHealth(report);
    renderStatus(verdict.state, verdict.detail);
    return { state: verdict.state, authMode: verdict.authMode };
  } catch (error) {
    if (timedOut) {
      renderStatus('unreachable', `No answer from ${healthUrl} within ${HEALTH_TIMEOUT_MS / 1000} seconds, so the check timed out.`);
      return { state: 'unreachable', authMode: null };
    }
    if (error && error.name === 'AbortError') {
      // The popup closed while the request was in flight — nothing to render.
      return { state: 'aborted', authMode: null };
    }
    renderStatus('unreachable', `The browser could not reach ${healthUrl} (network error: ${error && error.message ? error.message : 'request failed'}).`);
    return { state: 'unreachable', authMode: null };
  } finally {
    clearTimeout(timer);
    if (healthController === controller) healthController = null;
  }
}

/* -------------------------------------------------------- 2 · account state -- */

/** What the worker last told us. `known` is false until it actually answers. */
let workerState = { known: false, signedIn: false, email: '' };
/** Auth mode reported by the health probe: 'supabase' | 'prototype' | null. */
let authMode = null;

function signedIn() {
  return workerState.known && workerState.signedIn;
}

/**
 * Draw the account section. Never guesses: when the worker has not answered
 * the popup says so instead of showing a sign-in form it cannot honour.
 */
function renderAccount() {
  if (!stillOpen()) return;

  const show = signedIn();
  els.accountSignedIn.hidden = !show;
  els.accountSignedOut.hidden = show;

  if (show) {
    // textContent only — the email is data, never markup, and no token exists
    // here to leak in the first place.
    els.accountEmail.textContent = workerState.email || '(email not reported by the server)';
    return;
  }

  // Signed out. Pick exactly one honest explanation for the missing form.
  els.loginForm.hidden = authMode !== 'supabase';
  els.accountUnreachableNote.hidden = authMode !== null;
  els.accountPrototypeNote.hidden = authMode !== 'prototype';
  els.accountWorkerNote.hidden = workerState.known;

  if (!workerState.known) {
    els.accountNote.textContent = 'Sign-in state unknown — the background worker did not answer.';
  } else {
    els.accountNote.textContent = 'Nobody is signed in.';
  }
}

/** Re-read the worker's view of the session and repaint. */
async function refreshAccount() {
  const state = await sendRuntime({ type: 'getState' });
  if (!stillOpen()) return;

  if (!state || state.ok !== true || !state.auth) {
    workerState = { known: false, signedIn: false, email: '' };
  } else {
    workerState = {
      known: true,
      signedIn: Boolean(state.auth.signedIn),
      email: typeof state.auth.email === 'string' ? state.auth.email : '',
    };
    // The worker is the source of truth for settings too; adopt them so the
    // form never disagrees with what the worker will actually use.
    if (typeof state.apiUrl === 'string') els.apiInput.value = state.apiUrl;
    if (typeof state.siteUrl === 'string') els.siteInput.value = state.siteUrl;
    if (typeof state.enabled === 'boolean') els.toggle.checked = state.enabled;
  }
  renderAccount();
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  setLoginError('');

  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value;
  if (!email || !password) {
    setLoginError('Enter your email and password.');
    return;
  }

  els.loginBtn.disabled = true;
  els.loginBtn.setAttribute('aria-busy', 'true');
  const result = await sendRuntime({ type: 'login', email, password });
  els.loginBtn.disabled = false;
  els.loginBtn.removeAttribute('aria-busy');
  if (!stillOpen()) return;

  // Drop the password from the document immediately, whatever happened.
  els.loginPassword.value = '';

  if (result && result.ok === true && result.prototype === true) {
    setLoginError('This server runs in prototype mode and has no accounts to sign in to.');
    return;
  }
  if (result && result.ok === true) {
    await refreshAccount();
    return;
  }
  setLoginError(errorMessageOf(result, 'Sign-in failed. Check the API URL and try again.'));
}

async function handleLogout() {
  els.logoutBtn.disabled = true;
  els.logoutBtn.setAttribute('aria-busy', 'true');

  const result = await sendRuntime({ type: 'logout' });

  // Clear our own state first: the popup holds nothing but this in-memory
  // copy, so it must never outlive a sign-out.
  workerState = { known: true, signedIn: false, email: '' };
  els.loginPassword.value = '';
  renderAccount();

  // Then verify against the worker instead of assuming the clear worked.
  if (result && result.ok === true) {
    const state = await sendRuntime({ type: 'getState' });
    if (!stillOpen()) return;
    if (state && state.auth && state.auth.signedIn) {
      els.accountNote.textContent = 'Sign-out did not take effect — the worker still reports a session. Try again.';
    }
  } else {
    els.accountNote.textContent = 'The background worker did not answer, so sign-out could not be confirmed.';
  }

  els.logoutBtn.disabled = false;
  els.logoutBtn.removeAttribute('aria-busy');
}

function setLoginError(message) {
  if (!stillOpen()) return;
  els.loginError.textContent = message || '';
  els.loginError.hidden = !message;
}

/** One message for a worker error envelope, without internal details. */
function errorMessageOf(result, fallback) {
  if (result && result.error && typeof result.error.message === 'string' && result.error.message) {
    return result.error.message;
  }
  return fallback;
}

/* ------------------------------------------------------------ 3 · settings -- */

function setFieldError(input, errorEl, message) {
  if (!stillOpen()) return;
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function clearFieldError(input, errorEl) {
  setFieldError(input, errorEl, '');
  setSaveFeedback('');
}

function setSaveFeedback(message) {
  if (!stillOpen()) return;
  els.saveFeedback.textContent = message || '';
  els.saveFeedback.hidden = !message;
}

/**
 * Host permission for the API URL's origin, requested only when the manifest's
 * host_permissions do not already cover it. Must be called from a user
 * gesture (the Save click) so chrome.permissions.request may prompt.
 */
function requestOriginAccess(pattern) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [pattern] }, (granted) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        if (granted) {
          resolve(true);
          return;
        }
        chrome.permissions.request({ origins: [pattern] }, (result) => {
          resolve(Boolean(result) && !chrome.runtime.lastError);
        });
      });
    } catch {
      resolve(false); // permissions API unavailable — treat as not granted
    }
  });
}

/** Validate both fields. Returns { ok, siteUrl?, apiUrl? } with messages drawn. */
function validateSettings() {
  const site = parseUrl(els.siteInput.value);
  const api = parseUrl(els.apiInput.value);

  setFieldError(els.siteInput, els.siteError, site.ok ? '' : site.message);
  setFieldError(els.apiInput, els.apiError, api.ok ? '' : api.message);

  if (!site.ok || !api.ok) return { ok: false };
  return { ok: true, siteUrl: site.value, apiUrl: api.value };
}

async function handleSave(event) {
  event.preventDefault();
  setSaveFeedback('');
  els.saveBtn.disabled = true;
  els.saveBtn.setAttribute('aria-busy', 'true');

  const values = validateSettings();
  if (!values.ok) {
    els.saveBtn.disabled = false;
    els.saveBtn.removeAttribute('aria-busy');
    return;
  }

  // The origin pattern for the address that will actually be used.
  const pattern = `${parseUrl(values.apiUrl).url.origin}/*`;
  const allowed = await requestOriginAccess(pattern);
  if (!stillOpen()) return;

  els.saveBtn.disabled = false;
  els.saveBtn.removeAttribute('aria-busy');

  if (!allowed) {
    setSaveFeedback('Not saved: this extension was not allowed to reach that API address. '
      + 'Without it the highlighter and briefings cannot talk to the server.');
    return;
  }

  try {
    await storageSet({ apiUrl: values.apiUrl, siteUrl: values.siteUrl });
  } catch (error) {
    console.error('Could not save settings:', error && error.message);
    setSaveFeedback('Settings could not be saved to chrome.storage. Nothing was changed.');
    return;
  }

  setSaveFeedback('Settings saved.');

  // Re-probe with the address that will actually be used from now on.
  const outcome = await checkConnection(values.apiUrl);
  if (!stillOpen()) return;
  if (outcome.authMode) {
    authMode = outcome.authMode;
    renderAccount();
  }
}

async function handleToggleChange() {
  setSaveFeedback('');
  try {
    await storageSet({ enabled: els.toggle.checked });
    setSaveFeedback(els.toggle.checked ? 'Highlighting is on.' : 'Highlighting is off.');
  } catch (error) {
    console.error('Could not save the highlight setting:', error && error.message);
    setSaveFeedback('Highlighting could not be saved to chrome.storage. Nothing was changed.');
  }
}

async function handleReset() {
  setSaveFeedback('');
  try {
    await storageSet({ ...DEFAULTS });
  } catch (error) {
    console.error('Could not reset settings:', error && error.message);
    setSaveFeedback('Defaults could not be restored. Nothing was changed.');
    return;
  }
  els.toggle.checked = DEFAULTS.enabled;
  els.apiInput.value = DEFAULTS.apiUrl;
  els.siteInput.value = DEFAULTS.siteUrl;
  clearFieldError(els.apiInput, els.apiError);
  clearFieldError(els.siteInput, els.siteError);
  setSaveFeedback('Defaults restored.');
  await checkConnection(DEFAULTS.apiUrl);
}

/* ------------------------------------------------------------ open the app -- */

async function handleOpenApp() {
  els.openBtn.disabled = true;
  els.openBtn.setAttribute('aria-busy', 'true');
  setOpenFeedback('');

  const result = await sendRuntime({ type: 'openSite' });

  els.openBtn.disabled = false;
  els.openBtn.removeAttribute('aria-busy');
  if (!stillOpen()) return;

  if (result && result.ok === true) {
    setOpenFeedback('Opening Socius AI in a new tab…');
    window.close(); // the popup's job is done
    return;
  }
  setOpenFeedback(errorMessageOf(result, 'Socius AI could not be opened. Check the site URL and try again.'));
}

function setOpenFeedback(message) {
  if (!stillOpen()) return;
  els.openFeedback.textContent = message || '';
  els.openFeedback.hidden = !message;
}

/* --------------------------------------------------------- cross-context -- */

/**
 * Another context changed settings (a second popup, or chrome.storage.sync
 * arriving from the user's other devices), or the worker cleared the session
 * from the briefing panel. Re-read rather than trusting a stale form.
 */
function handleStorageChange(changes, area) {
  if (popupClosed) return;

  if (area === 'local' && changes.session) {
    refreshAccount();
    return;
  }
  if (area !== 'sync') return;

  let changed = false;
  for (const key of ['enabled', 'apiUrl', 'siteUrl']) {
    if (changes[key]) changed = true;
  }
  if (!changed) return;

  if (changes.enabled && typeof changes.enabled.newValue === 'boolean') {
    els.toggle.checked = changes.enabled.newValue;
  }
  if (changes.apiUrl && isStoredUrl(changes.apiUrl.newValue)) {
    els.apiInput.value = changes.apiUrl.newValue;
  }
  if (changes.siteUrl && isStoredUrl(changes.siteUrl.newValue)) {
    els.siteInput.value = changes.siteUrl.newValue;
  }
  setSaveFeedback('Settings changed in another window — the form now shows the saved values.');
}

/* ------------------------------------------------------------------- init -- */

async function init() {
  cacheElements();

  els.toggle.addEventListener('change', handleToggleChange);
  els.settingsForm.addEventListener('submit', handleSave);
  els.resetBtn.addEventListener('click', handleReset);
  els.statusRetry.addEventListener('click', async () => {
    const settings = await loadSettings();
    const outcome = await checkConnection(settings.apiUrl);
    if (outcome.authMode) {
      authMode = outcome.authMode;
      renderAccount();
    }
  });
  els.openBtn.addEventListener('click', handleOpenApp);
  els.loginForm.addEventListener('submit', handleLoginSubmit);
  els.logoutBtn.addEventListener('click', handleLogout);

  // A field error disappears the moment the student starts fixing it.
  els.siteInput.addEventListener('input', () => clearFieldError(els.siteInput, els.siteError));
  els.apiInput.addEventListener('input', () => clearFieldError(els.apiInput, els.apiError));
  els.loginEmail.addEventListener('input', () => setLoginError(''));
  els.loginPassword.addEventListener('input', () => setLoginError(''));

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(handleStorageChange);
  }

  // 1 · settings, so the form never shows a value that is not stored.
  const settings = await loadSettings();
  if (!stillOpen()) return;
  els.toggle.checked = settings.enabled;
  els.apiInput.value = settings.apiUrl;
  els.siteInput.value = settings.siteUrl;

  // 2 · who is signed in (the worker owns the session).
  await refreshAccount();
  if (!stillOpen()) return;

  // 3 · is the app reachable, and does that server have accounts?
  const outcome = await checkConnection(settings.apiUrl);
  if (!stillOpen()) return;
  if (outcome.authMode) {
    authMode = outcome.authMode;
    renderAccount();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
