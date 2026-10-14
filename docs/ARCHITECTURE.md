# Socius2 — Architecture

Who-owns-what is in [`OWNERSHIP.md`](OWNERSHIP.md). Endpoint shapes are in
[`API_CONTRACT.md`](API_CONTRACT.md). This file is the map in between: how the
pieces fit, which layer each job belongs to, and the design-system contract the
twelve pages are built on. Owner: **A01**. Propose changes here, don't silently
edit.

Still true of the rebuild: vanilla JavaScript, no framework, no build step.
Every file under `frontend/` is served to the browser as written.

---

## 1 · Repository map

| Path | Job | Owner |
|---|---|---|
| `frontend/*.html` | one page per route (`dashboard.html`, `library.html`, …). Markup + script/CSS tags only. | A21–A30 |
| `frontend/css/` | the whole visual layer (see §5) | A01, A21–A30, A47–A48 |
| `frontend/js/api.js` | the **only** `fetch` caller in the app; wraps every endpoint, adds the auth header, normalises errors, `?mock=1` mock mode | A03 |
| `frontend/js/auth.js` | session (Supabase or prototype), `#socius_session` handoff, token refresh | A03 |
| `frontend/js/components/shell.js` | the one app shell: sidebar, topbar, mobile menu, health pill, route mounting into `#app` | A02 |
| `frontend/js/ui.js` | shared render helpers: icons, citations, spinners, toasts, empty/error states | A02 |
| `frontend/js/components/*.js` | cross-page widgets (`material-import`, `session-form`, `scope-select`, `file-viewer`, `share`, `states`) | A23, A36, A37, A50 |
| `frontend/js/pages/*.js` | one file per page: reads `api.js`, renders into the shell, handles its own DOM events | A21–A30 |
| `server/app.js` | the Express app factory `createApp({ db, ai, vector, auth })` — the dependency-injection seam tests use | A04 |
| `server/index.js` | process entry: config, real dependencies, listen | A04 |
| `server/config.js`, `constants.js` | env parsing and shared constants (upload caps, enums, model ids) | A04 |
| `server/middleware/` | `auth.js` (`requireAuth`, ownership guards, `resolveScope`), `errors.js` (error envelope, 404) | A07, A04 |
| `server/routes/` | HTTP surface only: validate input, call services, shape the response | A07–A08, A14, A17, A19–A20, A31–A40 |
| `server/services/` | the actual work: extraction, chunking, retrieval, prompts, tutor, quiz, grading, learner model, embeddings, AI router | A08–A20, A31–A32 |
| `server/store/` | persistence facade: `db.js` picks an engine, `sqlite.js` / libSQL / `pg-schema.sql`, plus `vectorStore.js`, `vectorProvider.js`, `sqlite-vector.js` | A06, A10 |
| `server/services/prompts.js` | prompt library + injection hardening — **all** text sent to a model is assembled here | A15 |
| `api/` | Vercel serverless entry; mounts the same Express app, seeds the demo corpus | A04 |
| `extension/` | MV3 browser extension (highlight → button → briefing panel), talks to `/api` with the same session token | A41–A45 |
| `scripts/` | one-shot tools: migrations, reindex, e2e smoke, retrieval eval | A06, A10, A46 |
| `tests/` | `node:test` suite, offline (195 tests at Phase 0) | T01–T05, plus each feature's author |
| `data/` | runtime data: SQLite file, local Chroma storage, demo seed. Git-ignored. | — |
| `docs/` | this map, the ownership registry, the API contract, glossary, handoff log | — |
| `_legacy-frontend/` | the previous frontend, **read-only**. Reference only — never import it, never ship it. | nobody |

---

## 2 · Request flow

