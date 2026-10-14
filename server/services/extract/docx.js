// Word (.docx) text extraction with paragraph numbers and heading hints.
// A .docx is a zip; the body text lives in word/document.xml. Paragraphs are
// <w:p> elements, each holding <w:t> text runs plus <w:tab> / <w:br> breaks.
// We read that XML directly — no heavyweight Office library. Word also stores
// unaccepted tracked-change deletions (<w:del>/<w:delText>) and field codes
// (<w:instrText>) in the same file; those are not part of the visible document,
// so they are dropped before the text is collected.
//
// Headings: Word's own structure statement is the paragraph's STYLE — a heading
// paragraph carries <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>. That is far
// more reliable than guessing from the text, so we read it and hand the chunker
// `kind: 'heading'` plus the `section` every following paragraph belongs to.
// Without it the chunker has to infer headings from a line's shape, which fails
// on documents whose headings look like ordinary prose.

import AdmZip from 'adm-zip';
import { ApiError } from '../../middleware/errors.js';
import { decodeXmlEntities } from './pptx.js';

const DOCUMENT_PATH = 'word/document.xml';

// A section name is stored on every chunk of the section, so cap it: a
// mis-styled 4,000-character paragraph would otherwise bloat every chunk.
const MAX_SECTION_CHARS = 200;

// Word names every heading style one of these: "Heading1" … "Heading9",
// "heading 2", "TOC Heading", "Heading 1 No Spacing", "Title", "Subtitle".
// Matching on "heading" catches every variant (a style whose name mentions
// headings IS a heading style); "Title"/"Subtitle" are their own built-ins.
const HEADING_STYLE = /heading|^(?:sub)?title$/i;

function sectionName(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_SECTION_CHARS ? `${trimmed.slice(0, MAX_SECTION_CHARS - 1).trimEnd()}…` : trimmed;
}

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

/** The paragraph style Word applied, or null when the paragraph has none. */
function paragraphStyle(paragraphXml) {
  const match = /<w:pStyle\b[^>]*\bw:val\s*=\s*"([^"]*)"/i.exec(paragraphXml);
  return match ? match[1] : null;
}

/** Word's own statement that this paragraph is a heading. */
function isHeadingParagraph(paragraphXml) {
  return HEADING_STYLE.test(String(paragraphStyle(paragraphXml) ?? '').trim());
}

/**
 * Ordered, non-empty paragraphs with their heading flag.
 * Same order and same text as `extractDocxParagraphs`; the flag is the extra
 * the chunker consumes.
 */
export function extractDocxParagraphDetails(documentXml) {
  // Drop invisible content first: tracked-change deletions and field codes.
  const visible = documentXml
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '');

  const details = [];
  const paragraphRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let match;
  while ((match = paragraphRe.exec(visible)) !== null) {
    const body = match[1];
    const text = extractParagraphText(body);
    if (text === '') continue; // empty spacer paragraphs carry no citation value
    details.push({ text, isHeading: isHeadingParagraph(body) });
  }
  return details;
}

/** Ordered, non-empty paragraph texts from a word/document.xml string. */
export function extractDocxParagraphs(documentXml) {
  return extractDocxParagraphDetails(documentXml).map((paragraph) => paragraph.text);
}

/**
 * Extract a .docx into ordered paragraph segments.
 * Input: the file as a Buffer (the upload pipeline). AdmZip also accepts a
 * file path, which keeps direct CLI/debug calls convenient.
 * Output: same shape as the other extractors — { segments, pageCount, slideCount }.
 * A .docx has no fixed pages, so pageCount/slideCount are null and citations
 * point at { paragraph: n } exactly like pasted webpages.
 *
 * Each segment also carries the heading hints: `kind: 'heading'` on a heading
 * paragraph, and `section` = the heading it sits under (its own text for the
 * heading itself). Both are consumed by the chunker and dropped by
 * `persistSource`, which only keeps `text` and `location` for `source_segments`.
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

  const details = extractDocxParagraphDetails(xml);
  const segments = [];
  let section = null;
  for (const { text, isHeading } of details) {
    // A heading opens a new section for everything after it, and names itself.
    if (isHeading) section = sectionName(text);
    segments.push({
      text,
      location: { paragraph: segments.length + 1 },
      ...(isHeading ? { kind: 'heading' } : {}),
      ...(section != null ? { section } : {}),
    });
  }

  if (segments.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT',
      'No readable text found in this Word document. Documents containing only images are not supported yet.');
  }

  return { segments, pageCount: null, slideCount: null };
}
