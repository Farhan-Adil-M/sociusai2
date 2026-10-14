// components/shell.js — the shared sidebar (navigation, account corner and
// system-status indicator) injected into every application page's
// `[data-shell="header"]` slot. Each page calls mountShell('dashboard')
// (or study / library / quiz / progress / planner / session / flashcards /
// profile) once, so the chrome can never drift between pages.
//
// The markup follows the redesign's sidebar (demo4.1/index.html): brand row,
// primary `.side-menu` of real anchors, and a `.sidebar-footer` carrying the
// secondary links, health status and account/sign-out. Every element is
// optional so the shell works before (and after) the HTML pages are migrated.

import { api, isMockMode } from '../api.js';
import { authReady, getHealthStatus, getUserName, signOut, requireSignIn } from '../auth.js';
import { icon, escapeHtml, errorMessage } from '../ui.js';

/* ------------------------------------------------------------------ icons */

// Solid (fill) glyphs — the redesign stylesheet renders sidebar icons with
// `fill: currentColor`, so these must be fill shapes, not stroke outlines.
// The primary six reuse the demo's own paths.
const NAV_ICONS = {
  overview: '<path d="M6 4.5h9.5L18 7v12.5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5Zm9 0V7h2.5v.5H15Zm-8 5.5h9v1.5h-9V10Zm0 3.5h9v1.5h-9v-1.5Z"/>',
  tutor: '<path d="M12 2.5a7.5 7.5 0 0 1 7.5 7.5v4.4l1.8 4.1H2.7l1.8-4.1V10A7.5 7.5 0 0 1 12 2.5Zm0 19a2.7 2.7 0 0 1-2.7-2.7h5.4A2.7 2.7 0 0 1 12 21.5Z"/>',
  assessment: '<path d="M7 3.5h10a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2Zm1.5 4h7v1.5h-7V7.5Zm0 3.5h7v1.5h-7V11Zm0 3.5h4.5v1.5H8.5V14.5Z"/>',
  progress: '<path d="M8 3.5h8a2 2 0 0 1 2 2V6h1.5A1.5 1.5 0 0 1 21 7.5v11A1.5 1.5 0 0 1 19.5 20H4.5A1.5 1.5 0 0 1 3 18.5v-11A1.5 1.5 0 0 1 4.5 6H6V5.5a2 2 0 0 1 2-2Zm2 2.5h4V5h-4v1Z"/><path d="M6.5 10.5h11v3h-11v-3Z"/>',
  planner: '<path d="M7 2.5h10a2 2 0 0 1 2 2V6l-2 1.5V4.5H9V6L7 4.5V4.5A2 2 0 0 1 9 2.5Zm-2 5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2Zm5 2.5h4v2h-4v-2Zm-1 4.5h6v2H9v-2Z"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5V6.5Z"/>',
  cards: '<rect x="3.5" y="6.5" width="12.5" height="13" rx="2"/><rect x="8.5" y="3.5" width="12" height="13" rx="2" opacity="0.55"/>',
  person: '<path d="M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm0 2a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 4.75a1.25 1.25 0 0 1 1.25 1.25V16h-2.5v-1.5a1.25 1.25 0 0 1 1.25-1.25Z"/>',
};

const BRAND_MARK_SVG = `
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <path d="M12 2.5 3.5 7l8.5 4.5L20.5 7 12 2.5Zm-7 6.4 7 3.7 7-3.7v5.3L12 17.9 5 14.2V8.9Z"/>
    <path d="M7 11.5v3.2l5 2.7 5-2.7v-3.2l-5 2.7-5-2.7Z"/>
  </svg>`;

function navIcon(name) {
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18">${NAV_ICONS[name] || NAV_ICONS.overview}</svg></span>`;
}

/* -------------------------------------------------------------- structure */

// Primary group — the redesign's sidebar order. `key` is the value pages pass
// to mountShell() to mark themselves active.
const NAV_ITEMS = [
  { key: 'dashboard', href: 'dashboard.html', label: 'Overview', icon: 'overview' },
  { key: 'library', href: 'library.html', label: 'My Materials', icon: 'folder' },
  { key: 'study', href: 'study.html', label: 'AI Tutor', icon: 'tutor' },
  { key: 'quiz', href: 'quiz.html', label: 'Assessments', icon: 'assessment' },
  { key: 'progress', href: 'progress.html', label: 'Learning Progress', icon: 'progress' },
  { key: 'planner', href: 'planner.html', label: 'Study Planner', icon: 'planner' },
];

