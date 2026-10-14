import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { extractPptx, extractSlideText, slideNumberFromPath } from '../server/services/extract/pptx.js';
import { extractWebpage, normalizeWebpageText } from '../server/services/extract/webpage.js';
import { extractPdf } from '../server/services/extract/pdf.js';

// Build a minimal but structurally valid .pptx in memory.
function buildPptx(slides) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  slides.forEach((text, i) => {
    zip.addFile(
      `ppt/slides/slide${i + 1}.xml`,
      Buffer.from(`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
    );
  });
  return zip.toBuffer();
}

// Builds a minimal, structurally valid PDF with one text line per page.
function buildPdf(pageTexts) {
  const pageIds = pageTexts.map((_, i) => 3 + i * 2); // page obj, content obj per page
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
  for (let id = 1; id <= maxId; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
test('slideNumberFromPath only matches slide entries', () => {
  assert.equal(slideNumberFromPath('ppt/slides/slide12.xml'), 12);
  assert.equal(slideNumberFromPath('ppt/slides/_rels/slide1.xml.rels'), null);
  assert.equal(slideNumberFromPath('ppt/media/image1.png'), null);
});

test('extractSlideText joins text runs and decodes XML entities', () => {
  const xml = '<a:r><a:t>Recursion &amp; base cases</a:t></a:r><a:r><a:t> explained</a:t></a:r>';
  assert.equal(extractSlideText(xml), 'Recursion & base cases explained');
});

test('extractPptx returns per-slide segments with slide numbers', () => {
  const buffer = buildPptx([
    'Photosynthesis converts light energy into chemical energy.',
    'The light-dependent reactions happen in the thylakoid membrane &amp; beyond.',
  ]);
  const { segments, slideCount, pageCount } = extractPptx(buffer);
  assert.equal(slideCount, 2);
  assert.equal(pageCount, null);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].location, { slide: 1 });
  assert.deepEqual(segments[1].location, { slide: 2 });
  assert.ok(segments[1].text.includes('thylakoid membrane & beyond'));
});

test('extractPptx skips image-only slides but counts them', () => {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  // Slide 1 has a graphic frame but no <a:t> text runs at all.
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld><p:graphicFrame/></p:sld>'));
  zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>Only slide two has words.</a:t></p:sld>'));
  const { segments, slideCount } = extractPptx(zip.toBuffer());
  assert.equal(slideCount, 2);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].location, { slide: 2 });
});

test('extractPptx rejects non-zip buffers', () => {
  assert.throws(() => extractPptx(Buffer.from('not a zip at all')), { code: 'VALIDATION_ERROR' });
});

test('normalizeWebpageText splits paragraphs and collapses whitespace', () => {
  const paragraphs = normalizeWebpageText('First   para.\nwith wrap.\n\nSecond para.');
  assert.deepEqual(paragraphs, ['First para. with wrap.', 'Second para.']);
});

test('extractWebpage validates URL and text, keeps paragraph numbers', () => {
  const good = extractWebpage({
    url: 'https://example.org/lesson',
    title: '',
    text: 'Paragraph one about cells.\n\nParagraph two about nuclei.\n\nParagraph three finishes it.',
  });
  assert.equal(good.title, 'example.org'); // hostname fallback
  assert.equal(good.segments.length, 3);
  assert.deepEqual(good.segments[1].location, { paragraph: 2 });

  assert.throws(() => extractWebpage({ url: 'ftp://x', text: 'a'.repeat(60) }), { code: 'INVALID_URL' });
  assert.throws(() => extractWebpage({ url: 'https://x.org', text: 'too short' }), { code: 'VALIDATION_ERROR' });
});

// --- PDF extraction (absorbed from extract_pdf.test.js) ----------------------

test('extractPdf returns per-page text with page numbers', async () => {
  const buffer = buildPdf([
    'Mitochondria are the powerhouse of the cell.',
    'Ribosomes assemble proteins from amino acids.',
  ]);
  const { segments, pageCount, slideCount } = await extractPdf(buffer);
  assert.equal(pageCount, 2);
  assert.equal(slideCount, null);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].location, { page: 1 });
  assert.ok(segments[0].text.includes('powerhouse'));
  assert.deepEqual(segments[1].location, { page: 2 });
  assert.ok(segments[1].text.includes('Ribosomes'));
});

test('extractPdf skips pages with no extractable text', async () => {
  // Page 2 has no text-drawing operators at all.
  const buffer = buildPdf(['Only the first page has words.', '']);
  const { segments, pageCount } = await extractPdf(buffer);
  assert.equal(pageCount, 2);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].location, { page: 1 });
});

test('extractPdf rejects data that is not a PDF', async () => {
  await assert.rejects(() => extractPdf(Buffer.from('definitely not a pdf')), { code: 'VALIDATION_ERROR' });
});
