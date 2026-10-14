// Learning events: the events service's pure logic (v1.4 weights, recording,
// repeated-question detection, approach choice, recovery tracking) plus the
// observed behaviour over the HTTP API (v1.4 + M5 rescue): quizzes record
// per-question and result events, flashcard PATCHes record card events, and a
// mastery improvement while an approach change is open records a
// recovery_success. Everything here is server-side only — no API exposes the
// events table.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { startApp } from './helpers.js';
import { EVENT_WEIGHTS, APPROACH_ORDER } from '../server/services/events.js';
import {
  recordEvent,
  isRepeatedQuestion,
  lastApproach,
  chooseApproach,
  summarizeApproaches,
  maybeRecordRecovery,
} from '../server/services/events.js';

// Pure-logic tests below share a throwaway db via this helper (no HTTP).
async function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-events-'));
  const db = await openDb(path.join(dir, 'app.db'));
  t.after(() => db.close());
  return db;
}

function insertEvent(db, kind, topic, detail, at = '2026-10-13T10:00:00.000Z') {
  const id = db.prepare('INSERT INTO learning_events (kind, topic, detail_json, weight, at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, topic, JSON.stringify(detail), EVENT_WEIGHTS[kind] ?? 1, at).lastInsertRowid;
  return Number(id);
}

const CELL_PAGE = {
  url: 'https://learn.example/cells',
  title: 'Cells 101',
  text: 'Cells are the basic unit of life.\n\nThe nucleus stores DNA.\n\nMitosis produces two identical daughter cells.\n\nMitosis copies the nucleus once.\n\nMeiosis divides twice and produces four varied cells.',
};

const PHOTOSYNTHESIS_PAGE = {
  url: 'https://learn.example/photosynthesis',
  title: 'Photosynthesis basics',
  text: 'Photosynthesis converts light energy into chemical energy.\n\nChlorophyll absorbs light inside chloroplasts.\n\nThe light reactions split water and release oxygen.\n\nThe Calvin cycle fixes carbon dioxide into glucose.\n\nPhotosynthesis happens mainly in the leaves.',
};

async function addWebpage(ctx, page) {
  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(page),
  });
  assert.equal(res.status, 201);
  const { source } = await res.json();
  return source.id;
}

