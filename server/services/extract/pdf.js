// PDF text extraction with page numbers, using pdf-parse (pdf.js under the hood).

import { PDFParse } from 'pdf-parse';
import { ApiError } from '../../middleware/errors.js';

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
    .map((page) => ({ text: page.text, location: { page: page.num } }));

  if (segments.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT',
      'No readable text found in this PDF. Scanned or image-only PDFs are not supported yet — try a text-based export.');
  }

  return { segments, pageCount, slideCount: null };
}
