// Source ingestion routes: PDF/PPTX/DOCX upload and pasted webpage text.
// Pipeline: extract → chunk → embed → store vectors → store records (SQLite).

import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import path from 'node:path';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { chunkSegments } from '../services/chunker.js';
import { extractPdf } from '../services/extract/pdf.js';
import { extractPptx } from '../services/extract/pptx.js';
import { extractDocx } from '../services/extract/docx.js';
import { extractWebpage } from '../services/extract/webpage.js';
import { addChunks, deleteChunks } from '../store/vectorStore.js';
import { embedTexts } from '../services/embeddings.js';
import { retrieve, toCitation, assertSourcesExist } from '../services/retrieval.js';
import { suggestOrganization, acceptOrganization } from '../services/organizer.js';
import { requireAuth } from '../middleware/auth.js';
import { sanitizeFilename } from '../constants.js';
import { logActivity, newId, nowIso, getMeta, setMeta, delMeta } from '../store/sqlite.js';

// Every accepted upload: extension → stored source type, the MIME types a
// browser is expected to send, and a human label used in error messages.
const UPLOAD_FORMATS = new Map([
  ['.pdf', { type: 'pdf', label: 'PDF', mimes: new Set(['application/pdf']) }],
  ['.docx', {
    type: 'docx',
    label: 'Word document',
    mimes: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  }],
  ['.pptx', {
    type: 'pptx',
    label: 'PowerPoint',
    mimes: new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation']),
  }],
]);

// Some clients (and our own tests) send no type, or a generic container type.
// Those are accepted; a SPECIFIC type that contradicts the extension is not.
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed']);

const UNSUPPORTED_FILE_MESSAGE = 'Only .pdf, .docx, and .pptx files can be uploaded.';

// .docx/.pptx are ZIP containers; a small upload can expand enormously (a
// "zip bomb"). Cap the total UNCOMPRESSED size we are willing to read.
const ZIP_EXTENSIONS = new Set(['.docx', '.pptx']);
const MAX_UNCOMPRESSED_MB = Number(process.env.ZIP_MAX_UNCOMPRESSED_MB ?? 100);

function requireFormat(ext) {
  const format = UPLOAD_FORMATS.get(ext);
  if (!format) throw new ApiError(400, 'UNSUPPORTED_FILE', UNSUPPORTED_FILE_MESSAGE);
  return format;
}

// `sanitizeFilename` now lives in constants.js (shared with the extractors,
// which cannot import this route module without creating a cycle).

// Reject a zip whose contents would unpack past the cap BEFORE extracting any
// text, so a decompression bomb cannot exhaust memory. Throws the same
// VALIDATION_ERROR as the extractors when the bytes are not a zip at all.
// Exported for `routes/share.js`, which ingests a fetched Office file through
// the same guard (one implementation, not a copy).
export function assertZipWithinLimits(buffer, label) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR',
      `This file could not be read as a ${label}. Re-export it and try again.`);
  }
  let totalBytes = 0;
  for (const entry of zip.getEntries()) {
    totalBytes += entry.header?.size ?? 0;
    if (totalBytes > MAX_UNCOMPRESSED_MB * 1024 * 1024) {
      throw new ApiError(413, 'FILE_TOO_LARGE',
        `This ${label} unpacks to more than ${MAX_UNCOMPRESSED_MB} MB of text — too large to process safely.`);
    }
  }
}

