# Socius2 — File Ownership Registry

**Generated in Phase 0. This file is authoritative.**

## The rule

1. **Waves run sequentially.** Never start a wave until the previous one is green.
2. **Within a wave, file sets are strictly disjoint.** No two agents in the same wave may write the same file. This is enforced by this registry.
3. **Later waves may edit earlier waves' files** — but only the file's *owner* from the earlier wave, and only by appending to `docs/HANDOFF.md` first.
4. **`_legacy-frontend/` is READ-ONLY.** It is the old SociusAi frontend kept for behavioural reference. Never modify it, never import from it at runtime.
5. **`tests/` is owned by whoever writes the feature**, except `tests/helpers.js` which is Phase 0 owned. If you need a shared helper change, note it in `docs/HANDOFF.md`.
6. Before writing any file not listed as yours, **stop and record the conflict in `docs/HANDOFF.md`.**

## Read access

Everything is world-readable. Ownership controls **writes only**.

---

## Legend

| Symbol | Meaning |
|---|---|
| `W1`…`W5` | Wave number |
| `P0` | Phase 0 (foundation, already complete) |
| `P6` | Phase 6 integration |
| `P7` | Phase 7 testing |

---

## Phase 0 — Foundation (COMPLETE)

| Owner | Files |
|---|---|
| `P0` | `docs/OWNERSHIP.md`, `docs/ROADMAP.md`, `frontend/css/tokens.css`, `.gitignore`, git init |

---

## Wave 1 — Platform (A01–A10)

| ID | Owns | Responsibility |
|---|---|---|
| **A01** | `frontend/css/base.css`, `frontend/css/components.css`, `docs/ARCHITECTURE.md` | Design system primitives: reset, typography scale, buttons, inputs, cards, badges, tables, utilities. One CSS system that **replaces** the old 4,824-line `redesign.css` pile. |
| **A02** | `frontend/js/components/shell.js`, `frontend/js/ui.js`, **`frontend/css/shell.css`** (added P0 — A01 flagged it had no owner; sidebar/topbar were unstyled), `docs/GLOSSARY.md` | Single app shell: sidebar, topbar, mobile menu, health pill, route mounting. `ui.js` = shared render helpers (icons, citations, spinners, toasts, empty/error states). |
| **A03** | `frontend/js/auth.js`, `frontend/js/api.js` | Auth session (Supabase + prototype), `#socius_session` handoff, token refresh, the **only** `fetch` caller in the app, mock mode `?mock=1`. |
| **A04** | `server/app.js`, `server/index.js`, `server/config.js`, `server/constants.js`, `server/middleware/errors.js`, `package.json`, `vercel.json` | Server bootstrap, DI seam `createApp({db,ai,vector,auth})`, health, config, error envelope, npm scripts. |
| **A05** | `docs/API_CONTRACT.md`, `README.md` | Contract v2 — request/response shapes for **every** endpoint including the new media/adaptive/share ones. Source of truth for frontend↔backend. |
| **A06** | `server/store/db.js`, `server/store/sqlite.js`, `server/store/pg-schema.sql`, `scripts/migrate-db.mjs`, `scripts/migrate-supabase.mjs` | 3-engine facade, schema v8 (adds `source_conversions`, `difficulty_levels`, `shares`), migrations, RLS policies. |
| **A07** | `server/middleware/auth.js`, `server/routes/auth.js` | `requireAuth`, ownership guards, `resolveScope`, login/refresh. |
| **A08** | `server/routes/sources.js`, `server/services/extract/pdf.js`, `extract/pptx.js`, `extract/webpage.js`, **`extract/docx.js` (NEW)**, `server/services/organizer.js` | Upload pipeline + all extractors. DOCX is new. |
| **A09** | `server/services/chunker.js`, `server/services/events.js` | Chunking + activity/event recording. |
| **A10** | `server/store/vectorStore.js`, `vectorProvider.js`, `sqlite-vector.js`, `scripts/reindex.js` | Chroma / Chroma-Cloud / SQLite fallback selection + reindexing. |

---

## Wave 2 — AI core (A11–A20)

