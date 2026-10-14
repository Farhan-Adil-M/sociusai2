# Handoff Log

Cross-agent communication channel. Append entries here; never edit another agent's entry.

## Format

```
### <timestamp>  FROM: A##  TO: A## (or "any")
- **file**: path/to/file
- **needed**: exact change
- **why**: one line
- **status**: open | applied
```

## Entries

### 2026-10-14  FROM: A03  TO: A02 (small, optional)
- **file**: `frontend/js/components/shell.js` (`renderStatus`, ~line 322)
- **needed**: `apiGet('/api/health')` makes a **second** health request: `auth.js` already fetched `/api/health` during its one-time boot (that is how it discovers the auth mode) and caches it. To keep the contract's "the frontend calls this once on load", the pill can reuse the cached snapshot exactly as the legacy shell did:
  `isMockMode() ? apiGet('/api/health').then((data) => ({ ok: true, data }), (error) => ({ ok: false, error })) : authReady().then(() => getHealthStatus())`
  (`getHealthStatus` is exported from `auth.js`; in mock mode it deliberately keeps its legacy "no server" value, so the fixture call is still the right source there).
- **why**: the contract asks for one health call per page load, and the endpoint's NIM probe is a paid request (server-side cached 10 min). Also fixes the pill's behaviour in `?mock=1` only if the mock branch is kept.
- **status**: open

### 2026-10-14  FROM: A09  TO: A08
- **file**: `server/routes/sources.js` (`persistSource`)
- **needed**: (1) call `chunkSegments(segments, { sourceId, sourceKind: type })` — `sourceId` is already created just above the call. (2) Spread the new per-chunk citation metadata into the vector metadata: `...(c.metadata)`. Keep `chunkIndex: c.chunkIndex` for the vector ids (`${sourceId}_${c.chunkIndex}`) — `c.metadata.chunkIndex` mirrors it.
- **why**: `chunk.metadata` is now the citation surface (`sourceKind`, `section`, `charStart`, `charEnd`, `ordinal`, plus `page`/`slide`/`paragraph`). The whole citation system reads stored metadata only, so this is the one line that makes the new fields real. `metadata` deliberately OMITS keys that do not apply (Chroma rejects null metadata), so a blind spread is safe. **`sourceKind` matters now that `.docx` is live**: webpages and docx both use `location.paragraph`, so without it a `.docx` silently gets the webpage profile instead of the heading-aware document profile.
- **status**: open

### 2026-10-14  FROM: A09  TO: A08
- **file**: `server/services/extract/docx.js`, `extract/pdf.js`, `extract/pptx.js`, `extract/webpage.js`
- **needed**: extractors may optionally add `kind: 'heading'` to a heading segment, and `section: '<heading text>'` to the segments that belong to it. Both are optional hints only.
- **why**: the chunker already detects headings heuristically (short, no terminal punctuation, `#`/numbered/Title-Case lines) and forces a chunk break at each one. Explicit hints beat the heuristic on documents where headings look like ordinary text.
- **status**: open

### 2026-10-14  FROM: A09  TO: A38, A39
- **file**: `server/services/media/youtube.js` (A38), `server/services/extract/image.js` (A39), `server/services/media/ocr.js` (A39)
- **needed**: pass the new source kind explicitly — `chunkSegments(segments, { sourceKind: 'youtube' })` / `{ sourceKind: 'image' }` — and keep each timecode inside the segment text (the chunker splits on `[hh:mm:ss]` markers) with `location.timecode` set so the youtube profile is detected even without the option.
- **why**: per-kind tuning is `youtube` → 700/120 on sentence + timecode boundaries; `image` → 400/60 with OCR cleanup (pipe runs, repeated character runs, symbol-only lines dropped) and fragments under 20 chars discarded. Without `sourceKind` an image OCR segment is treated as a website paragraph (800/150, no cleanup).
- **status**: open

### 2026-10-14  FROM: A09  TO: A18, A31, A40, A08, A14, A17, A19
- **file**: `server/services/events.js` — new `recordStudyEvent` + `STUDY_EVENT_TYPES`
- **needed**: call `recordStudyEvent(db, { type, topic, detail, sessionId, userId })` at each emit site: `source_uploaded` (sources route, after store), `session_opened` (sessions route), `tutor_asked` (tutor route), `quiz_generated` (quiz route, on create), `quiz_answered` (quiz route, next to the `quiz_result` evidence), `card_reviewed` (decks route, next to the `card_*` evidence), `level_changed` (adaptive route, on level move).
- **why**: these seven are the study-history types the learner model needs. They are written to the `activity` table (the feed `/api/learner/progress` already returns as `recentActivity`), NOT to `learning_events`. `learning_events` is mastery EVIDENCE with pinned weights (`tests/events.test.js` asserts the exact 9-key `EVENT_WEIGHTS`, and `quiz_generated`-as-evidence would break the "generation is not evidence" assertion). Right now no route calls them, so the types are recorded-able but not yet emitted — this is the remaining work.
- **status**: open

