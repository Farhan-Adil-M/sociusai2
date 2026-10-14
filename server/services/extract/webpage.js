// Webpage ingestion: the student pastes the page text together with its URL.
// Paragraphs become segments so citations can point at a paragraph number.
//
// No heading hints are emitted here, deliberately: a pasted page has already
// lost its markup, so the extractor has nothing authoritative to say about
// structure — the `title` the client sends is the page's title, not a heading
// for any one paragraph. The chunker's prose heading detection is therefore the
// right (and only) tool for webpages, and it still applies: a pasted "## Cells"
// or "3.2 Photosynthesis" line marks a heading and starts a new section.

import { ApiError } from '../../middleware/errors.js';

export function normalizeWebpageText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/) // blank line = paragraph
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim()) // collapse spaces AND single newlines
    .filter((paragraph) => paragraph.length > 0);
}

export function extractWebpage({ url, title, text }) {
  if (typeof url !== 'string') {
    throw new ApiError(400, 'INVALID_URL', 'A URL is required for webpage sources.');
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    throw new ApiError(400, 'INVALID_URL', 'The URL must start with http:// or https://.');
  }

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length < 50) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Paste at least 50 characters of the page text.');
  }
  if (trimmed.length > 200000) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'That page text is too long (limit 200,000 characters).');
  }

  const paragraphs = normalizeWebpageText(trimmed);
  const segments = paragraphs.map((paragraph, i) => ({ text: paragraph, location: { paragraph: i + 1 } }));

  return {
    segments,
    title: (typeof title === 'string' && title.trim() !== '') ? title.trim() : parsed.hostname,
    url: parsed.toString(),
    pageCount: null,
    slideCount: null,
  };
}
