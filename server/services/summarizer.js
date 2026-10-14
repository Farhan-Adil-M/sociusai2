// Smart shortening — "paragraph → 1–2 sentences without losing content".
//
// This is LOSSLESS-ISH ABSTRACTIVE COMPRESSION, not truncation. Chopping text
// at N characters destroys exactly the facts, names, numbers and relationships
// a later retrieval query looks for, which is what this module exists to avoid.
// The model rewrites; the guardrails below make the contract deterministic.
//
// ── WHERE THIS RUNS (the decision this module makes) ─────────────────────────
// RECOMMENDED: INGEST TIME, per segment, before chunking + embedding.
// The workflow diagram puts "smart shortening" between document ingest and RAG,
// so the compressed text is what gets chunked, embedded and stored. A caller
// runs `shortenSegments(segments, opts)` right after extraction and before
// `chunkSegments()` (A09) — same segment shape, text replaced, everything else
// (location, section, kind) preserved.
//
// TRADE-OFF of storing the shortened text:
//   • Retrieval matches against the paraphrase, not the original wording, so a
//     query that depends on a word the summary dropped can score lower. The
//     guards below exist to limit that loss (numbers/names prompted for and
//     number-invention rejected, output never longer, never empty).
//   • Citation IDENTITY is unaffected: sourceId + page/slide/paragraph/section
//     come from the caller's `location`/metadata, never from the model's prose.
//   • Citation EXCERPT and any charStart/charEnd range refer to the shortened
//     segment, while the ORIGINAL segment text is still stored verbatim in
//     `source_segments` (A06). So an exact original excerpt stays recoverable
//     from the database by sourceId + location — see docs/HANDOFF.md (A16 → A13/A08).
//
// Query-time shortening (compress each retrieved passage on the fly) is the
// alternative: it keeps the stored index verbatim and needs no citation work,
// but pays a model call on every question and does not shrink the index. We do
// NOT do that here. This module only shortens text, so a caller that prefers
// query time can still call `shorten()` directly — the placement decision does
// not leak into the code.
//
// ── MODEL CHOICE (measured, not guessed) ─────────────────────────────────────
// Both configured chat models are reasoning models: they spend completion
// tokens on an internal `reasoning_content` before emitting `content`, so a
// *small* max_tokens makes them hit `finish_reason: "length"` with `content:
// null`. Two live measurements (2026-10-14) set the defaults here:
//   • nemotron-3.5-lightning (config.aiRouter.tutorModel) needed ~4,600
//     reasoning tokens and 67 s on a 600-char paragraph — past the 45 s
//     NIM_TIMEOUT_MS, so it would time out on EVERY call.
//   • nemotron-3-super (config.aiRouter.assessModel) finished in ~6 s with
//     ~430 reasoning tokens from the same prompt.
// So summarisation uses the assess model as its PRIMARY (still read from
// config, never hardcoded), with the tutor model left as the router's fallback.
// The `task: 'summarize'` label is still passed, so A11's usage stats stay
// honest. See docs/HANDOFF.md (A16 → A11): the router's TASKS table maps
// `summarize` to tutorModel, which this measurement contradicts.
//
// ── CONTRACT (deterministic, even though the model is not) ───────────────────
//   • Already within budget (≤ maxSentences sentences, or shorter than
//     minChars) → returned UNCHANGED with ZERO model calls. Pure fast path.
//   • Output must be non-empty, plausibly-sized, carry no number the input did
//     not have, and be STRICTLY shorter than the input. If not: ONE retry, then
//     the ORIGINAL text — never garbage.
//   • The result is never longer than the input.
//   • Input sent to the model is hard-capped (maxInputChars per call, a bounded
//     number of windows), so one huge document cannot blow the token budget.
//   • Shortening is an ENHANCEMENT: a timeout / 429 / auth failure is logged
//     and falls back to the original. `shorten()`/`shortenSegments()` NEVER
//     throw, and an ingest never fails because summarisation broke.
//
// One outbound model call per block (up to a bounded number for an over-long
// block); no other I/O.

import { config } from '../config.js';
import { chatCompletion } from './nimChat.js';
import { wrapPassages, UNTRUSTED_RULE } from './prompts.js';

/** Public tuning surface. `maxSentences` = 2 per the workflow diagram. */
export const DEFAULTS = Object.freeze({
  maxSentences: 2, // the rewritten passage may not exceed this many sentences
  minChars: 200, // below this, a model call is not worth it — return unchanged
  minOutputChars: 12, // shorter than this is a broken response, not a summary
  maxInputChars: 8000, // hard cap on text sent in ONE model call
  // Reasoning models bill reasoning tokens against max_tokens BEFORE any
  // content. Measured usage ranged ~130 tokens (simple, 1.7k-char input) to
  // ~500 (dense, 0.9k-char input); 3000 leaves comfortable headroom for a
  // complex segment while still capping cost (see the header comment). If the
  // cap is ever hit, the model returns empty content, the router throws, and
  // this module keeps the original text — safe, never garbage.
  maxTokens: 3000,
  temperature: 0, // compression should be as repeatable as the model allows
  task: 'summarize', // A11's router task label, used for usage stats
});