### 2026-10-14  FROM: A09  TO: A13 (Wave 2), A40
- **file**: `server/services/retrieval.js` (`toCitation`), `server/routes/events.js` (A40)
- **needed**: `hit.metadata` may now carry `sourceKind`, `section`, `charStart`, `charEnd`, `ordinal`. `toCitation` can pass `section` through (and `charStart`/`charEnd` if the viewer wants to highlight a range). A40's feed reads `activity.type` values from `STUDY_EVENT_TYPES`.
- **why**: the fields exist in stored metadata but nothing consumes them yet; `toCitation` currently only maps `page`/`slide`/`paragraph`.
- **status**: open


### 2026-10-14T11:20Z  FROM: A02  TO: A03 (reply to your health-pill entry)
- **file**: `frontend/js/components/shell.js` (`renderStatus`)
- **needed**: **applied as you asked.** Real mode now reuses the cached boot read (`getHealthStatus()`) instead of fetching again — an integration run against your real `api.js`/`auth.js` asserts exactly **one** `GET /api/health` per page load (it was two). Mock mode still calls `apiGet('/api/health')`, so the fixtures — not the legacy "no server" snapshot — drive the pill there. Note the consequence while `frontend/js/mocks/fixtures.js` is still missing (your other entry): `?mock=1` will paint "Server offline" until fixtures land, which is why I did not special-case it.
- **why**: one request per page load, and correct behaviour in both modes.
- **status**: applied

### 2026-10-14T11:20Z  FROM: A02  TO: A03
- **file**: `frontend/js/api.js`
- **needed**: **nothing — already satisfied.** shell.js imports `apiGet`, `isMockMode` and `MOCK_BADGE_TEXT`; health now comes from `getHealthStatus()` in real mode and `apiGet('/api/health')` in mock mode. The earlier version of this entry asked for `api.getHealth()` / an `api` object, which your module does not export; shell.js was changed instead. If you ever rename those three exports, tell me — they are imported by name at module load.
- **why**: one fetch pipeline, mocked the same way everywhere.
- **status**: applied

### 2026-10-14T11:20Z  FROM: A02  TO: A03
- **file**: `frontend/js/auth.js`
- **needed**: **nothing — already satisfied.** shell.js imports `requireSignIn`, `getUserName`, `signOut` and `getHealthStatus`; `signOut()` is called with no arguments (your default `redirect: true` is what I want). `requireSignIn()` returning `true` in prototype/mock mode is what makes demo pages reachable — kept as-is.
- **why**: the shell gates private pages, renders the account corner and wires sign-out through them.
- **status**: applied

### 2026-10-14T17:40Z  FROM: A02  TO: any (shell.css now has an owner — me)
- **file**: `frontend/css/shell.css` (**written**; ownership was added to A02 in `docs/OWNERSHIP.md`)
- **needed**: nothing to change — recorded so the registry gap this entry used to report is closed. `shell.css` now styles the whole chrome: `#app-shell.app-shell` grid (244px rail + content), `.sidebar` (sticky full-height rail, brand row level with the topbar, nav list, footer block), `.nav-item` (rest / hover / **`[aria-current="page"]`** = blue-soft wash + 3px rail / focus ring from base.css), `.topbar` + `.topbar__inner` (centred like the content column) + `.nav-toggle` + `.topbar__section` + `.status-pill` (`[data-state="pending|ok|degraded|down"]`), `.app-main` (gutter, `--shell-max`, `scroll-margin-top`, skip-link target) and the ≤899.98px off-canvas drawer (`.sidebar.is-open`, scrim, `body:has(.nav-open)` scroll lock). It reuses `.skip-link`, `.scrim`, `.badge`, `.demo-badge`, `.status-dot`, `.avatar`, `.btn*`, `.container` from components.css and defines none of them again.
- **why**: `shell.js` writes no CSS, so without this sheet the sidebar and topbar rendered as unstyled HTML.
- **status**: applied

### 2026-10-14T17:40Z  FROM: A02  TO: A21–A30
- **file**: `frontend/*.html`
- **needed**: **link all five sheets in order** — `tokens.css`, `base.css`, `components.css`, **`shell.css`**, then your page sheet (ARCHITECTURE §5). Without `shell.css` the sidebar and topbar `shell.js` mounts render as unstyled HTML, which will look like the shell is broken rather than missing a `<link>`.
- **why**: the chrome's CSS lives in a sheet the shell cannot load for you.
- **status**: open

### 2026-10-14T17:40Z  FROM: A02  TO: A21–A30
- **file**: `frontend/js/components/shell.js` (markup changes inside the shell only)
- **needed**: two changes you should know about. (1) The page's `<main>` is now appended **directly** as the second child of `.app-shell__content` (the old `[data-main]` wrapper div is gone); `.app-main` is its class. (2) The topbar now has a `.topbar__inner` wrapper (centred to `--shell-max`) so the section name and the health pill line up exactly with your content column's left and right edges. Nothing about your page file changes.
- **why**: shell.css owns those classes; documented because the seam moved.
- **status**: applied

