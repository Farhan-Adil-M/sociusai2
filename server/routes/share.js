// POST /api/share — "share to Socius".
//
// A student shares a link, a page or a passage INTO the app (from another app's
// share sheet, a browser extension, or our own share panel) and it lands as a
// normal source they can study from.
//
// WHAT A SHARE BECOMES
// --------------------
// One share produces TWO records:
//   · a `shares` receipt row (A06 v8 table) that tracks the ingest:
//       pending → ingested | failed
//   · a normal `sources` row — chunked, embedded, citable and owner-scoped
//     exactly like any uploaded file. The contract (docs/API_CONTRACT.md §
//     POST /api/share) promises "a normal source, listable, organizable,
//     citable, and scoped like any other", so the share is NOT a special kind
//     of thing: it becomes study material. The `shares` row is only the audit
//     receipt of "this link was shared in, and this is the source it produced".
//
// INGEST MECHANISM (deliberately conservative — no new dependencies)
// -----------------------------------------------------------------
//   · `text` present        → the shared page text is used verbatim as a
//                             webpage source (same rule as POST /api/sources/
//                             webpage; we reuse its extractor). This is the
//                             primary, always-works path and needs no network.
//   · document URL, no text → a direct .pdf/.pptx/.docx link is FETCHED on the
//                             server and run through the real extractors.
//   · any other URL, no text→ an honest 400 asking the student to paste the
//                             page text. There is no server-side HTML fetch +
//                             text extractor in the codebase, and adding one
//                             means either a dependency (blocked) or a fragile
//                             hand-rolled stripper (AGENTS.md: keep it reliable).
//                             Recorded as a scope decision in docs/HANDOFF.md.
//
// SECURITY (shared content is the most injection-prone input in the app)
// ---------------------------------------------------------------------
//   · Never trust a client-supplied user id. req.userId comes only from the
//     verified Bearer token (requireAuth); a userId in the body is ignored.
//   · Cap every field; reject control characters; accept only http(s) URLs
//     (never javascript:/data:). Per-user scoping on every read/write.
//   · The document fetch is guarded: http(s) only, no embedded credentials, a
//     private/loopback host blocklist (best-effort SSRF defence-in-depth),
//     a size cap and a timeout. See fetchDocument().

import express from 'express';
import AdmZip from 'adm-zip';
import path from 'node:path';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { chunkSegments } from '../services/chunker.js';
import { extractWebpage } from '../services/extract/webpage.js';
import { extractPdf } from '../services/extract/pdf.js';
import { extractPptx } from '../services/extract/pptx.js';
import { extractDocx } from '../services/extract/docx.js';
import { embedTexts } from '../services/embeddings.js';
import { addChunks, deleteChunks } from '../store/vectorStore.js';
import { sourceRowToApi } from '../routes/sources.js';
import { logActivity, newId, nowIso, getMeta, setMeta, delMeta } from '../store/sqlite.js';

/* --------------------------------------------------------------- limits */

const TITLE_MAX = 160;              // contract: title ≤160 chars
const TEXT_MIN = 50;                // contract: text 50–200 000 chars
const TEXT_MAX = 200000;
const URL_MAX = 2048;               // far above any real share link
const MAX_UNCOMPRESSED_MB = Number(process.env.ZIP_MAX_UNCOMPRESSED_MB ?? 100);
const FETCH_TIMEOUT_MS = Number(process.env.SHARE_FETCH_TIMEOUT_MS ?? 15000);
// Sandbox-only escape hatch for the private-host SSRF blocklist (OFF by
// default; only a trusted sandbox that must fetch from localhost sets it).
const ALLOW_PRIVATE_FETCH = String(process.env.SHARE_ALLOW_PRIVATE_HOSTS ?? '').toLowerCase() === 'true';

// URL path suffix → document source type. Mirrors UPLOAD_FORMATS in
// sources.js (a direct share link to a document is treated as that document).
const DOC_EXTENSIONS = new Map([
  ['.pdf', 'pdf'],
  ['.pptx', 'pptx'],
  ['.docx', 'docx'],
]);