| ID | Owns | Responsibility |
|---|---|---|
| **A11** | `server/services/aiRouter.js` **(NEW)**, `server/services/nimChat.js` | **Track D#1 multi-model.** Provider-agnostic router: task → model (embed / tutor / assess), timeouts, retry, fallback, cost logging. `nimChat.js` becomes one driver behind the router. |
| **A12** | `server/services/embeddings.js` | Embedding calls, batching, error mapping. |
| **A13** | `server/services/retrieval.js` | **Track D#2 source grounding.** Retrieval, scoring, dedupe, filter, citation building from stored metadata only. |
| **A14** | `server/services/tutorService.js`, `server/services/studyAdvice.js`, `server/routes/tutor.js` | Grounded tutor + deterministic intent routing. |
| **A15** | `server/services/prompts.js`, `server/services/personalization.js` | Prompt library + injection hardening + learner-preference context. |
| **A16** | `server/services/summarizer.js` **(NEW)** | **From diagram:** smart shortening — paragraph → 1–2 sentences *without losing content*. Lossless-ish abstractive compress. |
| **A17** | `server/services/quizService.js`, `server/routes/quiz.js` | Quiz generation from material, difficulty tagging. |
| **A18** | `server/services/grading.js` **(NEW)**, `server/services/learner.js` | Deterministic grading + **Track D#4 learner model** mastery inference. |
| **A19** | `server/services/flashcardService.js`, `server/routes/decks.js` — ⚠️ **`routes/flashcards.js` does not exist**: `flashcardsRouter` is exported from `decks.js` and mounted at `/api/flashcards` by `app.js` (P0 corrected; do not create a second router) | Flashcard generation, decks, review states. |
| **A20** | `server/routes/learner.js`, `server/services/onboarding.js`, `server/services/studyAdvice.js` *read-only* | Progress endpoint, onboarding interview, learner profile reads. |

---

## Wave 3 — Frontend pages (A21–A30)

Each page agent owns **exactly three files**: its `.html`, its `js/pages/*.js`, its `css/*.css`.
They may **read** `shell.js`, `ui.js`, `api.js`, `auth.js`, `tokens.css`, `components.css`.

| ID | Owns |
|---|---|
| **A21** | `frontend/index.html`, `frontend/js/pages/landing.js`, `frontend/css/landing.css` — pixel-art identity, pink/blue/white · **PLUS entry/auth pages**: `frontend/login.html`, `frontend/js/pages/login.js`, `frontend/css/login.css` (added P0: was unassigned — `auth.js#LOGIN_PATH` redirects to `login.html`) |
| **A22** | `frontend/dashboard.html`, `frontend/js/pages/dashboard.js`, `frontend/css/dashboard.css` |
| **A23** | `frontend/library.html`, `frontend/js/pages/library.js`, `frontend/css/library.css` |
| **A24** | `frontend/session.html`, `frontend/js/pages/session.js`, `frontend/css/session.css` |
| **A25** | `frontend/study.html`, `frontend/js/pages/study.js`, `frontend/css/study.css` — **one** chat UI, never two |
| **A26** | `frontend/quiz.html`, `frontend/js/pages/quiz.js`, `frontend/css/quiz.css` |
| **A27** | `frontend/flashcards.html`, `frontend/js/pages/flashcards.js`, `frontend/css/flashcards.css` |
| **A28** | `frontend/progress.html`, `frontend/js/pages/progress.js`, `frontend/css/progress.css` |
| **A29** | `frontend/planner.html`, `frontend/js/pages/planner.js`, `frontend/css/planner.css` |
| **A30** | `frontend/profile.html`, `frontend/js/pages/profile.js`, `frontend/css/profile.css` |

**Shared read-only:** `frontend/js/components/material-import.js`, `session-form.js`, `scope-select.js` — owned by **A23** (library is their primary consumer). Others request changes via HANDOFF.

---

## Wave 4 — Features (A31–A40)