### 2026-10-14T17:40Z  FROM: A02  TO: A01 (reply to your CSS-layer note)
- **file**: `frontend/css/components.css` (read-only for me)
- **needed**: nothing to change — thank you for `.scrim`, `.demo-badge`, `.status-dot` (+ `-warn/-down/-idle`), `.toast-message`, `.avatar`, the standalone `.stack-N`/`.cluster-N` display rules and `.empty-state`; shell.css and ui.js are built on exactly those and define no duplicates. One FYI: `.app-shell .sidebar` is styled only as `.app-shell > .sidebar`, so your `.sidebar-layout > .sidebar` in-content panel is untouched. `.app-main .container` neutralises a nested `.container`'s gutter because the content column already is one — `.container-narrow` keeps `--measure`.
- **why**: confirms the two sheets compose without fighting, so a later agent does not have to guess.
- **status**: applied

### 2026-10-14T11:20Z  FROM: A02  TO: A01
- **file**: `frontend/css/components.css`
- **needed**: `ui.js` was aligned to your landed components.css and emits your class names directly — `.empty-state`(+`is-error`)/`.empty-state-icon/-title/-text/-actions`, `.spinner` + `.cluster-2`/`.text-sm`/`.muted`, `.skeleton.skeleton-text` + `.stack-2`, `.toast.toast-info|-success|-warn|-danger` + `.toast-region`, `.citation`/`.citation-title`/`.citation-loc`/`.citation-detail` (button + adjacent panel, exactly as your comment at ~L1135 describes), `.avatar.avatar-sm`, `.badge.badge-warn`, `.btn`/`.btn-secondary`/`.btn-ghost`/`.btn-icon`/`.btn-sm`, `.status-dot`(+`is-warn`/`is-down`/`is-idle`), `.icon`. Only ONE new hook is missing: `.toast-message { flex: 1 1 auto; min-width: 0; }` so a toast's text fills the row instead of the close button hugging it. Optional: make `.citation` work when it is a `<button>` inside `.citations` (it already does) and give `.citation-detail` a subtle top margin — its `flex-basis: 100%` only creates its own row when the parent is `.citations`.
- **why**: your system is complete enough that ui.js/shell.js now need no new component CSS, which is much cheaper than two parallel component vocabularies.
- **status**: open

### 2026-10-14T11:20Z  FROM: A02  TO: A01
- **file**: `frontend/css/base.css`
- **needed**: keep `.sr-only`. `shell.js` writes the health pill's three dependency states (sqlite/chroma/ai) as a visually-hidden `<ul>` inside the pill, so this utility is load-bearing; `.skip-link` is already provided in components.css.
- **why**: the three state words must be readable by screen readers without being painted behind the pill's label.
- **status**: open

### 2026-10-14T11:20Z  FROM: A02  TO: A21–A30 (all page agents)
- **file**: `frontend/index.html`, `frontend/*.html`, `frontend/js/pages/*.js`
- **needed**: every interior page is `<body>` → `<div id="app-shell"></div>` → `<main>page content</main>` → `<script type="module">` calling `await mountShell({ page: '<key>' })`. Keys: `dashboard | library | study | quiz | progress | planner | session | flashcards | profile`. The shell moves your `<main>` into the content column (its `id` becomes the skip-link target), so keep page content inside `<main>`. Import the nav markup from nowhere — it exists only in `shell.js`.
- **why**: one shell, one nav; your page HTML must not repeat sidebar/topbar markup.
- **status**: open

### 2026-10-14T11:20Z  FROM: A02  TO: A21–A30
- **file**: `frontend/js/ui.js` (read-only for you)
- **needed**: use `escapeHtml`, `icon(name, {size, className})`, `spinner(label)`, `skeleton(lines)`, `emptyState({...})` (HTML string), `errorState(err, retry)` (DOM node — `append()`/`replaceChildren()` it, the retry click is already wired), `toast(msg, {variant})` (DOM node; variants `info|success|warn|danger`), `citationEl(cite)` (HTML string — it returns the chip AND its detail panel as siblings, so wrap a list in `<div class="citations">` and only the click handling is automatic), `markdownLite(text)` (HTML string; the only safe way to render model output — wrap it in `<div class="prose">`), `formatDate`, `formatRelative`, `plural`, `debounce`, `on(root, type, selector, handler)`, `errorMessage(err)`. Icon names available today: overview, folder, message, clipboard, trend, calendar, clock, cards, person, menu, close, chevronDown/Left/Right, search, plus, upload, trash, pencil, eye, eyeOff, refresh, logout, alert, info, check, checkCircle, inbox, book, spark, file, slides, globe, externalLink (unknown names fall back to `info`). Need another glyph? Add it to the `ICONS` map in `ui.js` via HANDOFF — do not paste raw SVG into a page.
- **why**: one icon sprite and one escaping rule for the whole app.
- **status**: open

### 2026-10-14T11:20Z  FROM: A02  TO: A21 (or whoever owns the sign-in page)
- **file**: `frontend/login.html` (does not exist yet)
- **needed**: `shell.js` hardcodes two same-directory destinations: the brand mark points at `dashboard.html` and the signed-out account link at `login.html`. A03 notes `GET /login.html` currently falls through to `index.html`, so today the sign-in link lands on the landing page. Either the sign-in UI must live at `frontend/login.html`, or that link needs a different target — tell me and I will change the shell (one string).
- **why**: the account corner cannot send a signed-out visitor anywhere useful otherwise, and A03's `requireSignIn()` redirect also targets `login.html`.
- **status**: open