```
browser
  │  js/pages/*.js  ──calls──▶  js/api.js  (the only fetch caller)
  │                                 │  Authorization: Bearer <session token>
  ▼                                 ▼
Express  (server/app.js)
  request id → security headers → CORS allow-list → express.json(1mb)
    → static frontend + page fallback
    → /api/auth  /api/sources  /api/tutor  /api/quiz  /api/flashcards
      /api/decks /api/sessions /api/learner /api/profile /api/onboarding
      /api/extension  /api/health   (+ Wave 4 routers, see below)
    → middleware/auth.js     requireAuth, ownership guard, resolveScope
    → routes/*.js            validate input → call service(s) → shape JSON
      ▼
  services/*.js
      · extract/*, chunker, organizer   source text → segments
      · embeddings, retrieval           segments → vectors → ranked passages + citations
      · tutorService, quizService, flashcardService, summarizer
      · grading, learner, adaptive      deterministic, no AI
      · aiRouter → nimChat              the only outbound AI calls
      ▼
  store/*.js
      · db.js  → node:sqlite (data/app.db) │ libSQL/Turso │ Postgres+RLS
      · vectorStore.js → Chroma (local │ Cloud) │ sqlite-vector fallback
```

**Errors** leave as `{ "error": { "code": …, "message": … } }` with a stable
code (`VALIDATION_ERROR`, `NIM_TIMEOUT`, `CHROMA_UNAVAILABLE`, …) — see
`API_CONTRACT.md` § Conventions. `api.js` turns that envelope into the message a
page shows; a page never inspects HTTP status codes itself.

**Wave 4 routes** (`/api/adaptive`, `/planner`, `/advice`, `/share`, `/viewer`,
`/media`, `/events`) are mounted from `app.js` through a dynamic import guarded
by try/catch. Adding the route file is the only step needed — no edit to
`app.js`.

---

## 3 · The AI boundary

* **The browser never talks to NVIDIA NIM or ChromaDB.** No API key, model id or
  Chroma URL ever reaches frontend code. The browser knows only `/api/...`.
* Every model call happens inside `server/services/`, reached through
  `aiRouter.js` (task → model, timeout, retry, fallback, cost logging) which
  drives `nimChat.js`; embeddings go through `embeddings.js` only.
* Prompts are assembled in `services/prompts.js`. Retrieved passages are inserted
  as data, with injection hardening, never as instructions.
* **Citations are built from stored metadata, never from model text.** `retrieval.js`
  produces `{ sourceId, type, title, url, location, excerpt, score }`; the model's
  prose cannot invent a filename or page number.
* **Deterministic where it matters:** quiz grading (`grading.js`) and mastery
  (`learner.js`) are plain algorithms, not model judgements. The model generates
  questions and explanations; it does not decide a score.
* With no materials to ground an answer, the tutor says so and suggests topics
  from the learner's own library — it does not guess.

---

## 4 · Data ownership

* **Structured records** — users, sources, sessions, decks, quizzes, attempts,
  progress, profiles, events — live in the database chosen by configuration
  (local `node:sqlite`, hosted libSQL/Turso, or Postgres with RLS in Supabase
  mode), always through `store/db.js`.
* **ChromaDB is for searchable passages + their source metadata**, and nothing
  else. A new feature that needs a table does not get a Chroma collection.
* The two stores are joined by `source_id` (and session scope). Scoped features
  (tutor, quiz, decks) filter by scope server-side; the client cannot widen it.
* Original uploaded binaries are not retained — only extracted text — which is
  what makes `npm run reindex` possible without re-uploading.

---

## 5 · CSS layer order

Every page loads the same sheets, in this order. Later sheets may compose and
extend earlier ones; earlier sheets never reach forward.

| # | File | Owns | Rule |
|---|---|---|---|
| 1 | `css/tokens.css` | every colour, type size, space step, radius, shadow, duration, z-index | the single retheme point; only Phase 0/A01 touch it |
| 2 | `css/base.css` | reset, element defaults, focus rings, selection, scrollbar, `.sr-only`, `.pixel` scope, reduced-motion guard | no component styling |
| 3 | `css/components.css` | the shared vocabulary in §6 | no page-specific styling |
| 4 | `css/shell.css` | app chrome: sidebar, topbar, content slot, mobile menu, health pill | ⚠ **no owner in `OWNERSHIP.md`** — `shell.js` writes no CSS, so this sheet must exist for the shell to render. See HANDOFF (A01 → A02/I01). |
| 5 | `<page>.css` | that page's unique composition | one file per page; never restyle a shared component |
| 6 | `css/a11y.css`, `css/responsive.css` | cross-page accessibility and breakpoint passes | Wave 5 (A47, A48) |

