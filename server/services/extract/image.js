// Image → text extraction, and the validation that has to happen first.
//
// Shape contract (same as pdf.js / pptx.js / docx.js / webpage.js):
//   in : a Buffer of uploaded bytes, plus what the transport knows about it
//   out: { segments, pageCount, slideCount, ocr }
//   each segment is { text, location, confidence? } — `location.paragraph` is
//   the only location key `chunker.js` copies into citation metadata, so an
//   image chunk still cites where in the image it came from.
//
// The extra `ocr` key is the one field the other extractors do not need: it
// carries what the engine measured (confidence, how long it took, which lines
// it is unsure about), which the route echoes to the student. `persistSource`
// ignores it.
//
// WHY the validation lives here and not only in the route: images are the one
// upload type whose content is completely attacker-controlled pixels. Every
// check below runs on the raw bytes BEFORE any decoding, because the expensive
// and dangerous work (allocating a bitmap, running a CPU-bound engine) must
// never be reachable from a hostile file.
//
//   size      → 413 FILE_TOO_LARGE     (the pipeline-wide MAX_UPLOAD_MB cap)
//   extension → 400 UNSUPPORTED_FILE  (.png/.jpg/.jpeg/.webp only)
//   MIME      → 400 UNSUPPORTED_FILE  (a .png that claims to be something else)
//   magic     → 400 UNSUPPORTED_FILE  (the bytes are not the extension's format)
//   pixels    → 413 FILE_TOO_LARGE     (a memory/CPU bomb is caught by pixels, not bytes)

import path from 'node:path';
import { ApiError } from '../../middleware/errors.js';
import { config } from '../../config.js';
import { sanitizeFilename } from '../../constants.js';
import {
  CONFIDENCE_BANDS,
  OCR_LANGUAGE_REPORTED,
  overallReliability,
  positiveOr,
  readImageText,
  reliabilityNote,
} from '../media/ocr.js';

/** Accepted extensions, and the MIME type a browser is expected to report. */
export const IMAGE_FORMATS = new Map([
  ['.png', { label: 'PNG image', mime: 'image/png', type: 'png' }],
  ['.jpg', { label: 'JPEG image', mime: 'image/jpeg', type: 'jpeg' }],
  ['.jpeg', { label: 'JPEG image', mime: 'image/jpeg', type: 'jpeg' }],
  ['.webp', { label: 'WebP image', mime: 'image/webp', type: 'webp' }],
]);

// Some clients (and our own tests) send no type, or a generic container type.
// Same policy as sources.js: a generic type is accepted, a CONTRADICTING
// specific type is a spoof.
const GENERIC_IMAGE_MIMES = new Set(['', 'application/octet-stream']);

export const UNSUPPORTED_IMAGE_MESSAGE = 'Only .png, .jpg, and .webp images can be read for text.';

/**
 * Pixel ceiling. A 40-megapixel image decodes to a ~160 MB bitmap and keeps a
 * CPU-bound engine busy for tens of seconds, which is a memory and time bomb
 * delivered as a normal-looking upload. 40 MP is a genuine photo (7000×5700);
 * anything past it is either a stitch or an attack.
 */
const DEFAULT_MAX_PIXELS = 40_000_000;

/** Default file-size cap: the pipeline-wide upload limit, overridable per deployment. */
const DEFAULT_MAX_FILE_MB = Number.isFinite(config.maxUploadMb) && config.maxUploadMb > 0
  ? config.maxUploadMb
  : 25;

/** Maximum upload size in bytes (env `OCR_MAX_FILE_MB`, default MAX_UPLOAD_MB). */
export function maxImageBytes() {
  return positiveOr(process.env.OCR_MAX_FILE_MB, DEFAULT_MAX_FILE_MB) * 1024 * 1024;
}

/** Maximum pixel count (env `OCR_MAX_PIXELS`, default 40 MP). */
export function maxImagePixels() {
  return positiveOr(process.env.OCR_MAX_PIXELS, DEFAULT_MAX_PIXELS);
}

// ------------------------------------------------------------------ filenames

/**
 * Image ingest's filename guard. The logic lives in `constants.js#sanitizeFilename`
 * (shared with `routes/sources.js`); importing the route module from here would
 * create a circular dependency, since sources.js imports the extractors.
 * The only difference is the fallback name.
 */
export function sanitizeImageFilename(name) {
  return sanitizeFilename(name, 'image');
}

// ------------------------------------------------------------- format sniffing