// Secondary group — real pages that live in the sidebar footer.
const SECONDARY_ITEMS = [
  { key: 'session', href: 'session.html', label: 'Study sessions', icon: 'folder' },
  { key: 'flashcards', href: 'flashcards.html', label: 'Flashcards', icon: 'cards' },
  { key: 'profile', href: 'profile.html', label: 'Profile', icon: 'person' },
];

/**
 * Who is signed in (kept synchronous for callers; see auth.getUserName for the
 * two modes): in Supabase mode the account's name metadata or email local-part,
 * in prototype mode the name typed on the login page. '' when signed out.
 */
export function currentUser() {
  return getUserName();
}

let healthPromise = null;

/** One shared health request per page load (the contract asks for exactly one). */
export function getHealth() {
  if (!healthPromise) {
    // Mock mode answers from fixtures. Otherwise auth.boot()'s cached
    // /api/health read (config discovery) is reused — no second request.
    healthPromise = isMockMode()
      ? api.getHealth().then(
          (data) => ({ ok: true, data }),
          (error) => ({ ok: false, error }),
        )
      : authReady().then(() => getHealthStatus());
  }
  return healthPromise;
}

function menuItem(item, active) {
  const isActive = item.key === active;
  return `
    <a class="menu-item${isActive ? ' active' : ''}" href="${item.href}"${
      isActive ? ' aria-current="page"' : ''
    }>${navIcon(item.icon)}${item.label}</a>`;
}

function accountArea() {
  const name = currentUser();
  if (!name) {
    return `<a class="menu-item" href="login.html">${navIcon('person')}Sign in</a>`;
  }
  const initial = escapeHtml(name.trim().charAt(0) || 'S');
  return `
    <span class="shell-side-account account-chip" title="Signed in as ${escapeHtml(name)}">
      <span class="account-avatar" aria-hidden="true">${initial}</span>
      <span class="account-name">${escapeHtml(name)}</span>
    </span>
    <button type="button" class="menu-item sign-out-btn" data-sign-out>
      <span class="icon" aria-hidden="true">↪</span>Sign out
    </button>`;
}

function sidebarHtml(active) {
  const demo = isMockMode()
    ? '<span class="badge badge-demo shell-side-badge" title="This page is showing canned fixture data, not live AI output.">Demo data</span>'
    : '';
  return `
    <aside class="sidebar" id="appSidebar" aria-label="Socius AI">
      <div class="brand-row">
        <a class="brand-mark" href="dashboard.html" aria-label="Socius AI — go to the dashboard">${BRAND_MARK_SVG}</a>
        <a class="brand-name" href="dashboard.html">Socius AI</a>
        <button type="button" class="shell-nav-toggle" data-nav-toggle
                aria-expanded="false" aria-controls="topnav" aria-label="Open menu">
          ${icon('menu', { size: 18 })}
        </button>
      </div>

      <nav class="side-menu" id="topnav" aria-label="Main">
        ${NAV_ITEMS.map((item) => menuItem(item, active)).join('')}
      </nav>

      <div class="sidebar-footer">
        <div class="side-menu sidebar-secondary" aria-label="More">
          ${SECONDARY_ITEMS.map((item) => menuItem(item, active)).join('')}
        </div>
        ${demo}
        <span class="shell-side-status sys-status" data-sys-status>
          <span class="status-dot" aria-hidden="true"></span>
          <span class="sys-status-label">Checking services…</span>
        </span>
        <div class="shell-side-account-row" data-account>${accountArea()}</div>
      </div>
    </aside>`;
}

const FOOTER_HTML = `
  <div class="shell-footer-inner">
    <span>Socius AI — an AI study companion.</span>
    <span class="spacer"></span>
    <a href="index.html">Home</a>
    <a href="study.html">Study</a>
    <a href="quiz.html">Quiz</a>
    <a href="login.html">Account</a>
  </div>`;

/* ------------------------------------------------------- injected styles */

// A few rules the redesign stylesheet does not provide: the mobile menu
// toggle, and fallback look for the status/account rows. Scoped + small on
// purpose so redesign.css always wins where it has an opinion.
const SHELL_STYLE_ID = 'shell-redesign-fallback';

