# Socius AI — Glossary

The shared vocabulary for talking about this project. If a term is not here,
do not invent one — add it.

Each entry is one line of plain language. Words in `code style` are the exact
names you will see in the API (`docs/API_CONTRACT.md`), in the database, or in
the code.

---

## Material: what the student studies from

- **Source** — one piece of study material the student added: a PDF, a PowerPoint (`pptx`), or a saved web page (`webpage`). Its ID starts with `src_`.
- **Segment** — one natural part of a source: a page of a PDF, a slide of a presentation, or a paragraph of a web page. A segment remembers where it came from so a citation can point back at it.
- **Chunk** — one searchable piece of a segment's text (about 800 characters, with a little overlap so a sentence is not cut in half). Chunks are the units the search index stores: retrieve a chunk, cite its source.
- **Scope** — the material an AI answer is allowed to look at: everything the student has, an explicit list of sources, or one study session's sources. Scope is enforced on the server, not just highlighted in the UI.
- **Seed** — the small built-in demo material (`data/demo-seed.json`, three biology pages, marked `origin: "seed"`) given to a new account and to an empty fallback index so the app always has something to read from.

## Ways of studying

- **Session** — a named collection that groups material for one purpose, such as a course or an exam. A source that belongs to no session lives in "Unsorted"; IDs start with `ses_`.
- **Deck** — a saved set of flashcards on one topic, optionally inside a session, that the student reviews over time; IDs start with `deck_`.
- **Card** — one flashcard: a question (`front`), an answer (`back`), its citations, and a review state of `new`, `known`, or `review`.
- **Quiz** — a set of multiple-choice questions on one topic generated from the student's material. The correct answers stay on the server; IDs start with `quiz_`.
- **Attempt** — one full submission of a quiz's answers, graded on the server by comparing text (no AI involved). Submitting the same quiz twice returns the first attempt instead of creating a second one.

## The learner

- **Learner profile** — the record of who the student is and how they want to learn: interests, goals, purpose, explanation style, and self-reported subject familiarity.
- **Stated vs inferred** — `stated` means the student said it (typing it themselves or confirming it during onboarding); `inferred` means the app guessed it from their activity. Both are shown with their source, and only `stated` items are trusted.
- **Mastery** — how well the student is doing on one topic, calculated as `correct answers ÷ questions attempted`. No machine learning: anyone can check the number by hand.
- **Level 1–4** — how hard the next questions for a topic are, from level 1 (easiest) to level 4 (hardest). The level is chosen deterministically from mastery over that topic; the quiz request's `difficulty` field is how a level is handed to the server today.

## Evidence

- **Citation** — the reference that shows where an answer's evidence came from: `sourceId`, `type`, `title`, `url`, `location` (page, slide, or paragraph), `excerpt`, and `score`. Citations are built only from passages that were actually retrieved — the AI never supplies a filename or page number.
- **Excerpt** — the exact snippet of retrieved text a citation points at (up to ~300 characters), shown when a citation chip is opened.
