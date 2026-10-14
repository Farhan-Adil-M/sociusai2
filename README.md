# Socius AI

AI study companion — Track D, Personalized Tutoring & Adaptive Learning.
Upload PDFs / PowerPoint slides / webpage text, ask questions **grounded in your own materials** with verifiable citations, generate quizzes, and watch a deterministic learner model adapt question difficulty to your performance.
When a question isn't covered by your materials, the tutor says so instead of guessing and suggests up to 4 real topics from your material to ask about next (also shown in the browser extension's briefing panel).

Full API specification: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) — the shared contract between backend (`server/`, OpenCode) and frontend (`frontend/`, Freebuff).

## Learner profile & personalisation (new)

- **What it is:** a short conversational intro on the Study page (interests, goals, why you're studying, preferred explanation style) that lets the tutor teach your way. The tutor still answers strictly from your own uploaded materials with citations — personalisation shapes style and examples only, never facts.
- **Where:** the intro is offered on the Study page while unused (skippable); a **Profile** page lets you view/edit everything anytime, with `stated` vs `inferred` badges and a delete/restart button.
- **Privacy:** preferences are stored in the app's local SQLite database to personalise learning. They are never sent anywhere except to the configured NIM model as a compact teaching context. Single-user only (no authentication — one shared profile per install, like all learner data); the profile is deleted on server reset (e.g. a Vercel deployment resets on cold start).
- Full endpoint details: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md), § "v1.4 — Learner profile, onboarding & personalisation".

## Requirements

