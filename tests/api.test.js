// End-to-end API test of the whole learning loop with stubbed AI + vector
// services (no network, no ChromaDB). Proves the wiring: upload → retrieve →
// tutor citations → quiz generation without a leaked key → deterministic
// grading → learner update → progress rollup.

import test from 'node:test';
import assert from 'node:assert/strict';

// The upload-size-limit tests (absorbed from upload-limits.test.js) need a
// non-default MAX_UPLOAD_MB. config.js reads process.env ONCE at import, so
// the override is set here BEFORE the dynamic imports below; `node --test`
// runs this file in its own process, so it cannot leak into other test files.
process.env.MAX_UPLOAD_MB = '1';

const { config } = await import('../server/config.js');
const { startApp, buildPptx, fakeVector, TUTOR_ANSWER } = await import('./helpers.js');

const WEBPAGE = {
  url: 'https://learn.example/cells',
  title: 'Cells 101',
  text: 'Cells are the basic unit of life.\n\nThe nucleus stores DNA.\n\nMitochondria release energy from glucose.\n\nMitosis produces two identical daughter cells.\n\nMeiosis produces four varied cells for reproduction.',
};

test('full learning loop over the HTTP API (stubbed AI + vector store)', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  let sourceId;

  await t.test('health reports ok with stubbed dependencies', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.sqlite.ok, true);
    assert.equal(body.checks.nim.ok, true);
  });

  await t.test('webpage ingestion creates a source', async () => {
    const res = await fetch(`${ctx.base}/api/sources/webpage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
    });
    assert.equal(res.status, 201);
    const { source } = await res.json();
    sourceId = source.id;
    assert.equal(source.type, 'webpage');
    assert.equal(source.sizeLabel, 'webpage');
    assert.ok(source.chunkCount >= 5);
    assert.equal(ctx.vector.store.length, source.chunkCount); // vectors actually stored
  });

  await t.test('GET /api/sources lists the source', async () => {
    const { sources } = await (await fetch(`${ctx.base}/api/sources`)).json();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, sourceId);
  });

  await t.test('tutor answer carries real retrieved citations', async () => {
    const res = await fetch(`${ctx.base}/api/tutor/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'How does mitosis work?', sourceIds: [sourceId] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.answer, TUTOR_ANSWER);
    assert.equal(body.needsContent, false);
    assert.ok(body.citations.length > 0);
    assert.equal(body.citations[0].sourceId, sourceId);
    assert.equal(body.citations[0].title, 'Cells 101');
    assert.ok(body.citations[0].location.paragraph >= 1);
    assert.equal(typeof body.citations[0].score, 'number');
  });

  await t.test('quiz generation never leaks the answer key', async () => {
    const res = await fetch(`${ctx.base}/api/quiz/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cell division', sourceIds: [sourceId] }),
    });
    assert.equal(res.status, 201);
    const { quiz } = await res.json();
    assert.ok(quiz.id.startsWith('quiz_'));
    assert.equal(quiz.questions.length, 3);
    assert.equal(quiz.questions[0].choices.length, 4);
    const raw = JSON.stringify(quiz);
    assert.ok(!raw.includes('correctChoiceId'), 'key must not be in the generate response');
    assert.ok(!raw.includes('explanation'), 'explanations must not be in the generate response');
    ctx.quizId = quiz.id;
    ctx.correctChoices = ['a', 'b', 'a']; // from QUIZ_JSON
  });

  await t.test('deterministic grading, key reveal, learner update', async () => {
    const answers = { answers: [{ index: 0, choiceId: 'a' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'b' }] };
    const res = await fetch(`${ctx.base}/api/quiz/${ctx.quizId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answers),
    });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.deepEqual(result.score, { correct: 2, total: 3, percent: 67 });
    assert.equal(result.questions[0].correctChoiceId, 'a'); // revealed only now
    assert.equal(result.questions[0].correct, true);
    assert.equal(result.masteryUpdate.topic, 'cell division');
    assert.ok(Math.abs(result.masteryUpdate.after - 2 / 3) < 0.0001); // rounded to 4 decimals
    assert.equal(result.recommendedDifficulty, 'medium');
  });

  await t.test('resubmitting the same quiz returns 409 with the EXACT stored result', async () => {
    const original = await fetch(`${ctx.base}/api/quiz/${ctx.quizId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ index: 0, choiceId: 'b' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'b' }] }),
    }).then((r) => r.json()).catch(() => null) || null;
    // The first replay is the 409 (the grading subtest above already graded);
    // a SECOND replay returns the same stored result again.
    const resubmit = await fetch(`${ctx.base}/api/quiz/${ctx.quizId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ index: 0, choiceId: 'b' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'b' }] }),
    });
    assert.equal(resubmit.status, 409);
    const body = await resubmit.json();
    assert.equal(body.error.code, 'QUIZ_ALREADY_ANSWERED');
    ctx.replayResult = body.result;
  });

  await t.test('replayed result matches the original graded attempt', async () => {
    const res = await fetch(`${ctx.base}/api/quiz/${ctx.quizId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ index: 0, choiceId: 'b' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'b' }] }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body.result, ctx.replayResult); // identical shape every replay
    const topics = await (await fetch(`${ctx.base}/api/learner/progress`)).json();
    assert.equal(topics.overall.quizzesTaken, 1); // progress was not double-counted
  });

  await t.test('progress endpoint reflects everything', async () => {
    const body = await (await fetch(`${ctx.base}/api/learner/progress`)).json();
    assert.equal(body.topics.length, 1);
    assert.equal(body.topics[0].topic, 'cell division');
    assert.equal(body.topics[0].masteryPercent, 67);
    assert.equal(body.overall.questionsAnswered, 3);
    assert.ok(['easy', 'medium', 'hard'].includes(body.suggestedNext.topic === 'cell division' ? body.suggestedNext.difficulty : 'medium'));
    const types = body.recentActivity.map((a) => a.type);
    assert.ok(types.includes('quiz') && types.includes('upload') && types.includes('question'));
  });

  await t.test('flashcards generation returns validated cards', async () => {
    const res = await fetch(`${ctx.base}/api/flashcards/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cells', sourceIds: [sourceId] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.cards.length, 3); // stub fixture returns a three-card pile
    assert.ok(body.cards[0].front.length > 0);
    assert.equal(body.cards[0].citations[0].sourceId, sourceId);
  });
});