/**
 * Identify an image by its MAGIC BYTES, not its name. Returns 'png' | 'jpeg' |
 * 'webp', or null when the bytes are none of those. A file that claims to be
 * one of the accepted formats but is actually something else (an executable, a
 * zip, HTML) is rejected — the extension alone is never trusted.
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** A header parser needs the first few dozen bytes, never the whole file. */
const HEADER_BYTES = 64 * 1024;

/**
 * Pixel dimensions read straight from the file header, with no decoding.
 *
 * This is the guard that makes the pixel ceiling enforceable BEFORE allocating
 * anything: we only ever look at 64 KB of the file, so even a 500-megabyte
 * upload is measured in microseconds.
 */
export function imagePixelSize(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const type = detectImageType(buffer);
  if (type === 'png') return pngSize(buffer);
  if (type === 'jpeg') return jpegSize(buffer);
  if (type === 'webp') return webpSize(buffer);
  return null;
}

function pngSize(buffer) {
  // 8-byte signature, then the IHDR chunk: 4 length + 4 "IHDR" + 4 width + 4 height.
  if (buffer.length < 24) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return validSize(width, height) ? { width, height } : null;
}

// Start-of-frame markers (SOF0..SOF15) minus the two that are not frames:
// C4 = DHT, C8 = JPG, CC = DAC.
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length && offset < HEADER_BYTES) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // resync: a stray byte between segments
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2; // markers with no payload
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // scan data / end of image
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      // SOF payload: 1 precision, 2 height, 2 width.
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return validSize(width, height) ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  const chunk = buffer.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    // Extended format: 24-bit little-endian width-1 / height-1.
    if (buffer.length < 30) return null;
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return validSize(width, height) ? { width, height } : null;
  }
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte sync code, then 14 bits of size.
    if (buffer.length < 30) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return validSize(width, height) ? { width, height } : null;
  }
  if (chunk === 'VP8L') {
    // Lossless: 1 signature byte, then 14 bits width-1 / 14 bits height-1.
    if (buffer.length < 25) return null;
    const bits = buffer.readUInt32LE(21);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return validSize(width, height) ? { width, height } : null;
  }
  return null;
}

/** Zero or absurd dimensions mean the header is lying; treat it as unreadable. */
function validSize(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0 && width < 100_000 && height < 100_000;
}

// ------------------------------------------------------------------ validation

/**
 * Every check that can be made without decoding the pixels.
 *
 * @param {object} input
 * @param {Buffer} input.buffer       raw uploaded bytes
 * @param {string} [input.originalname] filename as sent by the client (untrusted)
 * @param {string} [input.mimetype]   MIME type as sent by the client (untrusted)
 * @param {number} [input.size]       declared byte size; defaults to buffer.length
 * @returns {{ext: string, type: string, label: string, pixelSize: {width: number, height: number}|null, safeName: string}}
 * @throws {ApiError} 400 VALIDATION_ERROR, 400 UNSUPPORTED_FILE, 413 FILE_TOO_LARGE
 */
export function assertImageUpload(input = {}) {
  const { buffer } = input;
  if (!Buffer.isBuffer(buffer)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Attach one image in the "file" field.');
  }

  const size = positiveOr(input.size, buffer.length);
  const maxBytes = maxImageBytes();
  if (buffer.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The image file is empty.');
  }
  if (buffer.length > maxBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE',
      `This image is ${(buffer.length / (1024 * 1024)).toFixed(1)} MB — the upload limit is `
      + `${Math.round(maxBytes / (1024 * 1024))} MB. Use a smaller picture, or ask the server owner to raise OCR_MAX_FILE_MB.`);
  }

  // Only the final segment of a client-supplied name is ever considered.
  const safeName = sanitizeImageFilename(input.originalname);
  const ext = path.extname(safeName).toLowerCase();
  const format = IMAGE_FORMATS.get(ext);
  if (!format) {
    throw new ApiError(400, 'UNSUPPORTED_FILE', UNSUPPORTED_IMAGE_MESSAGE);
  }

  const mime = String(input.mimetype ?? '').toLowerCase();
  if (!GENERIC_IMAGE_MIMES.has(mime) && mime !== format.mime) {
    throw new ApiError(400, 'UNSUPPORTED_FILE',
      `"${safeName}" has a ${ext} extension but reports type "${mime}" — re-save the image and try again.`);
  }

  // The bytes must actually be the format the extension claims.
  const sniffed = detectImageType(buffer);
  if (sniffed !== format.type) {
    throw new ApiError(400, 'UNSUPPORTED_FILE',
      `"${safeName}" is named like a ${format.label} but its contents are not one. `
      + 'Re-save the file from an image editor and try again.');
  }

  const pixelSize = imagePixelSize(buffer);
  const maxPixels = maxImagePixels();
  if (pixelSize && pixelSize.width * pixelSize.height > maxPixels) {
    throw new ApiError(413, 'FILE_TOO_LARGE',
      `This image is ${pixelSize.width}×${pixelSize.height} pixels `
      + `(${((pixelSize.width * pixelSize.height) / 1_000_000).toFixed(1)} megapixels) — `
      + `the limit is ${(maxPixels / 1_000_000).toFixed(0)} megapixels. Resize it and try again.`);
  }

  return { ext, type: format.type, label: format.label, pixelSize, safeName, size };
}

