// =============================================================================
// routes/viewer.js — the in-app document reader's data source.
//
// A student should be able to READ the material they uploaded inside Socius AI
// instead of downloading it. This route serves what the app stored at ingest
// time, in the shape docs/API_CONTRACT.md already documents.
//
// WHAT IS AND IS NOT SERVED
// -------------------------
// The upload pipeline (routes/sources.js) extracts text, chunks it, embeds it
// and keeps ONLY the extracted text — one row per page / slide / paragraph in
// `source_segments`. The original PDF / DOCX / PPTX binary is deliberately not
// retained (docs/ARCHITECTURE.md §4: that is what makes `npm run reindex`
// possible without re-uploading). There are therefore no file bytes to stream:
// the reader renders the stored text, which is exactly what the tutor, the
// quizzes and the flashcards are grounded in.
//
// OWNERSHIP — non-negotiable
// --------------------------
// `source_segments` carries no `user_id`: its owner is the parent row in
// `sources`. Every handler here therefore starts from
//     SELECT * FROM sources WHERE id = ? AND user_id = ?
// with `req.userId` — the id `requireAuth` derived from the verified token,
// never one supplied by the client. A source belonging to somebody else is
// indistinguishable from a missing one: same 404, same message, no text, no
// count, no file path. `requireAuth` runs before any handler, so an anonymous
// request is 401 before a single row is read.
//
// No AI call, no vector call, no filesystem access: reading is a pure database
// read. `ai` and `vector` are accepted so the factory signature matches every
// other router; neither is used.
// =============================================================================

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { parseJsonObject } from '../store/sqlite.js';

// A source id is `src_` plus short hex (newId('src')), except the seeded row
// `src_seed_demo`. Anything else — a slash, `..`, an absolute path, a very long
// string, an empty value — is refused BEFORE the database is touched. The
// queries are parameterised anyway (so traversal could not work even past this
// check); this is the explicit rejection, and it keeps the error identical for
// "malformed", "missing" and "someone else's".
const SOURCE_ID = /^src_[A-Za-z0-9_-]{1,48}$/;

// One message for every "you may not read that" outcome. It names neither the
// id nor whether the row exists, so probing for another account's material
// learns nothing.
const NOT_IN_YOUR_LIBRARY = 'That study material is not in your library.';

/** The reading unit a stored segment points at, in a student's words. */
function unitLabel(location) {
  const where = location && typeof location === 'object' ? location : {};
  if (where.page != null) return `Page ${where.page}`;
  if (where.slide != null) return `Slide ${where.slide}`;
  if (where.paragraph != null) return `Paragraph ${where.paragraph}`;
  if (where.timestamp != null) return `At ${where.timestamp}`;
  if (where.segment != null) return `Section ${where.segment}`;
  return '';
}

/** Load one source the caller owns, or 404. `userId` is the VERIFIED id. */
async function loadOwnedSource(db, sourceId, userId) {
  if (!SOURCE_ID.test(sourceId)) throw new ApiError(404, 'SOURCE_NOT_FOUND', NOT_IN_YOUR_LIBRARY);
  const row = await db.get('SELECT * FROM sources WHERE id = ? AND user_id = ?', sourceId, userId);
  if (!row) throw new ApiError(404, 'SOURCE_NOT_FOUND', NOT_IN_YOUR_LIBRARY);
  return row;
}

/** The stored segments of an owned source, in extraction order. */
async function loadSegments(db, sourceId) {
  const rows = await db.all(
    'SELECT seg_index, location, text FROM source_segments WHERE source_id = ? ORDER BY seg_index',
    sourceId,
  );
  // `location` is written by persistSource as JSON and read defensively: a
  // corrupt row must never crash the reader, it simply loses its unit label.
  return rows.map((row) => ({
    location: parseJsonObject(row.location),
    text: typeof row.text === 'string' ? row.text : '',
  }));
}

/**
 * The contract's `document` object.
 * `viewable: false` (with empty `segments`) is the honest answer for a source
 * with no readable text — the reader shows a "nothing to display" panel, never
 * a blank one and never an error.
 */
function documentOf(source, segments) {
  const readable = segments.filter((segment) => segment.text.trim() !== '');
  return {
    sourceId: source.id,
    type: source.type,
    title: source.title,
    url: source.url ?? null,
    createdAt: source.created_at ?? null,
    viewable: readable.length > 0,
    pageCount: source.page_count ?? null,
    slideCount: source.slide_count ?? null,
    segmentCount: readable.length,
    segments: readable.map((segment, index) => ({
      index,
      location: segment.location,
      text: segment.text,
    })),
  };
}

/** A safe inline filename: no path separators, no quotes, ASCII only. */
function inlineFilename(title) {
  const base = String(title ?? 'document')
    .replace(/[\\/]+/g, ' ')                 // a title may look like a path
    .replace(/[\u0000-\u001f\u007f"]/g, '')  // control characters and quotes
    .replace(/[^\x20-\x7e]/g, '_')           // anything non-ASCII
    .trim()
    .slice(0, 80);
  return `${base === '' ? 'document' : base}.txt`;
}

/** The same reading text, as one plain-text body (the extension's format). */
function textOf(document) {
  const lines = [document.title, ''];
  for (const segment of document.segments) {
    const label = unitLabel(segment.location);
    if (label) lines.push(`[${label}]`);
    lines.push(segment.text, '');
  }
  return lines.join('\n');
}

export function viewerRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  // Anonymous → 401 before any handler runs (prototype mode never 401s: it has
  // no sign-in, so every request is the fixed dev user).
  router.use(requireAuth({ auth, db }));

  /** Shared by GET /:sourceId and POST /:sourceId/document. */
  async function respondWithDocument(req, res) {
    const source = await loadOwnedSource(db, req.params.sourceId, req.userId);
    const segments = await loadSegments(db, source.id);
    res.json({ document: documentOf(source, segments) });
  }

  // The reader's data source, and the library's existing "Show stored text"
  // call — A23 wired POST /api/viewer/:sourceId/document before this route
  // existed and reads exactly this shape, so it now works unchanged.
  router.get('/:sourceId', respondWithDocument);
  router.post('/:sourceId/document', respondWithDocument);

  // The same content as one inline plain-text body: correct Content-Type,
  // Content-Disposition: inline (never a download), and never cached — it is
  // private, per-user text. Ownership is checked before a byte is produced.
  router.get('/:sourceId/text', async (req, res) => {
    const source = await loadOwnedSource(db, req.params.sourceId, req.userId);
    const segments = await loadSegments(db, source.id);
    const document = documentOf(source, segments);
    if (!document.viewable) {
      throw new ApiError(422, 'EMPTY_CONTENT',
        'No readable text was stored for this material, so there is nothing to show.');
    }
    res.type('text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${inlineFilename(source.title)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(textOf(document));
  });

  return router;
}
