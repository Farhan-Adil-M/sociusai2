// T2 round: the extract seams that tests/extract.test.js does not cover.
//
// extract.test.js already owns: slideNumberFromPath matching, extractSlideText
// entity decoding, per-slide pptx segments, image-only-slide skipping, the pptx
// non-zip rejection, webpage parsing, and pdf extraction. This file deliberately
// does NOT repeat any of those. What it adds:
//
//   extract/office.js  the shared OOXML plumbing — the 200-char section cap at
//                      its exact boundary, the container guard's error contract,
//                      and decodeXmlEntities' ordering rules.
//   extract/docx.js    real .docx fixtures (headings, styles, empty titles,
//                      over-long titles) end to end through AdmZip.
//   extract/pptx.js    title placeholders and out-of-order slide entries.
//   extract/image.js   the `location.paragraph` key an image segment emits,
//                      asserted all the way through chunkSegments, because the
//                      chunker copies only page|slide|paragraph|timecode|
//                      timestamp and a wrong key would silently break citations.
//   chunker.js         that five-key copy invariant itself, plus the one
//                      documented extra (`section`).
//   media/youtube.js   the pure helpers only: no network path is exercised.
//   media/ocr.js       which language-data layout resolves as local — the case
//                      (a directory holding only eng.traineddata.gz) that
//                      shipped broken and was only caught by running it.
//
// Everything here is offline: no fetch, no tesseract worker, no NIM.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  MAX_SECTION_CHARS,
  decodeXmlEntities,
  openOfficeZip,
  sectionName,
} from '../server/services/extract/office.js';
import {
  extractDocx,
  extractDocxParagraphDetails,
  extractDocxParagraphs,
  extractParagraphText,
} from '../server/services/extract/docx.js';
import {
  extractPptx,
  extractSlideTitle,
} from '../server/services/extract/pptx.js';
import { imageSegments } from '../server/services/extract/image.js';
import { chunkSegments } from '../server/services/chunker.js';
import { resolveLanguageData } from '../server/services/media/ocr.js';
import {
  buildTranscriptSegments,
  chooseCaptionTrack,
  formatTimecode,
  parseTimedText,
  parseYouTubeUrl,
  readCaptionTracks,
} from '../server/services/media/youtube.js';

// ----------------------------------------------------------------- fixtures

/** A minimal word/document.xml body from `[style, text]` pairs. */
function docxXml(paragraphs) {
  const body = paragraphs
    .map(([style, text]) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join('');
  return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function docxBuffer(paragraphs) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('word/document.xml', Buffer.from(docxXml(paragraphs)));
  return zip.toBuffer();
}

/** A minimal pptx slide: one optional title placeholder plus one body shape. */
function slideXml(title, bodyText) {
  const titleShape = title === undefined
    ? ''
    : `<p:sp><p:nvSpPr/><p:ph type="title"/><p:txBody>${title}</p:txBody></p:sp>`;
  const body = bodyText === undefined
    ? ''
    : `<p:sp><p:nvSpPr/><p:spPr/><p:txBody><a:p><a:r><a:t>${bodyText}</a:t></a:r></a:p></p:txBody></p:sp>`;
  return `<p:sld><p:cSld><p:spTree>${titleShape}${body}</p:spTree></p:cSld></p:sld>`;
}

/** A pptx buffer from `{ name, xml }` entries, in the order given. */
function pptxBuffer(entries) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  for (const { name, xml } of entries) {
    zip.addFile(`ppt/slides/${name}`, Buffer.from(xml));
  }
  return zip.toBuffer();
}