- Node 24.x (developed and verified on 24–26; serverless tests target 24.x — on 26 the pdfjs polyfill in `api/polyfill.js` is a no-op). Uses built-in `node:sqlite`, `node:test`, `--env-file`.
- An NVIDIA NIM API key ([build.nvidia.com](https://build.nvidia.com))
- A ChromaDB: either **Chroma Cloud** (preferred) or the **local server** set up once below

## Setup

```bash
npm install                    # backend dependencies
cp .env.example .env           # then fill in NIM_API_KEY (and Chroma Cloud keys if you have them)
```

`.env` is git-ignored — never commit it. The model IDs in `.env.example` were verified live against our account on 2026-10-12; do not swap them without re-running the checks below.

### Option A — Chroma Cloud (preferred)

Create a project at [cloud.trychroma.com](https://cloud.trychroma.com), then put its credentials in `.env`:

```
CHROMA_API_KEY=...   CHROMA_TENANT=...   CHROMA_DATABASE=...
```

### Option B — Local Chroma server (fallback, used when the above are empty)

One-time setup (needs Python 3 — this is the only place Python appears; all application code is JavaScript):

```bash
python3 -m venv .venv
.venv/bin/pip install chromadb
```

Start it (keep this terminal open, or run it in the background):

```bash
.venv/bin/chroma run --path data/chroma --port 8100
```

## Run

```bash
# terminal 1 — vector database (local option only; skip if using Chroma Cloud)
.venv/bin/chroma run --path data/chroma --port 8100

# terminal 2 — the app server (also serves the frontend at http://localhost:3000)
npm start            # or: npm run dev   (restarts on file changes)
```

Open http://localhost:3000 — `GET /api/health` shows whether sqlite, Chroma, and NIM are all reachable. To open it from another device on your LAN, set `BIND_HOST` in `.env` (see “Exposure policy” below).

**Exposure policy:** by default the server binds to `127.0.0.1` — this machine only. The app has **no authentication**: never port-forward it or put it behind a public URL; that requires an approved authentication/rate-limiting design first. On a trusted local network you may opt in by setting `BIND_HOST` in `.env` to your LAN IP (or `0.0.0.0`) and restarting — the startup log then prints the `http://<lan-ip>:<port>` URLs to open from other devices, and anyone on that network can upload, delete data, and spend NIM tokens.

## Storage architecture

- **Structured records** (sessions, sources, decks, quizzes, attempts, learner progress, profiles, events) live in one database selected by configuration: the local `node:sqlite` file at `data/app.db` by default (auto-migrating, idempotent, version-tracked), or a **hosted Turso/libSQL** database when `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are configured. Hosted schema is applied once with `npm run migrate` — the server refuses to boot against a behind-schema hosted database instead of racing migrations on every serverless invocation.
- **ChromaDB** remains the vector store (embeddings, chunks, retrieval metadata) behind the existing provider switch — local server, Chroma Cloud, or the SQLite fallback. Source IDs and session scope tie the two stores together.
- **Original uploaded binaries are not retained** — text is extracted and stored (`source_segments`), which is what makes `npm run reindex` possible without re-uploading. There are two upload paths, each with its own size cap: the multipart API path (`POST /api/sources/upload`) is capped by the platform request-body limit on serverless (~4.5 MB) and by `MAX_UPLOAD_MB` (25 by default) elsewhere; the direct-to-storage path (below) is capped by `MAX_STORAGE_UPLOAD_MB` (25 by default).

## Deploying to Vercel (cloud demo)

```
vercel login  →  vercel link --yes  →  vercel deploy --prod --yes
```

- `api/index.js` mounts the same Express app; `vercel.json` routes `/api/*` and app pages to it (60s max duration for long model calls).
- Set these env vars in the Vercel dashboard/CLI: `NIM_API_KEY`, `NIM_BASE_URL`, `NIM_CHAT_MODEL`, `NIM_ASSESS_MODEL`, `NIM_EMBED_MODEL`, `RAG_MIN_SIMILARITY`, `RAG_RELATIVE_KEEP`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MAX_UPLOAD_MB` (keep well below 4 on serverless — it only governs the multipart path, whose request bodies Vercel caps anyway), `MAX_STORAGE_UPLOAD_MB` (optional, default 25 — the direct-to-storage cap).
- **Upload size on the cloud demo — two paths**: Vercel enforces a platform request-body cap (~4.5 MB) on the multipart API path (`POST /api/sources/upload`) BEFORE our code runs — even if `MAX_UPLOAD_MB` were raised, the platform rejects oversized multipart bodies with its own generic 413 (plain text, not our JSON envelope), which the frontend recognises and explains. For files larger than that, the frontend switches to the **direct-to-Supabase-Storage path**: the browser uploads the file straight to the Supabase Storage bucket `study-sources`, then calls `POST /api/sources/storage-ingest` with the object path; the server fetches the object back with the user's own JWT and runs the normal pipeline. This path bypasses the Vercel body cap and is limited by `MAX_STORAGE_UPLOAD_MB` (25 MB by default). It requires `SUPABASE_URL` + `SUPABASE_ANON_KEY` (auth must be in supabase mode — the route needs the user's request token) and a `study-sources` storage bucket the authenticated user can write to.
- **Vector store**: Chroma Cloud credentials (`CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE`) are used when present — the local venv Chroma server cannot run on Vercel. Without them the app automatically falls back to a SQLite-backed vector store (`server/store/sqlite-vector.js`): the same chunks and embeddings, searched with cosine similarity in JavaScript (distance = 1 − cosine, so every evidence rule behaves identically). Force a choice with `VECTOR_STORE=chroma|sqlite`.
- **Demo seeding**: with the fallback store, every cold start begins empty, so `api/index.js` seeds the committed demo corpus (`data/demo-seed.json`) once per instance — embeddings are computed live via NIM, so the deployment always opens with a populated, answerable library (source appears in the library as "origin: seed").
- Two honest differences from the laptop: SQLite there is **ephemeral** (`/tmp` resets on cold starts — uploaded sources, sessions, and seeded vectors are not durable without a hosted DB), and multipart uploads are capped at ~4.5 MB (larger files work through the direct-to-Supabase-Storage path above, capped at `MAX_STORAGE_UPLOAD_MB`). For the full-fidelity demo, `npm start` on this laptop remains the primary environment.
- **Observed limitation (2026-10-13):** Vercel can route consecutive requests to different warm execution environments, each with its own private `/tmp`. Short flows (upload → ask → quiz) passed live repeatedly; longer multi-step flows eventually hit a "not found" because a session/source lives on another environment. There is no platform setting to pin instances — the real fix is a hosted database (e.g. Turso/libSQL), which needs your approval for the new dependency; Chroma Cloud alone does not fix it (sessions/sources live in SQLite).

## Test

```bash
npm test             # 195 offline tests, ~3s (195/195 as of 2026-10-14): chunking, extraction, learner model, grading, sessions, decks, retrieval eval, storage-ingest, full HTTP API loop
npm run eval         # live retrieval evaluation against the running server (fixed eval set, prints an honest report)
npm run e2e          # real-services smoke: upload → scoped tutor → quiz → grade → organised session → saved deck (needs server + Chroma running)
```

Live end-to-end checks (need a running server + Chroma):

1. Upload a text-based PDF → it appears in the sources list with its page count.
2. Ask a question on the Study page → the answer cites real pages from that PDF.
3. Generate a quiz → no answers are visible before you submit; after submitting you see the key, explanations, and your updated mastery.
4. Restart the server (`npm start` again) → your progress is still there.

## Rebuilding the vector index

Required only after changing `NIM_EMBED_MODEL` (vectors from different models are incompatible):

```bash
npm run reindex      # re-embeds from the extracted text already stored in SQLite — no re-uploading
```

## Model verification (do this before a demo if anything was changed)

Catalog visibility ≠ account access — many public model IDs return 404 on our account. Verified working on our account:

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
docs/API_CONTRACT.md   shared API contract (source of truth for both agents; v1.1 = sessions + decks)
server/                backend — Express, modular services, SQLite, ChromaDB client
frontend/              frontend — HTML/CSS/vanilla JS (owned by the frontend agent)
scripts/reindex.js     vector index rebuild
scripts/e2e-smoke.mjs  real-services loop smoke (npm run e2e)
tests/                 node:test suite (runs offline)
data/                  runtime data: SQLite file, local Chroma storage (git-ignored)
```

v1.1 additions: persistent **study sessions** (organise sources; AI suggests placement; manual choices always win) and **saved flashcard decks** grouped by session with persisted review status. Session scope is enforced server-side for tutoring, quizzes, and deck generation — see the contract's v1.1 section.

## Known limitations (honest list)

- Login is a visual prototype — there is no real authentication, and the server is localhost-only by design.
- Text-based PDFs and .pptx only; scanned/image-only documents are rejected with a clear message (no OCR).
- The tutor answers each question independently (no multi-turn conversation memory).
- Flashcard decks persist with per-card "known / review" status; spaced-repetition scheduling is not implemented.
