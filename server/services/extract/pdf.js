// PDF text extraction with page numbers, using pdf-parse (pdf.js under the hood).
//
// pdf-parse hands back one string per page with line breaks but NO blank lines,
// so the chunker's paragraph splitter collapses an entire page into a single
// unit and can never see a heading inside it. The extractor therefore supplies
// the one structural signal it does have — the page's first line, which is the
// page heading on almost every textbook and slide-export PDF — as the segment's
// `section`.
//
// The rule is deliberately conservative (short, no sentence punctuation, and
// title-shaped). A line that merely LOOKS like text is left alone: a wrong
// section on a citation is worse than none, and the citation still carries its
// page number and excerpt. A sentence-case heading ("Introduction to
// photosynthesis") is therefore missed on purpose — at this level it is
// indistinguishable from a line of body text wrapped mid-sentence.

import { PDFParse } from 'pdf-parse';
import { ApiError } from '../../middleware/errors.js';

// A page heading is short by definition; anything longer is body prose. This is
// also the cap on a section name stored against every chunk of the page.
const MAX_PAGE_HEADING_CHARS = 80;

// "Mitochondria are the powerhouse of the" must NOT read as a heading, and
// "The Light-Dependent Reactions" / "Introduction to Photosynthesis" must.
// Title-shaped = every word capitalised, a number, a short word (≤3 chars), or
// one of these function words — a mid-sentence line break in justified body
// text always contains a longer word that is none of those.
const FUNCTION_WORDS = new Set([
  'about', 'across', 'after', 'against', 'along', 'among', 'around', 'before', 'behind',
  'below', 'beneath', 'beside', 'between', 'beyond', 'during', 'except', 'from', 'inside',
  'into', 'near', 'onto', 'outside', 'over', 'since', 'than', 'through', 'throughout',
  'toward', 'towards', 'under', 'underneath', 'until', 'upon', 'with', 'within', 'without',
]);

// "1.2 Title" / "# Title" — an explicit marker beats any shape test.
const NUMBERED_HEADING = /^#{1,6}\s+\S|^\d+(?:\.\d+)*[.)]?\s+\S/;

function isTitleShaped(words) {
  return words.every((word) => /^[\p{Lu}(]/u.test(word) || /^\d/.test(word)
    || (word.length <= 3 && word === word.toLowerCase())
    || FUNCTION_WORDS.has(word.toLowerCase()));
}

/** First line of a page = its heading, when the line is heading-shaped. */
export function pageHeading(pageText) {
  const line = String(pageText ?? '').split(/[\n\r\f]+/).map((part) => part.trim()).find((part) => part !== '');
  if (!line) return null;
  if (line.length > MAX_PAGE_HEADING_CHARS) return null; // long → body prose
  if (!/\p{L}/u.test(line)) return null; // a page number or a rule
  if (/[.!?;:,]$/.test(line)) return null; // reads like a sentence
  const words = line.split(/\s+/);
  if (words.length > 10) return null;
  if (!NUMBERED_HEADING.test(line) && !isTitleShaped(words)) return null;
  return line;
}

export async function extractPdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let result;
  try {
    result = await parser.getText();
  } catch (err) {
    console.error('[extract/pdf]', err?.message ?? err);
    throw new ApiError(400, 'VALIDATION_ERROR',
      'This file could not be read as a PDF. If it is password-protected or damaged, re-export it and try again.');
  } finally {
    await parser.destroy().catch(() => {});
  }

  const pageCount = result.pages.length;
  const segments = result.pages
    .filter((page) => page.text && page.text.trim() !== '')
    .map((page) => {
      const section = pageHeading(page.text);
      return { text: page.text, location: { page: page.num }, ...(section ? { section } : {}) };
    });

  if (segments.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT',
      'No readable text found in this PDF. Scanned or image-only PDFs are not supported yet — try a text-based export.');
  }

  return { segments, pageCount, slideCount: null };
}
