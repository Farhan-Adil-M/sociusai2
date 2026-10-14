# Socius2 — Build Roadmap

Baseline: **195/195 tests passing** (`npm test`), established in Phase 0.

| Phase | Agents | Status |
|---|---|---|
| P0 Foundation | — | ✅ complete |
| W1 Platform | A01–A10 | ⬜ |
| W2 AI core | A11–A20 | ⬜ |
| W3 Pages | A21–A30 | ⬜ |
| W4 Features | A31–A40 | ⬜ |
| W5 Extension+polish | A41–A50 | ⬜ |
| P6 Integration | I01–I02 | ⬜ |
| P7 Test | T01–T05 | ⬜ |

## Wave gate rule
Do not start wave N+1 until wave N reports green AND `npm test` ≥ baseline (195).

## ⚠️ How to load a skill (IMPORTANT — affects every agent)

52 skills are installed at `~/.agents/skills/<name>/SKILL.md` and registered in
`~/.agents/.skill-lock.json`. **The `skill` tool does NOT reliably see them** — its
session registry was snapshotted mid-install and only exposes ~13 of the 52, so
`skill(id=...)` returns "Unable to load skill" for most names.

**Do this instead — it is authoritative and always works:**

```bash
cat ~/.agents/skills/<skill-name>/SKILL.md
# plus any referenced files in that directory
ls ~/.agents/skills/<skill-name>/
```

If `skill` happens to work for a name, fine. If it errors, **fall back to the file
immediately** — do not report the skill as missing. A09 hit this and recovered
correctly by following AGENTS.md conventions.

Full list of installed skills: `ls ~/.agents/skills/`

## Integration backlog (collected from agent reports — resolve in Phase 6/7)

Items agents correctly filed rather than fixing in someone else's file. **I01 owns sweeping this list.**

