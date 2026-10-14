// Image → text, run locally with tesseract.js.
//
// ONE job: turn image bytes into recognised text plus an HONEST confidence, and
// do it inside a hard wall-clock budget. Nothing here knows about sources,
// chunks, citations or HTTP — that is `extract/image.js` and the routes.
//
// Why the budget is a hard requirement rather than a nicety: OCR is CPU-bound
// and a single page can take seconds. The app deploys behind a 60-second
// serverless ceiling (`vercel.json` `maxDuration`), so a request that overruns
// is killed by the platform and surfaces to the student as a generic 500. We
// would rather stop at 45 s ourselves and say exactly what happened.
//
// Determinism and honesty:
//   - No model decides the text. Tesseract's own reading is the text; we never
//     substitute, guess or "improve" it. If the engine says nothing, we fail.
//   - Confidence comes from the engine's own per-word scores (TSV), averaged
//     per line and per page. We report what it measured, not what would be
//     reassuring.
//   - The engine's language data is read from a LOCAL directory. The library's
//     default is to fetch ~10–20 MB of trained data from a CDN on the first
//     call; a serverless cold start doing that would eat most of the 60 s
//     budget before recognising a single character.

import { createWorker, OEM } from 'tesseract.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '../../middleware/errors.js';

/** The only language we ship engine data for. Tesseract's code for English. */
export const OCR_LANGUAGE = 'eng';

/** The BCP-47 tag we report for the recognised text (the API contract's `en`). */
export const OCR_LANGUAGE_REPORTED = 'en';

/**
 * Default wall-clock budget for one image, in milliseconds. 45 s leaves ~15 s
 * of the 60 s platform ceiling for the request, the chunking and the reply.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Bootstrap-only: downloading the engine's language data, which happens at most once per machine. */
const DATA_DOWNLOAD_TIMEOUT_MS = 25_000;
const DATA_DOWNLOAD_MAX_MB = 25;

/**
 * Confidence bands, as fractions. Below `fair` the text is presented as
 * unreliable; between `fair` and `good` the student is told to check it.
 * These are editorial choices about how much trust to express, not engine
 * output — they live in one place so the wording and the numbers cannot drift.
 */
export const CONFIDENCE_BANDS = Object.freeze({ good: 0.8, fair: 0.6 });

/** Reliability grades. `unknown` means the engine reported no score at all. */
export const RELIABILITY = Object.freeze({
  good: 'good',
  fair: 'fair',
  poor: 'poor',
  unknown: 'unknown',
});

/**
 * A positive number, or the fallback when the value is absent, zero or junk.
 * Shared with `extract/image.js`, which reads the same shape of env override.
 */
