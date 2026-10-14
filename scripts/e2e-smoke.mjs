// Real end-to-end smoke test: actual ChromaDB + actual NVIDIA NIM, no stubs.
// Proves the whole learning loop the way a demo would exercise it.
//
// Requires: server running (npm start) + Chroma reachable (local or cloud).
// Run:  npm run e2e

// --- minimal valid PDF builder (also used by tests) ---
function buildPdf(pageTexts) {
  const pageIds = pageTexts.map((_, i) => 3 + i * 2);
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  };
  pageTexts.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 999 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objs[contentId] = `<< /Length ${stream.length} >> stream\n${stream}\nendstream`;
  });
  objs[999] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets = {};
  for (const id of Object.keys(objs).map(Number).sort((a, b) => a - b)) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xrefStart = out.length;
  const maxId = Math.max(...Object.keys(objs).map(Number));
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const fail = (msg) => { console.error('SMOKE FAILED:', msg); process.exit(1); };

// 1) health
const health = await (await fetch(`${BASE}/api/health`)).json();
console.log('1) health:', health.status, JSON.stringify(health.checks.chroma));
if (health.status !== 'ok') fail('dependencies are not all healthy — start Chroma and check .env');

// 2) upload a real PDF
const pdf = buildPdf([
  'Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose. It takes place mainly in the chloroplasts of plant cells.',
  'The light-dependent reactions occur in the thylakoid membranes and produce ATP and NADPH. The Calvin cycle uses these molecules to fix carbon dioxide into sugar in the stroma.',
]);
const fd = new FormData();
fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'smoke-photosynthesis.pdf');
const up = await (await fetch(`${BASE}/api/sources/upload`, { method: 'POST', body: fd })).json();
if (!up.source) fail(`upload: ${JSON.stringify(up.error)}`);
console.log(`2) uploaded: ${up.source.title} → ${up.source.id} (${up.source.sizeLabel}, ${up.source.chunkCount} chunks)`);

// 3) tutor — grounded answer expected
const ask = await post('/api/tutor/ask', { question: 'Where do the light-dependent reactions take place?' });
const askBody = await ask.json();
if (ask.status !== 200 || !askBody.answer) fail(`tutor: ${JSON.stringify(askBody.error)}`);
console.log(`3) tutor: ${askBody.answer.slice(0, 140)}…`);
console.log(`   citations: ${askBody.citations.map((c) => `${c.title} ${JSON.stringify(c.location)}`).join(' | ')}`);
if (askBody.citations.length === 0) fail('tutor returned no citations');

// 4) quiz — key must not leak
const quizBody = await (await post('/api/quiz/generate', { topic: 'Photosynthesis', questionCount: 3 })).json();
if (quizBody.error) fail(`quiz generate: ${JSON.stringify(quizBody.error)}`);
if (JSON.stringify(quizBody).includes('correctChoiceId')) fail('answer key leaked before submission');
console.log(`4) quiz ${quizBody.quiz.id} (${quizBody.quiz.difficulty}): ${quizBody.quiz.questions.length} questions, key hidden ✓`);

// 5) grade deterministically
const answers = { answers: quizBody.quiz.questions.map((q, i) => ({ index: i, choiceId: i === 0 ? null : 'a' })) };
const ansBody = await (await post(`/api/quiz/${quizBody.quiz.id}/answer`, answers)).json();
if (ansBody.error) fail(`answer: ${JSON.stringify(ansBody.error)}`);
console.log(`5) graded: ${ansBody.result.score.correct}/${ansBody.result.score.total} → mastery ${ansBody.result.masteryUpdate.after}, next difficulty: ${ansBody.result.recommendedDifficulty}`);

// 6) replay guard
const again = await post(`/api/quiz/${quizBody.quiz.id}/answer`, answers);
if (again.status !== 409) fail(`resubmit returned ${again.status}, expected 409`);
console.log('6) resubmit → 409 QUIZ_ALREADY_ANSWERED ✓');

// 7) session-scoped organisation: create a session, move the PDF in, ask scoped
const ses = await post('/api/sessions', { title: 'Smoke Biology', category: 'subject' });
const sesBody = await ses.json();
if (ses.status !== 201) fail(`session create: ${JSON.stringify(sesBody.error)}`);
const sessionId = sesBody.session.id;
const move = await fetch(`${BASE}/api/sources/${up.source.id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
});
if (move.status !== 200) fail(`source move: ${JSON.stringify(await move.json())}`);
const scopedAsk = await post('/api/tutor/ask', { question: 'Where do the light-dependent reactions take place?', sessionId });
if (scopedAsk.status !== 200) fail(`scoped tutor: ${JSON.stringify(await scopedAsk.json())}`);
const scopedBody = await scopedAsk.json();
if (!scopedBody.citations.length) fail('scoped tutor returned no citations');
if (scopedBody.citations.some((c) => c.sourceId !== up.source.id)) fail('scoped tutor used sources outside the session');
console.log(`7) scoped tutor ✓ (citations only from ${up.source.id}, sessionId echoed: ${scopedBody.sessionId})`);

// 8) a deck generated INSIDE the session is saved and counted
const deckRes = await post('/api/flashcards/generate', { topic: 'Photosynthesis', count: 3, sessionId });
if (deckRes.status !== 201) fail(`deck generate: ${JSON.stringify(await deckRes.json())}`);
const deckBody = await deckRes.json();
const library = await fetch(`${BASE}/api/decks?sessionId=${sessionId}`).then((r) => r.json());
const saved = library.decks.find((d) => d.id === deckBody.deckId);
if (!saved) fail('generated deck did not appear in the library');
if (saved.cardCount !== deckBody.cards.length) fail('deck cardCount mismatch');
await fetch(`${BASE}/api/decks/${saved.id}/cards/0`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
});
const afterMark = await fetch(`${BASE}/api/decks/${saved.id}`).then((r) => r.json());
if (afterMark.deck.knownCount !== 1) fail('card status did not persist');
console.log(`8) deck saved in session ✓ (${saved.cardCount} cards, knownCount=1 after marking)`);

// 9) sources list reflects session assignment
const srcList = await fetch(`${BASE}/api/sources?sessionId=${sessionId}`).then((r) => r.json());
if (!srcList.sources.some((s) => s.id === up.source.id)) fail('session source filter failed');
console.log('9) session source filter ✓');

console.log('\nSMOKE PASSED — full learning loop verified against real services.');