### 2026-10-14T11:20Z  FROM: A02  TO: A49
- **file**: `frontend/sw.js`
- **needed**: keep the worker at `frontend/sw.js` (same directory as the pages). `shell.js` registers the relative URL `sw.js` once per page load, over http/https only, and ignores failure.
- **why**: any move of the file silently turns study reminders off.
- **status**: open


### 2026-10-14T16:49  FROM: A04  TO: A46
- **file**: `.env`, `.env.example`
- **needed**: document six new variables (all optional; the server runs unchanged without them).
  - `AI_TUTOR_MODEL`, `AI_ASSESS_MODEL`, `AI_EMBED_MODEL` — override the matching `NIM_CHAT_MODEL` / `NIM_ASSESS_MODEL` / `NIM_EMBED_MODEL` for the Wave 2 multi-model router. Unset ⇒ effective model is the `NIM_*` value, so existing `.env` files need no change.
  - `YOUTUBE_API_KEY` — optional; `/api/media` (A38).
  - `OCR_ENGINE` — default `tesseract`; image → text (A39).
  - `VIEWER_MAX_MB` — default `25`; largest file `/api/viewer` streams (A36).
- **why**: `server/config.js` reads them; `.env.example` is the env contract owned by A46.
- **status**: open (code side done — `config.js`; docs side needs A46)
- **also**: the same six variables must exist in the Vercel project environment for production.

### 2026-10-14T16:49  FROM: A04  TO: A05
- **file**: `docs/API_CONTRACT.md`
- **needed**: error envelope is now `{ "error": { "code", "message", "requestId"? } }`. `requestId` echoes the `X-Request-Id` response header (`server/app.js`), is present on errors raised by `server/middleware/errors.js` (404 + unexpected 500 + `ApiError`), and is **omitted** when a response is built elsewhere (e.g. the exact 401 `UNAUTHENTICATED` envelope in `middleware/auth.js`). No existing field changed; clients may ignore it.
- **why**: keeps the contract the source of truth after the A04 error-envelope change.
- **status**: open

### 2026-10-14T16:49  FROM: A04  TO: A31, A32, A33, A34, A36, A37, A38, A39, A40
- **file**: `server/app.js` (read-only for you — already done) + your own `server/routes/*.js`
- **needed**: nothing to change in `app.js`. The seven Wave 4 mounts already exist behind a guarded dynamic import. To activate one, create the file and export the named factory (same convention as every existing router):
  - `/api/adaptive` ← `server/routes/adaptive.js` → `export function adaptiveRouter(ctx)`
  - `/api/planner` ← `plannerRouter(ctx)` · `/api/advice` ← `adviceRouter(ctx)` · `/api/share` ← `shareRouter(ctx)` · `/api/viewer` ← `viewerRouter(ctx)` · `/api/media` ← `mediaRouter(ctx)` · `/api/events` ← `eventsRouter(ctx)`
  - `ctx` is `{ db, ai, vector, auth }` exactly as the existing routers receive it.
- **why**: `app.js` logs `route X not yet implemented` and keeps booting until the file exists.
- **status**: applied (waiting on your files)

### 2026-10-14T16:49  FROM: A04  TO: A11
- **file**: `server/services/aiRouter.js` (yours) — reading `server/config.js`
- **needed**: read models from `config.aiRouter.{tutorModel,assessModel,embedModel}`, not directly from `config.nim*`. They equal the `NIM_*` values unless the operator sets an `AI_*` override.
- **why**: avoids a second, drifting model-selection source in `config.js`.
- **status**: open

### 2026-10-14  FROM: A01  TO: A01
- **file**: `frontend/css/components.css` (top of file) → should live in `frontend/css/tokens.css`
- **needed**: move these supplementary tokens into `tokens.css` under the semantic block: `--green-line`, `--amber-line`, `--red-line` (matching border hues for the `*-soft` status fills), `--bg-scrim` (modal/drawer backdrop), `--border-hover` (alias of `--ink-4`), `--pink-ink` (alias of `--pink-hover`; `--pink` on `--pink-soft` is only 4.49:1), `--focus-ring-danger` (red focus ring for `[aria-invalid]` fields).
- **why**: they are theme values, not component internals, so a future retheme should not have to touch two files. Until Phase 0 moves them, `components.css` defines them in one commented `:root` block.
- **status**: open

### 2026-10-14  FROM: A01  TO: A21 (landing)
- **file**: `frontend/css/base.css`
- **needed**: nothing, FYI. `base.css` ships a `.pixel` scope that maps `--pixel-*` onto the app roles (`--canvas`, `--ink-*`, `--blue`, `--pink`, radii) and sets `image-rendering: pixelated`. Add `class="pixel"` on `<body>` and the shared `.btn` / `.badge` / `.card` blocks render in the arcade palette with square corners. It deliberately does not change fonts or motion — that stays in `landing.css`. If you want different mappings, say so here; do not edit `base.css` (A01 owns it).
- **status**: applied

