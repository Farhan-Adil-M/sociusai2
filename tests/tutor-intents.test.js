// Tutor study-planning intents (Part 6). Offline: in-memory db + stubbed
// AI/vector. Unit tests on the pure classifiers/advisors plus a few HTTP
// end-to-end checks through the /api/tutor/ask route (startApp pattern from
// api.test.js) to prove scoping and error envelopes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { logActivity } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { classifyIntent, revisionAdvice, progressAdvice, importantQuestions } from '../server/services/studyAdvice.js';
import { fakeVector, makeAi, EMBEDDING, TUTOR_ANSWER } from './helpers.js';

// ---------- db + stub helpers ----------

async function unitDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-intent-'));
  return openDb(path.join(dir, 'app.db'));
}

function seedTopic(db, topic, correct, total, lastPracticedAt) {
  db.prepare(
    'INSERT INTO learner_topics (topic, correct, total, difficulty, updated_at, last_practiced_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(topic, correct, total, 'medium', lastPracticedAt, lastPracticedAt);
}

function seedAttempt(db, quizId, correct, total) {
  db.prepare('INSERT INTO quizzes (id, topic, difficulty, question_count, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(quizId, 'cell division', 'medium', total, '2026-01-01T00:00:00Z');
  db.prepare('INSERT INTO quiz_attempts (quiz_id, answers_json, correct, total, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(quizId, '[]', correct, total, '2026-01-01T00:00:00Z');
}

function seedSource(db, id, title) {
  db.prepare("INSERT INTO sources (id, type, title, chunk_count, created_at) VALUES (?, 'webpage', ?, 2, ?)")
    .run(id, title, '2026-01-01T00:00:00Z');
}

function seedChunks(vector, sourceId, texts) {
  const metas = texts.map((_, i) => ({ sourceId, title: `Doc ${sourceId}`, paragraph: i + 1 }));
  return vector.addChunks({ ids: texts.map((_, i) => `c_${sourceId}_${i}`), embeddings: texts.map(() => EMBEDDING), documents: texts, metadatas: metas });
}

async function startApp({ ai, vector } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-intent-http-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const vectorStub = vector ?? fakeVector();
  const app = await createApp({ db, ...(ai ? { ai } : {}), vector: vectorStub });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, db, vector: vectorStub, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, body) => fetch(`${base}/api/tutor/ask`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ---------- unit: classifyIntent ----------

test('classifyIntent routes deterministically in precedence order', () => {
  assert.equal(classifyIntent('  What should I revise next?  ').intent, 'revise-next');
  assert.equal(classifyIntent('what am I weak at?').intent, 'revise-next');
  assert.equal(classifyIntent("I haven't revised enough — what is next topic?").intent, 'revise-next');

  assert.equal(classifyIntent('Give me important questions from the chapter').intent, 'important-questions');
  assert.equal(classifyIntent('What should I prepare before the test?').intent, 'important-questions'); // 'prepare' branch
  assert.equal(classifyIntent('Some practice questions on cells?').intent, 'important-questions');

  assert.equal(classifyIntent('How am I doing overall?').intent, 'progress');
  assert.equal(classifyIntent('What is my progress so far?').intent, 'progress');

  assert.equal(classifyIntent('How does mitosis work?').intent, 'normal');
  assert.equal(classifyIntent('Define the Krebs cycle').intent, 'normal');
  assert.equal(classifyIntent('').intent, 'normal');

  // Ambiguous overlap: the FIRST matching rule in precedence order wins.
  assert.equal(classifyIntent('what should I revise for important questions in my exam?').intent, 'revise-next');
  assert.equal(classifyIntent('what is my progress on exam important questions?').intent, 'important-questions'); // practice rule precedes the progress rule
});

// ---------- unit: revisionAdvice (deterministic, no AI) ----------

test('revisionAdvice recommends the worst flagged topic with honest numbers', async () => {
  const ai = makeAi();
  const db = await unitDb();
  // Topic 'ancient history' is recent but strong; 'cell division' is weak.
  seedTopic(db, 'cell division', 2, 5, '2026-01-02T00:00:00Z');
  seedTopic(db, 'ancient history', 4, 5, '2026-01-05T00:00:00Z');

  const result = await revisionAdvice(db);
  assert.equal(result.intent, 'revise-next');
  assert.deepEqual(result.citations, []);
  assert.equal(result.needsContent, false);
  assert.equal(result.suggestedNext.topic, 'cell division');
  assert.ok(result.answer.includes('cell division'), result.answer);
  assert.ok(result.answer.includes('40%'), result.answer); // 2 correct of 5 attempts
  assert.equal(result.suggestedNext.difficulty, 'easy'); // 0.4 < easyBelow (0.5)
  assert.ok(result.answer.includes('generate a quiz'), result.answer);
  assert.equal(ai.calls.length, 0); // MUST be model-free
});

test('revisionAdvice with no history is honest and suggests a diagnostic quiz', async () => {
  const db = await unitDb();
  const result = await revisionAdvice(db);
  assert.equal(result.intent, 'revise-next');
  assert.equal(result.suggestedNext, null);
  assert.deepEqual(result.citations, []);
  assert.match(result.answer, /no quiz attempts yet/i);
  assert.match(result.answer, /diagnostic quiz/i);
  // No fabricated mastery/history numbers in the empty state.
  assert.ok(!result.answer.includes('%'));
});

// ---------- unit: progressAdvice (deterministic roll-up) ----------

test('progressAdvice sums attempts and topics deterministically', async () => {
  const db = await unitDb();
  seedTopic(db, 'cell division', 2, 5, '2026-01-02T00:00:00Z');
  seedTopic(db, 'ancient history', 4, 5, '2026-01-05T00:00:00Z');
  seedAttempt(db, 'quiz_1', 1, 3);
  seedAttempt(db, 'quiz_2', 2, 2);
  await logActivity(db, 'quiz', 'cell division', 'Took decision quiz', null);
  await logActivity(db, 'question', null, 'Asked: what is a cell', null);

  const result = await progressAdvice(db);
  assert.equal(result.intent, 'progress');
  assert.deepEqual(result.citations, []);
  assert.equal(result.quizzesTaken, 2);
  assert.equal(result.questionsAnswered, 5);
  assert.equal(result.accuracyPercent, 60); // (1+2)/(3+2)
  assert.equal(result.bestTopic.topic, 'ancient history'); // 80% vs 40%
  assert.equal(result.worstTopic.topic, 'cell division');
  assert.deepEqual(result.needsRevision.map((t) => t.topic), ['cell division']); // 40% < 60% line, ≥3 attempts
  assert.equal(result.recentActivityCount, 2);
});

test('progressAdvice with no data is honest', async () => {
  const db = await unitDb();
  const result = await progressAdvice(db);
  assert.equal(result.intent, 'progress');
  assert.equal(result.quizzesTaken, 0);
  assert.equal(result.questionsAnswered, 0);
  assert.match(result.answer, /no recorded practice/i);
  assert.equal(result.bestTopic, null);
  assert.equal(result.needsRevision.length, 0);
});

// ---------- unit: importantQuestions (real retrieval + reused quiz generator) ----------

test('importantQuestions builds practice questions with answers and citations from hits', async () => {
  const ai = makeAi(); // returns QUIZ_JSON for multiple-choice prompts
  const vector = fakeVector();
  await seedChunks(vector, 'src_1', ['Mitosis produces two identical daughter cells.', 'Meiosis produces four varied cells.']);

  const db = await unitDb();
  const result = await importantQuestions(db, { question: 'give me important questions from the chapter', sourceIds: ['src_1'] }, { ai, vector });

  assert.equal(result.intent, 'important-questions');
  assert.equal(result.needsContent, false);
  assert.ok(result.answer.startsWith('Practice questions drawn from your material:'), result.answer);
  assert.ok(result.answer.includes('Answer:'), result.answer);
  assert.ok(result.answer.includes('Mitosis copies the nucleus once.'), result.answer); // explanations included
  assert.ok(!/predict/i.test(result.answer)); // honesty: never claims to predict real exam questions
  assert.ok(result.citations.length > 0 && result.citations.length <= 6, 'citations built from hits, capped at 6');
  for (const cite of result.citations) {
    assert.equal(cite.sourceId, 'src_1'); // built ONLY from retrieved hits
    assert.equal(cite.title, `Doc src_1`);
  }
});

test('importantQuestions with no matching material is an honest RETRIEVAL failure', async () => {
  const ai = makeAi();
  const vector = fakeVector(); // empty store
  const db = await unitDb();
  const result = await importantQuestions(db, { question: 'give me important questions on quantum physics', sourceIds: [] }, { ai, vector });
  assert.equal(result.intent, 'important-questions');
  assert.equal(result.needsContent, true);
  assert.deepEqual(result.citations, []);
  assert.match(result.answer, /couldn't find enough in your study materials/i);
  assert.equal(ai.calls.length, 0); // never asked the model for a fake list
});

// ---------- HTTP: dispatch through POST /api/tutor/ask ----------

test('HTTP: revision intent answers deterministically with no citations and no AI call', async (t) => {
  const ai = makeAi();
  const ctx = await startApp({ ai });
  t.after(ctx.close);
  seedTopic(ctx.db, 'cell division', 2, 5, '2026-01-02T00:00:00Z');

  const res = await post(ctx.base, { question: 'what should I revise next?' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intent, 'revise-next');
  assert.deepEqual(body.citations, []);
  assert.ok(body.answer.includes('cell division'));
  assert.equal(body.sessionId, null);
  const activity = ctx.db.prepare("SELECT detail FROM activity WHERE type = 'question' ORDER BY id DESC LIMIT 1").get();
  assert.match(activity.detail, /^\[revision\]/); // logged with the intent prefix

  // The normal answering path was NOT taken: the deterministic answer came
  // straight from the learner model, the AI was never called.
  assert.ok(!body.answer.includes(TUTOR_ANSWER));
  assert.equal(ai.calls.length, 0);
});

test('HTTP: important-questions passes the server-enforced sourceIds scope', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  seedSource(ctx.db, 'src_a', 'Doc A');
  seedSource(ctx.db, 'src_b', 'Doc B');
  await seedChunks(ctx.vector, 'src_a', ['Mitosis produces two identical daughter cells.']);
  await seedChunks(ctx.vector, 'src_b', ['Meiosis produces four varied cells, unrelated data.']);

  const res = await post(ctx.base, { question: 'give me important questions from the chapter', sourceIds: ['src_a'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intent, 'important-questions');
  assert.equal(body.needsContent, false);
  assert.ok(body.citations.length > 0);
  for (const cite of body.citations) assert.equal(cite.sourceId, 'src_a'); // only the permitted source
});

test('HTTP: provider failure on the practice path surfaces as a 5xx envelope, never a fabricated answer', async (t) => {
  const ai = makeAi({
    chatCompletion: async () => { throw new Error('NIM 502 upstream'); },
  });
  const ctx = await startApp({ ai });
  t.after(ctx.close);
  seedSource(ctx.db, 'src_a', 'Doc A');
  await seedChunks(ctx.vector, 'src_a', ['Mitosis produces two identical daughter cells.']);

  const res = await post(ctx.base, { question: 'give me important questions from the chapter' });
  assert.ok(res.status >= 500, `expected a server-side failure, got ${res.status}`);
  const body = await res.json();
  assert.ok(body.error && body.error.code, 'failure must come back as an error envelope');
  assert.ok(!body.answer, 'no answer field on failure');
  assert.ok(!JSON.stringify(body).includes('Which process'), 'no fabricated questions');
});

test('HTTP: normal factual questions keep the existing answering flow', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  seedSource(ctx.db, 'src_a', 'Doc A');
  await seedChunks(ctx.vector, 'src_a', ['Mitosis produces two identical daughter cells.']);

  const res = await post(ctx.base, { question: 'How does mitosis work?', sourceIds: ['src_a'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intent, undefined); // normal intent: no intent field, unchanged contract
  assert.equal(body.answer, TUTOR_ANSWER);
  assert.equal(body.needsContent, false);
  assert.ok(body.citations.length > 0);
  assert.equal(body.citations[0].sourceId, 'src_a');
});
