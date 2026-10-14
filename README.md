# Socius AI

AI study companion — Track D, Personalized Tutoring & Adaptive Learning.

Upload PDFs / PowerPoint slides / webpage text, ask questions **grounded in your own materials** with verifiable citations, generate quizzes and flashcards, and watch a deterministic learner model adapt question difficulty to your performance.
When a question isn't covered by your materials, the tutor says so instead of guessing and suggests up to 4 real topics from your material to ask about next (also shown in the browser extension's briefing panel).

- **Grounded, not guessy.** Answers are built only from retrieved passages of your own material; citations (file, page/slide) come from stored metadata, never from the language model.
- **Real accounts.** Supabase Auth signs users in; the backend verifies the token on every private endpoint and keeps each user's material separate (contract v1.6).
- **One shared contract.** Frontend, backend, and browser extension all build against [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) (currently v2.0).
- **Beginner-friendly by design.** Vanilla HTML/CSS/JS frontend and a modular Express backend — no framework magic to learn.

## What's built, and what's next

Facts, so nothing here is oversold:

- **Built today:** the backend + HTTP API through contract **v1.6** (sources, tutoring, quizzes, learner model, sessions, decks, profile/onboarding, per-user auth), the browser extension (`#socius_session` handoff, page highlighting, briefing panel), the offline test suite, and the Vercel deploy path.
- **In progress:** the rebuilt frontend pages (`frontend/` currently holds only the design tokens `css/tokens.css`) and the **Wave 4** features specced in the contract (adaptive difficulty levels 1–4, planner, advice, share, in-app viewer, YouTube/OCR media, activity feed). Those are **planned, not shipped**.
- Roadmap and wave gates: [`docs/ROADMAP.md`](docs/ROADMAP.md). File ownership: [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md).

## Authentication (read this before exposing anything)

The app runs in one of two modes, chosen automatically from configuration:

| Mode | Chosen when | What it means |
|---|---|---|
| **`supabase`** | `SUPABASE_URL` + `SUPABASE_ANON_KEY` are set | Real sign-in. The browser (or extension) obtains a Supabase session; the **backend verifies each request's `Authorization: Bearer <token>`** and scopes all data to that user. |
| **`prototype`** | no Supabase envs (the default local demo) | **No sign-in.** Every request acts as one fixed dev user (`'default'`). This is **single-user only** — never put it on a public URL. |

- The backend is the only place API keys live; the browser never talks to ChromaDB or NVIDIA NIM directly.
- `GET /api/health` is the only public endpoint. Everything else returns `401 UNAUTHENTICATED` without a valid token in `supabase` mode.
- The extension uses the same accounts through `POST /api/auth/login` / `POST /api/auth/refresh`.
- Full rules: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) § "Authentication & ownership".

## Requirements