/** A throwaway directory, removed when the test finishes. */
function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `socius-extract-media-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run `fn` with `overrides` applied to process.env, then restore them. */
async function withEnv(overrides, fn) {
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Prove the code under test cannot reach the network: every fetch is made to
 * fail immediately, and the stub is removed when the test ends. A production
 * path that is not supposed to download anything fails loudly instead of
 * silently succeeding here.
 */
function withoutNetwork(t) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline test: network access is disabled'));
  t.after(() => { globalThis.fetch = originalFetch; });
}

const repeat = (char, count) => char.repeat(count);

// === extract/office.js =======================================================

test('decodeXmlEntities decodes the five named entities in the safe order', () => {
  assert.equal(decodeXmlEntities('a &lt;b&gt; &quot;c&quot; &apos;d&#39;e&#x27;f'), 'a <b> "c" \'d\'e&#x27;f');
  assert.equal(decodeXmlEntities('&#160;a&#160;b'), ' a b'); // a numeric NBSP is decoded
  assert.equal(decodeXmlEntities('&amp;amp;lt;'), '&amp;lt;');
  assert.equal(decodeXmlEntities('Tom &amp; Jerry &#169; 2026'), 'Tom & Jerry © 2026');
  assert.equal(decodeXmlEntities('&#128512; far away'), '\u{1F600} far away');
});

test('decodeXmlEntities leaves unknown names, junk numbers and markup alone', () => {
  // Not one of the five entities Office XML emits, so left exactly as written.
  // (Word writes a real NBSP numerically — &#160; — and that IS decoded.)
  const untouched = '&nbsp; &copy; &ampx; &#; &#x27; &XYZ;';
  assert.equal(decodeXmlEntities(untouched), untouched);
  assert.equal(decodeXmlEntities('&ampx;'), '&ampx;'); // no semicolon, no entity
  assert.equal(decodeXmlEntities('&amp'), '&amp'); // truncated, not decodable
  assert.equal(decodeXmlEntities('<a:t>&lt;</a:t>'), '<a:t><</a:t>');
  assert.equal(decodeXmlEntities('&&amp;&'), '&&&');
  assert.equal(decodeXmlEntities(''), '');
});

test('sectionName caps a name at MAX_SECTION_CHARS and pads nothing else', () => {
  assert.equal(MAX_SECTION_CHARS, 200);
  assert.equal(sectionName(null), null);
  assert.equal(sectionName(undefined), null);
  assert.equal(sectionName('   '), null);
  assert.equal(sectionName(repeat(' ', 3) + 'Floor' + repeat(' ', 4)), 'Floor');

  // 199 characters is still a legal name and must survive untouched.
  assert.equal(sectionName(repeat('a', 199)), repeat('a', 199));
  // 200 is the last legal length: not truncated.
  assert.equal(sectionName(repeat('b', 200)), repeat('b', 200));
  // 201 is the first illegal length: 199 kept + one ellipsis character.
  assert.equal(sectionName(repeat('c', 201)), `${repeat('c', 199)}…`);
  assert.equal(sectionName(repeat('c', 201)).length, 200);
  // A truncated name never ends in the padding the cap cut into.
  assert.equal(sectionName(repeat('d', 198) + '  tail'), `${repeat('d', 198)}…`);
});

test('openOfficeZip hands back a readable archive and turns non-zips into VALIDATION_ERROR', () => {
  const zip = openOfficeZip(docxBuffer([['Heading1', 'Title']]), 'a .docx message');
  assert.ok(zip.getEntry('word/document.xml'));
  assert.equal(
    zip.getEntry('word/document.xml').getData().toString('utf8').includes('<w:t>Title</w:t>'),
    true,
  );

  for (const junk of ['not a zip at all', '', 'PK\u0003\u0004 truncated']) {
    assert.throws(() => openOfficeZip(Buffer.from(junk), 'a .docx message'), (err) => {
      assert.equal(err.name, 'ApiError');
      assert.equal(err.status, 400);
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.equal(err.message, 'a .docx message');
      return true;
    });
  }
});

// === extract/docx.js =========================================================

test('extractParagraphText joins runs and treats tabs and breaks as gaps', () => {
  const xml = '<w:r><w:t xml:space="preserve">Mitosis &amp; meiosis</w:t></w:r>'
    + '<w:r><w:t>  copies</w:t></w:r><w:tab/><w:r><w:t>   the  nucleus</w:t></w:r><w:br/><w:r><w:t>once</w:t></w:r>';
  assert.equal(extractParagraphText(xml), 'Mitosis & meiosis copies the nucleus once');
  assert.equal(extractParagraphText('<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'), '');
});

test('extractDocxParagraphDetails flags heading styles and drops invisible text', () => {
  const xml = docxXml([
    ['Title', 'Cell Division'],
    [null, 'Mitosis produces two identical cells.'],
    ['Heading 2', 'Meiosis'],
    [null, 'Meiosis divides twice.'],
    [null, ''],
  ]);
  assert.deepEqual(extractDocxParagraphDetails(xml).map((p) => [p.text, p.isHeading]), [
    ['Cell Division', true],
    ['Mitosis produces two identical cells.', false],
    ['Meiosis', true],
    ['Meiosis divides twice.', false],
  ]);
  assert.deepEqual(extractDocxParagraphs(xml), [
    'Cell Division',
    'Mitosis produces two identical cells.',
    'Meiosis',
    'Meiosis divides twice.',
  ]);

  const invisible = '<w:p><w:del><w:r><w:delText>rejected draft</w:delText></w:r></w:del></w:p>'
    + '<w:p><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:p>'
    + '<w:p><w:r><w:t>visible only</w:t></w:r></w:p>';
  assert.deepEqual(extractDocxParagraphs(invisible), ['visible only']);
});

test('extractDocx numbers paragraphs and names each section from its heading', () => {
  const { segments, pageCount, slideCount } = extractDocx(docxBuffer([
    ['Heading1', 'Cell Division'],
    [null, 'Mitosis produces two identical daughter cells.'],
    [null, 'The nucleus divides once.'],
    ['Heading2', 'Meiosis'],
    [null, 'Meiosis produces four cells with half the chromosomes.'],
  ]));

  assert.equal(pageCount, null);
  assert.equal(slideCount, null);
  assert.equal(segments.length, 5);
  assert.deepEqual(segments.map((s) => s.location), [
    { paragraph: 1 }, { paragraph: 2 }, { paragraph: 3 }, { paragraph: 4 }, { paragraph: 5 },
  ]);
  assert.deepEqual(segments.map((s) => s.kind), ['heading', undefined, undefined, 'heading', undefined]);
  assert.deepEqual(segments.map((s) => s.section), [
    'Cell Division', 'Cell Division', 'Cell Division', 'Meiosis', 'Meiosis',
  ]);
  assert.equal(segments[4].text, 'Meiosis produces four cells with half the chromosomes.');
});

test('extractDocx caps an over-long heading but stores its text in full', () => {
  const long = repeat('x', 201);
  const { segments } = extractDocx(docxBuffer([
    [null, 'Body paragraph before any heading, paragraph one.'],
    ['Heading1', long],
    [null, 'Body paragraph after the heading.'],
  ]));

  assert.equal(segments[0].section, undefined);
  assert.equal(segments[0].location.paragraph, 1);
  assert.equal(segments[1].section, `${repeat('x', 199)}…`);
  assert.equal(segments[1].section.length, 200);
  assert.equal(segments[1].text, long); // the cap is on the NAME, never on the text
  assert.equal(segments[2].section, segments[1].section);
  assert.equal(segments[2].location.paragraph, 3);
});

test('extractDocx leaves paragraphs unnamed when the document has no headings', () => {
  const { segments } = extractDocx(docxBuffer([
    [null, 'First paragraph about mitochondria.'],
    [null, 'Second paragraph about ribosomes.'],
  ]));
  assert.deepEqual(segments.map((s) => [s.location.paragraph, s.section, s.kind]), [
    [1, undefined, undefined],
    [2, undefined, undefined],
  ]);
});

test('extractDocx rejects a non-zip buffer with the .docx VALIDATION_ERROR', () => {
  assert.throws(() => extractDocx(Buffer.from('this is not a zip')), (err) => {
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.status, 400);
    assert.match(err.message, /could not be read as a \.docx/);
    assert.match(err.message, /binary \.doc format is not supported/);
    return true;
  });
});

test('extractDocx rejects a zip that holds no OOXML document body', () => {
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('a zip, but not a Word document'));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<a:t>a slide, not a document</a:t>'));
  assert.throws(() => extractDocx(zip.toBuffer()), (err) => {
    assert.equal(err.code, 'UNSUPPORTED_FILE');
    assert.equal(err.status, 400);
    return true;
  });
});

test('extractDocx rejects a body with no visible text', () => {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(docxXml([[null, '   ']])));
  assert.throws(() => extractDocx(zip.toBuffer()), { code: 'EMPTY_CONTENT' });

  const imagesOnly = new AdmZip();
  imagesOnly.addFile('word/document.xml',
    Buffer.from('<w:document><w:body><w:p><w:r><w:drawing><a:blip/></w:drawing></w:r></w:p></w:body></w:document>'));
  assert.throws(() => extractDocx(imagesOnly.toBuffer()), { code: 'EMPTY_CONTENT' });
});

// === extract/pptx.js =========================================================

test('extractSlideTitle reads only a title placeholder', () => {
  assert.equal(extractSlideTitle(slideXml('<a:p><a:r><a:t>The Cell Cycle</a:t></a:r></a:p>', 'Body text.')), 'The Cell Cycle');
  assert.equal(extractSlideTitle(slideXml(undefined, 'Body text.')), null);
  // An empty title placeholder names nothing; the body shape is not a title.
  assert.equal(extractSlideTitle(slideXml('<a:p><a:r><a:t>   </a:t></a:r></a:p>', 'Body text.')), null);
  assert.equal(extractSlideTitle(slideXml('<a:p><a:r><a:t>  </a:t></a:r></a:p>', 'Body text.')), null);
  // ctrTitle is the other spelling of the same placeholder.
  assert.equal(
    extractSlideTitle('<p:sld><p:sp><p:ph type="ctrTitle"/><p:txBody><a:p><a:r><a:t>Cover Slide</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'),
    'Cover Slide',
  );
});

test('extractPptx orders out-of-order slide entries and carries their titles', () => {
  // Added zipped in the order 10, 2, 1 on purpose.
  const { segments, slideCount, pageCount } = extractPptx(pptxBuffer([
    {
      name: 'slide10.xml',
      xml: slideXml('<a:p><a:r><a:t>Tenth</a:t></a:r></a:p>', 'Tenth slide body.'),
    },
    {
      name: 'slide2.xml',
      xml: slideXml('<a:p><a:r><a:t>Second</a:t></a:r></a:p>', 'Second slide body.'),
    },
    {
      name: 'slide1.xml',
      xml: slideXml('<a:p><a:r><a:t>First</a:t></a:r></a:p>', 'First slide body.'),
    },
  ]));

  assert.equal(pageCount, null);
  assert.equal(slideCount, 3); // every entry is counted, whatever the order
  assert.deepEqual(segments.map((s) => s.location), [{ slide: 1 }, { slide: 2 }, { slide: 10 }]);
  assert.deepEqual(segments.map((s) => s.section), ['First', 'Second', 'Tenth']);
  // A slide's text is every run it holds — title placeholder included — so the
  // section names the slide and the segment still carries the whole slide.
  assert.deepEqual(segments.map((s) => s.text), [
    'First First slide body.',
    'Second Second slide body.',
    'Tenth Tenth slide body.',
  ]);
});

test('extractPptx caps a slide title at the shared section limit', () => {
  const { segments } = extractPptx(pptxBuffer([
    { name: 'slide1.xml', xml: slideXml(`<a:p><a:r><a:t>${repeat('y', 201)}</a:t></a:r></a:p>`, 'Body.') },
  ]));
  assert.equal(segments[0].section, `${repeat('y', 199)}…`);
});

test('extractPptx rejects a non-zip buffer with the .pptx VALIDATION_ERROR', () => {
  assert.throws(() => extractPptx(Buffer.from('definitely not an Office file')), (err) => {
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.status, 400);
    assert.match(err.message, /could not be read as a \.pptx/);
    return true;
  });
});

test('extractPptx rejects a zip with no slides and a deck of empty slides', () => {
  const emptyZip = new AdmZip();
  emptyZip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  emptyZip.addFile('word/document.xml', Buffer.from('<w:document/>'));
  assert.throws(() => extractPptx(emptyZip.toBuffer()), (err) => {
    assert.equal(err.code, 'UNSUPPORTED_FILE');
    return true;
  });

  const noText = pptxBuffer([{ name: 'slide1.xml', xml: '<p:sld><p:graphicFrame/></p:sld>' }]);
  assert.throws(() => extractPptx(noText), { code: 'EMPTY_CONTENT' });
});

// === extract/image.js → chunker.js citation chain ============================

test('imageSegments splits on blank lines and cites each paragraph', () => {
  const text = 'Mitochondria are the powerhouse.\n\n  Ribosomes  assemble proteins.  \nBlurred line';
  const segments = imageSegments(text, [
    { text: 'Mitochondria are the powerhouse.', confidence: 0.92 },
    { text: 'Ribosomes assemble proteins.', confidence: 0.6 },
  ]);

  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((s) => s.location), [{ paragraph: 1 }, { paragraph: 2 }]);
  assert.equal(segments[0].text, 'Mitochondria are the powerhouse.');
  // Two paragraphs, so two segments; the second is one line with no score.
  assert.equal(segments[1].text, 'Ribosomes assemble proteins. Blurred line');
  assert.ok(Math.abs(segments[0].confidence - 0.92) < 1e-9);
  assert.equal('confidence' in segments[1], false);
});

test('imageSegments averages confidences and ignores malformed scores', () => {
  const segments = imageSegments('one line\nsecond line', [
    { confidence: 0.9 },
    { confidence: 0.6 },
    { confidence: null },
  ]);
  assert.ok(Math.abs(segments[0].confidence - 0.75) < 1e-9);

  const allJunk = imageSegments('line', [{ confidence: 'n/a' }, {}]);
  assert.equal('confidence' in allJunk[0], false);
  assert.equal(imageSegments('   \n\n  ', []).length, 0);
});

test('an image paragraph reaches a citation as location.paragraph', () => {
  // This is the seam the extract/image.js header warns about: the chunker copies
  // only page|slide|paragraph|timecode|timestamp, so the key an image segment
  // emits has to be exactly `paragraph` or every image citation loses its place.
  const extracted = {
    segments: imageSegments('Mitochondria are the powerhouse of the cell.\n\nRibosomes build proteins.', [
      { confidence: 0.9 },
      { confidence: 0.85 },
    ]),
  };
  const chunks = chunkSegments(extracted.segments, { sourceKind: 'image', sourceId: 'img-1' });

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].location, { paragraph: 1 });
  assert.deepEqual(chunks[1].location, { paragraph: 2 });

  const citationParagraphs = chunks.map((chunk) => chunk.metadata.paragraph ?? null);
  assert.deepEqual(citationParagraphs, [1, 2]);
  assert.deepEqual(chunks.map((chunk) => chunk.metadata.sourceId), ['img-1', 'img-1']);
  assert.deepEqual(chunks.map((chunk) => chunk.metadata.sourceKind), ['image', 'image']);
});

// === chunker.js location invariant ==========================================

test('a chunk copies exactly the five citable location keys and nothing else', () => {
  const sentence = 'A long enough sentence, with an ending, to be split into several chunks. ';
  const segment = {
    text: sentence.repeat(8),
    location: {
      page: 4, slide: 5, paragraph: 6, timecode: '00:00:07', timestamp: '00:00:07',
      // everything below must never reach chunk metadata
      section: 'Named by the location', note: 'prose', line: 9, x: 1, confidence: 0.4,
    },
  };
  const chunks = chunkSegments([segment], { size: 140, overlap: 30 });
  assert.ok(chunks.length >= 2, 'the fixture should have been split');

  for (const chunk of chunks) {
    assert.equal(chunk.metadata.page, 4);
    assert.equal(chunk.metadata.slide, 5);
    assert.equal(chunk.metadata.paragraph, 6);
    assert.equal(chunk.metadata.timecode, '00:00:07');
    assert.equal(chunk.metadata.timestamp, '00:00:07');
    // the location's own keys are copied verbatim, not renamed
    assert.deepEqual(chunk.location, segment.location);
    // and the five are the ONLY location keys that survive
    for (const dropped of ['note', 'line', 'x', 'confidence']) {
      assert.equal(dropped in chunk.metadata, false, `${dropped} must be dropped`);
    }
    // `section` is the documented exception: it is a named hint, not a position.
    assert.equal(chunk.metadata.section, 'Named by the location');
  }

  const owned = new Set(['sourceKind', 'section', 'page', 'slide', 'paragraph', 'timecode',
    'timestamp', 'charStart', 'charEnd', 'ordinal', 'chunkIndex']);
  for (const chunk of chunks) {
    for (const key of Object.keys(chunk.metadata)) {
      assert.ok(owned.has(key), `unexpected metadata key: ${key}`);
    }
  }
});

test('a chunk omits location keys the segment never carried', () => {
  const chunks = chunkSegments([{ text: 'A single short slide.', location: { slide: 3 } }]);
  assert.equal(chunks.length, 1);
  for (const key of ['page', 'paragraph', 'timecode', 'timestamp', 'section']) {
    assert.equal(key in chunks[0].metadata, false, `${key} must be omitted, not null`);
  }
  assert.equal(chunks[0].metadata.slide, 3);
});

// === media/youtube.js =======================================================

test('parseYouTubeUrl accepts the documented shapes and canonicalises them', () => {
  const cases = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'http://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/v/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ];
  for (const url of cases) {
    assert.deepEqual(parseYouTubeUrl(url), {
      videoId: 'dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }, url);
  }
  // Ids may use the URL-safe base64 alphabet.
  assert.equal(parseYouTubeUrl('https://youtu.be/a-b_cdefghi').videoId, 'a-b_cdefghi');
  assert.equal(parseYouTubeUrl('https://youtu.be/ABCDEFGHIJK').videoId, 'ABCDEFGHIJK');
});

test('parseYouTubeUrl rejects lookalike hosts, bad ids and unsafe schemes', () => {
  const rejected = [
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', // lookalike host
    'https://evil.test/watch?v=dQw4w9WgXcQ',
    'https://youtube.com', // no id
    'https://www.youtube.com/watch?v=tooShort',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQextra',
    'https://www.youtube.com/watch', // missing v entirely
    'https://www.youtube.com/shorts/', // missing segment
    'https://www.youtube.com/watch?v=javascript:alert(1)',
    'javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ',
    'data:text/html,https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'ftp://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '',
    'not a url at all',
  ];
  for (const url of rejected) {
    assert.equal(parseYouTubeUrl(url), null, url);
  }
  assert.equal(parseYouTubeUrl(null), null);
  assert.equal(parseYouTubeUrl(42), null);
  assert.equal(parseYouTubeUrl({ url: 'https://youtu.be/dQw4w9WgXcQ' }), null);
  // Over-long input is refused before it is ever parsed.
  assert.equal(parseYouTubeUrl(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&${'x'.repeat(2100)}`), null);
});

