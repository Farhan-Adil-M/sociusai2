// Word (.docx) text extraction with paragraph numbers.
// A .docx is a zip; the body text lives in word/document.xml. Paragraphs are
// <w:p> elements, each holding <w:t> text runs plus <w:tab> / <w:br> breaks.
// We read that XML directly — no heavyweight Office library. Word also stores
// unaccepted tracked-change deletions (<w:del>/<w:delText>) and field codes
// (<w:instrText>) in the same file; those are not part of the visible document,
// so they are dropped before the text is collected.
//
// Headings need no special case here: Word writes every heading as its own
// <w:p>, so heading text arrives as an ordinary paragraph segment in document
// order (citation location { paragraph: n }).

import AdmZip from 'adm-zip';
import { ApiError } from '../../middleware/errors.js';
import { decodeXmlEntities } from './pptx.js';

const DOCUMENT_PATH = 'word/document.xml';

// One ordered pass over a paragraph body: text runs, tabs, and line breaks.
// `<w:t>` cannot accidentally match `<w:tab>`/`<w:pPr>` because the run branch
// requires `>` or whitespace immediately after `w:t`.
const PARAGRAPH_TOKEN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*?\/?>|<w:br\b[^>]*?\/?>/g;

/** Text of one <w:p> body: runs joined, tabs/breaks as spaces, whitespace collapsed. */
export function extractParagraphText(paragraphXml) {
  const parts = [];
  PARAGRAPH_TOKEN.lastIndex = 0;
  let match;
  while ((match = PARAGRAPH_TOKEN.exec(paragraphXml)) !== null) {
    if (match[1] !== undefined) {
      parts.push(decodeXmlEntities(match[1]));
    } else {
      parts.push(' '); // <w:tab/> or <w:br/> — a gap, never a character
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Ordered, non-empty paragraph texts from a word/document.xml string. */
export function extractDocxParagraphs(documentXml) {
  // Drop invisible content first: tracked-change deletions and field codes.
  const visible = documentXml
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '');

  const paragraphs = [];
  const paragraphRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let match;
  while ((match = paragraphRe.exec(visible)) !== null) {
    const text = extractParagraphText(match[1]);
    if (text !== '') paragraphs.push(text);
  }
  return paragraphs;
}

/**
 * Extract a .docx into ordered paragraph segments.
 * Input: the file as a Buffer (the upload pipeline). AdmZip also accepts a
 * file path, which keeps direct CLI/debug calls convenient.
 * Output: same shape as the other extractors — { segments, pageCount, slideCount }.
 * A .docx has no fixed pages, so pageCount/slideCount are null and citations
 * point at { paragraph: n } exactly like pasted webpages.
 */
export function extractDocx(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR',
      'This file could not be read as a .docx. Export it as .docx (the older binary .doc format is not supported) and try again.');
  }

  const entry = zip.getEntry(DOCUMENT_PATH);
  if (!entry) {
    throw new ApiError(400, 'UNSUPPORTED_FILE',
      'No document body found inside this file. Make sure it is a Word .docx file.');
  }

  let xml;
  try {
    xml = entry.getData().toString('utf8');
  } catch (err) {
    console.error('[extract/docx]', err?.message ?? err);
    throw new ApiError(400, 'VALIDATION_ERROR',
      'The Word document body could not be read. Re-export the file and try again.');
  }

  const paragraphs = extractDocxParagraphs(xml);
  const segments = paragraphs.map((text, i) => ({ text, location: { paragraph: i + 1 } }));

  if (segments.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT',
      'No readable text found in this Word document. Documents containing only images are not supported yet.');
  }

  return { segments, pageCount: null, slideCount: null };
}
