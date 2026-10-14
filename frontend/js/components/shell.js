// =============================================================================
// components/shell.js — the ONE application shell for every interior page.
//
// There are nine interior pages (dashboard, library, study, quiz, progress,
// planner, session, flashcards, profile). Each of their HTML files contains:
//
//     <div id="app-shell"></div>
//     <main>…that page's own content…</main>
//
// and each page script starts with:
//
//     await mountShell({ page: 'dashboard' });
//
// mountShell() renders the sidebar, the navigation, the topbar and the service
// health pill into #app-shell, moves the page's <main> into the content column,
// wires the mobile drawer, and returns. The navigation markup exists exactly
// once — here — so it can never drift between pages.
//
// Dependencies: ../api.js (the only fetch caller — mock-mode health, mock
// detection, the demo badge text), ../auth.js (sign-in gate, signed-in name,
// cached health snapshot, sign-out) and ../ui.js (icons, escaping). Styling
// lives in frontend/css/shell.css, owned by another agent; this file only
// creates the class names listed in docs/HANDOFF.md.
// =============================================================================

import { MOCK_BADGE_TEXT, apiGet, isMockMode } from '../api.js';
import { getHealthStatus, getUserName, requireSignIn, signOut } from '../auth.js';
import { escapeHtml, icon } from '../ui.js';

/* --------------------------------------------------------------- navigation */

// The one and only navigation list, in the agreed order. `key` is what a page
// passes to mountShell({ page: '…' }) to mark itself active.
const NAV_ITEMS = [
  { key: 'dashboard', href: 'dashboard.html', label: 'Overview', icon: 'overview' },
  { key: 'library', href: 'library.html', label: 'My Materials', icon: 'folder' },
  { key: 'study', href: 'study.html', label: 'AI Tutor', icon: 'message' },
  { key: 'quiz', href: 'quiz.html', label: 'Assessments', icon: 'clipboard' },
  { key: 'progress', href: 'progress.html', label: 'Learning Progress', icon: 'trend' },
  // The study-history feed (js/pages/activity.js). Companion to Progress:
  // progress shows current mastery, activity shows what happened and when.
  { key: 'activity', href: 'activity.html', label: 'Activity', icon: 'clock' },
  { key: 'planner', href: 'planner.html', label: 'Study Planner', icon: 'calendar' },
  { key: 'session', href: 'session.html', label: 'Study Sessions', icon: 'clock' },
  { key: 'flashcards', href: 'flashcards.html', label: 'Flashcards', icon: 'cards' },
  { key: 'profile', href: 'profile.html', label: 'Profile', icon: 'person' },
];

// Below this width shell.css turns the sidebar into an off-canvas drawer and
// shows the hamburger. Kept here so the drawer can close itself when the
// viewport grows past it (a phone turning to landscape, a desktop resize).
const DRAWER_MEDIA = '(min-width: 900px)';

const BRAND_MARK = `
  <svg class="brand__mark" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false" fill="currentColor">
    <path d="M12 3 1.5 8.2 12 13.4l8.2-4.1v5.5h1.8V8.2L12 3Z"/>
    <path d="M5 11.6v4.2c0 1.8 3.1 3.2 7 3.2s7-1.4 7-3.2v-4.2l-7 3.5-7-3.5Z"/>
  </svg>`;

// The three dependencies behind GET /api/health (docs/API_CONTRACT.md), with
// the words a student would use for them.
const HEALTH_CHECKS = {
  sqlite: 'Database (sqlite)',
  chroma: 'Vector store (chroma)',
  nim: 'AI provider (nim)',
};

/* -------------------------------------------------------------- small parts */