- **Node 24.x** (developed and verified on 24–26; the offline suite passes on 26). Uses built-in `node:sqlite`, `node:test`, and `--env-file` — no test framework and no bundler.
- An **NVIDIA NIM API key** ([build.nvidia.com](https://build.nvidia.com)).
- A **vector database**: Chroma Cloud (preferred) or a local Chroma server (setup below).

## Setup

```bash
npm install                 # backend dependencies
cp .env.example .env        # then fill in NIM_API_KEY (and Chroma/Supabase values if you have them)
```

`.env` is git-ignored — never commit it. The model IDs in `.env.example` were verified live against our account on 2026-10-12; do not swap them without re-running the model check below.

### Vector database

**Option A — Chroma Cloud (preferred):** create a project at [cloud.trychroma.com](https://cloud.trychroma.com) and set `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE` in `.env`.

**Option B — local Chroma server (fallback, used when the Cloud values are empty):** one-time setup needs Python 3 (the only place Python appears — all application code is JavaScript):

```bash
python3 -m venv .venv
.venv/bin/pip install chromadb
```

## Run

```bash
# terminal 1 — vector database (local option only; skip if using Chroma Cloud)
.venv/bin/chroma run --path data/chroma --port 8100

# terminal 2 — the app server (also serves the frontend at http://localhost:3000)
npm start            # or: npm run dev   (restarts on file changes)
```

`GET /api/health` reports whether the database, the vector store, and NIM are reachable, and which auth mode is active.

**Current UI status:** `frontend/` holds only the design tokens while the rebuild (Wave 3) lands the pages; until then the API works but page requests fall back to the landing catch-all (404 while no `index.html` exists). `npm start` on this laptop is the full-fidelity environment.

**Exposure policy:** the server binds to `127.0.0.1` (this machine only) by default. In `prototype` mode there is **no authentication** — never port-forward it or place it behind a public URL. On a trusted local network you can opt in by setting `BIND_HOST` in `.env` to your LAN IP (or `0.0.0.0`) and restarting; the startup log then prints the `http://<lan-ip>:<port>` addresses, and anyone on that network can upload, delete data, and spend NIM tokens. In `supabase` mode every private endpoint still requires a verified token, but a WAN address deserves firewall care anyway.

## Architecture overview

The project keeps responsibilities separate — one module, one job.

```
Browser (frontend/, extension/)              Node backend (server/)
  HTML / CSS / vanilla JS                      Express 5 routes  ─►  services (AI, retrieval, learner, …)
  fetch() to /api/… only                       │                         │
  (Supabase client for sign-in)                │                         ├─► SQLite / libSQL / Postgres  (structured records)
                                               │                         └─► ChromaDB or SQLite fallback  (embeddings + chunks)
                                               └─► NVIDIA NIM (chat + embeddings) — called from the backend only
```

- **`server/routes/`** — thin HTTP layer: parse/validate input, call services, shape responses and the error envelope.
- **`server/services/`** — the logic: extraction, chunking, embeddings, retrieval, tutoring, quiz/flashcard generation, deterministic grading and learner model, personalisation.
- **`server/store/`** — storage facades: one async database interface across `node:sqlite` / hosted libSQL / Supabase Postgres, plus the vector-store provider (Chroma / Chroma Cloud / SQLite fallback).
- **`server/middleware/`** — auth verification and the shared error envelope.
- **`frontend/`** — one app shell plus one module per page; the API client is the only file allowed to `fetch` the backend.
- **`extension/`** — MV3 browser extension; talks to the same API with the same tokens.

## Scripts

Every command below comes from `package.json` (nothing invented):

| Command | What it does |
|---|---|
| `npm start` | Run the server (`node --env-file=.env server/index.js`), serving the API and the static frontend. |
| `npm run dev` | Same, but restarts on file changes (`node --watch`). |
| `npm test` | Offline test suite (`node --test tests/`) — no network or Chroma needed. |
| `npm run e2e` | Real-services smoke run: upload → scoped tutor → quiz → grade → organised session → saved deck (needs the server + a vector store). |
| `npm run eval` | Live retrieval evaluation against a running server (fixed eval set; prints an honest report). |
| `npm run reindex` | Re-embed stored text after changing the embedding model (no re-uploading). |
| `npm run migrate` | Apply the schema to a hosted libSQL/Turso database once. |
| `npm run migrate:supabase` | Apply `server/store/pg-schema.sql` to Supabase Postgres. |

Extra end-to-end scripts have no npm alias and run the same way (they need a running server and, for the auth ones, a git-ignored `.env.e2e` with `E2E_BASE_URL` + two test accounts):

```bash
node --env-file=.env scripts/e2e-auth-isolation.mjs     # two users never see each other's data
node --env-file=.env scripts/e2e-storage-upload.mjs     # direct-to-Supabase-Storage upload path
node --env-file=.env scripts/e2e-extension-api.mjs      # extension relevance + briefing against a live server
```

## Environment variables

All are read once by `server/config.js`. Required unless marked optional.

| Variable | Default | Purpose |
|---|---|---|
| `NIM_API_KEY` | — (**required**) | NVIDIA NIM key. Backend-only; never sent to the browser. |
| `NIM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NIM endpoint. |
| `NIM_EMBED_MODEL` | `nvidia/nemotron-3-embed-1b` | Embedding model; changing it requires `npm run reindex`. |
| `NIM_CHAT_MODEL` | `nvidia/nemotron-3.5-lightning-30b-a3b` | Fast tutor model. |
| `NIM_ASSESS_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Stronger model for quizzes/flashcards. |
| `NIM_TIMEOUT_MS` | `45000` | Per-request model timeout. |
| `RAG_MIN_SIMILARITY` | `0.1` | Evidence floor for the tutor (lower-scoring passages are dropped). |
| `RAG_RELATIVE_KEEP` | `0.5` | Relative share of the strongest hit kept for retrieval. |
| `EXTENSION_MIN_SIMILARITY` | `0.8` | Minimum similarity for a page sentence to earn an extension highlight. |
| `CHROMA_API_KEY` / `CHROMA_TENANT` / `CHROMA_DATABASE` | — | Chroma Cloud credentials (preferred vector store). |
| `CHROMA_COLLECTION` | `socius_chunks` | Chroma collection name. |
| `CHROMA_LOCAL_HOST` / `CHROMA_LOCAL_PORT` | `localhost` / `8100` | Local Chroma server (fallback). |
| `VECTOR_STORE` | auto | Force `chroma` or `sqlite` (the fallback store). |
| `SUPABASE_URL` | — | Enables real auth and the hosted-Postgres mode. |
| `SUPABASE_ANON_KEY` | — | Public anon key; the backend verifies bearer tokens with it. |
| `SUPABASE_DB_URL` | — | Supabase Postgres connection string (hosted structured data). |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | Hosted libSQL database (alternative to local SQLite). |
| `SQLITE_DB_PATH` | `data/app.db` | Local database file path (serverless defaults to `/tmp/socius-app.db`). |
| `DATA_DIR` | `data` | Runtime data directory. |
| `PORT` | `3000` | HTTP port. |
| `MAX_UPLOAD_MB` | `25` | Multipart upload cap. |
| `MAX_STORAGE_UPLOAD_MB` | `25` | Direct-to-Supabase-Storage upload cap. |
| `BIND_HOST` | `127.0.0.1` | Interface to bind (see "Exposure policy"). |
| `EVAL_BASE_URL` / `SMOKE_BASE_URL` | `http://localhost:3000` | Targets for `npm run eval` / `npm run e2e`. |
| `E2E_BASE_URL` + `E2E_U1_*` / `E2E_U2_*` | — | Target + two test accounts for the extra e2e scripts (kept in the git-ignored `.env.e2e`). |

> `.env.example` is owned by another agent (A46) and does not yet list the `SUPABASE_*` or `EXTENSION_MIN_SIMILARITY` variables; the values above are the contract it must match.

## Test, eval, and end-to-end

```bash
npm test        # offline suite — 195/195 passing as of 2026-10-14 (about 2–3 seconds)
npm run eval    # live retrieval evaluation against a running server
npm run e2e     # real-services smoke: upload → tutor → quiz → grade → session → deck
```

`npm test` needs no network and no Chroma. `eval` and `e2e` need a running server (and a vector store) plus a filled-in `.env`.

Manual end-to-end check (needs a running server + vector store):

1. Upload a text-based PDF → it appears in the sources list with its page count.
2. Ask a question on the Study page → the answer cites real pages from that PDF.
3. Generate a quiz → no answers are visible before you submit; after submitting you see the key, explanations, and your updated mastery.
4. Restart the server → your progress is still there (persistence depends on the database engine; the Vercel demo's filesystem is ephemeral).

## Deploying to Vercel

```bash
vercel login
vercel link --yes
vercel deploy --prod --yes
```

- `api/index.js` mounts the same Express app; `vercel.json` routes `/api/*` and the pages to it (60s max duration for long model calls).
- Set these env vars in the Vercel dashboard/CLI: `NIM_API_KEY`, `NIM_BASE_URL`, `NIM_CHAT_MODEL`, `NIM_ASSESS_MODEL`, `NIM_EMBED_MODEL`, `RAG_MIN_SIMILARITY`, `RAG_RELATIVE_KEEP`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MAX_UPLOAD_MB` (keep well below 4 on serverless — the platform caps request bodies anyway), and `MAX_STORAGE_UPLOAD_MB` (optional, default 25).
- **Uploads on the cloud demo — two paths.** Vercel caps multipart request bodies (~4.5 MB) *before* our code runs, so for larger files the frontend uploads directly to the Supabase Storage bucket `study-sources` and then calls `POST /api/sources/storage-ingest` with the object path; the server fetches the object back with the user's own JWT (row-level security keeps it owner-safe) and runs the normal extraction pipeline. That path needs `SUPABASE_URL` + `SUPABASE_ANON_KEY` and is capped by `MAX_STORAGE_UPLOAD_MB` (25 MB default).
- **Vector store.** Chroma Cloud credentials are used when present; without them the app falls back to a SQLite-backed vector store (`server/store/sqlite-vector.js`) that scores with cosine similarity in JavaScript (`distance = 1 − cosine`, so every evidence rule behaves identically). Force a choice with `VECTOR_STORE=chroma|sqlite`.
- **Demo seeding.** With the fallback store, cold starts begin empty, so `api/index.js` seeds the committed demo corpus (`data/demo-seed.json`) once per instance — embeddings are computed live via NIM, so the deployment always opens with a populated, answerable library.
- Two honest differences from the laptop: serverless SQLite is **ephemeral** (`/tmp` resets on cold starts — uploads, sessions, and seeded vectors are not durable without a hosted database), and multipart uploads are capped at ~4.5 MB.
- **Observed limitation (2026-10-13):** Vercel can route consecutive requests to different warm execution environments, each with its own `/tmp`; longer multi-step flows can hit a "not found" when a session/source lives on another instance. The real fix is a hosted database (Turso/libSQL or Supabase Postgres) — Chroma Cloud alone does not fix it, because sessions and sources live in the structured database.

## Storage architecture

- **Structured records** (sessions, sources, decks, quizzes, attempts, learner progress, profiles, events) live in one database selected by configuration: local `node:sqlite` at `data/app.db` (auto-migrating, idempotent, version-tracked) by default, or a hosted libSQL/Postgres database when configured. The server refuses to boot against a behind-schema hosted database instead of racing migrations on every serverless request.
- **ChromaDB** (or the SQLite fallback) stores searchable passages and their source metadata behind the provider switch. Source ids and session scope tie the two stores together.
- **Original uploaded binaries are not retained** — text is extracted and stored (`source_segments`), which is what makes `npm run reindex` possible without re-uploading.

## Rebuilding the vector index

Required only after changing `NIM_EMBED_MODEL` (vectors from different models are incompatible):

```bash
npm run reindex     # re-embeds from the extracted text already stored — no re-uploading
```

Stop the server first. Startup refuses a mismatched index and tells you to reindex.

## Model verification (before a demo, if anything changed)

Catalog visibility ≠ account access — many public model IDs return 404 on our account. Verify the configured models answer:

```bash
node --env-file=.env -e "
import('./server/services/embeddings.js').then(async ({embedQuery}) => {
  console.log('embed dims:', (await embedQuery('ping')).length);
  const {chatCompletion} = await import('./server/services/nimChat.js');
  console.log('chat:', await chatCompletion([{role:'user',content:'One sentence, please.'}]));
});"
```

Expected: `embed dims: 2048` and one sentence back. Models in use: `nvidia/nemotron-3-embed-1b` (embeddings), `nvidia/nemotron-3.5-lightning-30b-a3b` (tutor), `nvidia/nemotron-3-super-120b-a12b` (quizzes/flashcards).

## Project layout

```
api/                 Vercel serverless entry (mounts the same Express app)
server/              backend — routes, services, storage facades, middleware
frontend/            rebuilt frontend — HTML/CSS/vanilla JS (Wave 3; currently css/tokens.css)
extension/           MV3 browser extension (highlight + briefing, session handoff)
tests/               offline node:test suite (runs without network)
scripts/             reindex, migrations, eval, and end-to-end runs
docs/                API contract, ownership registry, roadmap, handoff log
data/                runtime data: database file, local Chroma storage, demo seed (git-ignored except demo-seed.json)
```

### `_legacy-frontend/` — retired in Phase 6

The old Socius AI frontend, kept read-only during the rebuild so we could compare layout, wording and edge cases. It was **deleted in Phase 6 (integration)**, as planned, once all twelve rebuilt pages were verified. It was never imported at runtime. To read the old code for reference:

```bash
git show 5eb9501 -- _legacy-frontend
```

## Known limitations (honest list)

- **Prototype mode has no authentication** and is single-user by design. Use `supabase` mode for real accounts (or keep the app on localhost).
- **Text-based PDF / PPTX / webpage only today.** Scanned, image-only documents are rejected with a clear message; OCR and YouTube ingestion are **planned (Wave 4)**, not available.
- **The tutor answers each question independently** — no multi-turn conversation memory.
- **Decks persist per-card `known` / `review` status; spaced-repetition scheduling is not implemented.**
- **Serverless persistence is ephemeral** without a hosted database (see "Deploying to Vercel").
- **The Wave 4 endpoints in the contract are planned, not shipped** — do not build against them as if they exist.