// Single dispatch point for every file upload, shared by both ingest routes:
// validate the extension, guard zip bombs, run the matching extractor, and tag
// the extracted segments with the source type to persist.
async function extractUpload(ext, buffer) {
  const format = requireFormat(ext);
  if (ZIP_EXTENSIONS.has(ext)) assertZipWithinLimits(buffer, format.label);

  let extracted;
  if (ext === '.pdf') extracted = await extractPdf(buffer);
  else if (ext === '.pptx') extracted = extractPptx(buffer);
  else extracted = extractDocx(buffer); // .docx

  return { type: format.type, ...extracted };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname ?? '').toLowerCase();
    const format = UPLOAD_FORMATS.get(ext);
    if (!format) {
      return cb(new ApiError(400, 'UNSUPPORTED_FILE', UNSUPPORTED_FILE_MESSAGE));
    }
    // Extension/MIME mismatch: a *.docx that claims to be an image is a spoof.
    const mime = String(file.mimetype ?? '').toLowerCase();
    if (!GENERIC_MIMES.has(mime) && !format.mimes.has(mime)) {
      return cb(new ApiError(400, 'UNSUPPORTED_FILE',
        `"${sanitizeFilename(file.originalname)}" has a ${ext} extension but reports type "${mime}" — re-export it and try again.`));
    }
    cb(null, true);
  },
});

// multer rejects an oversized file with a bare MulterError that knows the
// field name but not the file size, so we turn it into the contract's 413
// FILE_TOO_LARGE envelope here, with the REAL configured limit in the message.
function uploadSingleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        // memoryStorage keeps (a truncated version of) the file on the request
        // when the limit trips, so the real size is often available to show.
        const actualMb = req.file?.size != null ? (req.file.size / (1024 * 1024)).toFixed(1) : null;
        const sizeNote = actualMb != null ? `This file is ${actualMb} MB` : 'This file is too large';
        return next(new ApiError(413, 'FILE_TOO_LARGE',
          `${sizeNote} — the upload limit is ${config.maxUploadMb} MB. Use a smaller file, or ask the server owner to raise MAX_UPLOAD_MB.`));
      }
      return next(err);
    }
    next();
  });
}

// "512" seconds → "8:32", the contract's YouTube sizeLabel ("8:32 video").
function formatDuration(seconds) {
  const total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return null;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

// A pre-formatted size for the library row. Every accepted kind must land on a
// real label: a source with no page count and no slide count (webpage, docx,
// youtube, image) must never fall through to the "N slides" branch, which used
// to print the literal string "null slides".
function sizeLabelFor(type, pageCount, slideCount, durationSeconds) {
  if (type === 'webpage') return 'webpage';
  if (type === 'docx') return 'document'; // .docx has no fixed pages or slides
  if (type === 'youtube') {
    const duration = formatDuration(durationSeconds);
    return duration ? `${duration} video` : 'video';
  }
  if (type === 'image') return 'image'; // one still image has no countable pages
  if (pageCount != null) return `${pageCount} pages`;
  if (slideCount != null) return `${slideCount} slides`;
  return '—'; // unknown kind with no counts: an em dash, never a fake number
}

function parseSourceTags(value) {
  try { return JSON.parse(value) || []; } catch { return []; }
}

export function sourceRowToApi(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    url: row.url ?? null,
    sessionId: row.session_id ?? null,
    tags: parseSourceTags(row.tags_json),
    orgSource: row.org_source ?? 'manual',
    pageCount: row.page_count,
    slideCount: row.slide_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    sizeLabel: sizeLabelFor(row.type, row.page_count, row.slide_count),
  };
}

/**
 * Extract → chunk → embed → index → persist, for one source.
 * Exported so every ingest surface (upload, storage-ingest, webpage, and
 * `routes/share.js`'s imported document) runs this SAME pipeline rather than a
 * private copy of it.
 *
 * `durationSeconds` is optional and only meaningful for video (A38); it is
 * echoed back in the source object and is NOT stored (the `sources` table has
 * no duration column — `media_assets.duration_seconds` holds it).
 *
 * `media` (optional, media routes only) is `{ kind?, durationSeconds?,
 * textChars? }`. Passing it writes the v8 `media_assets` row inside the SAME
 * atomic batch as the source, so a source can never exist without its media
 * record. Without it nothing changes for the ordinary document upload path.
 */