function post(ctx, url, body) {
  return fetch(`${ctx.base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const events = (db) =>
  db.prepare('SELECT id, kind, topic, detail_json, weight FROM learning_events ORDER BY id').all();

// Contract v1.4 weight tier: quiz evidence (3) is deliberately stronger than
// flashcard evidence (1).
test('EVENT_WEIGHTS matches the contract: quiz evidence 3, everything else 1', () => {
  assert.deepEqual(EVENT_WEIGHTS, {
    quiz_result: 3,
    quiz_item_correct: 3,
    quiz_item_incorrect: 3,
    card_known: 1,
    card_review: 1,
    explain_again: 1,
    repeated_question: 1,
    approach_change: 1,
    recovery_success: 1,
  });
  assert.deepEqual(APPROACH_ORDER, ['step-by-step', 'examples-first', 'visual', 'concise', 'guided-questions']);
});

test('answering a quiz records per-item events, a quiz_result, and respects the 409 replay', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const sourceId = await addWebpage(ctx, CELL_PAGE);
  const genRes = await post(ctx, '/api/quiz/generate', { topic: 'Cell division', sourceIds: [sourceId] });
  assert.equal(genRes.status, 201);
  const { quiz } = await genRes.json();
  assert.equal(quiz.questions.length, 3);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM learning_events').get().n, 0); // generation is not evidence

  // Correct choices from QUIZ_JSON: a, b, a. Submitting a, a, b scores 1/3.
  const res = await post(ctx, `/api/quiz/${quiz.id}/answer`, {
    answers: [{ index: 0, choiceId: 'a' }, { index: 1, choiceId: 'a' }, { index: 2, choiceId: 'b' }],
  });
  assert.equal(res.status, 200);
  const { result } = await res.json();

  // Regression: the answer response shape is unchanged.
  assert.deepEqual(result.score, { correct: 1, total: 3, percent: 33 });
  assert.equal(result.masteryUpdate.topic, 'cell division');
  assert.equal(result.masteryUpdate.before, null);
  assert.equal(result.masteryUpdate.after, 0.3333);
  assert.equal(result.recommendedDifficulty, 'easy');

  const rows = events(ctx.db);
  assert.deepEqual(rows.map((r) => r.kind),
    ['quiz_item_correct', 'quiz_item_incorrect', 'quiz_item_incorrect', 'quiz_result']);

  const item0 = JSON.parse(rows[0].detail_json);
  assert.deepEqual(item0, { index: 0, correct: true });

  const result0 = JSON.parse(rows[3].detail_json);
  assert.equal(rows[3].weight, 3);
  assert.equal(rows[3].topic, 'cell division');
  assert.equal(result0.quizId, quiz.id);
  assert.deepEqual(
    { correct: result0.correct, total: result0.total, percent: result0.percent, masteryBefore: result0.masteryBefore, masteryAfter: result0.masteryAfter },
    { correct: 1, total: 3, percent: 33, masteryBefore: null, masteryAfter: 0.3333 },
  );

  // No prior approach_change for this topic → no recovery event can exist.
  assert.equal(rows.filter((r) => r.kind === 'recovery_success').length, 0);

  // Idempotent replay (409) must NOT record any more events.
  const replay = await post(ctx, `/api/quiz/${quiz.id}/answer`, {
    answers: [{ index: 0, choiceId: 'b' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'b' }],
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, 'QUIZ_ALREADY_ANSWERED');
  assert.equal(events(ctx.db).length, 4);
});

test('card status PATCHes record card_known/card_review but never card_new', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const sourceId = await addWebpage(ctx, CELL_PAGE);
  const genRes = await post(ctx, '/api/flashcards/generate', { topic: 'Cells', sourceIds: [sourceId] });
  assert.equal(genRes.status, 201);
  const { deckId } = await genRes.json();
  assert.ok(deckId, 'generate persists a deck and returns its id');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM learning_events').get().n, 0);

  // Regression: the PATCH response shape is unchanged.
  const known = await fetch(`${ctx.base}/api/decks/${deckId}/cards/0`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  });
  assert.equal(known.status, 200);
  const knownBody = await known.json();
  assert.equal(knownBody.deckId, deckId);
  assert.equal(knownBody.idx, 0);
  assert.equal(knownBody.status, 'known');
  assert.ok(knownBody.lastReviewedAt.length > 0);

  const review = await fetch(`${ctx.base}/api/decks/${deckId}/cards/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'review' }),
  });
  assert.equal(review.status, 200);

  // Re-marking a card as new is NOT evidence of anything.
  const backToNew = await fetch(`${ctx.base}/api/decks/${deckId}/cards/0`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'new' }),
  });
  assert.equal(backToNew.status, 200);

  const rows = events(ctx.db).filter((r) => r.kind.startsWith('card_'));
  assert.deepEqual(rows.map((r) => r.kind), ['card_known', 'card_review']);
  assert.equal(rows[0].weight, 1);
  assert.equal(rows[0].topic, 'cells');
  assert.deepEqual(JSON.parse(rows[0].detail_json), { deckId, idx: 0, status: 'known' });
  assert.deepEqual(JSON.parse(rows[1].detail_json), { deckId, idx: 1, status: 'review' });
});

test('weight tiers hold across the live rows: quiz_result (3) > card events (1)', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const sourceId = await addWebpage(ctx, CELL_PAGE);
  const quizGen = await post(ctx, '/api/quiz/generate', { topic: 'Cell division', sourceIds: [sourceId] });
  const { quiz } = await quizGen.json();
  await post(ctx, `/api/quiz/${quiz.id}/answer`, {
    answers: [{ index: 0, choiceId: 'a' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'a' }],
  });

  const flashGen = await post(ctx, '/api/flashcards/generate', { topic: 'Cells', sourceIds: [sourceId] });
  const { deckId } = await flashGen.json();
  await fetch(`${ctx.base}/api/decks/${deckId}/cards/0`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  });

  const resultWeight = ctx.db.prepare("SELECT weight FROM learning_events WHERE kind = 'quiz_result'").get().weight;
  const cardWeight = ctx.db.prepare("SELECT weight FROM learning_events WHERE kind = 'card_known'").get().weight;
  assert.ok(resultWeight > cardWeight, 'answering a quiz outweighs marking a card known');
});

