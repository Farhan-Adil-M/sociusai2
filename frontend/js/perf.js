// =============================================================================
// js/perf.js — the one performance report for Socius AI.
//
// WHAT IT DOES
// ------------
// Measures how long the page actually took to become usable, using the
// browser's own PerformanceObserver — the same numbers the Chrome UX Report
// and Lighthouse report — and keeps them on one object:
//
//     window.sociusPerf.report()      // → { vitals: { ttfb, fcp, lcp, cls, … } }
//
// Each metric is announced as it is finalised, for anyone who wants a live
// feed:
//
//     import { perf } from './js/perf.js';
//     const stop = perf.subscribe((name, value) => console.log(name, value));
//
// THE METRICS THAT MATTER
// -----------------------
//   LCP  Largest Contentful Paint — when the main content is actually drawn.
//        This is the "did it feel fast" number.
//   INP  Interaction to Next Paint — how long the page takes to respond to a
//        click or a key press. It replaces the retired FID.
//   CLS  Cumulative Layout Shift — how much content jumped around while
//        loading. It keeps growing as long as the visitor stays on the page,
//        so the value is snapshotted when the page is hidden.
//   TTFB Time To First Byte — when the server answered at all. A large number
//        here is a server problem, not a CSS problem.
//
// HOW TO TURN IT ON FOR A PAGE
// ----------------------------
//     <script type="module" src="js/perf.js"></script>
//
// after that page's own module script, so the app paints first and this runs
// while it is already visible. Left alone it changes nothing the visitor can
// see and prints nothing.
//
// Add ?perf=1 to a URL (or set localStorage.socius_perf = '1') to print a line
// per metric in the console. There is deliberately no network reporting: no
// analytics endpoint exists, and inventing one would post visitor timings
// somewhere nobody agreed to.
//
// SAFETY RULES THIS FILE FOLLOWS
// ------------------------------
//   1. It never throws. A browser without PerformanceObserver, or without a
//      given entry type, gets an empty report instead of an error, so this is
//      safe to include on every page — including the landing page and login.
//   2. It runs once per page however many times it is loaded: the state lives
//      under a Symbol on globalThis, and a second load re-uses it instead of
//      attaching a second set of observers.
//   3. It sends nothing anywhere. It reads timings and writes one object.
// =============================================================================

/* --------------------------------------------------------------- plumbing */

const SLOT = Symbol.for('socius.perf.report');

/** A finite number rounded to hundredths, or null when the value is missing. */
function metric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** Does this browser know the entry type? Missing API means "maybe", so we try. */
function supportsEntryType(type) {
  try {
    const supported = PerformanceObserver.supportedEntryTypes;
    return Array.isArray(supported) ? supported.includes(type) : true;
  } catch {
    return false;
  }
}

/**
 * Watch one PerformanceObserver entry type. `buffered: true` matters: a page
 * that loads this script late still receives entries that already happened.
 * Any failure is a silent no-op — a missing metric is never an error.
 */
function watch(state, type, onEntry) {
  if (typeof PerformanceObserver === 'undefined') return;
  if (!supportsEntryType(type)) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onEntry(entry);
    });
    observer.observe({ type, buffered: true });
    state.watchers.push(observer);
  } catch {
    // Unsupported entry type, or the observer was refused: skip it.
  }
}

/** Read a Navigation Timing value once, and again on `load` if it was 0. */
function fromNavigation(name) {
  try {
    const entries = performance.getEntriesByType('navigation');
    return entries.length > 0 ? entries[0][name] : null;
  } catch {
    return null;
  }
}

