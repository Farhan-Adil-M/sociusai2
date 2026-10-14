// Learner-context personalisation (M3) tests. Mixes direct service tests with
// HTTP-level tests. Core guarantees checked:
//  - no profile + no approach → prompt byte-identical to the legacy shape;
//  - personalisation adds rules + a budgeted <learner-context> block;
//  - citations keep coming from retrieved metadata only;
//  - observed events (repeated questions, approach changes) are recorded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, logActivity } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { recordEvent, APPROACH_ORDER, chooseApproach, lastApproach } from '../server/services/events.js';
import { resolveRelevantTopics, buildLearnerContext, buildLearnerBlock, describeApproach, tokenize } from '../server/services/personalization.js';
import { answerQuestion } from '../server/services/tutorService.js';
import { fakeVector, makeAi } from './helpers.js';

const NOW = new Date().toISOString();

async function newDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-pers-'));
  return openDb(path.join(dir, 'app.db'));
}

/** Seed the fake vector store so retrieval always returns grounded hits. */
function seedVector(vector, sourceId = 'src_football') {
  vector.addChunks({
    ids: [`${sourceId}_0`, `${sourceId}_1`],
    embeddings: [[0.1], [0.2]],
    documents: [
      'Penalty conversion rates depend on the kicker and the goalkeeper.',
      'Expected goals is a probability model of shot quality.',
    ],
    metadatas: [
      { sourceId, type: 'pdf', title: 'football-stats.pdf', page: 1 },
      { sourceId, type: 'pdf', title: 'football-stats.pdf', page: 2 },
    ],
  });
}

function insertTopic(db, topic, { correct = 3, total = 5 } = {}) {
  db.prepare("INSERT INTO learner_topics (topic, correct, total, difficulty, updated_at) VALUES (?, ?, ?, 'medium', ?)")
    .run(topic, correct, total, NOW);
}

function insertProfile(db, fields, state = 'completed') {
  db.prepare("INSERT INTO learner_profile (id, state, transcript_json, fields_json, created_at, updated_at) VALUES ('default', ?, '[]', ?, ?, ?)")
    .run(state, JSON.stringify(fields), NOW, NOW);
}

/* ------------------------------------------------------------------ */
/* 1. resolveRelevantTopics                                            */
/* ------------------------------------------------------------------ */

test('resolveRelevantTopics matches topics via question tokens and ignores unrelated ones', async () => {
  const db = await newDb();
  insertTopic(db, 'probability in football');
  insertTopic(db, 'photosynthesis');
  db.prepare("INSERT INTO learner_subjects (subject, familiarity, confidence, source, updated_at) VALUES ('chemistry', 'basic', 3, 'stated', ?)")
    .run(NOW);

  const topics = await resolveRelevantTopics(db, 'How is probability used in football penalties?', null);
  assert.ok(topics.includes('probability in football'), `matched by tokens: ${topics}`);
  assert.ok(!topics.includes('photosynthesis'), 'unrelated learner topic excluded');
  assert.ok(!topics.includes('chemistry'), 'unrelated subject excluded');
  assert.ok(topics.every((t) => t === t.toLowerCase()), 'keys are lowercase');
  assert.ok(topics.length <= 3, 'capped at 3');
});

/* ------------------------------------------------------------------ */
/* 2. buildLearnerContext                                              */
/* ------------------------------------------------------------------ */

test('buildLearnerContext includes relevant interests and goal, excludes unrelated interests', async () => {
  const db = await newDb();
  insertProfile(db, {
    interests: [
      { label: 'football tactics', source: 'stated' },
      { label: 'baking sourdough', source: 'stated' },
    ],
    goals: [{ label: 'Under expected goals models', deadline: null, source: 'stated' }],
    purpose: 'exam',
    preferences: { explanationStyle: { value: 'examples-first', source: 'stated' } },
  });
  insertTopic(db, 'football statistics');

  const ctx = await buildLearnerContext(db, { question: 'How do expected goals use probability in football?', sessionId: null });
  assert.ok(ctx, 'a real profile yields a context');
  assert.equal(ctx.goal, 'Under expected goals models');
  assert.equal(ctx.style, 'examples-first');
  assert.deepEqual(ctx.interests, ['football tactics'], 'relevant interest in, unrelated one out');
  assert.deepEqual(ctx.topics, ['football statistics']);
  assert.deepEqual(ctx.mastery, [{ topic: 'football statistics', percent: 60, uncertain: false }]);
});

