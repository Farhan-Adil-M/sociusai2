# Responsive audit — Socius2

**Scope:** all 13 shipped pages — `index`, `login`, `dashboard`, `library`,
`session`, `study`, `quiz`, `flashcards`, `progress`, `planner`, `profile`,
`viewer`, `activity`.

**Standard:** no horizontal scrolling or clipped content at phone widths, and
WCAG 2.2 AA target sizing (2.5.8 Target Size Minimum).

**Method:** a real headless Chromium driven over the DevTools Protocol against
the app running isolated on its own SQLite DB. Every page was loaded at three
viewport widths — **320px**, **375px** and **1280px** — and every element was
measured from its *rendered* `getBoundingClientRect()` and `getComputedStyle()`,
not from the stylesheet, so what is reported is what a learner actually sees.

The fixes found by this audit live in `frontend/css/responsive.css`. Like
`a11y.css`, it is loaded last on every page, and like `a11y.css` every rule in
it traces to a number in this file.

---

## 1 · Result

| Check | Result |
| --- | --- |
| Pages returning HTTP 200 | **13 / 13** at every width |
| App resource failures (JS/CSS/HTML 404 or MIME mismatch) | **0** |
| Console errors across all 39 page loads | **0** |
| Elements whose content overflows its own box | **2** — both deliberate, see §4 |
| Elements escaping the viewport | **0** (see §4.1 on the sidebar false positive) |

An earlier concern, `Unsupported MIME type ('text/html')` raised when a script
request was answered with the SPA shell, is **confirmed gone**: the service
worker added in Wave 5 routes asset requests correctly, and no page produced
that error in any of the 39 loads.

---

## 2 · The one real defect: a flex row of prose

`.fv-keys` is the keyboard-hint line in the document viewer:

```html
<p class="help fv-keys">[icon] Keyboard: ← → move between sections, Home first, End last.</p>
```

`viewer.css` laid it out as `display: flex; align-items: center`. `flex-wrap`
defaults to `nowrap`, so each text run and each `<span class="kbd">` became an
independent flex item that could not move to a new line. Below ~768px the row
ran out of room, so the items were *squeezed* rather than wrapped, and the text
re-wrapped inside its own squashed item — breaking mid-phrase and detaching the
kbd chips from the words they described.

**Measured** on `/viewer.html?source=<a real 2-page PDF>`, element height ×
width at four viewport widths:

| `flex-wrap` / `display` | 320px | 375px | 768px | 1280px |
| --- | --- | --- | --- | --- |
| `nowrap` (as shipped) | 262×**58** | 317×**58** | 673×23 | 938×23 |
| `wrap` (first attempt) | 262×**86** | 317×**55** | 673×23 | 938×23 |
| `display: block` (shipped fix) | 262×**47** | 317×**47** | 673×23 | 938×23 |

The first attempt is recorded because it is instructive: `flex-wrap: wrap`
**regressed** the narrow case, from 58px to 86px at 320px. Flex items wrap as
whole units, so the phrase `" move between sections,"` is a single unbreakable
item, the line breaks after it, and the row grows taller. Wrapping was never
the problem — the flex container was.

The shipped fix restores normal inline flow, which is what a `<p>` whose other
class is `.help` should have been. The text now breaks at word boundaries:

```
375px, before:  "Keyboard: ← → move between sections, Hom-   ← crammed, mid-phrase
                 e first, End last."

375px, after:   "⌨ Keyboard: [←] [→] move between sections, [Home]"
                 "first, [End] last."                          ← clean
```

The icon needs no alignment rule of its own: `components.css` `.icon` is
already `display: inline-block; vertical-align: -0.125em`, built for exactly
this, and it is what `.alert`, `.toast` and `.qz-notice` already rely on.

No viewport width is special-cased, and the hint text, kbd elements and icon
are all untouched.

---

## 3 · How the audit was run

Two measurements per page per width:

1. **Squeeze** — for every element under `main`, `header` and `nav`, compare
   `scrollWidth` against `clientWidth`. A difference means the content is wider
   than its own box. `overflow-x: auto` and `scrollX` containers are excluded,
   because scrolling there is the intent. This is the check that found
   `.fv-keys`, and unlike a horizontal-overflow check it catches the case where
   an element *shrinks its content* instead of overflowing.