/** Debug output is opt-in, so a production page stays silent. */
function debugEnabled() {
  try {
    if (new URLSearchParams(location.search).get('perf') !== null) return true;
    return localStorage.getItem('socius_perf') === '1';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ the collector */

function collect() {
  const state = {
    vitals: {},       // name → number, filled as each metric changes
    longTasks: { count: 0, total: 0, worst: 0 },
    resources: { count: 0, scriptBytes: 0, styleBytes: 0, slowest: [] },
    listeners: new Set(),
    watchers: [],
    startedAt: Date.now(),
  };

  /** Record a metric value and tell anyone who asked. Values may grow. */
  function settle(name, value) {
    const rounded = metric(value);
    if (rounded === null || rounded < 0) return;
    if (rounded === state.vitals[name]) return; // unchanged: nothing to report
    state.vitals[name] = rounded;
    announce(name);
  }

  function announce(name, value = state.vitals[name]) {
    if (state.listeners.size === 0 && !debugEnabled()) return;
    const detail = { name, value };
    for (const listener of [...state.listeners]) {
      try {
        listener(detail);
      } catch (listenerError) {
        // A broken subscriber is the author's bug, not the page's: say so,
        // drop that one listener, and keep collecting.
        console.error('[perf] a subscriber threw and was removed:', listenerError);
        state.listeners.delete(listener);
      }
    }
    if (debugEnabled()) {
      console.debug(`[perf] ${name}:`, typeof value === 'object' ? JSON.stringify(value) : value);
    }
  }

  /* ------------------------------------------------------- navigation timings */

  // TTFB, DOMContentLoaded and load are read as soon as this file runs and
  // again on `load`, because a script that runs before the Navigation Timing
  // entry is populated would otherwise report nothing.
  function readNavigation() {
    settle('ttfb', fromNavigation('responseStart'));
    settle('domContentLoaded', fromNavigation('domContentLoadedEventEnd'));
    settle('load', fromNavigation('loadEventEnd'));
  }

  readNavigation();
  if (document.readyState !== 'complete') {
    window.addEventListener('load', readNavigation, { once: true });
  }

  /* --------------------------------------------------- the observer metrics */

  watch(state, 'paint', (entry) => {
    if (entry.name === 'first-contentful-paint') settle('fcp', entry.startTime);
  });

  watch(state, 'largest-contentful-paint', (entry) => {
    // Best-effort: the element is only readable on the same task, so this may
    // be missing on a buffered entry. It is diagnostic, never a metric.
    try {
      const tag = entry.element && entry.element.tagName ? entry.element.tagName.toLowerCase() : null;
      if (tag) state.vitals.lcpElement = tag;
    } catch {
      // Nothing to read, nothing lost.
    }
    settle('lcp', entry.startTime);
  });

  watch(state, 'layout-shift', (entry) => {
    // Layout the visitor caused by typing or tapping is not the page's fault,
    // so the browser marks it and the metric ignores it.
    if (entry.hadRecentInput) return;
    settle('cls', (state.vitals.cls ?? 0) + entry.value);
  });

  watch(state, 'event', (entry) => {
    // INP is the worst interaction of the visit. `duration` is the processing
    // time the browser measured; a true next-frame latency needs the Long
    // Animation Frame API, which fewer browsers ship, so this is the
    // approximation the main libraries also use today.
    if (typeof entry.interactionId !== 'number' || entry.duration <= 0) return;
    if (entry.duration > (state.vitals.inp ?? -1)) {
      try {
        const target = entry.target;
        const tag = target && target.tagName ? target.tagName.toLowerCase() : null;
        if (tag) state.vitals.inpTarget = tag;
      } catch {
        // The node may be detached by now; the number is what matters.
      }
      settle('inp', entry.duration);
    }
  });

  watch(state, 'longtask', (entry) => {
    state.longTasks.count += 1;
    state.longTasks.total += entry.duration;
    state.longTasks.worst = Math.max(state.longTasks.worst, entry.duration);
  });

  watch(state, 'resource', (entry) => {
    state.resources.count += 1;
    // Encoded body size is the number that reaches the visitor; transferSize
    // includes headers and is not reported everywhere.
    const bytes = entry.encodedBodySize || entry.transferSize || 0;
    const type = entry.initiatorType;
    if (type === 'script') state.resources.scriptBytes += bytes;
    if (type === 'link' || type === 'css') state.resources.styleBytes += bytes;

    // Keep only the slowest few, so a page with hundreds of requests does not
    // turn the report into a list nobody reads.
    state.resources.slowest.push({ name: entry.name, duration: metric(entry.duration) ?? 0 });
    state.resources.slowest.sort((a, b) => b.duration - a.duration);
    state.resources.slowest.length = Math.min(state.resources.slowest.length, 8);
  });

  /* --------------------------------------------------------------- snapshots */

  // LCP, CLS and INP keep growing while the page is open. Chrome reports the
  // value at the moment the page is hidden, and so does this: otherwise a long
  // reading session would be measured as a slow page.
  let snapshotted = false;
  function snapshot() {
    if (snapshotted || document.visibilityState !== 'hidden') return;
    snapshotted = true;
    announce('snapshot', report());
  }
  document.addEventListener('visibilitychange', snapshot, { passive: true });
  window.addEventListener('pagehide', snapshot, { once: true });

  /* ------------------------------------------------------------- public face */

  function report() {
    const connection = navigator.connection || {};
    const slowest = state.resources.slowest
      .slice()
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5);

    return {
      vitals: { ...state.vitals },
      longTasks: { ...state.longTasks },
      resources: {
        count: state.resources.count,
        scriptBytes: state.resources.scriptBytes,
        styleBytes: state.resources.styleBytes,
        slowest,
      },
      device: {
        cores: navigator.hardwareConcurrency ?? null,
        memoryGb: metric(navigator.deviceMemory),
        connection: connection.effectiveType ?? null,
        saveData: connection.saveData === true,
        online: navigator.onLine !== false,
      },
      page: {
        url: location.href,
        hidden: document.visibilityState === 'hidden',
        controlledByServiceWorker: 'serviceWorker' in navigator && !!navigator.serviceWorker.controller,
        startedAt: state.startedAt,
      },
    };
  }

  const perf = {
    /** Current measurements. Never throws; returns null before any metric. */
    report,
    /**
     * Subscribe to metrics as they finish: listener({ name, value }).
     * Receives everything already known immediately, and returns unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      state.listeners.add(listener);
      for (const name of Object.keys(state.vitals)) {
        try {
          listener({ name, value: state.vitals[name] });
        } catch (listenerError) {
          console.error('[perf] a subscriber threw on subscribe:', listenerError);
        }
      }
      return () => state.listeners.delete(listener);
    },
    /** Stop every observer. Safe to call twice; mostly useful in tests. */
    stop() {
      for (const watcher of state.watchers) {
        try {
          watcher.disconnect();
        } catch {
          // Already disconnected.
        }
      }
      state.watchers.length = 0;
    },
  };

  return perf;
}

/* ------------------------------------------------------------------- exports */

// One instance per page, however often this file is loaded. A duplicate
// <script> tag, or a page that also imports the module, re-uses this state
// instead of measuring the same page twice.
function sharedPerf() {
  try {
    if (!globalThis[SLOT]) globalThis[SLOT] = collect();
    return globalThis[SLOT];
  } catch (error) {
    // A browser that cannot even do the fallback gets a report-less stub: the
    // page must never break because of a measurement.
    console.warn('[perf] could not start performance collection:', error);
    return { report: () => null, subscribe: () => () => {}, stop: () => {} };
  }
}

export const perf = sharedPerf();

// Convenient on every page without an import, and harmless in a browser that
// rejects writes to window (it is wrapped, so it cannot throw).
try {
  window.sociusPerf = perf;
} catch {
  // Read-only window: the export above is still the interface.
}
