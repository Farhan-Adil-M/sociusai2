// PowerPoint (.pptx) text extraction with slide numbers.
// A .pptx is a zip; each slide's text lives in ppt/slides/slideN.xml inside
// <a:t>…</a:t> runs. We read those directly — no heavyweight Office library.
//
// The deck's own structure statement is the title placeholder: a shape marked
// <p:ph type="title"/> (or "ctrTitle") is the slide's title. When a slide has
// one we hand it to the chunker as the segment's `section`, so a citation from
// a long slide can say which slide it came from AND what that slide was about.
// A slide with no title placeholder simply has no section.
//
// Entity decoding, the container guard and the section-name cap are shared with
// extract/docx.js and live in extract/office.js.

import { ApiError } from '../../middleware/errors.js';
import { decodeXmlEntities, openOfficeZip, sectionName } from './office.js';

// `decodeXmlEntities` has been part of this module's surface since it was
// written, so it stays exported from here; the definition moved to office.js
// with the rest of the OOXML plumbing it shares with extract/docx.js.
export { decodeXmlEntities } from './office.js';

export function slideNumberFromPath(entryName) {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entryName);
  return match ? Number(match[1]) : null;
}

export function extractSlideText(xml) {
  const parts = [];
  const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    parts.push(decodeXmlEntities(match[1]));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The slide's title text, or null when the slide has no title placeholder. */
export function extractSlideTitle(xml) {
  const shapes = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g;
  for (const shape of xml.matchAll(shapes)) {
    if (!/<p:ph\b[^>]*\btype\s*=\s*"(?:title|ctrTitle)"/i.test(shape[0])) continue;
    const title = sectionName(extractSlideText(shape[0]));
    if (title !== null) return title;
  }
  return null;
}

export function extractPptx(buffer) {
  const zip = openOfficeZip(buffer,
    'This file could not be read as a .pptx. Export it as .pptx (not the old .ppt format) and try again.');

  const slideEntries = zip.getEntries()
    .map((entry) => ({ entry, num: slideNumberFromPath(entry.entryName) }))
    .filter(({ num }) => num !== null)
    .sort((a, b) => a.num - b.num);

  if (slideEntries.length === 0) {
    throw new ApiError(400, 'UNSUPPORTED_FILE',
      'No slides found inside this file. Make sure it is a PowerPoint .pptx file.');
  }

  const segments = [];
  for (const { entry, num } of slideEntries) {
    const xml = entry.getData().toString('utf8');
    const text = extractSlideText(xml);
    if (text === '') continue; // image-only slide: no citation value
    const title = extractSlideTitle(xml);
    segments.push({
      text,
      location: { slide: num },
      ...(title != null ? { section: title } : {}),
    });
  }

  if (segments.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT',
      'No readable text found on any slide. Image-only slides are not supported yet.');
  }

  return { segments, pageCount: null, slideCount: slideEntries.length };
}