// Total calls for an over-long input are bounded: beyond this many windows the
// text is returned unchanged rather than compressing for minutes. Real ingest
// segments are far smaller (the chunker's own window is 800 chars), so this is
// a pathological-input safety net, not a normal path.
const MAX_WINDOWS = 4;

// One shortening attempt, then one retry (see `shortenOnce`).
const ATTEMPTS = 2;

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Shorten one block of text to at most `maxSentences` sentences while keeping
 * its facts, numbers and names.
 *
 * Never throws. Returns the original text (unchanged) when it is already within
 * budget, when the model cannot be reached, or when the model's answer fails a
 * guardrail.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxSentences=2]
 * @param {number} [options.minChars=200]
 * @param {number} [options.maxInputChars=8000]
 * @param {string} [options.model]  defaults to `config.aiRouter.assessModel`
 *                                  (see the model-choice note at the top)
 * @param {string} [options.task='summarize']  A11 router task label
 * @param {Function} [options.chat] `(messages, {task,model,temperature,maxTokens}) => Promise<string>`;
 *                                  defaults to `nimChat.chatCompletion`. Inject for tests,
 *                                  or pass `options.ai` (the createApp DI object).
 * @param {Function} [options.log]  defaults to console.error
 * @returns {Promise<string>} the shortened text, or the input unchanged
 */
export async function shorten(text, options = {}) {
  const opts = resolveOptions(options);
  const source = toText(text);

  if (!needsShortening(source, opts)) return source; // fast path — no AI cost

  // One huge block is split so no single prompt is oversized; each window is
  // then shortened by the normal single-call path.
  if (source.length > opts.maxInputChars) return shortenLong(source, opts);

  const { text: result } = await shortenOnce(source, opts);
  return result;
}

/**
 * Shorten the text of every segment in place, preserving every other field
 * (`location`, `section`, `kind`, …) so the result still feeds `chunkSegments()`.
 *
 * Segments that are already within budget are returned untouched (the SAME
 * object). A segment whose shortening fails keeps its original text. Never
 * throws; a failure in one segment never affects the others.
 *
 * @param {Array<{text?: string}>} segments
 * @param {object} [options] same as `shorten`
 * @returns {Promise<Array>} a new array of segments
 */
export async function shortenSegments(segments, options = {}) {
  const opts = resolveOptions(options);
  const list = Array.isArray(segments) ? segments : [];
  const out = [];

  for (const segment of list) {
    if (!segment || typeof segment !== 'object') {
      out.push(segment);
      continue;
    }
    const text = toText(segment.text);
    if (!needsShortening(text, opts)) {
      out.push(segment);
      continue;
    }
    const shortened = await shorten(text, opts);
    // Defence in depth: replace only with a strictly shorter, non-empty string.
    out.push(shortened && shortened.length < text.length ? { ...segment, text: shortened } : segment);
  }

  return out;
}

/** Sentences in a block of text. Abbreviations over-count (see limitation). */
export function countSentences(text) {
  return String(text ?? '')
    .split(/[.!?]+(?=\s|$)/)
    .filter((part) => part.trim() !== '').length;
}

// ── budget + length helpers (pure) ───────────────────────────────────────────

/** Is compression even worth attempting? (the whole fast path) */
function needsShortening(source, opts) {
  return source.trim() !== ''
    && countSentences(source) > opts.maxSentences
    && source.trim().length >= opts.minChars;
}