export function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** The configured OCR budget, in ms (env `OCR_TIMEOUT_MS`, default 45 s). */
export function ocrTimeoutMs() {
  return positiveOr(process.env.OCR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

// ---------------------------------------------------------------- reliability

/**
 * Grade a 0–1 confidence. Returns 'unknown' when the engine reported nothing,
 * because "we do not know" must never be dressed up as "it is fine".
 */
export function reliabilityOf(confidence) {
  if (confidence == null || !Number.isFinite(confidence)) return RELIABILITY.unknown;
  if (confidence >= CONFIDENCE_BANDS.good) return RELIABILITY.good;
  if (confidence >= CONFIDENCE_BANDS.fair) return RELIABILITY.fair;
  return RELIABILITY.poor;
}

/**
 * Grade the whole read from its average AND from the lines the engine is unsure
 * about.
 *
 * The average alone is not enough: a slide has no blank lines, so its entire
 * text is one paragraph, and a single confident headline can pull a page
 * average up to "good" while three lines in the middle are gibberish. If any
 * line is unreliable the read cannot be called good; if most of them are it is
 * not merely fair.
 *
 * @param {number|null} confidence page-average confidence, 0–1
 * @param {object} [evidence]
 * @param {number} [evidence.lineCount]     how many lines were recognised
 * @param {number} [evidence.unreliableLines] how many of them scored below `fair`
 */
export function overallReliability(confidence, evidence = {}) {
  const base = reliabilityOf(confidence);
  const lineCount = Number(evidence?.lineCount) || 0;
  const unreliable = Number(evidence?.unreliableLines) || 0;
  if (lineCount === 0 || unreliable === 0) return base;
  const fraction = unreliable / lineCount;
  if (base === RELIABILITY.poor || fraction >= 0.5) return RELIABILITY.poor;
  if (base === RELIABILITY.good) return RELIABILITY.fair;
  return base;
}

/**
 * One plain sentence a page can show next to the result, or null when there is
 * nothing worth saying (a confident read needs no disclaimer).
 *
 * @param {string} grade a RELIABILITY value
 */
export function reliabilityNote(grade) {
  if (grade === RELIABILITY.good) return null;
  if (grade === RELIABILITY.fair) {
    return 'Parts of this image were unclear, so check the text against the picture before relying on it.';
  }
  if (grade === RELIABILITY.poor) {
    return 'This text is unreliable — the image is too blurry, dark or noisy to read accurately. '
      + 'Retake it in better light, or type the text in instead.';
  }
  return 'The reader could not measure how accurate this text is, so treat it with caution.';
}

// ------------------------------------------------------------- language data

/** Directory names we accept trained data in, in order. */
function localLanguageDirs() {
  const configured = (process.env.OCR_LANG_PATH ?? '').trim();
  if (configured !== '') return [configured];
  return [
    path.join(process.cwd(), 'node_modules', '.tesseract-lang'),
    path.join(process.cwd(), 'data', 'tesseract'),
  ];
}

/**
 * The trained-data file inside `dir`, or null. Prefers the plain file, then
 * the gzipped one, and returns the full path so the caller knows WHICH it got.
 *
 * That distinction matters: `gzip` passed to createWorker is not a hint, it is
 * an instruction about the file NAME the engine should request. The engine
 * asks for `<langPath>/eng.traineddata` when gzip is false, so a directory
 * holding only `eng.traineddata.gz` — which is exactly what the
 * @tesseract.js-data/eng npm package ships — fails with ENOENT unless the
 * caller flips it. This function exists because that case shipped broken and
 * was only caught by running it.
 */
function languageDataFile(dir) {
  for (const name of [`${OCR_LANGUAGE}.traineddata`, `${OCR_LANGUAGE}.traineddata.gz`]) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) return { file, gzipped: name.endsWith('.gz') };
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/**
 * First local directory that already holds `eng.traineddata`, or null. Both the
 * plain and the gzipped file are accepted — see languageDataFile for why the
 * caller has to be told which one it found.
 */
function findLocalLanguageDir() {
  for (const dir of localLanguageDirs()) {
    if (languageDataFile(dir)) return dir;
  }
  return null;
}

/** A directory we can write to. Only /tmp is writable on a serverless host. */
function writableLanguageDir() {
  const place = (process.env.OCR_LANG_CACHE ?? '').trim()
    || path.join(os.tmpdir(), 'socius-tesseract');
  fs.mkdirSync(place, { recursive: true });
  return place;
}

/**
 * Download the trained data once, with a hard time and size budget. This is the
 * first-run convenience for a fresh clone; a deployment should instead bundle
 * the file (see the `vercel.json` includeFiles note in HANDOFF) so no request
 * ever pays for it.
 */
async function downloadLanguageData(dir) {
  const target = path.join(dir, `${OCR_LANGUAGE}.traineddata`);
  const url = `https://tessdata.projectnaptha.com/4.0.0/${OCR_LANGUAGE}.traineddata.gz`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DATA_DOWNLOAD_TIMEOUT_MS);
  let body;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw new ApiError(503, 'OCR_UNAVAILABLE',
      `The image reader's English language data is not installed and could not be downloaded (${err?.message ?? err}). `
      + 'Set OCR_LANG_PATH to a directory containing eng.traineddata and try again.');
  } finally {
    clearTimeout(timer);
  }
  if (body.length > DATA_DOWNLOAD_MAX_MB * 1024 * 1024) {
    throw new ApiError(503, 'OCR_UNAVAILABLE',
      `The image reader's language data download exceeded ${DATA_DOWNLOAD_MAX_MB} MB. `
      + 'Set OCR_LANG_PATH to a directory containing eng.traineddata and try again.');
  }
  fs.writeFileSync(target, body);
  return dir;
}