Rules that keep the cascade boring on purpose:

* Colour, spacing, radius, shadow, motion and z-index come from
  `var(--token)`. Raw `px` is allowed **only** for widths, heights and
  border-widths — a control height is not a theme value.
* `base.css` gives headings **no margin**. Vertical rhythm comes from `.stack`
  (any container) and `.prose` (long-form text). This is why a component's
  `margin: 0` never fights a page's `p { margin: 1em 0 }`.
* Element defaults in `base.css` sit inside `:where()`, so their specificity is
  zero and any class overrides them without `!important`.
* A page never redefines `.btn`, `.card`, `.input`… If the shape is wrong for a
  real screen, request the change in `HANDOFF.md` and it changes for everyone.

### The two palettes

`tokens.css` carries two palettes and they must not mix:

* `--ink-*`, `--blue*`, `--pink*`, `--*-soft` … — the **app interior**:
  cool neutrals, one blue for action, pink used sparingly. Restrained and
  academic. Everything in §6 uses these.
* `--pixel-*` — the **landing page** only (A21). `base.css` maps them onto the
  app roles inside a `.pixel` scope, so a landing page can reuse `.btn`/`.badge`
  and get the arcade look. `.pixel` must never appear on an app page.

---

## 6 · Component vocabulary (`components.css`)

The class names, by job. Pages compose these; the full markup recipe for each
block sits in a comment above it in the file.

* **Layout** — `.container`, `.container-narrow`; `.stack`/`.stack-1…8` (column
  rhythm), `.cluster`/`.cluster-1…8` (wrapping row) + `.cluster-between`,
  `.spacer`; `.grid`, `.grid-auto`, `.grid-2/3/4`; `.sidebar-layout` (+
  `.sidebar`, `.is-aside-first`); `.page-head` + `.page-head-actions`,
  `.toolbar` + `.toolbar-search`/`.toolbar-actions`; `.divider`,
  `.divider-vertical`, `.divider-flush`; `.skip-link`.
  *The number in a gap class is the space step: `.stack-3` = `var(--s3)` = 12px.
  Each numbered class works on its own (`class="stack-2"`, which is how `ui.js`
  emits its loading rows), so the display rule is part of every variant.*
* **Typography** — `.eyebrow`, `.muted`, `.lead`, `.mono`, `.text-xs`,
  `.text-sm`, `.truncate`, `.list`, `.prose`, `.icon`.
  *`.icon` sets no width: `ui.js` always passes `width`/`height` attributes
  (`icon(name, { size })`) and CSS would outrank them.*
  *`markdownLite()` output must sit inside `.prose` — its `<ul>`/`<ol>` need the
  markers that `base.css` strips from app-UI lists.*
* **Buttons** — `.btn` (neutral) + exactly one of `.btn-primary`,
  `.btn-secondary`, `.btn-ghost`, `.btn-danger`; sizes `.btn-sm`, `.btn-lg`,
  `.btn-block`, shape `.btn-icon`; states hover / active / `:focus-visible` /
  `:disabled` / `[aria-disabled="true"]` / `[aria-busy="true"]`.
* **Forms** — `.field`, `.label`, `.input`, `.textarea`, `.select`, `.checkbox`,
  `.radio`, `.choice-list`, `.field-row`, `.help`, `.error`, `.input-group`; the
  invalid state is driven by `[aria-invalid="true"]`, never by a colour class.
* **Surfaces** — `.card`, `.panel` (+ `.panel-head`, `.panel-title`,
  `.panel-body`, `.panel-foot`), `.well`.