/** The model's answer, minus the wrappers models like to add. */
function stripWrapper(value) {
  let out = toText(value).trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
  if (out.length >= 2
    && ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”')))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/** Every distinct run of digits, punctuation-stripped ("1,000" → "1000"). */
function numbersIn(text) {
  const found = new Set();
  for (const match of toText(text).matchAll(/\d+(?:[.,]\d+)*/g)) {
    found.add(match[0].replace(/[.,]/g, ''));
  }
  return found;
}

/** True when the output states a number the input never contained. */
function hasInventedNumbers(output, input) {
  const known = numbersIn(input);
  for (const value of numbersIn(output)) {
    if (!known.has(value)) return true;
  }
  return false;
}

/**
 * Deterministic guardrail on the model's answer. Returns a human-readable
 * problem, or null when the answer is acceptable.
 */
function findProblem(candidate, source, opts) {
  if (candidate === '') return 'empty output';
  if (!/[\p{L}\p{N}]/u.test(candidate)) return 'output has no letters or digits';
  if (candidate.length < Math.min(opts.minOutputChars, source.trim().length)) {
    return 'output is implausibly short';
  }
  if (candidate.length >= source.trim().length) return 'output is not shorter than the input';
  if (hasInventedNumbers(candidate, source)) return 'output contains a number the input did not';
  return null;
}

// ── the model call ───────────────────────────────────────────────────────────

/**
 * One shortening attempt with one retry. A model EXCEPTION (timeout, 429, auth)
 * falls back immediately; only an unusable BUT returned answer is retried —
 * exactly the guardrail the contract promises.
 */
async function shortenOnce(source, opts) {
  const messages = buildMessages(source, opts.maxSentences);
  const params = { task: opts.task, model: opts.model, temperature: opts.temperature, maxTokens: opts.maxTokens };

  // Retry once: the model can return a preamble, a longer "summary", or an
  // invented figure. A second sample often fixes it; if not, keep the original.
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS;
    try {
      const candidate = stripWrapper(await opts.chat(messages, params));
      const problem = findProblem(candidate, source, opts);
      if (!problem) return { text: candidate, shortened: true };
      opts.log(last ? `retry rejected too (${problem}) — keeping original text`
        : `answer rejected (${problem}) — retrying once`);
    } catch (err) {
      opts.log(last ? `retry failed — keeping original text (${describeError(err)})`
        : `model call failed — keeping original text (${describeError(err)})`);
      break; // a model exception is never retried
    }
  }

  return { text: source, shortened: false };
}

function buildMessages(source, maxSentences) {
  const plural = maxSentences === 1 ? '' : 's';
  const system = [
    'You compress study material for a retrieval system. You shorten text; you never change its meaning.',
    `Rewrite the passage in at most ${maxSentences} sentence${plural}, in concise plain wording — noticeably shorter than the original.`,
    'Preserve every number, date, name, quantity and unit, and the key relationships between them.',
    'Condense repetition, examples and filler, but never drop a distinct fact or change what it means.',
    'Do not add facts, opinions or commentary. Keep the result self-contained.',
    UNTRUSTED_RULE,
    'Output ONLY the rewritten passage — no preamble, labels, quotes or explanation.',
  ].join('\n');

  const user = [
    wrapPassages([{ text: source }], { label: () => 'untrusted study text' }),
    '',
    `Rewrite the passage above in at most ${maxSentences} sentence${plural}.`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── over-long input ──────────────────────────────────────────────────────────

/**
 * Compress a text too long for one prompt, window by window. Returns the
 * original untouched when it would need more than MAX_WINDOWS calls, or if the
 * joined result somehow did not get shorter.
 */
async function shortenLong(source, opts) {
  const windows = splitForModel(source, opts.maxInputChars);
  if (windows.length > MAX_WINDOWS) {
    opts.log(`text is ${source.length} chars across ${windows.length} windows (cap ${MAX_WINDOWS}) — keeping it unchanged`);
    return source;
  }

  const parts = [];
  for (const window of windows) {
    parts.push(await shorten(window, opts)); // each window ≤ maxInputChars
  }

  const joined = parts.filter((part) => part !== '').join('\n\n');
  return joined !== '' && joined.length < source.length ? joined : source;
}

/** Split on paragraph, then sentence, then character boundaries. */
function splitForModel(text, maxLen) {
  const windows = [];
  let current = '';

  const push = (piece) => {
    if (piece === '') return;
    if (current === '') {
      current = piece;
    } else if (current.length + 2 + piece.length <= maxLen) {
      current = `${current}\n\n${piece}`;
    } else {
      windows.push(current);
      current = piece;
    }
  };

  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (trimmed.length <= maxLen) {
      push(trimmed);
      continue;
    }
    for (const sentence of splitSentences(trimmed)) {
      if (sentence.length <= maxLen) {
        push(sentence);
        continue;
      }
      for (let i = 0; i < sentence.length; i += maxLen) {
        push(sentence.slice(i, i + maxLen).trim());
      }
    }
  }

  if (current !== '') windows.push(current);
  return windows;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

// ── plumbing ─────────────────────────────────────────────────────────────────

function resolveOptions(options) {
  const merged = { ...DEFAULTS, ...(options ?? {}) };
  return {
    ...merged,
    model: merged.model ?? config.aiRouter.assessModel,
    chat: merged.chat ?? merged.ai?.chatCompletion ?? chatCompletion,
    log: merged.log ?? defaultLog,
  };
}

function toText(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function defaultLog(message) {
  console.error(`[summarizer] ${message}`);
}

/** Safe one-line description of a thrown value — never leaks a secret. */
function describeError(err) {
  if (err?.message) return `${err.name ?? 'Error'}: ${err.message}`;
  return String(err);
}