/** Which nav item is this page? Accepts the key or the visible label. */
function activeKey(page) {
  const wanted = String(page ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const byKey = NAV_ITEMS.find((item) => item.key === wanted);
  if (byKey) return byKey.key;
  const byLabel = NAV_ITEMS.find((item) => item.label.toLowerCase() === wanted);
  return byLabel ? byLabel.key : null;
}

function navItem(item, active) {
  const isActive = item.key === active;
  return `<a class="nav-item${isActive ? ' is-active' : ''}" href="${item.href}"`
    + `${isActive ? ' aria-current="page"' : ''}>`
    + `${icon(item.icon, { size: 18 })}<span class="nav-item__label">${escapeHtml(item.label)}</span></a>`;
}

/** Account corner: who is signed in, or a link to sign in; plus sign-out. */
function accountHtml(user) {
  const name = typeof user === 'string' ? user.trim() : '';
  if (!name) {
    return `<a class="account account--signed-out" href="login.html">`
      + `${icon('person', { size: 16 })}<span class="account__name">Sign in</span></a>`;
  }
  const initial = escapeHtml(name.charAt(0).toUpperCase() || 'S');
  return `<span class="account" title="Signed in as ${escapeHtml(name)}">`
    + `<span class="avatar avatar-sm" aria-hidden="true">${initial}</span>`
    + `<span class="account__name">${escapeHtml(name)}</span></span>`
    + '<button type="button" class="btn btn-ghost btn-sm account__signout" data-sign-out>'
    + `${icon('logout', { size: 16 })}<span>Sign out</span></button>`;
}

// components.css owns `.status-dot` (green by default) and its modifiers.
const DOT_CLASS = { pending: ' is-idle', ok: '', degraded: ' is-warn', down: ' is-down' };

/** The pill starts in "checking" state; renderStatus() fills it in. */
function statusPillHtml() {
  return '<div class="status-pill" data-status-pill data-state="pending" role="status"'
    + ' aria-live="polite" title="Checking the app\u2019s services\u2026">'
    + '<span class="status-dot is-idle" aria-hidden="true"></span>'
    + '<span class="status-pill__label">Checking services\u2026</span></div>';
}

function shellHtml({ active, section, user, mock, mainId }) {
  const demoBadge = mock
    ? `<span class="badge badge-warn demo-badge" title="This page is showing canned fixture data, not live AI output.">${escapeHtml(MOCK_BADGE_TEXT)}</span>`
    : '';
  return `
  <a class="skip-link" href="#${mainId}">Skip to content</a>

  <aside class="sidebar" id="app-sidebar" data-sidebar>
    <div class="sidebar__brand">
      <a class="brand" href="dashboard.html" aria-label="Socius AI \u2014 go to the overview">
        ${BRAND_MARK}<span class="brand__name">Socius AI</span>
      </a>
    </div>
    <nav class="nav" aria-label="Main">
      ${NAV_ITEMS.map((item) => navItem(item, active)).join('\n      ')}
    </nav>
    <div class="sidebar__footer">
      ${demoBadge}
      <div class="sidebar__account">${accountHtml(user)}</div>
    </div>
  </aside>

  <div class="app-shell__content" data-content>
    <header class="topbar">
      <div class="topbar__inner">
        <button type="button" class="nav-toggle" data-nav-toggle
                aria-expanded="false" aria-controls="app-sidebar" aria-label="Open navigation">
          ${icon('menu', { size: 20 })}
        </button>
        <span class="topbar__section">${escapeHtml(section)}</span>
        ${statusPillHtml()}
      </div>
    </header>
  </div>

  <div class="scrim" data-scrim hidden></div>`;
}

/**
 * Hand the page's own <main> over to the shell. It is moved out of the way
 * (it may currently sit inside #app-shell, or beside it) and put back inside
 * the content column once the shell markup exists. If the page has no <main>,
 * an empty one is created so every page has the same content anchor.
 */
function adoptMain() {
  const existing = document.querySelector('main');
  const main = existing || document.createElement('main');
  main.classList.add('app-main');
  if (!/^[A-Za-z][\w-]*$/.test(main.id || '')) main.id = 'main';
  main.setAttribute('tabindex', '-1'); // lets the skip link move focus into it
  if (existing) existing.remove();
  return main;
}

/* ------------------------------------------------------------------ drawer */

/**
 * Mobile menu. shell.css does the sliding; this only toggles `.is-open` on the
 * sidebar plus `hidden` on the scrim, keeps the hamburger's aria state honest,
 * and manages keyboard behaviour: Escape closes, and Tab is trapped inside the
 * drawer while it is open.
 */
function wireDrawer(root) {
  const sidebar = root.querySelector('[data-sidebar]');
  const toggle = root.querySelector('[data-nav-toggle]');
  const scrim = root.querySelector('[data-scrim]');
  if (!sidebar || !toggle) return;

  const isOpen = () => sidebar.classList.contains('is-open');
  const focusables = () => sidebar.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');

  const setToggle = (open) => {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    toggle.innerHTML = icon(open ? 'close' : 'menu', { size: 20 });
  };

  // Escape always closes; Tab cycles within the drawer instead of escaping it.
  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!sidebar.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  function open() {
    sidebar.classList.add('is-open');
    root.classList.add('nav-open');
    if (scrim) scrim.hidden = false;
    setToggle(true);
    document.addEventListener('keydown', onKeydown, true);
    // Land on the first destination, not the brand: a keyboard visitor opening
    // the drawer wants the menu, so the focus ring marks "Overview".
    const target = sidebar.querySelector('.nav-item') || focusables()[0];
    if (target) target.focus();
  }

  function close({ restoreFocus = true } = {}) {
    sidebar.classList.remove('is-open');
    root.classList.remove('nav-open');
    if (scrim) scrim.hidden = true;
    setToggle(false);
    document.removeEventListener('keydown', onKeydown, true);
    if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  if (scrim) scrim.addEventListener('click', () => close());

  // A tapped link navigates away; close the drawer so it is not still open on
  // the way back (pages are plain HTML, so the browser does a real load).
  sidebar.addEventListener('click', (event) => {
    if (isOpen() && event.target.closest('a[href]')) close({ restoreFocus: false });
  });

  const wide = window.matchMedia(DRAWER_MEDIA);
  wide.addEventListener('change', (event) => {
    if (event.matches && isOpen()) close({ restoreFocus: false });
  });
}

function wireSignOut(root) {
  root.querySelectorAll('[data-sign-out]').forEach((button) => {
    button.addEventListener('click', () => {
      // auth.signOut() clears the session and routes back to login.html.
      signOut();
    });
  });
}

/* --------------------------------------------------------- service worker */

// frontend/sw.js (owned by another agent) handles notifications only: it never
// intercepts a fetch. Registering it is a progressive enhancement — a missing
// file or an unsupported browser must never block the page.
let serviceWorkerRequested = false;

function registerServiceWorker() {
  if (serviceWorkerRequested) return;
  if (!('serviceWorker' in navigator)) return;
  const { protocol } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return;
  serviceWorkerRequested = true;
  try {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // No worker, or the scope is not allowed — study reminders stay off.
    });
  } catch {
    // Never let registration break the shell.
  }
}