test('buildLearnerContext returns null for state "new", missing row, and an empty profile row', async () => {
  const db = await newDb();
  assert.equal(await buildLearnerContext(db, { question: 'anything about cells', sessionId: null }), null, 'no row');

  insertProfile(db, {}, 'new');
  insertTopic(db, 'cells');
  // state "new" but matched observed topic → observed data is still usable.
  const observed = await buildLearnerContext(db, { question: 'explain cells', sessionId: null });
  assert.ok(observed, 'observed mastery personalises even without a filled profile');
  // Profile "new" with truly nothing else → null.
  const empty = await newDb();
  insertProfile(empty, {}, 'new');
  assert.equal(await buildLearnerContext(empty, { question: 'explain cells', sessionId: null }), null);

  const withRow = await newDb();
  insertProfile(withRow, {}, 'completed');
  assert.equal(await buildLearnerContext(withRow, { question: 'explain us the krebs cycle', sessionId: null }), null,
    'row exists but everything empty → null');
});

test('confusion strings are composed from recorded events for matched topics', async () => {
  const db = await newDb();
  insertTopic(db, 'photosynthesis');
  await recordEvent(db, { kind: 'repeated_question', topic: 'photosynthesis', detail: {} });
  await recordEvent(db, { kind: 'quiz_item_incorrect', topic: 'photosynthesis', detail: {} });
  await recordEvent(db, { kind: 'explain_again', topic: 'unrelated topic', detail: {} });

  const ctx = await buildLearnerContext(db, { question: 'why does photosynthesis matter', sessionId: null });
  assert.ok(ctx, 'observed events make the context non-null');
  assert.equal(ctx.confusion.length, 2, 'capped at two strings');
  assert.match(ctx.confusion[0], /photosynthesis/);
  assert.match(ctx.confusion.join(' '), /asked a near-identical question about photosynthesis/);
  assert.match(ctx.confusion.join(' '), /1 quiz question on photosynthesis incorrectly/);
  assert.ok(!ctx.confusion.some((s) => s.includes('unrelated')), 'only matched topics appear');
});

/* ------------------------------------------------------------------ */
/* 3. learner block budget                                             */
/* ------------------------------------------------------------------ */

test('learner block stays within the 1200-char budget with a maximal profile', async () => {
  const db = await newDb();
  const irrelevant = ['sourdough baking', 'mountain hiking', 'chess puzzles', 'harbor shipwatching',
    'ceramic pottery', 'guitar practice', 'kite building', 'zoo volunteering',
    'gardening tomatoes', 'knitting scarves'];
  insertProfile(db, {
    interests: [
      { label: 'football tactics', source: 'stated' },
      { label: 'expected goals models', source: 'stated' },
      ...irrelevant.map((label) => ({ label, source: 'stated' })),
    ],
    goals: Array.from({ length: 6 }, (_, i) => ({ label: `pass the final exam with grade ${i + 1} first attempt`, deadline: null, source: 'stated' })),
    purpose: 'deep-understanding',
    preferences: { explanationStyle: { value: 'step-by-step', source: 'stated' } },
  });
  db.prepare("INSERT INTO learner_subjects (subject, familiarity, confidence, source, updated_at) VALUES (?, ?, 4, 'stated', ?)")
    .run('mathematics', 'confident', NOW);
  db.prepare("INSERT INTO learner_subjects (subject, familiarity, confidence, source, updated_at) VALUES (?, ?, 2, 'stated', ?)")
    .run('statistics', 'basic', NOW);
  insertTopic(db, 'football statistics', { correct: 3, total: 5 });
  insertTopic(db, 'football history', { correct: 1, total: 3 });
  await recordEvent(db, { kind: 'explain_again', topic: 'football statistics', detail: {} });

  const ctx = await buildLearnerContext(db, { question: 'expected goals in football scoring', sessionId: null });
  assert.ok(ctx);
  assert.equal(ctx.interests.length, 2, 'interest budget is two');
  const block = buildLearnerBlock(ctx);
  assert.ok(block.length <= 1200, `block was ${block.length} chars`);
  assert.match(block, /SELF-REPORTED/);
  assert.match(block, /OBSERVED/);
  assert.ok(block.includes('football tactics'), 'relevant interests included');
  for (const excluded of ['sourdough', 'harbor', 'guitar']) {
    assert.ok(!block.includes(excluded), `irrelevant interest excluded: ${excluded}`);
  }
  assert.ok(!block.includes('grade 2'), 'only the first goal is shown');
  assert.ok(block.includes('uncertain'), 'low-count mastery flagged');
  assert.ok(!block.includes('transcript'), 'no transcript content');
});