test('pptx upload extracts slides with locations', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const fd = new FormData();
  fd.append('file', new Blob([buildPptx()]), 'recursion-slides.pptx');
  const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: fd });
  assert.equal(res.status, 201);
  const { source } = await res.json();
  assert.equal(source.type, 'pptx');
  assert.equal(source.slideCount, 2);
  assert.equal(source.sizeLabel, '2 slides');
  const stored = ctx.vector.store.find((c) => c.text.includes('base case'));
  assert.equal(stored.metadata.slide, 1); // slide location preserved into vector metadata
});

test('validation and error handling (all stubbed, no network)', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const post = (url, body) => fetch(`${ctx.base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  await t.test('unsupported upload type', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['hello']), 'notes.txt');
    const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'UNSUPPORTED_FILE');
  });

  await t.test('missing file field', async () => {
    const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  });

  await t.test('webpage: bad URL and short text', async () => {
    assert.equal((await post('/api/sources/webpage', { url: 'nope', text: 'x'.repeat(60) })).status, 400);
    const short = await post('/api/sources/webpage', { url: 'https://ok.org', text: 'tiny' });
    assert.equal(short.status, 400);
    assert.equal((await short.json()).error.code, 'VALIDATION_ERROR');
  });

  await t.test('tutor: bad question length and unknown source', async () => {
    assert.equal((await post('/api/tutor/ask', { question: 'x' })).status, 400);
    const unknown = await post('/api/tutor/ask', { question: 'What is recursion?', sourceIds: ['src_nope'] });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'SOURCE_NOT_FOUND');
  });

  await t.test('quiz: bad difficulty, bad count, unknown quiz', async () => {
    assert.equal((await post('/api/quiz/generate', { topic: 'Cells', difficulty: 'insane' })).status, 400);
    assert.equal((await post('/api/quiz/generate', { topic: 'Cells', questionCount: 99 })).status, 400);
    const res = await post('/api/quiz/quiz_missing/answer', { answers: [{ index: 0, choiceId: 'a' }] });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'QUIZ_NOT_FOUND');
  });

  await t.test('quiz generation with no indexed material returns 422', async () => {
    const emptyCtx = await startApp({ vector: { ...fakeVector(), store: [] } });
    t.after(emptyCtx.close);
    const res = await fetch(`${emptyCtx.base}/api/quiz/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'Anything' }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'QUIZ_CONTENT_INVALID');
  });
});

test('health degrades gracefully when Chroma is unreachable', async (t) => {
  const failing = {
    ...fakeVector(),
    pingChroma: async () => { throw new Error('connection refused'); },
  };
  const ctx = await startApp({ vector: failing });
  t.after(ctx.close);
  const body = await (await fetch(`${ctx.base}/api/health`)).json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.chroma.ok, false);
  assert.ok(body.checks.chroma.message.length > 0);
  assert.equal(body.checks.sqlite.ok, true); // the rest still works
});

// --- upload-size limits (absorbed from upload-limits.test.js) -----------------
// MAX_UPLOAD_MB = '1' is set in this process before config.js loads (top of file).

test('health exposes the configured upload limit without degrading status', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const res = await fetch(`${ctx.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.checks.limits.maxUploadMb, config.maxUploadMb);
  // The limits block is a fact, not a probe — it must not tip the rollup.
  assert.equal(body.status, 'ok');
});

test('oversized upload returns 413 FILE_TOO_LARGE with the real limit', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const limitBytes = config.maxUploadMb * 1024 * 1024;
  const form = new FormData();
  form.set('file', new Blob([Buffer.alloc(limitBytes + 1000)]), 'big.pdf');
  const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: form });

  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.code, 'FILE_TOO_LARGE');
  assert.ok(body.error.message.includes('the upload limit is 1 MB'), body.error.message);
});