| ID | Owns | Responsibility |
|---|---|---|
| **A31** | `server/services/adaptive.js` **(NEW)**, `server/routes/adaptive.js` **(NEW)** | **Track D#3:** the 4 difficulty levels from the diagram. Deterministic mastery → level assignment → level-appropriate question selection. |
| **A32** | `server/services/planner.js` **(NEW)**, `server/routes/planner.js` **(NEW)** | Study plan generation on the server (replaces client-side-only logic). |
| **A33** | `server/routes/advice.js` **(NEW)** | "What should I revise next" endpoint over stored evidence. |
| **A34** | `server/routes/sources.js`, `server/services/chunker.js`, `server/services/extract/*.js` | **P0-reassigned (was "onboarding HTTP surface" — that surface already exists in `routes/profile.js` and A20 rebuilt the service in W2, so the old row would have been a dead-file refactor colliding with A35).** Now: **close backlog #1 (HIGH), #2, #27** — wire `sourceId`/`sourceKind` into `chunkSegments` and spread `...(c.metadata)` so `section`/`page`/`charStart`/`ordinal`/`timecode` actually reach citations; emit heading hints from extractors; fix the `"null slides"` sizeLabel. **A38/A39 will HANDOFF you their media interfaces — do not build their ingest.** |
| **A35** | `server/routes/profile.js` (extend), `server/services/personalization.js` *owned by A15 — coordinate* | Stated-vs-inferred preferences API. |
| **A36** | `frontend/viewer.html`, `frontend/js/components/file-viewer.js`, `frontend/css/viewer.css`, `server/routes/viewer.js` **(NEW)** | **From diagram:** open docx/pdf/ppt *inside* the app. |
| **A37** | `frontend/js/components/share.js`, `frontend/css/share.css`, `server/routes/share.js` **(NEW)** | **From diagram:** share ppt/doc/site → our app (Web Share API + deep link). |
| **A38** | `server/services/media/youtube.js` **(NEW)**, `server/routes/media.js` **(NEW)** | **From diagram:** YouTube → transcript → chunks. |
| **A39** | `server/services/media/ocr.js` **(NEW)**, `server/services/extract/image.js` **(NEW)** | **From diagram:** image → text. |
| **A40** | `server/routes/events.js` **(NEW)** | Activity feed / study history. |

---

## Wave 5 — Extension & polish (A41–A50)

| ID | Owns | Responsibility |
|---|---|---|
| **A41** | `extension/content/highlight.js`, `extension/content/highlight.css` | **From diagram:** highlight → **hover over word → button appears**. |
| **A42** | `extension/content/panel.js` | Floating briefing panel. |
| **A43** | `extension/background.js` | MV3 worker, relay, token refresh, session handoff. |
| **A44** | `extension/popup/popup.html`, `popup.css`, `popup.js` | Toolbar popup, settings, health. |
| **A45** | `extension/manifest.json`, `tests/extension-sync.test.js` **(NEW)** | **Your requirement: extension ↔ site fully synced.** Manifest, host perms, `#socius_session` contract test. |
| **A46** | `.env`, `.env.example`, `scripts/env-check.mjs` **(NEW)** | Env contract, local↔prod API discovery. |
| **A47** | `frontend/css/a11y.css` **(NEW)** + audit report `docs/A11Y.md` | Accessibility pass across all pages (own file, no cross-edits). |
| **A48** | `frontend/css/responsive.css` **(NEW)** + `docs/RESPONSIVE.md` | Mobile/tablet breakpoints in one owned file. |
| **A49** | `frontend/sw.js`, `frontend/js/perf.js` **(NEW)** | Caching, lazy-load, perf budget. |
| **A50** | `frontend/js/components/states.js` **(NEW)**, `docs/UX-COPY.md` | Loading / empty / error / validation states + copy deck. |

---

## Phase 6 — Integration (I01, I02)

| ID | Owns | Responsibility |
|---|---|---|
| **I01** | Everything, via HANDOFF-only edits | Seam resolution: cross-wave wiring, remove dead code, delete `_legacy-frontend/`, purge duplicate SVG sprites. |
| **I02** | `package.json`, `README.md`, `docs/` | Docs truth pass: kill the "no authentication" lie, align README with reality. |

## Phase 7 — Test (T01–T05)

| ID | Owns |
|---|---|
| **T01** | `tests/` backend regression vs. **195 baseline** |
| **T02** | `tests/` new-feature coverage (media, adaptive, share, viewer) |
| **T03** | `scripts/e2e-*.mjs` full user journey |
| **T04** | `scripts/eval-*.mjs` retrieval + system eval (**Track D#5**) |
| **T05** | Playwright browser suite for all 12 pages + extension sync |

---

## Conflict protocol

```
IF a file you must change is owned by another agent in YOUR wave:
    1. Do not touch it.
    2. Append to docs/HANDOFF.md:
       - FROM: A##   TO: A##
       - file path
       - exact change needed + why
    3. Continue with the parts you own.
IF a file is owned by an EARLIER wave:
    1. You may edit it directly.
    2. Record the edit in docs/HANDOFF.md (FROM: A## TO: you).
```