/* ------------------------------------------------------------------ */
/* 4. answerQuestion: legacy byte-shape without a profile              */
/* ------------------------------------------------------------------ */

test('answerQuestion without profile/approach keeps the exact legacy prompt and result shape', async () => {
  const db = await newDb();
  const ai = makeAi();
  const vector = fakeVector();
  seedVector(vector);

  const result = await answerQuestion({ question: 'What is expected goals in football match analysis?', sourceIds: [], db }, { ai, vector });

  assert.ok(ai.calls.length === 1);
  const [system, user] = ai.calls[0].map((m) => m.content);
  assert.ok(!system.includes('<learner-context>'), 'no learner-context tag');
  assert.equal(system.match(/Teaching approach/g)?.length ?? 0, 0, 'no approach line');
  assert.equal(system.match(/Learner context/g)?.length ?? 0, 0, 'no new rule lines');
  assert.equal(system.match(/FACTS must still come ONLY/g)?.length ?? 0, 0);
  assert.match(system, /You are Socius AI, a tutor who answers strictly from the passages the student provides\.\nRules:/);
  assert.match(user, /^Passages:\n\n<passage id="1"/, 'user message shape unchanged');
  assert.ok(!('approachUsed' in result), 'no approachUsed in the result');
  assert.equal(result.needsContent, false);
  // Citations come from stored metadata only.
  assert.ok(result.citations.length === 2);
  assert.ok(result.citations.every((c) => c.sourceId === 'src_football'));
  assert.ok(result.citations.every((c) => c.title === 'football-stats.pdf'));

  // And byte-identical when profile/state exists but contributes nothing:
  insertProfile(db, {}, 'new');
  const ai2 = makeAi();
  await answerQuestion({ question: 'What is expected goals in football match analysis?', sourceIds: [], db }, { ai: ai2, vector });
  assert.deepEqual(ai2.calls[0], ai.calls[0], 'empty "new" profile → identical messages');
});

/* ------------------------------------------------------------------ */
/* 5. answerQuestion: preferred style from the profile                 */
/* ------------------------------------------------------------------ */

test('answerQuestion with a styled profile adds the learner block and records the approach change', async () => {
  const db = await newDb();
  const ai = makeAi();
  const vector = fakeVector();
  seedVector(vector);
  insertProfile(db, {
    interests: [{ label: 'baking sourdough', source: 'stated' }, { label: 'football data', source: 'stated' }],
    goals: [{ label: 'understand statistics', deadline: null, source: 'stated' }],
    purpose: 'exam',
    preferences: { explanationStyle: { value: 'examples-first', source: 'stated' } },
  });
  insertTopic(db, 'penalties statistics', { correct: 4, total: 5 });

  const result = await answerQuestion(
    { question: 'how often are penalties scored, in statistics terms', sourceIds: [], db },
    { ai, vector },
  );

  assert.equal(result.approachUsed, 'examples-first');
  const system = ai.calls[0][0].content;
  assert.ok(system.includes('<learner-context>'), 'learner block present');
  assert.ok(system.includes('FACTS must still come ONLY from the passages'), 'facts rule added');
  assert.ok(system.includes('lead with a concrete worked example, then the rule'), 'approach instruction present');
  assert.ok(!system.includes('sourdough'), 'irrelevant interest excluded');
  assert.ok(system.includes('penalties statistics 80%'), 'matched mastery shown');
  const blockStart = system.indexOf('<learner-context>');
  assert.ok(system.lastIndexOf('Teaching approach for this answer') < blockStart, 'approach line before the block');

  const event = db.prepare(
    "SELECT topic, detail_json FROM learning_events WHERE kind = 'approach_change'"
  ).get();
  assert.ok(event, 'approach_change recorded');
  assert.equal(event.topic, 'penalties statistics');
  assert.equal(JSON.parse(event.detail_json).from, null);
  assert.equal(JSON.parse(event.detail_json).to, 'examples-first');
});

