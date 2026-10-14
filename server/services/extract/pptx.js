// PowerPoint (.pptx) text extraction with slide numbers.
// A .pptx is a zip; each slide's text lives in ppt/slides/slideN.xml inside
// <a:t>…</a:t> runs. We read those directly — no heavyweight Office library.

import AdmZip from 'adm-zip';
import { ApiError } from '../../middleware/errors.js';

function decodeXmlEntities(text) {
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
    const text = extractSlideText(entry.getData().toString('utf8'));
    if (text !== '') segments.push({ text, location: { slide: num } });
  }

  if (segments.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT',
      'No readable text found on any slide. Image-only slides are not supported yet.');
  }

  return { segments, pageCount: null, slideCount: slideEntries.length };
}