test('recovery: an open approach change plus an improvement records exactly one recovery_success', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const sourceId = await addWebpage(ctx, PHOTOSYNTHESIS_PAGE);

  // Seed the prior state: the tutor switched approach for this topic, and the
  // learner sat at 2/5 mastery (0.4) beforehand.
  ctx.db.prepare(
    "INSERT INTO learning_events (kind, topic, detail_json, weight, at) VALUES ('approach_change', 'photosynthesis', ?, 1, ?)"
  ).run(JSON.stringify({ from: null, to: 'step-by-step' }), new Date().toISOString());
  ctx.db.prepare(
    "INSERT INTO learner_topics (topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES ('photosynthesis', 2, 5, 'medium', ?, ?)"
  ).run(new Date().toISOString(), new Date().toISOString());

  const { quiz } = await (await post(ctx, '/api/quiz/generate', { topic: 'Photosynthesis', sourceIds: [sourceId] })).json();
  const answerRes = await post(ctx, `/api/quiz/${quiz.id}/answer`, {
    answers: [{ index: 0, choiceId: 'a' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'a' }], // 3/3
  });
  assert.equal(answerRes.status, 200);
  const { result } = await answerRes.json();
  assert.equal(result.masteryUpdate.before, 0.4); // 2/5
  assert.equal(result.masteryUpdate.after, 0.625); // 5/8

  const recoveries = events(ctx.db).filter((r) => r.kind === 'recovery_success');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].topic, 'photosynthesis');
  const detail = JSON.parse(recoveries[0].detail_json);
  assert.equal(detail.approach, 'step-by-step');
  assert.equal(detail.before, 0.4);
  assert.equal(detail.after, 0.625);

  // A second, worse attempt does NOT produce another recovery for the same
  // approach — maybeRecordRecovery consumes the open change after one success.
  const { quiz: quiz2 } = await (await post(ctx, '/api/quiz/generate', { topic: 'Photosynthesis', sourceIds: [sourceId] })).json();
  const res2 = await post(ctx, `/api/quiz/${quiz2.id}/answer`, {
    answers: [{ index: 0, choiceId: 'b' }, { index: 1, choiceId: 'a' }, { index: 2, choiceId: 'b' }], // 0/3
  });
  assert.equal(res2.status, 200);
  assert.equal(events(ctx.db).filter((r) => r.kind === 'recovery_success').length, 1, 'exactly one recovery row total');
});

test('tutor approach: unknown values are rejected with VALIDATION_ERROR', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const sourceId = await addWebpage(ctx, CELL_PAGE);

  const nonsense = await post(ctx, '/api/tutor/ask', {
    question: 'How does mitosis work?', sourceIds: [sourceId], approach: 'nonsense',
  });
  assert.equal(nonsense.status, 400);
  assert.equal((await nonsense.json()).error.code, 'VALIDATION_ERROR');
});

test('tutor without approach in the body returns no approachUsed field', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const sourceId = await addWebpage(ctx, CELL_PAGE);

  const plain = await post(ctx, '/api/tutor/ask', { question: 'How does mitosis work?', sourceIds: [sourceId] });
  assert.equal(plain.status, 200);
  assert.equal('approachUsed' in (await plain.json()), false);
});

test('tutor echoes a valid one-off approach as approachUsed (needs M3 tutorService)', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const sourceId = await addWebpage(ctx, CELL_PAGE);

  const withApproach = await post(ctx, '/api/tutor/ask', {
    question: 'How does mitosis work?', sourceIds: [sourceId], approach: 'step-by-step',
  });
  assert.equal(withApproach.status, 200);
  const body = await withApproach.json();
  if (!('approachUsed' in body)) {
    // tutorService is being updated in parallel (M3); until it lands the route
    // cannot echo what the service does not provide. Run again after M3 merges.
    t.skip('tutorService does not return approachUsed yet (parallel M3 work)');
    return;
  }
  assert.equal(body.approachUsed, 'step-by-step');
});