/**
 * The directory the engine should read its language data from, always a LOCAL
 * path, so tesseract.js never performs its own (unbounded, silent) download.
 * `source` reports where the data came from, for the operator-facing log.
 */
export async function resolveLanguageData() {
  const local = findLocalLanguageDir();
  if (local) return { dir: local, source: 'local' };
  const dir = writableLanguageDir();
  return { dir: await downloadLanguageData(dir), source: 'downloaded' };
}

// ------------------------------------------------------------------ progress

/**
 * Highest progress reached in each engine phase. tesseract.js reports phases
 * ("loading tesseract core", "loading language traineddata",
 * "recognizing text") with a 0–1 progress that advances several times during
 * recognition. Keeping the maximum per phase is what lets a timed-out request
 * say "it got 62% of the way through reading the image" instead of nothing.
 */
function progressTracker() {
  const stages = new Map();
  return {
    record(message) {
      const status = typeof message?.status === 'string' ? message.status : '';
      const progress = Number(message?.progress);
      if (status === '' || !Number.isFinite(progress)) return;
      stages.set(status, Math.max(stages.get(status) ?? 0, progress));
    },
    list() {
      return [...stages.entries()].map(([status, progress]) => ({ status, progress }));
    },
  };
}

/** Human-readable phase summary for a timeout message. */
function stageSummary(stages) {
  if (stages.length === 0) return 'the reader did not get as far as reading the image';
  const parts = stages.map((stage) => `${stage.status} (${Math.round(stage.progress * 100)}%)`);
  return `it reached ${parts.join(', ')}`;
}

/** The one failure the engine produces when it cannot decode the bytes it was given. */
function engineReadFailure() {
  return new ApiError(422, 'OCR_FAILED',
    'The image could not be read into text. It may be damaged or in a format this build does not support.');
}

// ----------------------------------------------------------------- tsv parse

/**
 * Per-line mean word confidence from the engine's TSV output.
 *
 * TSV rows are tab-separated; a "5" level row is one word and carries the
 * confidence in column 11. Grouping by `page.block.paragraph.line` gives one
 * record per recognised line. Returns an empty array when the engine produced
 * no words at all (an empty or unreadable image).
 */