| # | Item | From → to | Phase |
|---|---|---|---|
| 1 | `sources.js#persistSource` must pass `{sourceId, sourceKind}` to `chunkSegments` **and** spread `...(c.metadata)` into vector metadata — until then `section`/`charStart`/`ordinal` never reach citations, and the `docx` chunk profile is never selected | A09 → A08 | **P6 (high)** |
| 2 | Extractors should emit `kind:'heading'` / `section` hints so the chunker stops guessing | A09 → A08 | P6 |
| 3 | `GET /api/health` reports `checks.chroma.backend: 'chroma'` even after falling back to SQLite — `createApp` spreads the provider at boot | A10 → A04 | P6 |
| 4 | YouTube citations have no timestamp — `toCitation` must copy `timecode` | A09 → A13 | P6 |
| 5 | Move 7 supplementary tokens (`--green-line`, `--bg-scrim`, `--pink-ink`, …) from `components.css` into `tokens.css` | A01 → A01 | P6 |
| 6 | Malformed JSON body returns `500 INTERNAL` instead of `400 VALIDATION_ERROR` | A04 noted | P6 |
| 7 | **Supabase DB is at schema v7; code expects v8 → `npm start` refuses to boot.** Run `npm run migrate:supabase` (idempotent, additive) | A06 → **user** | **P7** |
| 8 | Five vector-store test cases A10 verified only with throwaway scripts (gate was pinned at exactly 195) | A10 → T01/T02 | P7 |
| 9 | Study-event call sites still unwired: `source_uploaded` (A08), `session_opened` (sessions route), `events` feed route (A40) | A09 → A08, A40 | P6 |
| 10 | **Diagram's "convert into docx" (PDF/DOC → docx) not implemented** — needs a converter dependency (LibreOffice/pandoc). `.docx` ingest itself works. **Needs your decision.** | A08 → user | **decision** |
| 11 | `npm test` prints 7 `route … not yet implemented` lines per process — normal until Wave 4 mounts land | A04 | P6 |
| 12 | ⚠️ **Contract contradiction:** `API_CONTRACT.md` v2.0 says `mastery = correct/total`, but Track D#4 requires **difficulty-weighted + recency-decayed** mastery (A18). They only agree when all questions share a difficulty. Decide: change the contract formula, or expose both. A31 must import `LEVEL_THRESHOLDS` from `learner.js`, not re-type them. | A18 → A05/A31 | **P6 (high)** |
| 13 | `prompts.js` builds `source="…"` from a possibly-untrusted webpage **title** (injection through an attribute) | A13 → A15 | P6 |
| 14 | `aiRouter` retry/backoff are module constants, not env-tunable — needs `AI_RETRY_ATTEMPTS` / `AI_RETRY_BACKOFF_MS` knobs in `config.js` | A11 → A04 | P6 |
| 15 | `reindex.js` comment `EMBED_BATCH = 32 // matches services/embeddings.js` is stale (now 16) | A12 → A10 | P6 |
| 16 | `decks.test.js` **intermittent** failure (`cardCount` 2 vs 3) — background auto-deck race in A19/A14's in-flight work. Seen by A11, A13, A18 independently. **Must be deterministic at the gate.** | A19/A14 | **P6 (high)** |
| 17 | 🚨 **`frontend/sw.js` does not exist** — `shell.js` registers a service worker that 404s → every page logs `Unsupported MIME type ('text/html')`. The app believes it has offline support and doesn't. | A25/A27 → **A49** | W5 |
| 18 | ⚠️ **`?mock=1` demo mode is broken for flashcards**: `mocks/fixtures.js` has no `GET /api/decks/due` (falls through to the deck-by-id matcher → 404) and its card PATCH **ignores `grade`**. Real mode fully verified. | A27 → A03/A05 (done) | **P6** |
| 19 | `tutor_asked` / `quiz_answered` **duplicate** the legacy `question` / `quiz` activity rows → the feed shows two rows per action. Kept deliberately (legacy rows are pinned by `tests/api.test.js`). A40 must decide what to render. | A14/A17/A20 → A40 | W4 |
| 20 | Contract "Frontend notes" ask for onboarding *on the study page*, but adding it recreates the legacy **second-chat** defect. A25 declined + filed a decision record. **Needs your call.** | A25 → user | **decision** |
| 21 | ⚠️ **A quiz is not resumable** — there is no `GET /api/quiz/:id`, so a page reload mid-quiz loses every question (the 409 replay only works because the quiz is still in memory). Contract-compliant, but a student who refreshes loses their work. | A26 → A05/A17 | **P6** |
| 22 | `?mock=1` quiz fixtures lack per-question `difficulty`/`estimatedMinutes`, so level badges vanish in demo mode — same root cause as #18 (stale `mocks/fixtures.js`) | A26 → A03 | P6 |
| 23 | ⚠️ **`DELETE /api/sessions/:id` does not exist** (not in contract, not in `routes/sessions.js`) and there is **no "complete" state** (enum is `active\|archived`). A24's Delete button honestly reports the 404 instead of pretending. Decide: add the endpoint or remove the button. | A24 → A05/A20 | **P6** |
| 24 | **`POST /api/share` has no `sessionId` field**, so "share *into a session*" can't be expressed — shared material always lands in My Materials. | A24 → A05/A37 | W4 |
| 25 | **`scope-select.js` never imported** by session page — the session *is* the scope (server-enforced), so importing it would be dead code (AGENTS.md forbids). Confirm intent. | A24 → A23 | P6 |
| 26 | `profile.js` reuses shell-owned `data-sign-out`, so `shell.js:252` binds `signOut()` to it **and** profile's own listener calls it → likely **double fire**. (A24 also caught: nav key is `'session'`, not `'sessions'` — my brief was wrong.) | found by P0 | P6 |
| 27 | ⚠️ **`sizeLabelFor` returns the literal string `"null slides"`** for `youtube`/`image` types — it only handles pdf/pptx/webpage/docx. Latent (those types can't be ingested until Wave 4), but it will surface the moment A38/A39 ship. | A22 → A05/A08 | W4 |
| 28 | 🎨 **Design question:** "Advanced" (level 4) is badged `.badge-accent` (**pink**), sitting next to amber "Needs revision" — pink marking the *best* level is questionable. Only 4 badge variants exist. | A22 → A01 | P6 |
| 29 | `ui.js` lacks `document` / `video` / `image` glyphs, so pages reuse `book`/`slides`/`eye` for docx/youtube/image. Three glyphs requested. | A22 → A02 | P6 |

## ⚠️ Wave operating notes (learned from Waves 1–2)

1. **Pick a unique port for any live-server test.** Two agents both defaulted to `:3999` and one agent's request was served by *another agent's* process against *their* temp DB. It cleaned up precisely what it created and re-ran isolated (`3973`–`3982`). **Use a port derived from your agent id**, e.g. `PORT=39${AGENT_NUM}` → A31 → `:3931`.
2. **Use an isolated `DATA_DIR` + `VECTOR_STORE=sqlite`** for live proofs so you never mutate a peer's database or the real `data/app.db`.
3. **Expect transient red.** During a wave, a peer's file is often momentarily 0 bytes or mid-write (`learner.js does not provide an export named 'applyAttempt'`). Before reporting a failure, **re-run**, and prove isolation by checking whether your own files are even imported by the failing test.
4. **Local Chroma on `:8100` may be stopped by a peer.** That is fine — A10's SQLite fallback engages automatically and is logged. Note it in your report rather than treating it as your bug.
5. **`npm run lint` may fail on a peer's in-flight file.** Run `node --check` on *your* files and report both results separately.

## Non-negotiables (from AGENTS.md)
- Vanilla JS / Express / ChromaDB / NIM. No frameworks without approval.
- Keys stay backend-side. Browser never touches Chroma or NIM directly.
- No speculative/empty modules. If it isn't implemented, it doesn't exist.
- Deterministic grading and mastery logic.