test('parseYouTubeUrl accepts scheme-less pastes and trims whitespace', () => {
  for (const pasted of [
    'youtube.com/watch?v=dQw4w9WgXcQ',
    '  www.youtube.com/watch?v=dQw4w9WgXcQ  ',
    'youtu.be/dQw4w9WgXcQ\n',
  ]) {
    assert.equal(parseYouTubeUrl(pasted)?.videoId, 'dQw4w9WgXcQ', pasted);
  }
});

test('parseYouTubeUrl judges the host, and drops credentials and ports on the way out', () => {
  // The guard is the HOST, never the whole URL string: a userinfo section or a
  // port does not change the hostname, so the paste is accepted — and the
  // canonical form it is stored as keeps neither the credentials nor the port.
  assert.deepEqual(parseYouTubeUrl('https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ'), {
    videoId: 'dQw4w9WgXcQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com:8080/watch?v=dQw4w9WgXcQ'), {
    videoId: 'dQw4w9WgXcQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
});

test('chooseCaptionTrack prefers the requested language, then human, then any', () => {
  const tracks = [
    { baseUrl: 'u1', languageCode: 'en', name: { simpleText: 'English (auto-generated)' } },
    { baseUrl: 'u2', languageCode: 'en', kind: 'asr' },
    { baseUrl: 'u3', languageCode: 'es', name: { runs: [{ text: 'Spanish' }] } },
    { baseUrl: 'u4', languageCode: 'de', kind: 'asr' },
  ];

  const en = chooseCaptionTrack(tracks, 'en');
  assert.equal(en.track, tracks[0]);
  assert.equal(en.name, 'English (auto-generated)');
  assert.equal(en.isAutoGenerated, true); // the name says so, even without kind
  assert.equal(en.languageCode, 'en');

  // Requested language with only an auto track: it is still the answer.
  const de = chooseCaptionTrack(tracks, 'de');
  assert.equal(de.track, tracks[3]);
  assert.equal(de.isAutoGenerated, true);

  // Unknown language falls back to the first human-written track of any language.
  const fr = chooseCaptionTrack(tracks, 'fr');
  assert.equal(fr.track, tracks[2]);
  assert.equal(fr.isAutoGenerated, false);
  assert.equal(fr.name, 'Spanish');

  // No human tracks at all: the first auto track.
  const onlyAuto = tracks.filter((t) => t.kind === 'asr');
  assert.equal(chooseCaptionTrack(onlyAuto, 'ja').track, tracks[1]);

  // The language match is case-insensitive and trims.
  assert.equal(chooseCaptionTrack(tracks, ' EN ').track, tracks[0]);

  // Nothing to choose from. (The route always feeds this an array from
  // readCaptionTracks, so an empty list is the real "no captions" shape.)
  assert.equal(chooseCaptionTrack([], 'en'), null);
});

test('readCaptionTracks only reads the documented JSON path', () => {
  const track = { baseUrl: 'u1', languageCode: 'en' };
  assert.deepEqual(readCaptionTracks({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } } }), [track]);
  assert.deepEqual(readCaptionTracks({ captions: {} }), []);
  assert.deepEqual(readCaptionTracks({}), []);
  assert.deepEqual(readCaptionTracks({ captions: { playerCaptionsTracklistRenderer: { captionTracks: 'nope' } } }), []);
  assert.deepEqual(readCaptionTracks(null), []);
});

