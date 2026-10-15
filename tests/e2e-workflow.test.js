// The learner's journey through the real HTTP surface — ONE app instance, ONE
// continuous session, every step fed by the state the previous one produced.
//
// The other suites test one module at a time. This one walks the path a student
// actually takes: add material → read it → ask the tutor → get an honest "not
// in your material" → sit a quiz → watch mastery move → review a flashcard →
// see all of it in the study history. That is how a wiring bug shows up: a
// field written by one route and read by another under a different name, an
// answer key that leaks on the way out, a level invented for a topic nobody
// has measured yet.
//
// Every AI call is stubbed (helpers' canned fixtures plus a per-step switch),
// so the suite stays offline, cheap and deterministic. No real NVIDIA NIM call,
// no real ChromaDB: the vector store is the in-memory stand-in from
// tests/helpers.js. The PDF is a REAL pdf-parse extraction — the same minimal
// text PDF the smoke script and the extractor unit test build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fakeVector, EMBEDDING, QUIZ_JSON, FLASHCARD_JSON } from './helpers.js';
import { ApiError } from '../server/middleware/errors.js';

// --- the study material ------------------------------------------------------
//
// Two pages of text-based PDF. The first line of each page is title-shaped, so
// extract/pdf.js keeps it as the page's `section` — that is what a citation
// carries as its section, and what the abstain path offers as a real topic.
// The wording deliberately avoids the words the stubbed quiz uses as answers
// ('Mitosis' / 'Two' / 'Nucleus'), so the answer-key assertions below can tell
// a leaked key apart from an ordinary choice.

const PAGE_HEADING = 'Photosynthesis And The Light Reactions';
const SECOND_HEADING = 'The Calvin Cycle And Carbon Fixation';
const PAGE_HEADINGS = [PAGE_HEADING, SECOND_HEADING];
const FILENAME = 'photosynthesis-cells.pdf';

// The answer key the stub hands the quiz generator (helpers.js exports the
// canned completion as a JSON string, so parse it here). A client must never
// see this; the test knows it only because it wrote the fixture.
const QUIZ_FIXTURE = JSON.parse(QUIZ_JSON);
const CHOICE_IDS = ['a', 'b', 'c', 'd'];
const CORRECT_ANSWERS = QUIZ_FIXTURE.questions.map((question) => question.answer);
const CORRECT_CHOICES = QUIZ_FIXTURE.questions.map((question) => CHOICE_IDS[question.choices.indexOf(question.answer)]);
const WRONG_CHOICE = 'd';

const PDF_PAGES = [`${PAGE_HEADING}

Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose. It takes place mainly in the chloroplasts of plant cells, and it is the reason most food chains begin with a plant.

Chlorophyll is the pigment that absorbs light, and it gives leaves their green colour. Water is split during the light-dependent stage, oxygen is released as a by-product, and the energy carriers ATP and NADPH are produced.

The light-dependent reactions happen in the thylakoid membranes, which are stacked inside the chloroplast. The thylakoid space holds a high concentration of protons, and that gradient drives the enzyme that makes ATP.

When a leaf is kept in the dark, the light-dependent reactions stop first and the sugar factory runs out of ATP within minutes. Chloroplasts also carry their own genetic material and ribosomes, which is one reason scientists think they were once free-living bacteria.`, `${SECOND_HEADING}

The second stage of photosynthesis does not need light directly, but it cannot run without the ATP and NADPH made by the light-dependent reactions. For that reason it is often called the light-independent stage.

Carbon fixation happens in the stroma, the fluid that surrounds the thylakoid stacks. An enzyme joins carbon dioxide to a five-carbon sugar, and the resulting molecule is reduced using ATP and NADPH.

Three turns of the cycle fix enough carbon dioxide to make one molecule of a three-carbon sugar. That sugar is the building block for glucose, sucrose and starch, and it is exported from the leaf through the veins.`];

/**
 * A minimal, structurally valid PDF with one visual line per wrapped row.
 *
 * pdf.js only reports text that lands inside the page box, so a single long
 * `Tj` per page gets clipped at the right edge (this fixture lost 90% of its
 * text until it was wrapped). Rows stay well inside 612pt at 10pt Helvetica.
 */