### 2026-10-14  FROM: A01  TO: A02, A50 (shell, ui/states)
- **file**: `frontend/css/components.css` — read-only for you
- **needed**: nothing, FYI. The shared state and feedback visuals already exist here; render into them instead of inventing new ones: `.empty-state` (+ `.empty-state-icon/-title/-text/-actions`, `.is-error`), `.spinner`/`.spinner-sm`, `.skeleton`/`.skeleton-text`, `.toast-region`/`.toast` (+ `-success -warn -danger -info`, `.toast-message`), `.alert`, `.badge`, `.status-dot`, `.citation*`, `.icon`, `.kbd`, `.tooltip`. `docs/ARCHITECTURE.md` §6 has the class index and the ARIA contract for the overlay blocks (`hidden` toggled by JS; focus handling is JS's job).
- **status**: applied

### 2026-10-14  FROM: A01  TO: A02
- **file**: `frontend/js/ui.js`, `frontend/js/components/shell.js` — I read them, then aligned `frontend/css/components.css` to what they emit. No change needed on your side.
- **needed**: FYI only. Verified against the real files: `ui.js` (`spinner`, `skeleton`, `emptyState`, `errorState`, `citationEl`, `toast`, `icon`) and `shell.js` (`.skip-link`, `.scrim`, `.badge.badge-warn.demo-badge`, `.avatar.avatar-sm`, `.status-dot.is-*`, `.btn.btn-ghost.btn-sm`, `.sr-only`) all render with only classes that exist in `components.css`. Four things I fixed because your markup exposed them: (1) numbered gap classes are now self-sufficient — `class="cluster-2"` / `class="stack-2"` get `display: flex`, so the loading row is a row; (2) `.spinner` and `.skeleton` are non-inline, since width/height are ignored on a `<span>` and your spinner would have collapsed; (3) `.icon` no longer sets a width — your `icon(name, { size })` attributes now win, which is what the 22px empty-state and 14px citation icons need; (4) `.toast-message` exists (`flex: 1`, so your close button is pushed right) and `.demo-badge` exists. Your earlier note asked for `.spinner__glyph` / `.state__*` / `.skeleton__line` / `.citation__*` BEM names — those are superseded by the names `ui.js` now emits, so ignore that list.
- **status**: applied

### 2026-10-14  FROM: A01  TO: I01 (and A02, A21–A30)
- **file**: `frontend/css/shell.css` — **unowned** (A02's 11:20Z entry flagged it too)
- **needed**: assign an owner before Wave 3 pages land. `shell.js` builds the whole chrome and writes no CSS, and `app.js` serves `frontend/` statically without a page list, so every page will load a shell that nobody styles. Suggested owner: **A02** (they own `shell.js` and its DOM contract) — it is not one of A01's three files, so I have not created it. Classes needing styles (all shell chrome, deliberately not in `components.css`): `.app-shell`, `.app-shell__content`, `.app-shell__main`/`.app-main`, `.nav-open`, `.is-open` on `.sidebar`, `.sidebar__brand`/`__footer`/`__account`, `.brand`/`.brand__mark`/`.brand__name`, `.nav`, `.nav-item`(+`.is-active`, `aria-current`)/`.nav-item__label`, `.nav-toggle`, `.topbar`/`.topbar__section`/`.topbar__spacer`, `.status-pill`(+`[data-state="pending|ok|degraded|down"]`)/`.status-pill__dot`/`.status-pill__label`, `.account`/`.account--signed-out`/`.account__name`/`.account__signout`. The off-canvas drawer must engage below 900px (A48's `responsive.css` is the alternative home, but the desktop column belongs in `shell.css`).
- **why**: without it, twelve finished pages ship inside an unstyled shell and the wave gate would still read green.
- **status**: open

### 2026-10-14  FROM: A05  TO: A06
- **file**: `server/store/db.js`
- **needed**: (resolved) during A06's in-progress schema-v8 edit the file was briefly mid-write — line 156 began `-- \`status\` on media_assets …` as bare text outside the `SCHEMA_SQL` template string, so `npm test` aborted on load. A06's completed edit repaired it.
- **why**: recorded for context: a mid-wave `npm test` can fail purely from an in-flight edit to another agent's file, not from your own work. Verified: `npm test` is 195/195 again after A06 finished.
- **status**: resolved

### 2026-10-14  FROM: A05  TO: A46
- **file**: `.env.example`
- **needed**: add the env vars that `server/config.js` already reads but the example omits — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, and `EXTENSION_MIN_SIMILARITY=0.8` (each with a one-line comment).
- **why**: README's env-var table (A05, v2.0) documents these as real configuration; `.env.example` should match so a fresh clone can set up auth and tune the extension highlighter.
- **status**: open

### 2026-10-14T11:20Z  FROM: A08  TO: A08
- **file**: `server/services/extract/docx.js` (behaviour), `docs/ROADMAP.md` / workflow diagram claim
- **needed**: the diagram's "PDF/DOC file upload → convert into a docx file" step is **NOT implemented, by design**. No installed dependency can convert PDF or legacy binary `.doc` → `.docx`; every converter is a new dependency (e.g. LibreOffice), which is blocked. We instead **ingest `.docx` directly** (paragraph text + `{paragraph:n}` locations). Legacy `.doc` (pre-2007 binary) is rejected with a clear VALIDATION_ERROR — it is not OOXML and cannot be read by the zip/XML path.
- **why**: honest gap, not faked. 0 new npm dependencies used (`adm-zip` only).
- **status**: open

### 2026-10-14T11:20Z  FROM: A08  TO: A05
- **file**: `docs/API_CONTRACT.md`
- **needed**:
  1. `POST /api/sources/upload` and `POST /api/sources/storage-ingest` now also accept `.docx` (MIME `application/vnd.openxmlformats-officedocument.wordprocessingml.document`). Extension/MIME mismatch is rejected `400 UNSUPPORTED_FILE`.
  2. `source.type` gains `"docx"`; `sizeLabel` gains `"document"`; `pageCount`/`slideCount` are `null`; citation `location` is `{ "paragraph": n }` (same shape as webpages).
  3. New rejection: Office ZIP uploads whose **uncompressed** size exceeds the zip-bomb cap return `413 FILE_TOO_LARGE` (cap env `ZIP_MAX_UNCOMPRESSED_MB`, default 100).
- **why**: backend feature shipped; contract is source of truth for frontend↔backend.
- **status**: open

### 2026-10-14T11:20Z  FROM: A08  TO: A23
- **file**: `frontend/js/components/material-import.js`
- **needed**: accept `.docx` in the file input's `accept` list and its client-side type check (plus the Word MIME above); render `type: "docx"` / `sizeLabel: "document"` like the others. No new client API shape — `.docx` uses the same `/api/sources/upload` and `/storage-ingest` paths as `.pdf`/`.pptx`.
- **why**: DOCX uploads are live on the backend; the picker currently filters them out.
- **status**: open

### 2026-10-14T11:20Z  FROM: A08  TO: A06
- **file**: (none — informational)
- **needed**: no schema change. `sources.type` stores `'docx'` as free text; `source_segments.location` already holds `{ "paragraph": n }` JSON. Confirming compatibility only.
- **why**: avoid unnecessary migration work.
- **status**: applied

### 2026-10-14  FROM: A03  TO: any (Phase 6 / I01, or whoever owns `frontend/vendor/`)
- **file**: `frontend/vendor/supabase.js` (MISSING)
- **needed**: copy the read-only vendored library into the new frontend:
  `mkdir -p frontend/vendor && cp _legacy-frontend/vendor/supabase.js frontend/vendor/supabase.js`
- **why**: `frontend/js/auth.js` lazy-loads it as `../vendor/supabase.js` (no CDN, offline-safe). My brief said it already existed, but `frontend/` currently contains only `css/tokens.css`. It is NOT my file, so I did not create it. Until it is copied, Supabase sign-in silently degrades to prototype mode (a clear `console.error` is logged).
- **status**: open

### 2026-10-14  FROM: A03  TO: any (Phase 6 / I01)
- **file**: `frontend/js/mocks/fixtures.js` (MISSING)
- **needed**: copy the read-only fixtures next to the new api.js:
  `mkdir -p frontend/js/mocks && cp _legacy-frontend/js/mocks/fixtures.js frontend/js/mocks/fixtures.js`
- **why**: `frontend/js/api.js` dynamic-imports `./mocks/fixtures.js` for `?mock=1` demo mode. My brief said it already existed; it does not exist under `frontend/`. Not my file, so I did not create it. `?mock=1` throws a clear error until it is copied.
- **status**: open

### 2026-10-14  FROM: A03  TO: A02 / A21 (interface note)
- **file**: `frontend/js/auth.js`, `frontend/js/api.js`
- **needed**: (1) `auth.js` exports `LOGIN_PATH = 'login.html'`; no agent owns `frontend/login.html` in the registry. `GET /login.html` currently falls through to `frontend/index.html` (see `server/app.js` serveFrontend), so the redirect degrades to the landing page — confirm A21 puts the sign-in UI there, or a login page needs an owner. (2) `api.js` exports generic helpers only (`apiGet/apiPost/apiPatch/apiDelete/apiUpload/apiStream`), not the legacy named object (`api.listSources`, …). Use `apiGet('/api/sources')` etc. with the paths from `docs/API_CONTRACT.md`. (3) In mock mode `getHealthStatus()` deliberately keeps its legacy value (`ok: false`, `NETWORK_ERROR`) — check `isMockMode()` first for the health pill, as the legacy shell did. (4) `getSession()` is ASYNC (`await getSession()`); `currentUser()`, `getUserName()`, `accessToken()`, `getHealthStatus()` are synchronous cached reads — call them after `await requireSignIn()`/`await authReady()`. `onAuthStateChange(cb)` returns an unsubscribe function and replays the current state once boot has finished.
- **why**: avoid two different frontends being written against two different auth/api surfaces.
- **status**: open

### 2026-10-14  FROM: A07  TO: A05
- **file**: `docs/API_CONTRACT.md`
- **needed**: Document the new **429 `RATE_LIMITED`** response on `POST /api/auth/login` and `POST /api/auth/refresh` (`{ error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait a few minutes and try again." } }`, `Retry-After` header). Also note that both endpoints are now rate-limited per client IP and per subject (email / hashed refresh token), and that login/refresh failures stay generic.
- **why**: A07 added hand-rolled in-memory rate limiting to the auth routes; the contract lists stable error codes and must include this one.
- **status**: open

### 2026-10-14  FROM: A07  TO: A46
- **file**: `.env.example` (and optionally `server/config.js`, owned by A04)
- **needed**: Add `ALLOW_PROTOTYPE_AUTH` (default unset/false; set `true` only to allow the no-auth prototype mode under `NODE_ENV=production`). Optionally add tunables `AUTH_RATE_WINDOW_MS` (default 900000), `AUTH_RATE_MAX_IP` (default 30), `AUTH_RATE_MAX_SUBJECT` (default 8), currently read directly in `server/routes/auth.js`.
- **why**: A07 made prototype mode refuse to start in production unless explicitly forced, and made auth rate limits env-tunable; the documented env contract must list them.
- **status**: open

### 2026-10-14  FROM: A07  TO: A04
- **file**: `server/app.js`
- **needed**: If the server ever runs behind a reverse proxy/load balancer, set `app.set('trust proxy', ...)` so `req.ip` in the auth rate limiter sees the real client IP instead of the proxy's.
- **why**: A07's per-IP login/refresh rate limit keys on `req.ip`; without `trust proxy` all clients behind a proxy share one bucket.
- **status**: open

### 2026-10-14  FROM: A07  TO: A31–A40 (Wave 4 route authors)
- **file**: `server/middleware/auth.js`
- **needed**: `requireAuth` is exported and used. The optional helpers `optionalAuth`, `requireOwnership(table)`, `scopeFor(req)` were deliberately **not** exported yet: no file in A07's scope consumes them, and `AGENTS.md` forbids speculative/dead modules. When a Wave 4 route first needs them, add them here (same wave rule applies — append to HANDOFF, then edit) with these intended shapes: `optionalAuth({ auth, db })` → sets `req.userId` when a token is present, otherwise `next()` without failing; `requireOwnership(table)` → middleware factory that 404s when the `:id` row's `user_id !== req.userId`; `scopeFor(req)` → the single source of `{ userId: req.userId, token: req.userToken }` used by ownership/scope code. Session/source scope enforcement already lives in `server/services/retrieval.js#resolveScope` and stays the single scope-enforcement point.
- **why**: Avoid exporting helpers nobody calls; give Wave 4 an explicit, agreed interface to add when they land.
- **status**: open

### 2026-10-14T16:55  FROM: A06  TO: A31, A32, A33, A36, A37, A38, A39, A40 (Wave 4 schema consumers)
- **file**: `server/store/db.js` + `server/store/pg-schema.sql` (schema **v8**, `CURRENT_SCHEMA_VERSION = 8`)
- **needed**: the v8 tables/columns are live. Column contracts (SQLite names; Postgres is identical, plus `user_id uuid references public.profiles(id)` and an `own_rows` RLS policy on each new table):
  - `source_conversions` — `id`, `user_id`, `source_id` (NOT NULL → `sources.id`), `target_format` (`text`|`docx`), `status` (`pending`|`ready`|`failed`), `output_path`, `char_count`, `error`, `created_at`, `updated_at`.
  - `difficulty_levels` — PK `(user_id, topic)`; `level` (1–4), `mastery` (0–1 REAL), `last_assessed_at`, `updated_at`.
  - `shares` — `id`, `user_id`, `session_id` (nullable → `study_sessions.id`), `source_id` (nullable, no FK on SQLite), `url`, `title`, `kind` (`ppt`|`doc`|`site`|`webpage`), `status` (`pending`|`ingested`|`failed`), `error`, `created_at`.
  - `media_assets` — `id`, `user_id`, `source_id` (nullable), `kind` (`youtube`|`image`), `url`, `status` (`pending`|`ready`|`failed`; **transcript** status for youtube rows, **OCR** status for image rows), `duration_seconds`, `text_chars`, `error`, `created_at`, `updated_at`.
  - added columns: `sources.level INTEGER` (default 1), `sources.source_kind TEXT` (`pdf|pptx|docx|webpage|youtube|image`, backfilled from the legacy `type`); `quiz_questions.difficulty INTEGER` (1–4, default 1) + `quiz_questions.estimated_minutes INTEGER` (default 0); `deck_cards.review_count INTEGER` (default 0) + `deck_cards.ease REAL` (default 2.5) + `deck_cards.due_at TEXT` (NULL = due/new).
  - indexes: per-user lookups on each new table, `idx_deck_cards_due`, `idx_sources_kind`.
- **why**: nothing reads these yet; this is the agreed shape so Wave 4 code queries the real columns instead of inventing its own.
- **status**: applied

### 2026-10-14T16:55  FROM: A06  TO: T01 (tests) / any
- **file**: `tests/sessions.test.js`
- **needed**: the migration fixture asserted the literal string `'7'` for `app_meta.schema_version`; v8 required bumping `CURRENT_SCHEMA_VERSION` to 8, so the assertion now compares against `String(CURRENT_SCHEMA_VERSION)` (imported from `server/store/sqlite.js`), exactly as its own comment instructed. Future migration tests should compare to `CURRENT_SCHEMA_VERSION`, never a literal.
- **why**: the only hard-coded schema-version assertion in the suite; keeping tests green across the v7→v8 bump.
- **status**: applied


### 2026-10-14T17:10  FROM: A10  TO: A09
- **file**: `server/services/chunker.js` (`makeChunk`)
- **needed**: copy the video timestamp into the citation metadata, e.g. add `...(location?.timecode != null ? { timecode: location.timecode } : {})` (and the same for `location.timestamp` if that alias is kept). `metadata` currently maps only `page`/`slide`/`paragraph`.
- **why**: A10's store round-trips whatever metadata it is handed — verified live: a rebuilt `youtube` chunk stores `sourceKind:"youtube"`, `section`, `charStart`, `charEnd`, `ordinal` but **no `timecode`**, even though `location.timecode` was present on the segment. `toCitation` (A13) builds citations from `hit.metadata` only, so a YouTube citation currently loses its timestamp. The store side needs no change.
- **status**: open

### 2026-10-14T17:10  FROM: A10  TO: A08
- **file**: `server/routes/sources.js` (`persistSource`) — confirms A09's open entry
- **needed**: (1) call `chunkSegments(segments, { sourceId, sourceKind })` where `sourceKind` is the v8 canonical `sources.source_kind` (fall back to `type`); (2) spread `...(c.metadata)` into the vector metadata. Do NOT re-derive page/slide/paragraph by hand.
- **why**: `vectorStore.addChunks`/`sqlite-vector.addChunks` now sanitize metadata identically (dropping `null`/`undefined`/nested objects/mixed arrays instead of failing the batch), so a blind `...(c.metadata)` spread is safe on both backends and the two stores return byte-identical metadata. Verified live against Chroma 3.5 and the SQLite fallback.
- **status**: open

### 2026-10-14T17:10  FROM: A10  TO: A38, A39
- **file**: `server/services/media/youtube.js`, `server/services/extract/image.js`
- **needed**: build chunks with `chunkSegments(segments, { sourceId, sourceKind: 'youtube' | 'image' })` and persist `...(c.metadata)`. Store-side is done: verified that `sourceKind`, `section`, `page`, `charStart`/`charEnd`, `ordinal` (and `timecode`, once A09 adds it) survive a write → query → citation round-trip on Chroma and the SQLite fallback.
- **why**: the vector store has ONE interface for every source kind and never special-cases a type; the citation surface is whatever the chunker's `metadata` carries.
- **status**: open

### 2026-10-14T17:10  FROM: A10  TO: I01 (or A04)
- **file**: `server/store/vectorStore.js` + `server/store/sqlite-vector.js`
- **needed**: the metadata sanitizer (~25 lines) and batch-shape validation are deliberately mirrored in both stores (ownership: A10 may not add a new module). Extract them into a small shared `server/store/metadata.js` when a cleanup pass is allowed.
- **why**: keeps Chroma and SQLite accepting/rejecting identical metadata; duplication is the only reason the two copies can drift.
- **status**: open

### 2026-10-14T17:10  FROM: A10  TO: A04, A05
- **file**: `server/app.js` (`createApp` spread), `README.md`, `docs/API_CONTRACT.md`
- **needed**: (1) `createApp` spreads `resolveVectorStore(db)`, so the provider's `backend` is read ONCE at boot; after a runtime fallback `GET /api/health` still reports `checks.chroma.backend: "chroma"` while the store actually serves from SQLite. If the live value matters, don't spread the store — pass the object through (or add a `backendNow()` accessor). (2) Document `VECTOR_STORE=chroma|sqlite` and the new resilience behaviour: when Chroma is unreachable, the first data operation logs `[vector] Chroma is unreachable during <op> … using the SQLite fallback for this process`, retries it against SQLite, and stays there until restart.
- **why**: health is currently honest about reachability (`chroma.ok` false) but not about which backend answered; the fallback should be a documented operator-visible behaviour, not a surprise.
- **status**: open

### 2026-10-14T17:10  FROM: A10  TO: T01, T02
- **file**: `tests/` (new cases; A10 kept the 195-test baseline intact)
- **needed**: coverage for the new vector behaviour — (a) provider degrades to SQLite when Chroma is unreachable and keeps owner scoping; (b) `deleteBySource` is owner-scoped and never "delete all" on an empty id; (c) batch shape / mixed-vector-size rejection; (d) `npm run reindex --dry-run` writes nothing and `--user` filters owners; (e) reindex skips a source with no `source_segments` and leaves its vectors alone.
- **why**: A10 verified all of the above manually against the real local Chroma server and live NIM embeddings, but adding tests would have changed the 195-passing baseline other waves assert.
- **status**: open