test('parseTimedText reads cues, decodes them and drops unreadable ones', () => {
  const body = '<timedtext format="3"><body>'
    + '<p t="18640" d="3240">We&#39;re no strangers &amp; to love</p>'
    + '<p t="20000"><font color="#ccc">stripped &lt;tag&gt;</font></p>'
    + '<p t="21000">wrapped\\nnewline</p>'
    + '<p t="30000">   </p>'
    + '<p d="100">no start attribute</p>'
    + '<p t="100">early cue</p>'
    + '<p t="not-a-number">bad attribute</p>'
    + '</body></timedtext>';

  assert.deepEqual(parseTimedText(body), [
    { startSeconds: 18.64, text: "We're no strangers & to love" },
    { startSeconds: 20, text: 'stripped <tag>' },
    { startSeconds: 21, text: 'wrapped newline' },
    { startSeconds: 0.1, text: 'early cue' },
  ]);
  // `d` is deliberately unread: the segment length comes from SEGMENT_SECONDS.
  assert.equal(parseTimedText('<body><p t="5000" d="999999">one cue</p></body>')[0].startSeconds, 5);

  // Not the shape we can read: an empty list, never invented text.
  assert.deepEqual(parseTimedText('<html><body>not timedtext</body></html>'), []);
  assert.deepEqual(parseTimedText(''), []);
  assert.deepEqual(parseTimedText(undefined), []);
  assert.deepEqual(parseTimedText(null), []);
});