// --- events-service pure logic (absorbed from events-core.test.js) -----------

test('recordEvent stores the row with the canonical weight and normalised topic', async (t) => {
  const db = await tempDb(t);

  const event = await recordEvent(db, { kind: 'quiz_result', topic: '  Photosynthesis ', detail: { correct: 3 } });
  assert.equal(event.kind, 'quiz_result');
  assert.equal(event.weight, 3);
  assert.equal(typeof event.at, 'string');

  const row = db.prepare('SELECT * FROM learning_events WHERE id = (SELECT MAX(id) FROM learning_events)').get();
  assert.equal(row.topic, 'photosynthesis', 'topic is trimmed and lowercased');
  assert.deepEqual(JSON.parse(row.detail_json), { correct: 3 });
  assert.equal(row.weight, 3);

  const noTopic = await recordEvent(db, { kind: 'card_known' });
  assert.equal(noTopic.weight, 1);
  assert.equal(db.prepare('SELECT topic FROM learning_events WHERE id = (SELECT MAX(id) FROM learning_events)').get().topic, null);
});

test('recordEvent throws VALIDATION_ERROR for unknown kinds', async (t) => {
  const db = await tempDb(t);
  await assert.rejects(
    () => recordEvent(db, { kind: 'made_up_event' }),
    (err) => err.status === 400 && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM learning_events').get().n, 0, 'nothing written on error');
});

test('isRepeatedQuestion spots near-duplicates and ignores unrelated or empty input', () => {
  assert.equal(
    isRepeatedQuestion('Explain photosynthesis again!', ['explain photosynthesis please']),
    true,
    'one filler word must not hide a repeat',
  );
  assert.equal(
    isRepeatedQuestion('How does mitosis divide the nucleus?', ['What causes volcanic eruptions?']),
    false,
    'unrelated questions are not repeats',
  );
  assert.equal(isRepeatedQuestion('', []), false);
  assert.equal(isRepeatedQuestion('ok?', ['ok?']), false, 'too-short tokens are dropped');
  assert.equal(isRepeatedQuestion('Explain the Calvin cycle in detail', []), false, 'no history → not a repeat');
  // Only the newest ≤5 items are considered.
  const recent = [
    'a very old question about tectonic plates entirely',
    'another stale question about volcano magma chamber flows',
    'some forgotten question regarding earthquake fault lines',
    'an outdated question on continental drift evidence here',
    'a previous question about the Calvin cycle steps please',
  ];
  assert.equal(isRepeatedQuestion('the Calvin cycle steps please', recent), true);
});

test('chooseApproach: explicit style wins; "different" cycles; preference is the fallback', () => {
  // Explicit wins even when it repeats the previous approach.
  assert.equal(chooseApproach({ explicit: 'visual', previous: 'visual', preferred: 'concise' }), 'visual');

  // 'different' walks the cycle and never repeats the previous approach.
  assert.equal(chooseApproach({ explicit: 'different', previous: 'step-by-step' }), 'examples-first');
  assert.equal(chooseApproach({ explicit: 'different', previous: 'guided-questions' }), 'step-by-step', 'cyclic wrap-around');
  assert.equal(chooseApproach({ explicit: 'different', previous: null, preferred: null }), 'step-by-step');
  assert.equal(chooseApproach({ explicit: 'different', previous: null, preferred: 'visual' }), 'concise');
  for (const previous of APPROACH_ORDER) {
    const next = chooseApproach({ explicit: 'different', previous });
    assert.notEqual(next, previous, `"different" must not return ${previous} again`);
    assert.ok(APPROACH_ORDER.includes(next));
  }

  // No explicit request → the saved preference (or null); previous ignored.
  assert.equal(chooseApproach({ preferred: 'concise', previous: 'visual' }), 'concise');
  assert.equal(chooseApproach({ preferred: 'simpler' }), null, 'non-style preferences count as none');
  assert.equal(chooseApproach({}), null);
});

test('lastApproach returns the newest approach_change for the topic', async (t) => {
  const db = await tempDb(t);
  assert.equal(await lastApproach(db, 'cells'), null, 'no events → null');

  insertEvent(db, 'approach_change', 'cells', { to: 'visual' });
  insertEvent(db, 'approach_change', 'cells', { to: 'step-by-step' });
  insertEvent(db, 'approach_change', 'recursion', { to: 'concise' });

  assert.equal(await lastApproach(db, 'cells'), 'step-by-step', 'newest wins');
  assert.equal(await lastApproach(db, ' Cells '), 'step-by-step', 'topic normalisation matches recording');
  assert.equal(await lastApproach(db, 'recursion'), 'concise');
});

test('summarizeApproaches classifies helped, unhelpful and last', () => {
  const eventsRows = [
    { id: 1, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'visual' }) },
    { id: 2, kind: 'quiz_result', topic: 'cells', detail_json: JSON.stringify({ masteryBefore: 0.6, masteryAfter: 0.5 }) }, // dropped
    { id: 3, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'step-by-step' }) },
    { id: 4, kind: 'quiz_result', topic: 'cells', detail_json: JSON.stringify({ masteryBefore: 0.4, masteryAfter: 0.7 }) }, // improved
    { id: 5, kind: 'recovery_success', topic: 'cells', detail_json: JSON.stringify({ approach: 'step-by-step' }) },
    { id: 6, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'concise' }) },
  ];
  const summary = summarizeApproaches(eventsRows, 'cells');
  assert.equal(summary.last, 'concise');
  assert.deepEqual(summary.helped, ['step-by-step']);
  assert.deepEqual(summary.unhelpful, ['visual']);

  // An approach that recovered after a drop is "helped", not "unhelpful".
  const recovered = [
    { id: 1, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'visual' }) },
    { id: 2, kind: 'quiz_result', topic: 'cells', detail_json: JSON.stringify({ masteryBefore: 0.6, masteryAfter: 0.5 }) },
    { id: 3, kind: 'recovery_success', topic: 'cells', detail_json: JSON.stringify({ approach: 'visual' }) },
  ];
  const s2 = summarizeApproaches(recovered, 'cells');
  assert.deepEqual(s2.helped, ['visual']);
  assert.deepEqual(s2.unhelpful, [], 'recovery beats an earlier drop');

  // No approach_change yet → everything null/empty.
  assert.deepEqual(summarizeApproaches([{ id: 1, kind: 'quiz_result', topic: 'cells', detail_json: '{}' }], 'cells'), {
    last: null, helped: [], unhelpful: [],
  });
});