// -------------------------------------------------------------------- segments

/**
 * Group recognised lines into paragraphs, the way a pasted web page is split:
 * a blank line in the OCR output is a paragraph break. Each paragraph becomes
 * one segment citing `location.paragraph`, and carries the mean confidence of
 * the lines it came from so the caller can say which parts are shaky.
 */
export function imageSegments(text, lines) {
  // A run of consecutive non-blank lines is one paragraph, so collect the runs
  // first and build a segment per run — no shared mutable accumulator to reset.
  const runs = [];
  let run = [];
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    // Walk the RAW text lines, so a line's measured confidence can follow its
    // paragraph even when the engine's own line count differs from the text's.
    run.push({ raw, confidence: lines[index]?.confidence });
  }
  if (run.length > 0) runs.push(run);

  return runs.map((paragraph, index) => {
    const confidences = paragraph
      .map((line) => line.confidence)
      .filter((value) => Number.isFinite(value));
    const segment = {
      text: paragraph.map((line) => line.raw).join(' ').replace(/\s+/g, ' ').trim(),
      location: { paragraph: index + 1 },
    };
    if (confidences.length > 0) {
      segment.confidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
    }
    return segment;
  });
}

/** The one message for "the engine read nothing", used for both empty cases. */
const NO_TEXT_MESSAGE = 'No text could be read from this image. It may be a photo of something other than text, '
  + 'too blurry, or too dark. Try a sharper, well-lit, straight-on picture.';

/**
 * Extract the text in an image.
 *
 * @param {Buffer} buffer raw image bytes
 * @param {object} [input] same fields as `assertImageUpload`
 * @returns {Promise<{segments: Array, pageCount: null, slideCount: null, ocr: object}>}
 * @throws {ApiError} validation failures as above, 400 EMPTY_CONTENT when the
 *   engine found no text at all, 422 OCR_FAILED / 422 OCR_TIMEOUT from the engine.
 */
export async function extractImage(buffer, input = {}) {
  const { safeName, pixelSize } = assertImageUpload({ buffer, ...input });

  const timeoutMs = positiveOr(input.timeoutMs, 0);
  const result = await readImageText(buffer, timeoutMs ? { timeoutMs } : {});

  const segments = imageSegments(result.text, result.lines);
  if (result.text === '' || segments.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT', NO_TEXT_MESSAGE);
  }

  // Per-line, not just per-paragraph: a slide has no blank lines, so its whole
  // text is ONE segment whose average can look healthy while a single line in
  // the middle is gibberish. The engine measured every line, so say so.
  const shakyLines = result.lines
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.confidence != null && line.confidence < CONFIDENCE_BANDS.fair)
    .map(({ index }) => index);

  const shakySegments = segments
    .filter((segment) => segment.confidence != null && segment.confidence < CONFIDENCE_BANDS.fair)
    .map((segment) => segment.location.paragraph);

  const reliability = overallReliability(result.confidence, {
    lineCount: result.lines.length,
    unreliableLines: shakyLines.length,
  });

  return {
    segments,
    pageCount: null,
    slideCount: null,
    ocr: {
      text: result.text,
      charCount: result.text.length,
      language: result.language || OCR_LANGUAGE_REPORTED,
      confidence: result.confidence,
      reliability,
      note: reliabilityNote(reliability),
      segmentCount: segments.length,
      unreliableSegments: shakySegments,
      unreliableLines: shakyLines,
      lineCount: result.lines.length,
      durationMs: result.durationMs,
      stages: result.stages,
      dataSource: result.dataSource,
      pixelSize,
      filename: safeName,
    },
  };
}