2. **Overflow** — flag any element whose bounding rect extends past
   `window.innerWidth`, plus every interactive element under 24×24 CSS px.

Console errors and page errors were collected on all 39 loads.

---

## 4 · Deliberate tradeoffs, audited and left alone

These were measured, judged intentional, and **not** changed. They are written
down so a later pass does not mistake them for bugs.

### 4.1 The off-canvas sidebar reads as "wider than the viewport"

Every interior page reports 12 elements past the right edge — `a.brand
right=-125`, `a.nav-item right=-13`, and so on. These are the closed sidebar.
At phone widths the rail is translated off-canvas with a transform, so its
links sit at negative offsets until the hamburger opens it. This is a false
positive of the bounding-rect check, not a layout failure: the page itself does
not scroll horizontally, and the links are reachable by opening the drawer.
Confirming the drawer opens and is keyboard-reachable is an accessibility
concern and is covered in `docs/A11Y.md`.

### 4.2 `.topbar__section` truncates the section name at 320px

`shell.css` sets `overflow: hidden; white-space: nowrap; text-overflow:
ellipsis`, and documents the reasoning inline:

> Truncates rather than pushing the health pill out; on the phone the longest
> label ("Learning Progress") is the first to give.

Measured at a 320px viewport:

| Page | Box | Content | Renders as |
| --- | --- | --- | --- |
| `session` | 88px | 96px | `Study Sess…` |
| `planner` | 88px | 90px | `Study Pla…` |
| `progress` | 88px | 114px | `Learning P…` |

At 375px and above nothing truncates. This is a considered choice — the
alternative is pushing the health pill out of the topbar — and the full section
name is still present in the sidebar nav, so the information is not lost, only
not repeated in full. Reversing it would undo a documented decision.

### 4.3 Tap targets

Nine elements across three pages measure under 24×24 CSS px: `input` checkboxes
at 16×16 (`session`, `quiz`), one 80×18 text link (`session`) and two 13×29
links (`planner`). None is a bare target: the checkboxes sit inside labels at
least 24px tall, so the *effective* clickable area passes, and the small links
are inline text links, which WCAG 2.2 AA 2.5.8 exempts when they sit in a
sentence. The detailed per-page findings are in `docs/A11Y.md`.

---

## 5 · What was checked and found already correct

- **Long unbroken tokens.** The reading surface guards against a long URL, DOI
  or chemical name forcing the page wide, with `overflow-wrap: anywhere` on the
  viewer's prose styles.
- **The material-import panel** renders and is usable at 375px, including its
  file-type guidance.
- **Tables** do not overflow at any tested width.
- **Print styles** in `viewer.css` drop the controls and let sections flow,
  which is the right behaviour for a reading tool a student prints.

---

## 6 · Reproducing

The audit scripts are throwaway harness scripts and are not committed. The
server can be run isolated with a throwaway database:

```bash
SUPABASE_URL= SUPABASE_ANON_KEY= SUPABASE_DB_URL= PORT=3977 \
  SQLITE_DB_PATH=/tmp/opencode/rx/app.db VECTOR_STORE=sqlite \
  DATA_DIR=/tmp/opencode/rx node --env-file=.env server/index.js
```

Blanking `SUPABASE_URL` selects prototype mode, which disables authentication
so pages load without an account. Upload a real text-bearing PDF to give the
viewer something to render, then open
`/viewer.html?source=<the returned id>` — the keyboard-hint row only exists
once a document is open, which is why the §2 measurements need a source.

Playwright needs an explicit browser path in this environment:

```js
chromium.launch({
  headless: true,
  executablePath: '/home/puri/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  args: ['--no-sandbox'],
})
```

---

## 7 · Known limitations

- Three viewport widths were tested, not a full device matrix. Widths between
  375px and 768px, and landscape phone orientations, are untested. The single
  shipped rule is width-independent — it removes a flex container rather than
  adding a breakpoint — so it is not expected to be sensitive to those gaps, but
  that is reasoning, not measurement.
- The audit is automated. It measures geometry and console output; it cannot
  judge whether a layout merely *looks* wrong. The §2 before/after screenshots
  were reviewed by eye for that reason.
- Touch scrolling and gesture behaviour were not exercised.