test('formatTimecode always renders hh:mm:ss and refuses junk', () => {
  assert.equal(formatTimecode(0), '00:00:00');
  assert.equal(formatTimecode(512), '00:08:32');
  assert.equal(formatTimecode(212), '00:03:32');
  assert.equal(formatTimecode(3661), '01:01:01');
  assert.equal(formatTimecode(59.9), '00:00:59'); // floored, never rounded up
  assert.equal(formatTimecode('512'), '00:08:32');
  assert.equal(formatTimecode(-1), null);
  assert.equal(formatTimecode(NaN), null);
  assert.equal(formatTimecode(Infinity), null);
  assert.equal(formatTimecode('soon'), null);
  assert.equal(formatTimecode(undefined), null);
  assert.equal(formatTimecode({}), null);
});

test('buildTranscriptSegments groups cues by time and carries one timecode', () => {
  const segments = buildTranscriptSegments([
    { startSeconds: 12, text: 'first cue' },
    { startSeconds: 18, text: 'second cue' },
    { startSeconds: 187, text: 'a later cue' },
  ]);

  assert.equal(segments.length, 2);
  assert.deepEqual(Object.keys(segments[0]).sort(), ['location', 'text']); // no build-time leftovers
  assert.equal(segments[0].location.timecode, '00:00:12');
  assert.equal(segments[0].text, '[00:00:12] first cue [00:00:18] second cue');
  assert.deepEqual(segments[0].location, { timecode: '00:00:12' });
  assert.equal(segments[1].text, '[00:03:07] a later cue');
  assert.deepEqual(segments[1].location, { timecode: '00:03:07' });
});