function buildPdf(pageTexts) {
  const wrap = (text, width = 62) => text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      const lines = [];
      let line = '';
      for (const word of words) {
        if (line === '') line = word;
        else if (`${line} ${word}`.length <= width) line += ` ${word}`;
        else { lines.push(line); line = word; }
      }
      if (line !== '') lines.push(line);
      return [...lines, '']; // blank line = paragraph break, as a wrapped PDF has
    })
    .slice(0, -1);

  const pageIds = pageTexts.map((_, i) => 3 + i * 2);
  const objects = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  };
  pageTexts.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    const body = wrap(text).map((line) => `(${line}) Tj T*`).join('\n');
    const stream = `BT /F1 10 Tf 13 TL 72 760 Td\n${body}\nET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 999 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >> stream\n${stream}\nendstream`;
  });
  objects[999] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets = {};
  for (const id of Object.keys(objects).map(Number).sort((a, b) => a - b)) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = out.length;
  const maxId = Math.max(...Object.keys(objects).map(Number));
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

// --- the stubbed AI provider -------------------------------------------------
//
// Canned and deterministic, but switchable per step: the same app instance
// answers a grounded question, then an ungrounded one, then a question whose
// retrieval comes back empty. `prompts` records every prompt the server sent,
// so the test can prove what reached the model.

const MODEL_ABSTAIN_TOKEN = 'EVIDENCE_INSUFFICIENT';
// A hostile completion: it invents a source, a page and a slide number. None of
// that may reach the citation objects, which are built from stored metadata.
const POISONED_ANSWER = 'The light-dependent reactions happen in the thylakoid membranes. '
  + 'See "Totally Made Up Almanac", page 99, src_forged_0001, slide 7.';

const journey = { tutor: 'grounded', retrieval: 'normal' };
const prompts = [];

const stubAi = {
  embedTexts: async (texts) => texts.map(() => EMBEDDING),
  embedQuery: async () => EMBEDDING,
  chatCompletion: async (messages) => {
    prompts.push(messages.map((message) => message.content));
    const system = messages[0].content;
    if (system.includes('flashcards')) return FLASHCARD_JSON;
    if (system.includes('multiple-choice')) return QUIZ_JSON;
    if (journey.tutor === 'abstain') return MODEL_ABSTAIN_TOKEN;
    if (journey.tutor === 'poisoned') return POISONED_ANSWER;
    return 'The light-dependent reactions happen in the thylakoid membranes of the chloroplast.';
  },
};

// The shared in-memory vector store, with a switch for "retrieval found
// nothing" — the honest abstain's other route, which needs no model call.
const baseVector = fakeVector();
const stubVector = {
  ...baseVector,
  queryChunks: async (args) => (journey.retrieval === 'empty' ? [] : baseVector.queryChunks(args)),
};