export async function persistSource(db, { type, title, url, segments, pageCount, slideCount, durationSeconds, media, userId }, { embed, store, remove }) {
  const sourceId = newId('src');
  // `sourceKind` is the v8 canonical kind and it SELECTS the chunker profile:
  // without it a .docx is chunked with the webpage profile (both cite
  // paragraphs) and every chunk loses its sourceKind in stored metadata.
  const chunks = chunkSegments(segments, { sourceId, sourceKind: type });
  if (chunks.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT', 'No usable text was extracted from this content.');
  }

  const vectors = await embed(chunks.map((c) => c.text));

  // Embedding-model guard (v1.2): record the model on first ingestion, and stop
  // clearly if the configured model no longer matches the recorded index — a
  // mixed-model index would silently corrupt retrieval.
  const storedModel = await getMeta(db, 'embed_model');
  if (storedModel && storedModel !== config.nimEmbedModel) {
    throw new ApiError(503, 'CHROMA_UNAVAILABLE',
      `The search index was built with "${storedModel}" but NIM_EMBED_MODEL is "${config.nimEmbedModel}". Run npm run reindex, then try again.`);
  }
  if (!storedModel && vectors[0]) {
    await setMeta(db, 'embed_model', config.nimEmbedModel);
    await setMeta(db, 'embed_dimension', String(vectors[0].length));
  }

  const metadatas = chunks.map((c) => ({
    // The chunker owns the citation surface: sourceKind, section, the
    // page/slide/paragraph location, charStart/charEnd, ordinal, timecode and
    // chunkIndex. Spreading it (not re-deriving it here) is what makes those
    // fields reach the store — and therefore the citations every consumer
    // builds from stored metadata only.
    ...(c.metadata ?? {}),
    // Identity fields are re-asserted after the spread: they come from the
    // request, so a chunk whose kind could not be resolved still carries the
    // source's real type instead of the chunker's 'default' profile name.
    sourceId,
    sourceKind: type,
    type,
    title,
    chunkIndex: c.chunkIndex,
    ...(url ? { url } : {}),
    // Per-user ownership on the vector side: retrieval filters by metadata
    // ownerId (Chroma) and the user_id column (sqlite fallback).
    ownerId: userId,
  }));

  const ids = chunks.map((c) => `${sourceId}_${c.chunkIndex}`);
  const createdAt = nowIso();
  const removeVectors = () => (remove ?? deleteChunks)(ids);

  const clearEmbeddingMeta = () => ([
    delMeta(db, 'embed_model'),
    delMeta(db, 'embed_dimension'),
  ]);

  try {
    await store({
      ids,
      embeddings: vectors,
      documents: chunks.map((c) => c.text),
      metadatas,
      userId,
    });
  } catch (err) {
    // Compensation (v1.2): if vector storage partially failed, remove anything
    // recorded persistently before rethrowing.
    await removeVectors();
    if (!storedModel) await Promise.all(clearEmbeddingMeta());
    throw err;
  }

  // Structured persistence AFTER indexing: if it fails, delete the freshly
  // indexed vectors so no searchable orphans are left behind. Source record and
  // all segments belong together — one atomic batch.
  //
  // `source_kind` is written alongside `type`: they are the same value today,
  // but the column is the v8 canonical kind that `sourceRowToApi` and the
  // viewer read. Omitting it made an ingested image read back as 'pdf'
  // (A39's finding) while its vectors correctly said 'image'.
  try {
    const rows = [
      {
        sql: `INSERT INTO sources
                (id, user_id, type, title, url, page_count, slide_count, chunk_count, created_at, source_kind)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [sourceId, userId, type, title, url ?? null, pageCount, slideCount, chunks.length, createdAt, type],
      },
      ...segments.map((segment, i) => ({
        sql: 'INSERT INTO source_segments (source_id, seg_index, location, text) VALUES (?, ?, ?, ?)',
        args: [sourceId, i, JSON.stringify(segment.location ?? {}), segment.text],
      })),
    ];

    if (media) {
      rows.push({
        sql: `INSERT INTO media_assets
                (id, user_id, source_id, kind, url, status, duration_seconds, text_chars, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId('med'), userId, sourceId, media.kind ?? type, url ?? null, 'ready',
          media.durationSeconds ?? null, media.textChars ?? null, createdAt, createdAt,
        ],
      });
    }

    await db.batch(rows, 'write');
  } catch (err) {
    await removeVectors();
    if (!storedModel) await Promise.all(clearEmbeddingMeta());
    throw err;
  }

  return {
    id: sourceId, type, title, pageCount, slideCount, chunkCount: chunks.length, createdAt,
    // Video length is only known by the media routes (A38), which pass it in;
    // it is echoed here so every source object has one shape. The `sources`
    // table has no duration column, so a source re-read from the DB cannot
    // report one — `media_assets.duration_seconds` (A06, v8) holds it.
    ...(durationSeconds != null ? { durationSeconds } : {}),
    sizeLabel: sizeLabelFor(type, pageCount, slideCount, durationSeconds),
  };
}

