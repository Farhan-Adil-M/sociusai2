// =============================================================================
// pages/landing.js — presentation for the public landing page.
//
// One job: make the page look alive. It renders the pixel-art sprites and plays
// the single hero reveal (a question being typed into the tutor, then the answer
// and its citations). It holds no application state and fetches nothing itself.
//
// Everything here is progressive enhancement. The page is complete with
// JavaScript off: the hero's question, answer and citations are in the HTML, so
// the body copy only hides content inside elements that landing.js is about to
// reveal, and it never leaves them hidden (a watchdog clears the animation class
// if anything throws).
//
// The one exception is the deferred auth check at the bottom: auth.js is
// imported so that the browser extension's `#socius_session` handoff is consumed
// on this page too (see docs/HANDOFF.md, A03), and so the primary button can say
// "Open the app" to someone who is already signed in.
// =============================================================================

import { authReady, currentUser } from '../auth.js';

/* ------------------------------------------------------------ pixel sprites */

// Pixel art is written as ASCII grids: one character per pixel, '.' = empty.
// The letters are palette slots, resolved to tokens.css values below — this file
// is the only place a colour is named, and it never names one that is not a
// --pixel-* token.
const PALETTE = {
  i: 'var(--pixel-ink)',
  w: 'var(--pixel-white)',
  p: 'var(--pixel-pink)',
  b: 'var(--pixel-blue)',
};

const SPRITES = {
  // The wordmark's mark: a page block with a pink spine.
  book: [
    '................',
    '................',
    '..iiiiiiiiiiii..',
    '..ib..........b.',
    '..ib.iiiiiiii.b.',
    '..ib.iwwwwwwi.b.',
    '..ib.iwwwwwwi.b.',
    '..ib.iiiiiiii.b.',
    '..ib.iwwwwwwi.b.',
    '..ib.iwwwwwwi.b.',
    '..ib.iiiiiiii.b.',
    '..ib..........b.',
    '..iiiiiiiiiiii..',
    '................',
    '................',
    '................',
  ],
  // A document: lines of text with a pink heading.
  doc: [
    '................',
    '..iiiiiiiiiiii..',
    '..i..........i..',
    '..i.pppppppp.i..',
    '..i..........i..',
    '..i.iiiiiii..i..',
    '..i..........i..',
    '..i.iiiiiii..i..',
    '..i..........i..',
    '..i.iiiiiii..i..',
    '..i..........i..',
    '..i.iiii.....i..',
    '..i..........i..',
    '..iiiiiiiiiiii..',
    '................',
    '................',
  ],
  // A quiz: a page with a question mark pencilled in.
  quiz: [
    '................',
    '....iiiiii......',
    '...i.iiii.i.....',
    '..iiiiiiiiii....',
    '..i........i....',
    '..i.ii..ii.i....',
    '..i...ii....i...',
    '..i.ii...ii.i...',
    '..i..ii.ii..i...',
    '..i........i....',
    '..i........i....',
    '..iiiiiiiiii....',
    '................',
    '................',
    '................',
    '................',
  ],
  // Flashcards: two stacked cards, one pink, one blue.
  cards: [
    '................',
    '....iiiiiiiiii..',
    '....i........i..',
    '....i.bbbbb..i..',
    '....i........i..',
    '..iiiiiiiiii....',
    '..i.............',
    '..i.iiiiiiiiii..',
    '..i.i........i..',
    '..i.i.pppppp.i..',
    '..i.i........i..',
    '..i.i.iiii...i..',
    '..i.i........i..',
    '..iiiiiiiiiiii..',
    '................',
    '................',
  ],
  // Progress: two columns, one blue, one pink, on an ink baseline.
  chart: [
    '................',
    '................',
    '................',
    '........pppp....',
    '........pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    '..bbbb..pppp....',
    'iiiiiiiiiiiiiiii',
    '................',
  ],
};