* **Feedback** — `.badge` (+ `-success -warn -danger -info -accent`), `.demo-badge`,
  `.status-dot` (+ `.is-warn/.is-down/.is-idle`), `.alert` (+ `-info -success
  -warn -danger`), `.spinner`, `.spinner-sm`, `.progress` / `.progress-bar` /
  `.is-indeterminate` / `.progress-label`, `.skeleton` / `.skeleton-text`.
* **Content** — `.table-wrap` + `.table` + `.table-num`, `.row-list` +
  `.row-item` / `.row-icon` / `.row-main` / `.row-title` / `.row-meta`,
  `.tabs` + `.tab`, `.chip` + `.chip-remove`, `.avatar` (+ `-sm`, `-lg`),
  `.tooltip` / `.tooltip-bubble` / `[data-tooltip]`, `.kbd`, `.empty-state`
  (+ its four children, `.is-error`), `.breadcrumb`, `.citations` +
  `.citation*`.
* **Overlay** — `.scrim` (backdrop for a drawer or the mobile nav),
  `.modal` + `.modal-dialog`/`-head`/`-title`/`-body`/`-foot`,
  `.drawer` + `.drawer-panel`/`-head`/`-title`/`-body`/`-foot` (+ `.is-left`),
  `.toast-region` + `.toast` (+ `.toast-message`, `-success -warn -danger -info`).

### The CSS ↔ JS seam

These names are what the JS layer may rely on. If a name has to change,
append to `HANDOFF.md` — twelve pages and two shared modules depend on them.

| Markup | Rendered by | Closed/open by |
|---|---|---|
| `.icon` inside buttons, rows, alerts, toasts | `ui.js` (icons); size comes from the SVG's `width`/`height` attributes | — |
| `.cluster-2`, `.stack-2`, `.text-sm`, `.muted` inside loading rows | `ui.js` (`spinner()`, `skeleton()`) | — |
| `.citations` + `.citation` + `.citation-detail` | `ui.js` (`citationEl()`, which also installs the click handler) | `aria-expanded` on the chip flips the next sibling's `hidden` |
| `.toast-region`, `.toast`, `.toast-message` | `ui.js` (`toast()`, mounts itself) | auto-removed after its duration |
| `.empty-state` (+ `.is-error`) | `ui.js` (`emptyState()`, `errorState()`) | — |
| `.spinner`, `.skeleton`, `.skeleton-text` | `ui.js` (loading states) | — |
| `.badge`, `.demo-badge`, `.status-dot`, `.avatar` in the sidebar/topbar | `shell.js` | — |
| `.skip-link`, `.scrim` | `shell.js` (mobile nav) | the `hidden` attribute |
| `.modal`, `.drawer` | page markup + `ui.js` behaviour | the `hidden` attribute |
| `.sidebar-layout`, `.container` | `shell.js` owns the app chrome; pages own their content column | — |

**Overlay contract** (modal, drawer, and anything focusable over the page):
`role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the title;
focus moves into the panel on open and returns to the trigger on close; Escape
closes; the markup ships with `hidden` set. The CSS provides the look and the
`hidden` behaviour only — focus management is JS.

**API contract**: pages call `api.js` and nothing else. It returns the parsed
body or throws an error whose `message` is safe to display and whose `code` is
stable. `?mock=1` runs the page against recorded fixtures, which is how pages are
demonstrated without a Chroma/NIM backend.

---

## 7 · Adding a page

1. Create `frontend/<name>.html`: semantic markup, one `<h1>`, a `.container`,
   the skip link, the sheets of §5 in order, and the page's `js/pages/<name>.js`
   as `type="module"`.
2. `shell.js` mounts the chrome and hands the page its content slot; the page
   renders only inside it.
3. Build the page from the classes in §6. Reach for `.stack`/`.cluster`/`.grid`
   for rhythm, `.card`/`.panel` for surfaces, `.empty-state` for "nothing here
   yet", `.skeleton` while loading, and `.alert` for a failure.
4. Give the page its own CSS file only for what is genuinely unique to it.
5. Run `npm test`, then open the page and step through its real workflow.