function injectShellStyles() {
  if (document.getElementById(SHELL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SHELL_STYLE_ID;
  style.textContent = `
    /* The host holds a sidebar now, not a topbar: the demo's anchors are
       buttons, so links need the underline/colour reset. */
    .sidebar a { text-decoration: none; color: inherit; }
    /* The row is viewport-tall like the demo: the sidebar stays put and the
       page content scrolls inside the main panel. */
    .app-shell[data-shell-root] { height: 100vh; }
    .app-shell[data-shell-root] > main { overflow-y: auto; min-width: 0; }
    .shell-sidebar-host { display: flex; flex: 0 0 230px; min-width: 0; }
    @media (max-width: 760px) { .shell-sidebar-host { flex: 0 0 auto; } }
    .shell-nav-toggle {
      display: none; align-items: center; justify-content: center;
      width: 34px; height: 34px; margin-left: auto; padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 6px;
      background: transparent; color: #faf7f2; cursor: pointer;
    }
    .shell-nav-toggle:hover { background: rgba(255, 255, 255, 0.06); }
    @media (max-width: 760px) {
      .shell-nav-toggle { display: inline-flex; }
      .sidebar:not(.is-open) .side-menu,
      .sidebar:not(.is-open) .shell-side-status,
      .sidebar:not(.is-open) .shell-side-account-row,
      .sidebar:not(.is-open) .shell-side-badge { display: none; }
    }
    .shell-side-badge { margin: 8px 12px 0; }
    .shell-side-status {
      display: flex; align-items: center; gap: 7px;
      padding: 8px 12px; font-size: 0.74rem; color: #aba294;
    }
    .shell-side-status .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #4fbf87; flex: 0 0 auto;
    }
    .shell-side-status .status-dot.is-warn { background: #e0a33a; }
    .shell-side-status .status-dot.is-down { background: #e5534b; }
    .shell-side-account-row { display: flex; flex-direction: column; gap: 2px; padding-top: 6px; }
    .shell-side-account {
      display: flex; align-items: center; gap: 9px; min-width: 0;
      padding: 6px 12px; color: #e9e2d6; font-size: 0.8rem;
    }
    .shell-side-account .account-avatar {
      display: grid; place-items: center; width: 26px; height: 26px;
      border-radius: 50%; background: rgba(255, 255, 255, 0.1);
      font-size: 0.8rem; font-weight: 600; flex: 0 0 auto;
    }
    .shell-side-account .account-name {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sign-out-btn .icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; font-size: 1.05rem;
    }
  `;
  document.head.appendChild(style);
}

/* --------------------------------------------------------- service worker */

// frontend/sw.js is the study-reminder worker copied from demo4.1/sw.js. It
// handles ONLY install / activate / notificationclick / message — it never
// intercepts a fetch and never writes to a cache — so registering it cannot
// change how the app loads. Register once per page load, over http(s) only.
let serviceWorkerRequested = false;

function registerStudyReminderWorker() {
  if (serviceWorkerRequested) return;
  if (!('serviceWorker' in navigator)) return;
  try {
    const { protocol } = window.location;
    if (protocol !== 'http:' && protocol !== 'https:') return;
    serviceWorkerRequested = true;
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Missing file or unsupported scope — study reminders stay off.
    });
  } catch {
    // Registration is a progressive enhancement: never block the shell on it.
  }
}

/* ------------------------------------------------------------ health, etc */

/**
 * Fill `host` with a banner when the backend reports a problem (or is
 * unreachable). Nothing is rendered when everything is healthy.
 */
export function mountHealthBanner(host) {
  if (!host) return;
  getHealth().then((health) => {
    if (!health.ok) {
      host.innerHTML = `
        <div class="banner banner-error">${icon('alert', { size: 16 })}
          <span><strong>The server is not responding.</strong> ${escapeHtml(errorMessage(health.error))} Features below will not work until it is back.</span>
        </div>`;
      return;
    }
    const { status, checks } = health.data;
    if (status === 'ok') return;
    const broken = Object.entries(checks || {})
      .filter(([, value]) => value && value.ok === false)
      .map(([key, value]) => `${key}${value.message ? `: ${value.message}` : ''}`);
    host.innerHTML = `
      <div class="banner banner-warn">${icon('alert', { size: 16 })}
        <span><strong>Running in degraded mode.</strong> Unavailable — ${escapeHtml(broken.join(', ') || 'unknown service')}. Features that rely on it will show an error.</span>
      </div>`;
  });
}

