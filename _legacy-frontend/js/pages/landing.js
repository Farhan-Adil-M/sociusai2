// Landing page behaviour: renders the pixel-art feature icons and plays the
// single hero animation (a tutor question being typed, answered, cited).
// The page is complete without this script — the animation only hides content
// it is about to reveal, and is skipped when reduced motion is requested.

const PALETTE = { i: '#0E1024', w: '#FFFFFF', p: '#FF3E9A', b: '#2544E8' };

// Pixel art is written as ASCII grids: one character per pixel, '.' = empty.
const SPRITES = {
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

/** Turn an ASCII grid into a crisp-edged SVG (horizontal runs become rects). */
function spriteSvg(name) {
  const grid = SPRITES[name];
  if (!grid) return '';
  const rects = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x];
      if (char === '.') { x += 1; continue; }
      let run = 1;
      while (x + run < row.length && row[x + run] === char) run += 1;
      rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${PALETTE[char] || PALETTE.i}"/>`);
      x += run;
    }
  });
  return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

function renderSprites() {
  document.querySelectorAll('[data-sprite]').forEach((node) => {
    node.innerHTML = spriteSvg(node.dataset.sprite);
  });
}

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One orchestrated reveal: type the question, then the answer, then citations. */
function playHeroSequence() {
  const windowEl = document.querySelector('[data-window]');
  if (!windowEl || prefersReducedMotion()) return;

  const question = windowEl.querySelector('[data-type="question"]');
  const caret = windowEl.querySelector('[data-caret]');
  const answer = windowEl.querySelector('[data-answer]');
  const cites = [...windowEl.querySelectorAll('[data-cites] li')];
  if (!question || !answer) return;

  const text = question.textContent;
  question.textContent = '';
  answer.classList.remove('is-shown');
  windowEl.classList.add('is-animating');
  if (caret) caret.hidden = false;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  (async () => {
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
    windowEl.classList.remove('is-animating');
  })();
}

renderSprites();
playHeroSequence();