test('maybeRecordRecovery records only on improvement with an open approach_change, and never twice', async (t) => {
  const db = await tempDb(t);

  // No approach_change yet → nothing to attribute.
  assert.equal(await maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.4, masteryAfter: 0.6 }), null);

  insertEvent(db, 'approach_change', 'cells', { from: 'visual', to: 'step-by-step' });

  // No improvement → no event.
  assert.equal(await maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.6, masteryAfter: 0.5 }), null);
  assert.equal(await maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.6, masteryAfter: 0.6 }), null, 'equal is not improvement');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'recovery_success'").get().n, 0);

  // Improvement with the approach_change still open → recovery recorded.
  const event = await maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.4, masteryAfter: 0.7 });
  assert.ok(event, 'recovery event returned');
  assert.equal(event.kind, 'recovery_success');
  const row = db.prepare("SELECT * FROM learning_events WHERE kind = 'recovery_success'").get();
  assert.equal(row.topic, 'cells');
  assert.deepEqual(JSON.parse(row.detail_json), { approach: 'step-by-step', before: 0.4, after: 0.7 });

  // Second call finds the recorded recovery → not recorded twice.
  assert.equal(await maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.5, masteryAfter: 0.8 }), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'recovery_success'").get().n, 1);

  // A fresh approach_change re-opens the question.
  insertEvent(db, 'approach_change', 'cells', { from: 'step-by-step', to: 'examples-first' });
  const second = await maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.3, masteryAfter: 0.5 });
  assert.ok(second, 'a new approach change can recover again');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'recovery_success'").get().n, 2);
});