test('buildTranscriptSegments closes a group on the exact 30s boundary', () => {
  const joined = buildTranscriptSegments([
    { startSeconds: 0, text: 'opening' },
    { startSeconds: 30, text: 'exactly thirty' },
  ]);
  assert.equal(joined.length, 1, 'exactly SEGMENT_SECONDS later is still the same segment');
  assert.equal(joined[0].text, '[00:00:00] opening [00:00:30] exactly thirty');

  const split = buildTranscriptSegments([
    { startSeconds: 0, text: 'opening' },
    { startSeconds: 30, text: 'exactly thirty' },
    { startSeconds: 30.001, text: 'one millisecond past it' },
  ]);
  assert.equal(split.length, 2);
  assert.equal(split[1].text, '[00:00:30] one millisecond past it');
  assert.deepEqual(split[1].location, { timecode: '00:00:30' });
});

test('buildTranscriptSegments closes a group at the character budget', () => {
  // A segment's running length counts each cue's text plus 12 characters for
  // its [hh:mm:ss] marker, and the next cue closes the group only when that
  // running total plus the cue would EXCEED SEGMENT_MAX_CHARS (600).
  const exactlyAtBudget = buildTranscriptSegments([
    { startSeconds: 0, text: 'x'.repeat(488) }, // 500 with its marker
    { startSeconds: 5, text: 'y'.repeat(99) }, // 500 + 99 + 1 = 600 exactly
    { startSeconds: 10, text: 'z'.repeat(99) }, // would push it past 600
  ]);
  assert.equal(exactlyAtBudget.length, 2);
  assert.equal(exactlyAtBudget[0].text, `[00:00:00] ${'x'.repeat(488)} [00:00:05] ${'y'.repeat(99)}`);
  assert.deepEqual(exactlyAtBudget[0].location, { timecode: '00:00:00' });
  assert.equal(exactlyAtBudget[1].text, `[00:00:10] ${'z'.repeat(99)}`);
  assert.deepEqual(exactlyAtBudget[1].location, { timecode: '00:00:10' });

  // One character over the budget and the cue opens its own segment instead.
  const oneOver = buildTranscriptSegments([
    { startSeconds: 0, text: 'x'.repeat(488) }, // 500
    { startSeconds: 5, text: 'y'.repeat(100) }, // 500 + 100 + 1 = 601
  ]);
  assert.equal(oneOver.length, 2);
  assert.equal(oneOver[0].text, `[00:00:00] ${'x'.repeat(488)}`);
  assert.deepEqual(oneOver[1].location, { timecode: '00:00:05' });
});

