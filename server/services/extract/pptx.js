// PowerPoint (.pptx) text extraction with slide numbers.
// A .pptx is a zip; each slide's text lives in ppt/slides/slideN.xml inside
// <a:t>…</a:t> runs. We read those directly — no heavyweight Office library.
//
// The deck's own structure statement is the title placeholder: a shape marked
// <p:ph type="title"/> (or "ctrTitle") is the slide's title. When a slide has
// one we hand it to the chunker as the segment's `section`, so a citation from
// a long slide can say which slide it came from AND what that slide was about.
// A slide with no title placeholder simply has no section.

import AdmZip from 'adm-zip';
import { ApiError } from '../../middleware/errors.js';

// A section name is stored on every chunk of the slide, so cap it: a title
// placeholder misused as a body placeholder would otherwise bloat each chunk.
const MAX_SECTION_CHARS = 200;

// Shared with extract/docx.js — both parsers read Office Open XML text runs.
export function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&'); // must be last
}

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
    const title = extractSlideText(shape[0]);
    if (title !== '') return title.length > MAX_SECTION_CHARS ? `${title.slice(0, MAX_SECTION_CHARS - 1).trimEnd()}…` : title;
  }
  return null;
}

export function extractPptx(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new ApiError(400, 'VALIDATION_ERROR',
      'This file could not be read as a .pptx. Export it as .pptx (not the old .ppt format) and try again.');
  }

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