function renderStatus(root, health) {
  const wrap = root.querySelector('[data-sys-status]');
  if (!wrap) return;
  const dot = wrap.querySelector('.status-dot');
  const label = wrap.querySelector('.sys-status-label');
  if (!dot || !label) return;
  if (!health.ok) {
    dot.classList.add('is-down');
    label.textContent = 'Server offline';
    wrap.title = 'The Socius AI server could not be reached.';
    return;
  }
  const { status, checks } = health.data;
  if (status === 'ok') {
    label.textContent = 'All systems normal';
    wrap.title = 'SQLite, ChromaDB and the AI provider are all reachable.';
    return;
  }
  dot.classList.add('is-warn');
  const broken = Object.entries(checks || {})
    .filter(([, value]) => value && value.ok === false)
    .map(([key]) => key);
  label.textContent = 'Degraded';
  wrap.title = `Unavailable: ${broken.join(', ') || 'unknown'}. Features that need it will show an error.`;
}

/** Attach (re-attach) the sign-out handler after the account area re-renders. */
function wireSignOut(root) {
  root.querySelectorAll('[data-sign-out]').forEach((button) => {
    if (button.dataset.signOutWired) return; // already bound (re-entrant call)
    button.dataset.signOutWired = '1';
    // Re-rendering the account area replaces the node, so always bind fresh.
    button.addEventListener('click', () => {
      // auth.signOut clears the prototype name (and the Supabase session when
      // one exists), then both modes route back to login.html.
      signOut();
    });
  });
}

/**
 * The redesign's layout is one flex row: sidebar + content
 * (demo4.1: `.app-shell > .sidebar + .main-panel`). Pages still carry the
 * pre-redesign `<header data-shell="header">` above `<main>`, so the shell
 * host and the main content are wrapped into a single `.app-shell` row here —
 * no HTML change is needed on the pages themselves.
 */
function layoutShellRow(host) {
  if (host.closest('.app-shell')) return; // already laid out
  const main = document.querySelector('main');
  if (!main || main.parentNode !== host.parentNode) return;
  const row = document.createElement('div');
  row.className = 'app-shell';
  row.setAttribute('data-shell-root', '');
  host.parentNode.insertBefore(row, host);
  row.appendChild(host);
  row.appendChild(main);
  // The host carries the sidebar now; drop the old topbar class so its
  // stylesheet rules cannot fight the sidebar's.
  host.classList.remove('topbar');
  host.classList.add('shell-sidebar-host');
}

/** Mobile menu: same behaviour as the old topbar toggle, sidebar selectors. */function wireMobileMenu(header, sidebar) {
  const toggle = header.querySelector('[data-nav-toggle]');
  const nav = header.querySelector('#topnav');
  if (!toggle || !sidebar) return;
  toggle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    toggle.innerHTML = icon(open ? 'close' : 'menu', { size: 18 });
  });
  if (nav) {
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a') && sidebar.classList.contains('is-open')) {
        sidebar.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open menu');
        toggle.innerHTML = icon('menu', { size: 18 });
      }
    });
  }
}

/**
 * Inject the shared sidebar/footer, wire the mobile menu and sign-out, and
 * resolve the system status once for the page. `active` marks the current
 * page: 'dashboard' | 'library' | 'study' | 'quiz' | 'progress' | 'planner' |
 * 'session' | 'flashcards' | 'profile'.
 */
export async function mountShell(active) {
  // Application pages are private in supabase mode: no session → login.
  if (!isMockMode()) await requireSignIn();

  injectShellStyles();
  registerStudyReminderWorker();

  const header = document.querySelector('[data-shell="header"]');
  const footer = document.querySelector('[data-shell="footer"]');

  if (header) {
    header.innerHTML = sidebarHtml(active);
    layoutShellRow(header);
    const sidebar = header.querySelector('#appSidebar');
    wireMobileMenu(header, sidebar);
    wireSignOut(header);
    // In Supabase mode the account corner depends on the restored session,
    // which finishes after this first render — refresh it once ready.
    authReady().then(() => {
      if (!document.body.contains(header)) return;
      if (getUserName()) {
        const slot = header.querySelector('[data-account]');
        if (slot) slot.innerHTML = accountArea();
      }
      wireSignOut(header);
    });
    getHealth().then((health) => renderStatus(header, health));
  }

  if (footer) footer.innerHTML = FOOTER_HTML;
}