const post = (ctx, url, body) => fetch(`${ctx.base}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// =============================================================================
// The journey
// =============================================================================

test('the learner journey: material → reading → tutor → abstain → quiz → mastery → cards → history', async (t) => {
  const ctx = await startApp({ ai: stubAi, vector: stubVector });
  t.after(ctx.close);

  let sourceId;
  let quizId;
  let deckId;
  const quizIds = [];

  const askTutor = (question) => post(ctx, '/api/tutor/ask', { question, sourceIds: [sourceId] });
  const readProgress = async () => (await (await fetch(`${ctx.base}/api/learner/progress`)).json());
  // The "Cell division" topic as the learner-progress roll-up reports it.
  const cellDivision = async () => {
    const body = await readProgress();
    return body.topics.find((entry) => entry.topic === 'cell division') ?? null;
  };

  // ---- 1. add material -----------------------------------------------------
  await t.test('step 1 — uploading a real PDF returns 201, a real chunk count, and a library row', async () => {
    const form = new FormData();
    form.append('file', new Blob([buildPdf(PDF_PAGES)], { type: 'application/pdf' }), FILENAME);
    const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: form });

    assert.equal(res.status, 201);
    const { source } = await res.json();
    assert.equal(source.type, 'pdf');
    assert.equal(source.title, FILENAME);
    assert.equal(source.pageCount, 2);
    assert.equal(source.slideCount, null);
    assert.equal(source.sizeLabel, '2 pages');
    // A real chunk count from real extraction (this fixture yields 3 chunks),
    // never a placeholder — and every one of them really reached the store.
    assert.ok(Number.isInteger(source.chunkCount) && source.chunkCount >= 2, `chunkCount was ${source.chunkCount}`);
    assert.equal(ctx.vector.store.length, source.chunkCount);
    sourceId = source.id;
    assert.ok(sourceId.startsWith('src_'));

    const { sources } = await (await fetch(`${ctx.base}/api/sources`)).json();
    const listed = sources.find((row) => row.id === sourceId);
    assert.ok(listed, 'the uploaded source is missing from GET /api/sources');
    assert.equal(listed.title, FILENAME);
    assert.equal(listed.chunkCount, source.chunkCount);
  });

  // ---- 2. study it ---------------------------------------------------------
  await t.test('step 2 — the viewer serves the stored text with a navigable location', async () => {
    const res = await fetch(`${ctx.base}/api/viewer/${sourceId}`);
    assert.equal(res.status, 200);
    const { document } = await res.json();

    assert.equal(document.sourceId, sourceId);
    assert.equal(document.type, 'pdf');
    assert.equal(document.title, FILENAME);
    assert.equal(document.viewable, true);
    assert.equal(document.pageCount, 2);
    assert.equal(document.segments.length, 2);
    document.segments.forEach((segment, i) => {
      assert.equal(segment.index, i);
      assert.deepEqual(segment.location, { page: i + 1 }); // the same shape a citation uses
      assert.ok(segment.text.includes(PDF_PAGES[i].split('\n')[0]));
    });

    // The plain-text variant the reader can also ask for.
    const text = await fetch(`${ctx.base}/api/viewer/${sourceId}/text`);
    assert.equal(text.status, 200);
    assert.ok(text.headers.get('content-type').startsWith('text/plain'));
    assert.ok((await text.text()).includes(PAGE_HEADING));
  });

  // ---- 3. ask the tutor ----------------------------------------------------
  await t.test('step 3 — the tutor answers from the material, and no citation field comes from the model', async () => {
    journey.tutor = 'poisoned';
    const res = await askTutor('Where do the light-dependent reactions take place?');
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.answer, POISONED_ANSWER); // the model's prose passes through
    assert.equal(body.needsContent, false);
    // Contract v2.1: "suggestions: always an array … [] otherwise". The tutor
    // route omits the key entirely on a grounded answer (routes/extension.js
    // has to default it back to [] because of that). What a learner depends on
    // is that a grounded answer offers no model-invented topics — see report.
    assert.ok(body.suggestions === undefined || body.suggestions.length === 0,
      'a grounded answer must not offer topics the model made up');
    assert.ok(typeof body.model === 'string' && body.model.length > 0);

    assert.ok(Array.isArray(body.citations) && body.citations.length > 0);
    assert.ok(body.citations.length <= 6, 'at most six citations (contract)');

    const storedChunks = ctx.vector.store.map((chunk) => chunk.text);
    for (const citation of body.citations) {
      // Every field below is read from stored vector metadata, never from the
      // completion the stub just returned.
      assert.equal(citation.sourceId, sourceId);
      assert.equal(citation.type, 'pdf');
      assert.equal(citation.title, FILENAME);
      assert.equal(citation.url, null);
      assert.ok([1, 2].includes(citation.location.page), `location was ${JSON.stringify(citation.location)}`);
      assert.ok(typeof citation.score === 'number' && citation.score > 0 && citation.score <= 1);
      assert.ok(typeof citation.section === 'string' && PAGE_HEADINGS.includes(citation.section));
      assert.ok(Number.isInteger(citation.charStart) && Number.isInteger(citation.charEnd));
      assert.ok(citation.charEnd > citation.charStart);
      assert.ok(typeof citation.excerpt === 'string' && citation.excerpt.length > 0);
      assert.ok(citation.excerpt.length <= 300, 'excerpt is capped at 300 characters');
      assert.ok(storedChunks.some((text) => text.startsWith(citation.excerpt)),
        'the excerpt is the head of a stored chunk, not model prose');
    }

    // The forged identifiers the model "cited" must not have survived.
    const citationJson = JSON.stringify(body.citations);
    for (const forgery of ['src_forged_0001', 'Totally Made Up Almanac', 'slide', 'page 99']) {
      assert.ok(!citationJson.includes(forgery), `citation metadata was taken from the model text (${forgery})`);
    }

    // And the retrieved passages really did reach the prompt (the grounding
    // half of the wiring): the last prompt is the tutor's.
    const lastPrompt = prompts[prompts.length - 1];
    assert.ok(lastPrompt[1].includes('thylakoid membranes'), 'retrieved passages never reached the prompt');
    assert.ok(lastPrompt[1].includes('Where do the light-dependent reactions take place?'));
  });

  // ---- 4. the honest abstain ----------------------------------------------
  await t.test('step 4 — when nothing grounds an answer the tutor abstains with zero citations', async () => {
    journey.tutor = 'abstain';
    const callsBefore = prompts.length;
    const res = await askTutor('Who won the 1998 world cup final?');
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.needsContent, true);
    assert.deepEqual(body.citations, []);
    assert.equal(body.answer.length > 0, true);
    assert.ok(!body.answer.includes(MODEL_ABSTAIN_TOKEN), 'the abstain is friendly copy, not the raw token');
    // Suggestions come from the learner's own material, not from the model.
    assert.ok(Array.isArray(body.suggestions) && body.suggestions.length > 0);
    assert.ok(body.suggestions.some((suggestion) => suggestion === PAGE_HEADING));
    for (const suggestion of body.suggestions) {
      assert.ok(typeof suggestion === 'string' && suggestion.length >= 2 && suggestion.length <= 80);
    }
    assert.equal(prompts.length, callsBefore + 1, 'the model was asked and it declined to answer');

    // The other way to abstain: retrieval itself comes back empty, so no model
    // call happens at all.
    journey.tutor = 'grounded';
    journey.retrieval = 'empty';
    try {
      const callsBeforeEmpty = prompts.length;
      const empty = await (await askTutor('Where do the light-dependent reactions take place?')).json();
      assert.equal(empty.needsContent, true);
      assert.deepEqual(empty.citations, []);
      assert.ok(empty.suggestions.length > 0);
      assert.equal(prompts.length, callsBeforeEmpty, 'an answer with no retrieved passage never calls the model');
    } finally {
      journey.retrieval = 'normal';
    }
  });

  // ---- 5. the quiz ---------------------------------------------------------
  await t.test('step 5 — the answer key never leaves the backend, and grading counts exactly the right answers', async () => {
    const gen = await post(ctx, '/api/quiz/generate', { topic: 'Cell division', questionCount: 3, sourceIds: [sourceId] });
    assert.equal(gen.status, 201);
    const generated = await gen.json();
    quizId = generated.quiz.id;
    quizIds.push(quizId);
    assert.ok(quizId.startsWith('quiz_'));
    assert.equal(generated.quiz.topic, 'Cell division');
    assert.equal(generated.quiz.difficulty, 'medium'); // no history yet → the model's default
    assert.equal(generated.quiz.questions.length, 3);
    generated.quiz.questions.forEach((question, i) => {
      assert.equal(question.index, i);
      assert.equal(question.choices.length, 4);
      assert.deepEqual(question.choices.map((choice) => choice.id), CHOICE_IDS);
    });

    // ---- the answer key must not be in this response ----
    const raw = JSON.stringify(generated);
    for (const marker of ['correctChoiceId', 'correct_choice_id', '"correct"', 'explanation', '"answer"', 'answerKey']) {
      assert.ok(!raw.includes(marker), `the generate response leaked "${marker}"`);
    }
    generated.quiz.questions.forEach((question, i) => {
      const answerText = CORRECT_ANSWERS[i];
      // The correct answer may appear only inside this question's own choices.
      const questionWithoutChoices = JSON.stringify({ ...question, choices: question.choices.map((c) => c.id) });
      assert.ok(!questionWithoutChoices.includes(answerText),
        `question ${i} carries its correct answer in a field other than its choices`);
      const otherQuestions = JSON.stringify(generated.quiz.questions.filter((_, j) => j !== i));
      assert.ok(!otherQuestions.includes(answerText),
        `question ${i}'s correct answer is readable from another question`);
    });

    // ---- no attempt yet: the topic is real, but nobody has measured it ----
    const before = await readProgress();
    const unassessed = before.topics.find((entry) => entry.topic === 'cell division');
    assert.ok(unassessed, 'a generated-but-unanswered quiz is a topic the learner engaged with');
    assert.equal(unassessed.level, null);
    assert.equal(unassessed.levelLabel, 'unassessed');
    assert.equal(unassessed.hasEvidence, false);
    assert.equal(unassessed.masteryPercent, null);
    assert.equal(unassessed.correct, 0);
    assert.equal(unassessed.total, 0);
    assert.notEqual(unassessed.level, 1, 'unassessed must never read as level 1');
    assert.equal(before.overall.quizzesTaken, 0);

    // ---- submit: one correct, one deliberately unanswered, one correct ----
    const answers = [
      { index: 0, choiceId: CORRECT_CHOICES[0] },
      { index: 1, choiceId: null }, // unanswered → incorrect
      { index: 2, choiceId: CORRECT_CHOICES[2] },
    ];
    const res = await post(ctx, `/api/quiz/${quizId}/answer`, { answers });
    assert.equal(res.status, 200);
    const { result } = await res.json();

    assert.deepEqual(result.score, { correct: 2, total: 3, percent: 67 });
    assert.equal(result.questions.length, 3);
    result.questions.forEach((question, i) => {
      assert.equal(question.index, i);
      assert.equal(question.yourChoiceId, answers[i].choiceId);
      assert.equal(question.correctChoiceId, CORRECT_CHOICES[i]); // revealed only now
      assert.equal(question.correct, answers[i].choiceId === CORRECT_CHOICES[i]);
      assert.ok(typeof question.explanation === 'string' && question.explanation.length > 0);
      assert.ok(Array.isArray(question.citations) && question.citations.length > 0);
      assert.equal(question.citations[0].sourceId, sourceId);
    });
    assert.equal(result.questions[1].yourChoiceId, null);
    assert.equal(result.masteryUpdate.topic, 'cell division');
    assert.equal(result.masteryUpdate.before, null); // first ever attempt on this topic
    assert.ok(Math.abs(result.masteryUpdate.after - 2 / 3) < 0.0001);
    assert.equal(result.recommendedDifficulty, 'medium');

    // Resubmitting is a 409 with the stored result, never a second mastery update.
    const replay = await post(ctx, `/api/quiz/${quizId}/answer`, { answers });
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, 'QUIZ_ALREADY_ANSWERED');
    assert.deepEqual(replayBody.result, result);
  });

  // ---- 6. mastery must move ------------------------------------------------
  await t.test('step 6 — the graded answers move mastery in the direction the answers imply', async () => {
    const first = await readProgress();
    assert.equal(first.overall.quizzesTaken, 1);
    assert.equal(first.overall.questionsAnswered, 3);
    assert.equal(first.overall.accuracyPercent, 67);
    assert.equal(first.suggestedNext.topic, 'cell division');
    assert.ok(['easy', 'medium', 'hard'].includes(first.suggestedNext.difficulty));

    const takeQuiz = async (answers) => {
      const gen = await post(ctx, '/api/quiz/generate', { topic: 'Cell division', questionCount: 3, sourceIds: [sourceId] });
      assert.equal(gen.status, 201);
      const { quiz } = await gen.json();
      quizIds.push(quiz.id);
      const res = await post(ctx, `/api/quiz/${quiz.id}/answer`, { answers });
      assert.equal(res.status, 200);
      return (await res.json()).result;
    };
    const allCorrect = CORRECT_CHOICES.map((choiceId, index) => ({ index, choiceId }));
    const allWrong = CORRECT_CHOICES.map((_, index) => ({ index, choiceId: WRONG_CHOICE }));
    assert.ok(!CORRECT_CHOICES.includes(WRONG_CHOICE), 'the "wrong" choice must really be wrong');

    // A perfect attempt: 2/3 → 5/6.
    const second = await takeQuiz(allCorrect);
    assert.deepEqual(second.score, { correct: 3, total: 3, percent: 100 });
    assert.ok(second.masteryUpdate.after > second.masteryUpdate.before, 'a better attempt must raise mastery');
    assert.equal(second.recommendedDifficulty, 'hard');
    const rising = await cellDivision();
    assert.equal(rising.masteryPercent, 83);
    assert.equal(rising.level, 4);
    assert.equal(rising.levelLabel, 'advanced');
    assert.equal(rising.hasEvidence, true);
    assert.equal(rising.difficulty, 'hard');

    // A failed attempt: 5/6 → 5/9. Mastery must fall, and the topic now needs revision.
    const third = await takeQuiz(allWrong);
    assert.deepEqual(third.score, { correct: 0, total: 3, percent: 0 });
    assert.ok(third.masteryUpdate.after < third.masteryUpdate.before, 'a worse attempt must lower mastery');
    const falling = await cellDivision();
    assert.equal(falling.masteryPercent, 56);
    assert.equal(falling.correct, 5);
    assert.equal(falling.total, 9);
    assert.equal(falling.level, 2);
    assert.equal(falling.levelLabel, 'developing');
    assert.equal(falling.difficulty, 'medium');
    assert.equal(falling.needsRevision, true);
    assert.deepEqual((await readProgress()).overall, { quizzesTaken: 3, questionsAnswered: 9, accuracyPercent: 56 });
  });

  // ---- 7. flashcards -------------------------------------------------------
  await t.test('step 7 — a generated deck is saved, and a graded card comes back graded', async () => {
    const res = await post(ctx, '/api/flashcards/generate', { topic: 'Cell division', count: 3, sourceIds: [sourceId] });
    assert.equal(res.status, 201);
    const body = await res.json();
    deckId = body.deckId;
    assert.ok(deckId.startsWith('deck_'));
    assert.equal(body.topic, 'Cell division');
    assert.equal(body.cards.length, 3);
    body.cards.forEach((card, i) => {
      assert.equal(card.id, `card_${i + 1}`);
      assert.equal(card.status, 'new'); // a fresh card has never been reviewed
      assert.ok(card.front.length > 0 && card.back.length > 0);
      assert.ok(card.citations.length > 0);
      assert.equal(card.citations[0].sourceId, sourceId);
      // Every card points back at a real page of the PDF uploaded in step 1.
      assert.ok([1, 2].includes(card.citations[0].location.page),
        `a card cited ${JSON.stringify(card.citations[0].location)}`);
    });
    assert.ok(typeof body.model === 'string' && body.model.length > 0);

    const mark = await fetch(`${ctx.base}/api/decks/${deckId}/cards/0`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'known' }),
    });
    assert.equal(mark.status, 200);
    const marked = await mark.json();
    assert.equal(marked.deckId, deckId);
    assert.equal(marked.idx, 0);
    assert.equal(marked.status, 'known');
    assert.ok(marked.lastReviewedAt);

    // It persisted: reopening the deck shows the graded card, not a fresh one.
    const reread = await (await fetch(`${ctx.base}/api/decks/${deckId}`)).json();
    assert.equal(reread.deck.id, deckId);
    assert.equal(reread.deck.cardCount, 3);
    assert.equal(reread.deck.knownCount, 1);
    assert.ok(reread.deck.lastReviewedAt);
    const card = reread.cards.find((entry) => entry.idx === 0);
    assert.equal(card.status, 'known');
    assert.equal(card.reviewCount, 1);
    assert.ok(card.reviewedAt);
    assert.ok(card.front.length > 0 && card.back.length > 0);

    // And it reappears in the deck library with the same counts.
    const { decks } = await (await fetch(`${ctx.base}/api/decks`)).json();
    const listed = decks.find((entry) => entry.id === deckId);
    assert.ok(listed, 'the graded deck disappeared from GET /api/decks');
    assert.equal(listed.cardCount, 3);
    assert.equal(listed.knownCount, 1);
  });

  // ---- 8. the study history ------------------------------------------------
  await t.test('step 8 — GET /api/events tells the whole story, newest first, with a stable cursor', async () => {
    const feed = await (await fetch(`${ctx.base}/api/events?limit=100`)).json();
    assert.ok(Array.isArray(feed.events));
    const types = feed.events.map((event) => event.type);
    for (const type of ['upload', 'tutor_asked', 'quiz_generated', 'quiz_answered', 'level_changed', 'card_reviewed']) {
      assert.ok(types.includes(type), `the feed is missing the "${type}" event`);
    }

    // One action, one event: the two writers of a quiz submission and of a
    // tutor question are collapsed and named.
    const quizEvents = feed.events.filter((event) => event.type === 'quiz_answered');
    assert.equal(quizEvents.length, 3);
    for (const event of quizEvents) assert.deepEqual(event.recordedAs, ['quiz', 'quiz_answered']);
    const tutorEvents = feed.events.filter((event) => event.type === 'tutor_asked');
    assert.equal(tutorEvents.length, 3);
    for (const event of tutorEvents) assert.deepEqual(event.recordedAs, ['question', 'tutor_asked']);

    // Newest first, with the id as a stable tie-break inside one millisecond.
    for (let i = 1; i < feed.events.length; i += 1) {
      const newer = feed.events[i - 1];
      const older = feed.events[i];
      assert.ok(newer.at > older.at || (newer.at === older.at && newer.id > older.id),
        `feed order broke at ${i}: ${newer.id}/${newer.at} before ${older.id}/${older.at}`);
    }

    // The newest quiz event is the attempt this learner submitted last. When
    // several attempts land inside the reference window the server cannot tell
    // which stored row an event is about, so it omits the link rather than
    // guessing — it must never point at a quiz this journey did not create.
    assert.equal(quizEvents[0].topic, 'cell division');
    if (quizEvents[0].ref != null) {
      assert.equal(quizEvents[0].ref.kind, 'quiz');
      assert.ok(quizIds.includes(quizEvents[0].ref.id), 'the feed linked to a quiz this journey never created');
    }
    // The upload links back to the source uploaded in step 1.
    const upload = feed.events.find((event) => event.type === 'upload');
    assert.deepEqual(upload.ref, { kind: 'source', id: sourceId, label: FILENAME });
    assert.ok(upload.detail.includes(FILENAME));
    // The card review is the newest thing that happened.
    assert.equal(feed.events[0].type, 'card_reviewed');
    assert.equal(feed.events[0].topic, 'cell division');
    // The feed reads the learner model for the topic's measured level.
    assert.equal(quizEvents[0].topicMastery.hasEvidence, true);
    assert.equal(quizEvents[0].topicMastery.level, 2);

    // Paging with the cursor returns exactly the same events, in the same
    // order, with no repeat and no gap.
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const url = `${ctx.base}/api/events?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await (await fetch(url)).json();
      assert.ok(body.events.length <= 2, 'limit was honoured');
      seen.push(...body.events);
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    assert.deepEqual(seen.map((event) => event.id), feed.events.map((event) => event.id));
    assert.equal(new Set(seen.map((event) => event.id)).size, seen.length, 'a row was repeated across pages');
  });
});

// =============================================================================
// The honest failure path
// =============================================================================
//
// Every step above ran against working stubs. When a dependency is genuinely
// unavailable the journey must say so with the documented error code, not a
// blank page and not a fabricated answer.

test('a genuinely unavailable dependency is reported with the documented error code', async (t) => {
  const failingAi = {
    embedTexts: async (texts) => texts.map(() => EMBEDDING),
    embedQuery: async () => EMBEDDING,
    // Exactly what the real NIM adapter throws when the provider fails.
    chatCompletion: async () => { throw new ApiError(502, 'NIM_ERROR', 'The AI provider did not answer in time.'); },
  };
  const ctx = await startApp({ ai: failingAi });
  t.after(ctx.close);

  await t.test('material can still be added (embedding is unaffected)', async () => {
    const res = await fetch(`${ctx.base}/api/sources/webpage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://learn.example/cells',
        title: 'Cells 101',
        text: 'Cells are the basic unit of life.\n\nThe nucleus stores DNA.\n\nMitochondria release energy from glucose.',
      }),
    });
    assert.equal(res.status, 201);
  });

  await t.test('the tutor answers 502 NIM_ERROR instead of inventing an answer', async () => {
    const res = await post(ctx, '/api/tutor/ask', { question: 'What is the basic unit of life?' });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'NIM_ERROR');
    assert.equal(body.answer, undefined);
    assert.ok(body.error.message.length > 0);
    assert.ok(!body.error.message.includes('stack'));
  });

  await t.test('a quiz cannot be generated either — 502 NIM_ERROR', async () => {
    const res = await post(ctx, '/api/quiz/generate', { topic: 'Cells' });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'NIM_ERROR');
  });

  await t.test('an unreachable vector store is reported as 503 CHROMA_UNAVAILABLE', async () => {
    const brokenVector = {
      ...fakeVector(),
      queryChunks: async () => {
        throw new ApiError(503, 'CHROMA_UNAVAILABLE', 'The vector database is unreachable.');
      },
    };
    const vectorCtx = await startApp({ vector: brokenVector });
    t.after(vectorCtx.close);
    const res = await post(vectorCtx, '/api/tutor/ask', { question: 'What is the basic unit of life?' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'CHROMA_UNAVAILABLE');
  });
});
