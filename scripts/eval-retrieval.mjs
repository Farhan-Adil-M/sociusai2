// Live retrieval evaluation:Runs the fixed eval set (tests/eval-set.json)
// against the REAL backend — real embeddings, real tutor, real abstention —
// and prints an honest report. Run: npm run eval (server must be running).
//
// Metrics per the plan:
//  - source-hit: the tutor's citations include the expected source+page
//  - abstention: unsupported questions produce needsContent with no citations
// The script exits 1 if quality is below the acceptance thresholds.

import { hitScore } from '../server/services/retrieval.js';
import evalSet from '../tests/eval-set.json' with { type: 'json' };

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';

// Three pages, one fact per page — deterministic targets for the eval set.
const pages = [
  'Photosynthesis converts light energy into glucose. This happens inside the chloroplasts of plant cells.',
  'The light-dependent reactions occur in the thylakoid membranes. They produce ATP and NADPH, which the Calvin cycle uses.',
  'Cellular respiration happens in mitochondria. It consumes oxygen and produces ATP for the cell.',
];

// Minimal valid PDF (same builder pattern as the unit-test fixtures).
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

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (health.status !== 'ok') {
  console.error('EVAL BLOCKED: dependencies are not healthy —', JSON.stringify(health.checks));
  process.exit(1);
}

// Upload the eval document fresh; the upload is idempotent-safe for the eval
// run itself (it creates its own source) but leaves one source behind — noted
// in the report.
const fd = new FormData();
fd.append('file', new Blob([buildPdf(pages)], { type: 'application/pdf' }), 'smoke-eval-source.pdf');
const up = await fetch(`${BASE}/api/sources/upload`, { method: 'POST', body: fd });
const upBody = await up.json();
if (up.status !== 201) { console.error('EVAL BLOCKED: upload failed', upBody.error); process.exit(1); }
console.log(`eval source: ${upBody.source.id} (${upBody.source.sizeLabel})`);

const report = { grounded: [], unsupported: [], metrics: {} };

for (const testCase of evalSet.cases) {
  const res = await fetch(`${BASE}/api/tutor/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: testCase.question }),
  });
  const body = await res.json();
  const top = body.citations?.[0] ?? null;

  if (testCase.unsupported) {
    const pass = body.needsContent === true && (body.citations ?? []).length === 0;
    report.unsupported.push({ id: testCase.id, pass });
    console.log(`${pass ? '✓' : '✗'} [abstain] ${testCase.question.slice(0, 50)} → needsContent=${body.needsContent}`);
    continue;
  }

  const topTitle = top?.title ?? '';
  const topPage = top?.location?.page;
  const pass = topTitle === testCase.expectTitle && topPage === testCase.location?.page;
  report.grounded.push({
    id: testCase.id, pass, topTitle, topPage,
    score: top ? (top.score ?? hitScore({ distance: 1 - (top.score ?? 0) })) : null,
    expectedScore: top ? Math.max(...body.citations.map((c) => c.score ?? -1)) : null,
  });
  console.log(`${pass ? '✓' : '✗'} [hit] ${testCase.question.slice(0, 50)} → ${topTitle} p.${topPage}${top?.score !== undefined ? ` (score ${top.score})` : ''}`);
}

const groundedPass = report.grounded.filter((r) => r.pass).length;
const unsupportedPass = report.unsupported.filter((r) => r.pass).length;
report.metrics = {
  sourceHit: `${groundedPass}/${evalSet.groundedTotal}`,
  abstention: `${unsupportedPass}/${evalSet.unsupportedTotal}`,
};
console.log('\n=== RETRIEVAL EVAL REPORT ===');
console.log(JSON.stringify(report, null, 1));
console.log(`NOTE: leaves one eval source in the library (${upBody.source.id}); safe to delete manually.`);

const GROUNDED_MIN = Math.ceil(evalSet.groundedTotal * 0.8); // ≥75% (4/5)
if (groundedPass < GROUNDED_MIN || unsupportedPass < evalSet.unsupportedTotal) {
  console.error(`EVAL FAILED: source-hit ${report.metrics.sourceHit} (need ≥${GROUNDED_MIN}), abstention ${report.metrics.abstention} (need all)`);
  process.exit(1);
}
console.log('EVAL PASSED');