export function sourcesRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  const embed = ai?.embedTexts ?? embedTexts;
  const store = vector?.addChunks ?? addChunks;
  const remove = vector?.deleteChunks ?? deleteChunks;
  router.use(requireAuth({ auth, db }));


  // Supabase-Storage ingest: the browser uploads the file DIRECTLY to the
  // study-sources bucket (bypassing the ~4.5 MB serverless request cap, so
  // 25 MB PDFs work in production), then hands us the object path. We fetch
  // the bytes back with the USER'S OWN JWT (RLS keeps it owner-safe) and run
  // the normal extraction pipeline.
  router.post('/storage-ingest', async (req, res) => {
    const { storagePath, title, sizeBytes } = req.body ?? {};
    if (typeof storagePath !== 'string' || !storagePath.includes('/') || storagePath.includes('..')) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'storagePath is required (bucket object path like <userId>/<file>).');
    }
    const APP_MAX = Number(process.env.MAX_STORAGE_UPLOAD_MB ?? 25);
    if (Number.isFinite(Number(sizeBytes)) && Number(sizeBytes) > APP_MAX * 1024 * 1024) {
      throw new ApiError(413, 'FILE_TOO_LARGE', `This file is ${(Number(sizeBytes) / 1048576).toFixed(1)} MB — storage upload limit is ${APP_MAX} MB.`);
    }
    const ext = path.extname(storagePath).toLowerCase();
    if (!UPLOAD_FORMATS.has(ext)) {
      throw new ApiError(400, 'UNSUPPORTED_FILE', 'Only .pdf, .docx, and .pptx files can be ingested.');
    }
    const userToken = req.userToken;
    if (!userToken) {
      throw new ApiError(500, 'INTERNAL', 'Storage ingest requires the authenticated request token.');
    }
    const objectUrl = `${config.supabaseUrl}/storage/v1/object/study-sources/${storagePath}`;
    const response = await fetch(objectUrl, { headers: { Authorization: `Bearer ${userToken}` } });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ApiError(422, 'STORAGE_FETCH_FAILED',
        `Could not read the uploaded file from storage (${response.status}). Re-upload the file and try again.${detail ? '' : ''}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const extracted = await extractUpload(ext, bytes);
    const source = await persistSource(db, {
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 160) : sanitizeFilename(storagePath.split('/').pop()),
      userId: req.userId,
      ...extracted,
    }, { embed, store, remove });
    await logActivity(db, 'upload', null, `${source.title} via storage (${source.sizeLabel})`, null, req.userId);
    res.status(201).json({ source: { ...source, url: null } });
  });
  router.post('/upload', uploadSingleFile, async (req, res) => {
    if (!req.file) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Attach one file in the "file" field.');
    }
    const userId = req.userId;
    const safeName = sanitizeFilename(req.file.originalname);
    const ext = path.extname(safeName).toLowerCase();

    const extracted = await extractUpload(ext, req.file.buffer);

    const source = await persistSource(db, {
      title: safeName.slice(0, 160),
      userId,
      ...extracted,
    }, { embed, store, remove });
    await logActivity(db, 'upload', null, `${source.title} (${source.sizeLabel})`, null, userId);
    res.status(201).json({ source: { ...source, url: null } });
  });

  router.post('/webpage', async (req, res) => {
    const { segments, title, url, pageCount, slideCount } = extractWebpage(req.body ?? {});
    const source = await persistSource(db, { type: 'webpage', title, url, segments, pageCount, slideCount, userId: req.userId }, { embed, store, remove });
    await logActivity(db, 'upload', null, `${source.title} (webpage)`, null, req.userId);
    res.status(201).json({ source: { ...source, url } });
  });

  router.post('/:id/suggest-organization', async (req, res) => {
    const { description } = req.body ?? {};
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Description must be at most 500 characters.');
    }
    const result = await suggestOrganization(db, { sourceId: req.params.id, description, userId: req.userId }, { chat: ai?.chatCompletion, });
    res.json(result); // 502 NIM_ERROR on model failure — the source simply stays Unsorted
  });

  router.post('/:id/accept-suggestion', async (req, res) => {
    const { source, session } = await acceptOrganization(db, { sourceId: req.params.id, userId: req.userId });
    await logActivity(db, 'organize', null, `${source.title} → ${session?.title ?? 'Unsorted'}`, session?.id ?? null, req.userId);
    res.json({ source: sourceRowToApi(source), session: session ? { id: session.id, title: session.title, category: session.category } : null });
  });

  router.get('/', async (req, res) => {
    const { sessionId } = req.query;
    const filters = ['user_id = ?'];
    const params = [req.userId];
    if (sessionId === 'unsorted') {
      filters.push('session_id IS NULL');
    } else if (typeof sessionId === 'string' && sessionId !== '') {
      filters.push('session_id = ?');
      params.push(sessionId);
    }
    const where = `WHERE ${filters.join(' AND ')}`;
    const rows = await db.all(`SELECT * FROM sources ${where} ORDER BY created_at DESC`, ...params);
    const unsortedSourceCount = (await db.get(`SELECT COUNT(*) AS n FROM sources ${where}`, ...params)).n;
    res.json({ sources: rows.map(sourceRowToApi), unsortedSourceCount });
  });

  router.patch('/:id', async (req, res) => {
    // Ownership: another user's source id is indistinguishable from a missing one.
    const row = await db.get('SELECT * FROM sources WHERE id = ? AND user_id = ?', req.params.id, req.userId);
    if (!row) throw new ApiError(404, 'SOURCE_NOT_FOUND', `Source "${req.params.id}" does not exist.`);

    const { sessionId, title, tags } = req.body ?? {};
    const updates = [];
    const params = [];

    if (sessionId !== undefined) {
      if (sessionId !== null) {
        const session = await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', sessionId, req.userId);
        if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${sessionId}" does not exist.`);
      }
      updates.push('session_id = ?');
      params.push(sessionId); // null = back to Unsorted
      const destination = sessionId === null ? 'Unsorted' : (await db.get('SELECT title FROM study_sessions WHERE id = ? AND user_id = ?', sessionId, req.userId))?.title ?? sessionId;
      await logActivity(db, 'organize', null, `${row.title} → moved to ${destination}`, sessionId, req.userId);
    }
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > 160) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Title must be 1–160 characters.');
      }
      updates.push('title = ?');
      params.push(title.trim());
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.length > 8) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Tags must be an array (at most 8).');
      }
      const clean = tags.map((tag) => String(tag).trim()).filter(Boolean);
      if (clean.some((tag) => tag.length > 24)) throw new ApiError(400, 'VALIDATION_ERROR', 'Each tag must be 1–24 characters.');
      updates.push('tags_json = ?');
      params.push(JSON.stringify(clean));
    }

    if (updates.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide sessionId, title, or tags to update.');
    }

    // Manual choices are sticky: the organiser never replaces them automatically.
    updates.push('manual_override = 1');
    updates.push('org_source = ?');
    params.push('manual');

    await db.run(`UPDATE sources SET ${updates.join(', ')} WHERE id = ?`, ...params, row.id);
    res.json({ source: sourceRowToApi(await db.get('SELECT * FROM sources WHERE id = ?', row.id)) });
  });

  return router;
}