/* ------------------------------------------------------------------ health */

function checkState(checks, key) {
  const check = checks ? checks[key] : null;
  if (!check || typeof check !== 'object') return 'unknown';
  return check.ok === false ? 'unavailable' : 'available';
}

/**
 * Paint the status pill from a GET /api/health payload
 * ({ status, checks: { sqlite, chroma, nim } }). The three dependency states
 * are always readable — visually through the pill's state and tooltip, and for
 * screen readers through the hidden list inside it.
 */
function paintStatusPill(pill, health, failure) {
  const checks = (health && health.checks) || {};
  const entries = Object.entries(HEALTH_CHECKS)
    .map(([key, label]) => `${label}: ${checkState(checks, key)}`);
  const detail = entries.join(' \u00b7 ');

  let state = 'ok';
  let label = 'All systems normal';
  let note = 'Database, vector store and AI provider are all reachable.';

  if (failure) {
    state = 'down';
    label = 'Server offline';
    note = failure.message
      ? String(failure.message)
      : 'The Socius AI server could not be reached.';
  } else if (!health || health.status !== 'ok') {
    state = 'degraded';
    label = 'Degraded';
    note = 'Some features are unavailable.';
  }

  pill.dataset.state = state;
  pill.title = `${note} (${detail})`;
  pill.innerHTML = `<span class="status-dot${DOT_CLASS[state]}" aria-hidden="true"></span>`
    + `<span class="status-pill__label">${escapeHtml(label)}</span>`
    + `<ul class="status-pill__checks sr-only">${entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`;
}

/**
 * One health read per page load, as the contract asks — and no second one.
 *
 * Real mode: auth.js already fetched /api/health during its one-time boot
 * (that is how it discovers the auth mode) and cached the result, so reuse
 * that snapshot. The endpoint probes the AI provider, so a duplicate call
 * would cost a second round trip for information we already hold.
 *
 * Mock mode: auth.js deliberately keeps its "no server" snapshot there, so the
 * fixtures are the only honest source and apiGet answers from them.
 * Failures are shown, never thrown.
 */
async function renderStatus(root) {
  const pill = root.querySelector('[data-status-pill]');
  if (!pill) return;

  let health = null;
  let failure = null;
  try {
    if (isMockMode()) {
      health = await apiGet('/api/health');
    } else {
      const snapshot = getHealthStatus();
      if (snapshot && snapshot.ok) health = snapshot.data;
      else failure = (snapshot && snapshot.error) || { code: 'NETWORK_ERROR' };
    }
  } catch (error) {
    failure = error;
  }
  paintStatusPill(pill, health, failure);
}

/* ------------------------------------------------------------------- mount */

/**
 * Mount the application shell. Call once, from the page script:
 *
 *     import { mountShell } from './components/shell.js';
 *     await mountShell({ page: 'library' });
 *
 * `page` is the nav key (dashboard, library, study, quiz, progress, planner,
 * session, flashcards, profile). Resolves once the shell — navigation,
 * topbar, health pill — is on screen and interactive.
 */
export async function mountShell(options) {
  const page = typeof options === 'string' ? options : options && options.page;

  const host = document.getElementById('app-shell');
  if (!host) {
    console.error('[shell] This page has no <div id="app-shell"></div> — the shell cannot mount.');
    return;
  }

  // Private pages: in supabase mode a visitor without a session is sent to
  // login.html and this resolves false, so nothing else runs.
  if (!(await requireSignIn())) return;

  const main = adoptMain();
  const active = activeKey(page);
  const activeItem = NAV_ITEMS.find((item) => item.key === active);
  const section = activeItem ? activeItem.label : 'Socius AI';

  host.classList.add('app-shell');
  host.innerHTML = shellHtml({
    active,
    section,
    user: getUserName(), // boots are finished by now: requireSignIn awaited authReady
    mock: isMockMode(),
    mainId: main.id,
  });

  // The page's <main> becomes the content column's second child, under the topbar.
  const contentSlot = host.querySelector('[data-content]');
  if (contentSlot) contentSlot.appendChild(main);

  wireDrawer(host);
  wireSignOut(host);
  registerServiceWorker();
  await renderStatus(host);
}