export function lineConfidences(tsv) {
  const lines = new Map();
  for (const row of String(tsv ?? '').split('\n').slice(1)) {
    const cells = row.split('\t');
    if (cells.length < 12 || cells[0] !== '5') continue;
    const key = `${cells[2]}.${cells[3]}.${cells[4]}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ confidence: Number(cells[10]), text: cells[11] ?? '' });
  }
  const out = [];
  for (const words of lines.values()) {
    const confidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
    out.push({
      text: words.map((word) => word.text).join(' ').trim(),
      confidence: confidence / 100, // the engine reports 0–100, the contract says 0–1
    });
  }
  return out.filter((line) => line.text !== '');
}

// ------------------------------------------------------------------- engine

/**
 * Run OCR on one image.
 *
 * @param {Buffer} buffer raw image bytes (already validated by the caller)
 * @param {object} [options]
 * @param {number} [options.timeoutMs] override for the wall-clock budget
 * @returns {Promise<{text: string, lines: Array<{text: string, confidence: number|null}>,
 *   confidence: number|null, wordCount: number, language: string,
 *   durationMs: number, stages: Array<{status: string, progress: number}>,
 *   dataSource: string}>}
 * @throws {ApiError} 400 VALIDATION_ERROR for an empty buffer,
 *   422 OCR_TIMEOUT when the budget runs out, 422 OCR_FAILED when the engine
 *   cannot read the image, 503 OCR_UNAVAILABLE when the engine data is missing.
 */
export async function readImageText(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The image file is empty.');
  }
  const timeoutMs = positiveOr(options.timeoutMs, ocrTimeoutMs());
  const tracker = progressTracker();

  const { dir, source } = await resolveLanguageData();

  const startedAt = Date.now();
  let worker = null; // set as soon as the engine is up, so a timeout can kill it
  let retired = false;

  /** Kill the engine thread. Idempotent, and never waits for a round-trip. */
  const retire = () => {
    retired = true;
    if (worker) worker.terminate().catch(() => {});
  };

  // Never let tesseract.js download anything itself: `langPath` points at a
  // local directory, so the engine reads the file or fails loudly.
  //
  // `errorHandler` is not optional. tesseract.js reports a failure inside the
  // worker by calling it; with no handler the library re-throws from its
  // message listener, which kills the Node process instead of failing the
  // request. Routing it into the race below is what turns a corrupt image into
  // a 422.
  let reportEngineFailure = () => {};
  const engineFailure = new Promise((_resolve, reject) => {
    reportEngineFailure = () => reject(engineReadFailure());
  });
  const dataFile = languageDataFile(dir);
  const engineOptions = {
    langPath: dir,
    // Which name the engine should ask for. This is about the FILE NAME, not
    // the bytes: a plain-named file is requested as-is and tesseract detects
    // gzip content from the magic bytes itself (which is how the download
    // path's gzipped-content-but-plain-named file works). A `.gz`-named
    // directory -- what @tesseract.js-data/eng ships -- needs this flipped,
    // or the engine asks for a `eng.traineddata` that does not exist.
    gzip: Boolean(dataFile?.gzipped),
    cacheMethod: 'none', // no read-through cache, no writes into the deploy
    logger: (message) => tracker.record(message),
    errorHandler: (err) => {
      console.error('[media/ocr] engine error:', typeof err === 'string' ? err : (err?.message ?? err));
      reportEngineFailure();
    },
  };

  // `createWorker` never rejects: its init chain swallows failures and leaves
  // the returned promise unsettled. That is why the deadline below covers
  // creation as well as recognition — a stuck engine must not hang the
  // request, and with a local language file there is nothing left to fetch.
  const creation = Promise.resolve(createWorker(OCR_LANGUAGE, OEM.LSTM_ONLY, engineOptions));
  // A worker that only finishes booting AFTER the budget expired can be
  // reached through no other handle, so watch it here too: either way, the
  // request must not leave a live engine thread behind.
  creation.then((created) => {
    if (!worker) worker = created;
    if (retired) retire();
  }, () => {});

  const deadline = new Promise((_resolve, reject) => {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const timer = setTimeout(() => {
      reject(new ApiError(422, 'OCR_TIMEOUT',
        `Reading this image took longer than ${seconds} ${seconds === 1 ? 'second' : 'seconds'}, so it was stopped `
        + `part-way through (${stageSummary(tracker.list())}). `
        + 'Try a smaller, clearer photo.'));
    }, timeoutMs);
    // The engine keeps the event loop alive on its own; without this a timer
    // left behind after a normal finish would hold the process open.
    timer.unref();
  });

  try {
    const ready = creation
      .then((created) => created.recognize(buffer, {}, { text: true, tsv: true }))
      .finally(retire);

    const { data } = await Promise.race([ready, deadline, engineFailure]);

    const lines = lineConfidences(data.tsv);
    const textLines = String(data.text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
    // Pair engine-measured confidences with the recognised lines by position.
    // This is exact when the two counts agree (they do for every image we
    // measured); when they do not we report the page score instead of guessing
    // which line a score belongs to.
    const paired = lines.length === textLines.length;
    const pageConfidence = Number.isFinite(data.confidence) && data.confidence >= 0
      ? data.confidence / 100
      : null;

    return {
      text: String(data.text ?? '').trim(),
      lines: paired
        ? textLines.map((text, index) => ({ text, confidence: lines[index].confidence }))
        : textLines.map((text) => ({ text, confidence: null })),
      confidence: pageConfidence,
      wordCount: lines.length,
      language: OCR_LANGUAGE_REPORTED,
      durationMs: Date.now() - startedAt,
      stages: tracker.list(),
      dataSource: source,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err; // OCR_TIMEOUT / OCR_UNAVAILABLE — already specific
    // The engine failing to decode the file (a truncated PNG, a WebP variant
    // it does not accept, …) is an OCR failure, not a server fault.
    console.error('[media/ocr]', err?.message ?? err);
    throw engineReadFailure();
  }
}