/**
 * Turn one ASCII grid into a crisp-edged SVG: each horizontal run of equal
 * pixels becomes a single rect, so 16x16 art is a handful of shapes and stays
 * sharp at any size.
 *
 * The colour goes in an inline `style`, not a `fill` presentation attribute:
 * presentation attributes are not required to accept `var()` (Chrome ignores it
 * and paints black), while an inline style does resolve it. The value is a
 * `--pixel-*` token name from the fixed map above — never a raw hex — so the
 * palette stays in tokens.css.
 */
function spriteSvg(name) {
  const grid = SPRITES[name];
  if (!grid) return '';

  const rects = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x];
      if (char === '.') {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < row.length && row[x + run] === char) run += 1;
      const colour = PALETTE[char] || PALETTE.i;
      rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" style="fill:${colour}"/>`);
      x += run;
    }
  });

  return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" focusable="false" aria-hidden="true">`
    + `${rects.join('')}</svg>`;
}

/** Fill every `[data-sprite="name"]` placeholder. Content is this file's own
 *  ASCII art, so there is nothing untrusted in the string we assign. */
function renderSprites() {
  document.querySelectorAll('[data-sprite]').forEach((node) => {
    const svg = spriteSvg(node.dataset.sprite);
    if (svg) node.innerHTML = svg;
  });
}

/* ------------------------------------------------------------ hero reveal */

const prefersReducedMotion = () =>
  Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Play the one hero animation: type the question, reveal the answer, then its
 * citations. When the visitor asks for reduced motion, nothing happens at all —
 * the HTML already shows every word.
 */
function playHeroSequence() {
  const windowEl = document.querySelector('[data-window]');
  if (!windowEl || prefersReducedMotion()) return;

  const question = windowEl.querySelector('[data-type="question"]');
  const caret = windowEl.querySelector('[data-caret]');
  const answer = windowEl.querySelector('[data-answer]');
  const cites = [...windowEl.querySelectorAll('[data-cites] li')];
  if (!question || !answer) return;

  // The rails: with `.is-animating` on the window, CSS hides what is about to be
  // revealed. Clearing the class last guarantees the content comes back even if
  // the sequence below throws.
  const finish = () => windowEl.classList.remove('is-animating');

  const text = question.textContent;
  question.textContent = '';
  windowEl.classList.add('is-animating');
  if (caret) caret.hidden = false;

  const run = async () => {
    await wait(500);
    for (const char of text) {
      question.textContent += char;
      await wait(char === ' ' ? 42 : 26);
    }
    await wait(240);
    if (caret) caret.hidden = true;
    answer.classList.add('is-shown');
    await wait(420);
    for (const cite of cites) {
      cite.classList.add('is-shown');
      await wait(160);
    }
    await wait(400);
    finish();
  };

  // Watchdog: if anything interrupts the sequence, never leave the hero blank.
  window.setTimeout(finish, 9000);
  run().catch(finish);
}

/* -------------------------------------------------------------- signed-in CTA */

/**
 * If this visitor already has a session — including one handed over by the
 * browser extension through `#socius_session` — the primary button should open
 * the app instead of asking them to sign in again.
 *
 * Deferred until after the first paint: it costs one /api/health read (which
 * auth.js would make on the app pages anyway) and nothing on this page waits for
 * it. In prototype mode there is no account to open, so the page is left alone.
 */
async function upgradeCtaForSignedInUser() {
  const primary = document.querySelector('[data-primary-cta]');
  if (!primary) return;

  let outcome;
  try {
    outcome = await authReady();
  } catch {
    return; // never let an auth hiccup break a marketing page
  }

  if (outcome?.mode !== 'supabase' || !currentUser()) return;

  primary.href = 'dashboard.html';
  primary.textContent = 'Open the app';
}

/* ------------------------------------------------------------------ start */

renderSprites();
playHeroSequence();

// requestIdleCallback is not in every browser (Safari only gained it recently);
// a timeout of 1ms is the same "after the current paint" behaviour.
const afterPaint = window.requestIdleCallback ?? ((callback) => window.setTimeout(callback, 1));
afterPaint(upgradeCtaForSignedInUser);