// Control characters that must never reach a stored field. Newlines/tabs are
// legal in pasted page `text`, so they are carved out of the `text` check.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;          // url + title
const CONTROL_CHARS_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // text

/* -------------------------------------------------------------- validation */

function requireString(value, field) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a string.`);
  }
  return value.trim();
}

// A safe http(s) URL. Order matters: a control character is a VALIDATION_ERROR
// (malformed input), while a well-formed non-http(s) URL (javascript:, data:,
// ftp:) is INVALID_URL — the contract's dedicated code for a bad web address.
function validateShareUrl(value) {
  const url = requireString(value, 'url');
  if (url === '') throw new ApiError(400, 'VALIDATION_ERROR', 'A URL is required.');
  if (url.length > URL_MAX) throw new ApiError(400, 'VALIDATION_ERROR', `URL is too long (limit ${URL_MAX} characters).`);
  if (CONTROL_CHARS.test(url)) throw new ApiError(400, 'VALIDATION_ERROR', 'URL must not contain control characters.');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, 'INVALID_URL', 'That is not a valid web address.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'INVALID_URL', 'The link must start with http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, 'INVALID_URL', 'The link must not contain embedded credentials.');
  }
  return parsed;
}

function validateTitle(value) {
  if (value === undefined || value === null) return undefined;
  const title = requireString(value, 'title');
  if (title === '') return undefined;
  if (CONTROL_CHARS.test(title)) throw new ApiError(400, 'VALIDATION_ERROR', 'Title must not contain control characters.');
  if (title.length > TITLE_MAX) throw new ApiError(400, 'VALIDATION_ERROR', `Title must be at most ${TITLE_MAX} characters.`);
  return title;
}

// `text` is optional; when present it is the page text the sharer could not
// hand over as a fetchable URL. Returns undefined when absent/empty.
function validateText(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'text must be a string.');
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (CONTROL_CHARS_TEXT.test(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Pasted text must not contain control characters.');
  }
  if (trimmed.length < TEXT_MIN || trimmed.length > TEXT_MAX) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Pasted page text must be between ${TEXT_MIN} and ${TEXT_MAX} characters.`);
  }
  return trimmed;
}

/* -------------------------------------------------- SSRF-guarded fetching */

// Whether a hostname is a private/loopback/link-local/reserved target that a
// share must never cause the server to fetch (cloud metadata, internal
// services). BEST EFFORT: it blocks the obvious literal cases; it does not
// resolve DNS or pin the connection, so a production deployment behind the
// public internet must add egress filtering too (see docs/HANDOFF.md).
function isBlockedHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '') return true; // a URL with no host is never fetchable
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host === '::1' || host === '' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true; // IPv6 loopback / link-local / unique-local
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a === 0 || a === 10 || a === 127) return true;                       // this-net / private / loopback
    if (a === 169 && b === 254) return true;                                 // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;                        // private
    if (a === 192 && b === 168) return true;                                 // private
    if (a === 100 && b >= 64 && b <= 127) return true;                       // CGNAT
    if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)) return true;                   // documentation ranges
    if (a === 255) return true;                                              // broadcast
  }
  return false;
}

