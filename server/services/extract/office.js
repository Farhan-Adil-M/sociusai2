// Office Open XML plumbing shared by the two container extractors.
//
// A .docx and a .pptx are both ZIP archives full of XML parts, so
// `extract/docx.js` and `extract/pptx.js` need the same three things: how to
// decode the entities Office writes, how to open the container without letting
// a hostile or broken file crash the request, and how long a section name may
// be before it bloats every chunk it is stored on. Those rules used to live in
// each extractor separately; keeping them here is what stops the two drifting
// apart on a decision that must be identical in both.

import AdmZip from 'adm-zip';
import { ApiError } from '../../middleware/errors.js';

/** The named entities Office XML emits, plus any numeric reference. */
export function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&'); // must be last, or a decoded "&lt;" becomes "<"
}

/**
 * Cap on a section name. A section name is stored on EVERY chunk of the
 * section, so a title placeholder (or a mis-styled 4,000-character paragraph)
 * used as a heading would otherwise bloat each chunk it touches.
 */
export const MAX_SECTION_CHARS = 200;

/** A section name trimmed and capped, or null when there is nothing to name. */
export function sectionName(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_SECTION_CHARS ? `${trimmed.slice(0, MAX_SECTION_CHARS - 1).trimEnd()}…` : trimmed;
}

/**
 * Open an Office container, or fail with the caller's message.
 *
 * AdmZip throws a bare Error on bytes that are not a zip at all. The extractors
 * owe the student the contract's 400 VALIDATION_ERROR envelope instead, with a
 * message that names the format the student actually sent — hence `message`
 * rather than a label this module would have to format for two formats.
 */
export function openOfficeZip(buffer, message) {
  try {
    return new AdmZip(buffer);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', message);
  }
}