test('buildTranscriptSegments skips cues that are not real', () => {
  assert.deepEqual(buildTranscriptSegments([
    { startSeconds: 5, text: '   ' },
    { startSeconds: 6 },
    { startSeconds: 'soon', text: 'bad time' },
    { startSeconds: -3, text: 'negative time' },
    null,
    { startSeconds: 7, text: 'kept' },
  ]), [{ text: '[00:00:07] kept', location: { timecode: '00:00:07' } }]);

  assert.deepEqual(buildTranscriptSegments([]), []);
  assert.deepEqual(buildTranscriptSegments(null), []);
  assert.deepEqual(buildTranscriptSegments([{}]), []);
});

// === media/ocr.js ===========================================================

test('resolveLanguageData prefers a plain eng.traineddata when one is present', async (t) => {
  const dir = tempDir(t, 'ocr-plain');
  fs.writeFileSync(path.join(dir, 'eng.traineddata'), 'plain data');
  fs.writeFileSync(path.join(dir, 'fr.traineddata'), 'another language');

  const found = await withEnv({ OCR_LANG_PATH: dir }, resolveLanguageData);
  assert.equal(found.dir, dir);
  assert.equal(found.source, 'local');
});

test('resolveLanguageData accepts a directory holding only eng.traineddata.gz', async (t) => {
  // This is the shipped bug, pinned: @tesseract.js-data/eng ships ONLY the
  // gzipped file. When languageDataFile did not accept that name the directory
  // did not resolve locally and every image request went down the download
  // path instead. It must now resolve as local with no download at all — the
  // network is disabled here, so any download attempt would fail the test.
  const dir = tempDir(t, 'ocr-gz');
  fs.writeFileSync(path.join(dir, 'eng.traineddata.gz'), 'gzipped data');

  withoutNetwork(t);
  const found = await withEnv({ OCR_LANG_PATH: dir }, resolveLanguageData);
  assert.equal(found.dir, dir);
  assert.equal(found.source, 'local');
});

