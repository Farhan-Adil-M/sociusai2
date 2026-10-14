# UX copy — Socius2

The words the interface says, where they live, and the rules that keep them
consistent. This is a reference for anyone writing a string, and the checklist
a reviewer uses to check one.

The copy is not decoration. This app's central promise is that it never
invents an answer, so the wording has to carry the same standard: a learner is
told what actually happened, in words they can act on, and is never flattered
with a number the system did not measure.

---

## 1 · Voice

Write like a capable tutor talking to someone who is busy and possibly stuck.

- **Plain, short, specific.** "That video has no captions to read, so there is
  nothing to study from it. Try a video with subtitles."
- **Address the learner, not the system.** Say what *they* can do next. Not
  "An error occurred" and not "The extraction pipeline returned no segments".
- **Never blame the user.** Not "Invalid file". Not "You entered the wrong
  thing". The file was not supported; the thing was not accepted.
- **Name the object.** "That image", "that link", "this material" — the learner
  should know which thing failed without counting.
- **No jargon in the message body.** Contract codes are a backend concept. A
  learner never sees `OCR_UNAVAILABLE`, `NIM_TIMEOUT` or `EMPTY_CONTENT`.

---

## 2 · The two-part error shape

Every error block is **a short heading plus one sentence**, and the two do
different jobs.

| Part | Job | Rule |
| --- | --- | --- |
| Heading (`ERROR_TITLES`) | What happened | A short fragment, **no trailing period** |
| Body (the message) | Why, and what to do | **One sentence**, ends with a period, gives an action where one exists |

Headings are fragments, not full sentences — that is why they carry no final
period while bodies do. Both are in
`frontend/js/components/states.js`, which is the only place a page should get
its wording from.

```js
ERROR_TITLES.NO_TRANSCRIPT = 'That video has no captions'
EXTRA_CODE_COPY.NO_TRANSCRIPT =
  'That video has no captions to read, so there is nothing to study from it. Try a video with subtitles.'
```

Note what that body does: states the fact, explains the consequence ("nothing
to study from it"), and offers a concrete alternative.

### Resolution order

`stateMessage(error)` picks a message in this order, and the order is the
point:

1. The **server's own message**, if it has one. It is the most specific
   explanation available and it is already written for people.
2. The contract **code table** in `ui.js#CODE_FALLBACKS`.
3. The extension table in `states.js#EXTRA_CODE_COPY`.
4. Otherwise the generic fallback.

Never a stack trace. A multi-line blob from a proxy 502 or a body-parser
failure is collapsed to one line and capped at 300 characters by
`states.js#readableText` before it can reach the screen.

---

## 3 · The honesty rules

These are not style preferences. Breaking one breaks the product's promise.

### A topic with no evidence is never "level 1"

```js
unassessedBadge() // → "Not assessed yet"
// title="No graded answers yet — this topic has not been measured."
```

A topic the learner has never answered a question about is **unassessed**. It
is not level 1, not 0%, not "needs work", and not "weak". Those all claim a
measurement that was never taken. The badge and its tooltip live in one
function so the sentence cannot drift between the four pages that show it.

### An action that already finished never offers "Try again"

`ALREADY_DONE_TITLES` covers `ONBOARDING_COMPLETE` and
`QUIZ_ALREADY_ANSWERED`, and `NO_RETRY_CODES` removes the retry button for
them. A second submit would double-record an answer the learner already gave.
These render as neutral information showing the stored result, not as a red
error block — because nothing went wrong.

### Failures are visible, never papered over

- A save that the server did not confirm is reported as a failure. Optimistic
  "Saved" copy before the response arrives is not allowed.
- An empty list is an **empty state**, an **unassessed** state, or an **error**
  state. Those are three different sentences and must not collapse into one
  another. An error disguised as "nothing here yet" hides a real problem.
- No fabricated counts, dates, percentages, streaks or progress bars anywhere.

---

## 4 · State copy

`frontend/js/components/states.js` is the single door for empty, loading,
error and confirmation blocks. Use it rather than hand-rolling markup, so a
page cannot invent a fourth phrasing of "nothing here yet".

Its rules, which the copy follows:

- Every state gets a **real heading** (`h2`–`h4`, default `h3`) — a block never
  leads with a bare sentence.
- **One body sentence.**
- A **retry is offered only when retrying can help.** If the action completed,
  there is nothing to retry.
- The **one 401 action** is `Sign in again`, which returns the learner to the
  page that failed. It is site-relative only — a scheme-relative
  `//evil.example.com` would turn the button into an open redirect, so
  anything that is not `/…` falls back to `/`.

### In-progress copy

Use a gerund with an ellipsis: `Adding…`, `Importing material`, `Working`.
The `aria-label` for the spinner defaults to `"Working"`.

---

## 5 · Buttons and actions

- **Verb first, sentence case, no trailing period.** `Add material`,
  `Add to My Materials`, `Try again`, `Sign in again`, `Cancel`.
- **Destructive actions name their object**: `Delete deck Cell biology`,
  `Delete bio.pdf`. The learner should never have to infer which row a
  confirmation is about.
- **Destructive buttons use the `danger` variant** and always sit behind a
  confirmation.
- **`Adding…`-style disabled labels** appear on the button that submitted, so a
  double-click cannot double-submit.

## 6 · Accessible names

`aria-label` text is how the interface reads aloud, so it describes rather than
names:

- **Verb first, descriptive, no trailing period.**
  `aria-label="Delete deck Cell biology"`, not `aria-label="delete"`.
- **State the value, don't just name the control.**
  `aria-label="72 percent, 18 of 25 correct"`, `aria-label="Mastery in Cell
  biology"`.
- Icon-only buttons must always have one. `Close dialog`, `Open navigation`,
  `Next section`, `Previous section`.

---

## 7 · Terminology

Use the project vocabulary in `docs/GLOSSARY.md`. In particular:

- **Material** — what the learner adds (a PDF, a deck of slides, a web page,
  an image, a video). Not "document", not "file", not "resource".
- **Deck** — a slide deck, and separately a flashcard deck. Context disambiguates.
- **Topic** — a unit of the syllabus that mastery is tracked against.
- **Mastery** — the measured level for a topic. Never "score", which is for a
  single quiz.
- **Not assessed yet** — the fixed phrase for no evidence.

---

## 8 · Review checklist

For any new or changed string:

1. Does the heading say what happened, as a fragment with no final period?
2. Does the body say why and what to do, as one sentence ending in a period?
3. Could a learner act on it without knowing any internal code?
4. Does it avoid blaming the learner?
5. If the data is missing, does it say **unassessed** rather than showing a
   zero, a level, or a judgement?
6. If the action already succeeded, is there **no** "Try again"?
7. Are there any invented counts, dates or percentages? There must be none.
8. Does the button/aria-label follow verb-first sentence case, and does a
   destructive action name its object?
9. Is the wording taken from `states.js` rather than re-invented on the page?

---

## 9 · Known gaps

- Wording is not covered by an automated test. `states.js` centralises it, but
  nothing asserts that a page did not hand-roll a competing sentence. A test
  that greps pages for inline empty/error markup would close this.
- The landing page's marketing copy is the one place with a different voice —
  it is the pixel-art identity and is intentionally warmer and more informal.
  It does not use the error-shape rules, and should not.
- Toast copy is looser than block copy: it is transient and space-constrained,
  so it sometimes omits the "what to do" half. That is a deliberate tradeoff,
  not an oversight, but it is not written down anywhere else.