/* ------------------------------------------------------------------ */
/* 6. explicit approach "different" cycles and logs explain_again       */
/* ------------------------------------------------------------------ */

test("approach 'different' never repeats the previous approach and logs explain_again", async () => {
  const db = await newDb();
  const ai = makeAi();
  const vector = fakeVector();
  seedVector(vector);
  insertTopic(db, 'statistics'); // matched topic
  await recordEvent(db, { kind: 'approach_change', topic: 'statistics', detail: { from: null, to: 'step-by-step' } });

  const result = await answerQuestion(
    { question: 'explain this statistics idea differently', sourceIds: [], db, approach: 'different' },
    { ai, vector },
  );

  assert.ok(APPROACH_ORDER.includes(result.approachUsed), `cycled value in order: ${result.approachUsed}`);
  assert.notEqual(result.approachUsed, 'step-by-step');
  const explainAgain = db.prepare("SELECT topic, detail_json FROM learning_events WHERE kind = 'explain_again'").get();
  assert.ok(explainAgain, 'explain_again recorded');
  assert.equal(explainAgain.topic, 'statistics');
  assert.equal(JSON.parse(explainAgain.detail_json).requested, true);
  const change = db.prepare("SELECT detail_json FROM learning_events WHERE kind = 'approach_change' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(change.detail_json).from, 'step-by-step');
  assert.equal(JSON.parse(change.detail_json).to, result.approachUsed);
});

/* ------------------------------------------------------------------ */
/* 7. repeated question detection over the HTTP route                   */
/* ------------------------------------------------------------------ */

test('repeated questions are detected through the route (route logs AFTER the answer)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-pers-http-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const ai = makeAi();
  const vector = fakeVector();
  seedVector(vector);
  insertTopic(db, 'photosynthesis');
  const app = await createApp({ db, ai, vector });
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));

  // History BEFORE this ask: the route logs the current question afterwards.
  await logActivity(db, 'question', null, 'Asked: explain photosynthesis');

  const res = await fetch(`http://localhost:${server.address().port}/api/tutor/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'explain photosynthesis again please' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.citations.every((c) => c.sourceId === 'src_football'));

  const event = db.prepare("SELECT topic FROM learning_events WHERE kind = 'repeated_question'").get();
  assert.ok(event, 'repeated_question recorded');
  assert.equal(event.topic, 'photosynthesis');
});

/* ------------------------------------------------------------------ */
/* 8. citation integrity across every path exercised above             */
/* ------------------------------------------------------------------ */

test('citations always point at sources present in the vector store', async () => {
  const db = await newDb();
  const vector = fakeVector();
  seedVector(vector, 'src_only_one');
  const ai = makeAi();
  const storeIds = new Set(vector.store.map((s) => s.metadata.sourceId));

  const plain = await answerQuestion({ question: 'what does expected goals say', sourceIds: [], db }, { ai, vector });
  const approach = await answerQuestion(
    { question: 'what does expected goals say again with examples', sourceIds: [], db, approach: 'visual' },
    { ai, vector },
  );
  for (const result of [plain, approach]) {
    assert.ok(result.citations.length > 0);
    assert.ok(result.citations.every((c) => storeIds.has(c.sourceId)), 'citation sourceIds ⊆ store');
  }
});

/* ------------------------------------------------------------------ */
/* 9. small unit checks for the helpers                                 */
/* ------------------------------------------------------------------ */

test('describeApproach and tokenize behave per contract', async () => {
  assert.equal(describeApproach('step-by-step'), 'teach in numbered steps, one idea per step');
  assert.equal(describeApproach('different'), 'explain it a DIFFERENT way than before — change structure, framing, and the example; do not repeat the previous explanation');
  assert.equal(describeApproach('made-up'), '');
  assert.deepEqual(tokenize('Photosynthesis?. LIGHT, energy!'), ['photosynthesis', 'light', 'energy']);
  assert.deepEqual(tokenize('ab of to x'), [], 'tokens shorter than 3 chars are dropped');
  // chooseApproach + lastApproach wiring sanity
  const db = await newDb();
  assert.equal(await lastApproach(db, 'nope'), null);
  assert.equal(chooseApproach({ explicit: null, previous: null, preferred: null }), null);
});