test('resolveLanguageData accepts a directory holding both spellings', async (t) => {
  const dir = tempDir(t, 'ocr-both');
  fs.writeFileSync(path.join(dir, 'eng.traineddata'), 'plain data');
  fs.writeFileSync(path.join(dir, 'eng.traineddata.gz'), 'gzipped data');

  withoutNetwork(t);
  const found = await withEnv({ OCR_LANG_PATH: dir }, resolveLanguageData);
  assert.equal(found.dir, dir);
  assert.equal(found.source, 'local');
});

test('resolveLanguageData fails with OCR_UNAVAILABLE when no data is installed', async (t) => {
  const empty = tempDir(t, 'ocr-none');
  const cache = tempDir(t, 'ocr-cache');

  // No network is touched: the download the fallback path would otherwise make
  // is replaced with an immediate rejection, which is the same failure the
  // module already knows how to answer with 503 OCR_UNAVAILABLE.
  withoutNetwork(t);

  await assert.rejects(
    withEnv({ OCR_LANG_PATH: empty, OCR_LANG_CACHE: cache }, resolveLanguageData),
    (err) => {
      assert.equal(err.name, 'ApiError');
      assert.equal(err.status, 503);
      assert.equal(err.code, 'OCR_UNAVAILABLE');
      assert.match(err.message, /could not be downloaded/);
      assert.match(err.message, /OCR_LANG_PATH/);
      return true;
    },
  );
});