// Fetch a document URL to bytes, guarded against oversized / private targets
// and slow responses. Throws the contract's FETCH_FAILED / FILE_TOO_LARGE.
async function fetchDocument(parsedUrl) {
  const capBytes = config.maxUploadMb * 1024 * 1024;

  if (!ALLOW_PRIVATE_FETCH && isBlockedHost(parsedUrl.hostname)) {
    throw new ApiError(400, 'VALIDATION_ERROR',
      'That link points to a private or local address, which Socius will not fetch.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(parsedUrl, { redirect: 'follow', signal: controller.signal });
  } catch (err) {
    throw new ApiError(502, 'FETCH_FAILED',
      `Socius could not fetch that link (${err?.name === 'AbortError' ? 'it took too long' : 'the request failed'}). Try pasting the page text instead.`);
  } finally {
    clearTimeout(timer);
  }

  // A redirect could land on a private host the guard did not see up front.
  if (!ALLOW_PRIVATE_FETCH && response.url) {
    try {
      if (isBlockedHost(new URL(response.url).hostname)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'That link redirected to a private address, which Socius will not fetch.');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }
  }
  if (!response.ok) {
    throw new ApiError(502, 'FETCH_FAILED',
      `Socius could not fetch that document (server replied ${response.status}). Try pasting the page text instead.`);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > capBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE',
      `That document is about ${(declared / 1048576).toFixed(1)} MB — over the ${config.maxUploadMb} MB limit.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > capBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE',
      `That document is over the ${config.maxUploadMb} MB limit.`);
  }
  return buffer;
}

// .pptx/.docx are ZIP containers: cap the UNCOMPRESSED size before extraction
// so a decompression bomb cannot exhaust memory. Mirrors the guard in
// sources.js (which A34 owns and has not exported); kept local on purpose and
// flagged for consolidation in docs/HANDOFF.md.
function assertZipWithinLimits(buffer, label) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR',
      `This file could not be read as a ${label}. Re-export it and try again.`);
  }
  let total = 0;
  for (const entry of zip.getEntries()) {
    total += entry.header?.size ?? 0;
    if (total > MAX_UNCOMPRESSED_MB * 1024 * 1024) {
      throw new ApiError(413, 'FILE_TOO_LARGE',
        `This ${label} unpacks to more than ${MAX_UNCOMPRESSED_MB} MB of text — too large to process safely.`);
    }
  }
}

async function extractDocument(ext, buffer) {
  if (ext === '.pptx') assertZipWithinLimits(buffer, 'PowerPoint');
  else if (ext === '.docx') assertZipWithinLimits(buffer, 'Word document');
  if (ext === '.pdf') return await extractPdf(buffer);
  if (ext === '.pptx') return extractPptx(buffer);
  return extractDocx(buffer);
}

/* ------------------------------------------------------------- persistence */

// Build a `shares` receipt row and return its id. Inserted BEFORE ingest so a
// failure leaves an honest `failed` receipt rather than nothing.
async function recordShare(db, { userId, url, title, kind }) {
  const id = newId('shr');
  await db.run(
    'INSERT INTO shares (id, user_id, url, title, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, userId, url, title ?? null, kind, 'pending', nowIso(),
  );
  return id;
}

// Chunk → embed → index → persist a shared source, with the same compensation
// (remove freshly indexed vectors on a later failure) and embedding-model guard
// that sources.js#persistSource uses, so a shared source is byte-for-byte as
// citable as an uploaded one. Every primitive is reused; only the small
// orchestration lives here because persistSource is not exported by A34's
// sources.js (flagged for consolidation in docs/HANDOFF.md).
async function persistSharedSource(db, { type, title, url, segments, pageCount, slideCount, userId }, { embed, store, remove }) {
  const sourceId = newId('src');
  const chunks = chunkSegments(segments, { sourceId, sourceKind: type });
  if (chunks.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT', 'No usable text was found in the shared content.');
  }

  const vectors = await embed(chunks.map((c) => c.text));

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
    ...(c.metadata ?? {}),
    sourceId, sourceKind: type, type, title, chunkIndex: c.chunkIndex,
    ...(url ? { url } : {}),
    ownerId: userId, // per-user vector ownership (retrieval filters on it)
  }));
  const ids = chunks.map((c) => `${sourceId}_${c.chunkIndex}`);
  const createdAt = nowIso();
  const clearEmbedMeta = () => (storedModel ? Promise.resolve() : Promise.all([
    delMeta(db, 'embed_model'), delMeta(db, 'embed_dimension'),
  ]));

  try {
    await store({ ids, embeddings: vectors, documents: chunks.map((c) => c.text), metadatas, userId });
  } catch (err) {
    await remove(ids);
    await clearEmbedMeta();
    throw err;
  }

  try {
    await db.batch([
      { sql: 'INSERT INTO sources (id, user_id, type, title, url, page_count, slide_count, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [sourceId, userId, type, title, url ?? null, pageCount, slideCount, chunks.length, createdAt] },
      ...segments.map((segment, i) => ({
        sql: 'INSERT INTO source_segments (source_id, seg_index, location, text) VALUES (?, ?, ?, ?)',
        args: [sourceId, i, JSON.stringify(segment.location ?? {}), segment.text],
      })),
    ], 'write');
  } catch (err) {
    await remove(ids);
    await clearEmbedMeta();
    throw err;
  }

  return { id: sourceId, type, title, url, pageCount, slideCount, chunkCount: chunks.length, createdAt };
}

/* ---------------------------------------------------------------- the router */

export function shareRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  const embed = ai?.embedTexts ?? embedTexts;
  const store = vector?.addChunks ?? addChunks;
  const remove = vector?.deleteChunks ?? deleteChunks;
  router.use(requireAuth({ auth, db }));

  // POST /api/share — { url, title?, text? } → 201 { source, share }
  router.post('/', async (req, res) => {
    const userId = req.userId;            // verified id only — never from the body
    const body = req.body ?? {};

    const parsedUrl = validateShareUrl(body.url);
    const title = validateTitle(body.title);
    const text = validateText(body.text);

    const ext = path.extname(parsedUrl.pathname).toLowerCase();
    const isDocument = DOC_EXTENSIONS.has(ext);

    // Receipt first, so a failed ingest is still traceable.
    const kind = isDocument && text === undefined ? 'file' : 'site';
    const shareId = await recordShare(db, { userId, url: parsedUrl.toString(), title, kind });

    try {
      let source;
      if (text !== undefined || !isDocument) {
        // Webpage path: pasted text is used verbatim. If a non-document URL
        // arrived with no text we cannot fetch + read HTML, so ask for it
        // honestly rather than inventing content.
        if (text === undefined) {
          throw new ApiError(400, 'VALIDATION_ERROR',
            'Socius cannot read that page on its own. Paste the page text, or share a direct link to a .pdf, .docx or .pptx file.');
        }
        const extracted = extractWebpage({ url: parsedUrl.toString(), title, text });
        source = await persistSharedSource(db, { type: 'webpage', ...extracted, userId }, { embed, store, remove });
      } else {
        // Document path: fetch the binary and run the real extractor.
        const buffer = await fetchDocument(parsedUrl);
        const extracted = await extractDocument(ext, buffer);
        source = await persistSharedSource(
          db,
          { type: DOC_EXTENSIONS.get(ext), title: documentTitle(parsedUrl, title), url: parsedUrl.toString(), ...extracted, userId },
          { embed, store, remove },
        );
      }

      await db.run('UPDATE shares SET status = ?, source_id = ? WHERE id = ? AND user_id = ?', 'ingested', source.id, shareId, userId);
      await logActivity(db, 'upload', null, `${source.title} (shared ${kind})`, null, userId);

      // Shape the source exactly like every other source (re-read the stored
      // row) so the share response is identical to /sources' object shape.
      const shareRow = await db.get('SELECT * FROM shares WHERE id = ?', shareId);
      res.status(201).json({
        source: sourceRowToApi(await db.get('SELECT * FROM sources WHERE id = ?', source.id)),
        share: {
          id: shareId, kind, url: parsedUrl.toString(), sourceId: source.id,
          title: source.title, createdAt: shareRow.created_at,
        },
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'The shared content could not be imported.';
      await db.run('UPDATE shares SET status = ?, error = ? WHERE id = ? AND user_id = ?', 'failed', message.slice(0, 300), shareId, userId);
      throw err;
    }
  });

  return router;
}

// A shared document with no explicit title uses its file name (falling back to
// the host), matching how sources.js titles an upload.
function documentTitle(parsedUrl, title) {
  if (title) return title;
  const base = path.posix.basename(parsedUrl.pathname);
  return base ? decodeURIComponent(base) : parsedUrl.hostname;
}
