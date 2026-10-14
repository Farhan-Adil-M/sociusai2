// AI router — the one place that decides which model serves which task, with
// timeouts, retry-with-backoff, fallback and structured logging.
//
// BACKEND ONLY. This module is imported by server/services/* and by no frontend
// file. The browser must never reach NVIDIA NIM directly: no model id, API key
// or provider URL ever leaves the server. Every model call in the app flows
// through `complete()` (chat tasks) or `embed()` (the embed task).
//
// Dependency direction:   nimChat.js  →  aiRouter.js  →  { config, errors }
//                         embeddings.js ──(lazy dynamic import)→ aiRouter.js
// aiRouter NEVER imports either of them (no cycle). The NIM transport lives here
// so routing/retry/fallback and the legacy `chatCompletion` wrapper share one
// implementation: nimChat.js is now just a thin adapter over this module, and
// embeddings.js delegates its provider request to `embed()`.
//
// Model ids are never hardcoded: they are read from config.aiRouter (A04's
// HANDOFF), where tutorModel/assessModel/embedModel equal the NIM_* values
// unless the operator sets an AI_* override.

import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';

// --- task taxonomy ----------------------------------------------------------
// Every task the app asks a model to do. `kind` is the call class; `modelKey`
// names the config.aiRouter field that carries the default model. Several chat
// tasks legitimately share a model — the point of an explicit table is that
// changing a default here changes it for every caller at once.
export const TASKS = Object.freeze({
  tutor: Object.freeze({ kind: 'chat', modelKey: 'tutorModel' }), // grounded tutor answers
  assess: Object.freeze({ kind: 'chat', modelKey: 'assessModel' }), // quiz generation, grading prose
  organize: Object.freeze({ kind: 'chat', modelKey: 'assessModel' }), // strict-JSON classification
  summarize: Object.freeze({ kind: 'chat', modelKey: 'tutorModel' }), // smart shortening
  flashcard: Object.freeze({ kind: 'chat', modelKey: 'assessModel' }), // card generation
  advice: Object.freeze({ kind: 'chat', modelKey: 'tutorModel' }), // "what to revise next"
  embed: Object.freeze({ kind: 'embed', modelKey: 'embedModel' }), // called by embeddings.js
});

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1200;
/** Attempts per model before the next model in the chain is tried. */
const DEFAULT_ATTEMPTS = 2;
/** Base backoff between attempts (ms); grows exponentially, capped, jittered. */
const DEFAULT_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 4000;

// --- in-memory usage counters ----------------------------------------------
// Deliberately bounded: keys are task names and model ids, both small fixed
// sets. Nothing here is persisted; a restart resets it.
const stats = {
  calls: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  fallbacks: 0,
  byTask: Object.create(null),
  byModel: Object.create(null),
  latency: { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
};

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * A snapshot of model usage since process start. Copy, not a live reference, so
 * callers can render it without freezing the router's own counters.
 */
export function getStats() {
  return {
    calls: stats.calls,
    successes: stats.successes,
    failures: stats.failures,
    retries: stats.retries,
    fallbacks: stats.fallbacks,
    byTask: { ...stats.byTask },
    // One entry per model that actually served a successful call.
    byModel: { ...stats.byModel },
    latencyMs: {
      samples: stats.latency.count,
      last: stats.latency.lastMs,
      max: stats.latency.maxMs,
      avg: stats.latency.count ? Math.round(stats.latency.totalMs / stats.latency.count) : 0,
    },
  };
}

// --- model resolution -------------------------------------------------------

function taskSpec(task) {
  const spec = TASKS[task];
  if (!spec) throw new ApiError(500, 'AI_TASK_UNKNOWN', `Unknown AI task "${task}".`);
  return spec;
}

/**
 * The model that would serve `task`. Pass `{ model }` to override the default
 * (callers that already pinned a model keep their choice).
 */
export function resolveModel(task, { model } = {}) {
  const spec = taskSpec(task);
  if (typeof model === 'string' && model.trim() !== '') return model.trim();
  const configured = config.aiRouter?.[spec.modelKey];
  if (!configured) {
    throw new ApiError(500, 'AI_MODEL_UNCONFIGURED', `No model configured for task "${task}" (config.aiRouter.${spec.modelKey}).`);
  }
  return configured;
}

// The chat-capable models, in preference order. The embedding model is NOT
// chat-capable and must never be used as a chat fallback.
function chatModels() {
  return [config.aiRouter.tutorModel, config.aiRouter.assessModel].filter((m) => m && m.trim() !== '');
}

/** Primary model first, then the other configured chat model (if different). */
function modelChain(task, explicitModel) {
  const primary = resolveModel(task, { model: explicitModel });
  const other = chatModels().find((m) => m !== primary);
  return other ? [primary, other] : [primary];
}

// --- structured logging -----------------------------------------------------
// One JSON line per attempt: task, model, attempt number, outcome, latency and
// error code. NEVER logs the API key, headers, tokens, or message bodies.
function logCall(entry) {
  const line = JSON.stringify({ scope: 'aiRouter', ...entry });
  if (entry.outcome === 'error') console.error(line);
  else if (entry.outcome === 'retry' || entry.outcome === 'fallback') console.warn(line);
  else console.log(line);
}

// --- error classification ---------------------------------------------------
// Attach routing metadata to the ApiError (without touching the shared class):
// `aiRetry` = retry the same model; `aiFallback` = try the other chat model.
function providerError(status, code, message, { retry, fallback }) {
  const err = new ApiError(status, code, message);
  err.aiRetry = retry;
  err.aiFallback = fallback;
  return err;
}

function classify(err) {
  if (err && typeof err.aiRetry === 'boolean') {
    return { retry: err.aiRetry, fallback: err.aiFallback !== false };
  }
  // An unexpected error (a bug): do not spend another paid call on the same
  // model, but let the other model try once before failing loudly.
  return { retry: false, fallback: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelay(baseMs, attempt) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  const capped = Math.min(baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(capped * (0.5 + Math.random() * 0.5)); // 50–100% jitter
}

function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/** The one flag pair the embedding endpoint ever uses: retry the same model,
 *  never swap models (a different embedding model would change the vector size
 *  and corrupt the index). */
const RETRY_ONLY = Object.freeze({ retry: true, fallback: false });

// --- NIM transport ----------------------------------------------------------
// OpenAI-compatible endpoints. Each throws an ApiError whose code/message match
// the long-standing contract, plus the aiRetry/aiFallback routing flags.
//
// Both endpoints send the same shape of request — same URL, same headers, same
// network → HTTP-status → body sequence — so the transport is shared and only
// the WORDING differs. `canFallback` is the one behavioural difference: a
// different embedding model returns a different vector size and would corrupt
// the index, so an embedding failure is never handed to another model.

const cap = (text) => text[0].toUpperCase() + text.slice(1); // "embedding service" → "Embedding service"

const WORDS = {
  chat: {
    service: 'AI provider', model: 'AI model', canFallback: true,
    timeout: 'The AI model did not respond in time. Try again.',
    unreachable: (err) => `Could not reach the AI provider: ${err.message}`,
    rateLimit: 'Wait a moment and try again.', unreadable: 'Try again.',
  },
  embed: {
    service: 'embedding service', model: 'Embedding model', canFallback: false,
    timeout: 'The embedding service did not respond in time. Try again.',
    unreachable: () => 'Could not reach the embedding service. Check the server connection and try again.',
    rateLimit: 'Try again shortly.', unreadable: 'Try again later.',
  },
};

/** Map an HTTP failure onto an ApiError. Only the status is read: the provider's
 *  response body is never read or logged, so a provider that echoes the request
 *  can never put prompt text in a log. */
function statusError(status, model, words) {
  if (status === 429) {
    return providerError(502, 'NIM_ERROR', `${cap(words.service)} rate limit reached. ${words.rateLimit}`, { retry: true, fallback: words.canFallback });
  }
  if (status === 401 || status === 403) {
    // A bad key fails for every model, so neither retry nor fallback helps.
    return providerError(502, 'NIM_ERROR', `${cap(words.service)} rejected the API key. Check NIM_API_KEY in .env.`, { retry: false, fallback: false });
  }
  if (status === 404) {
    // Model-specific: another configured model may well be available.
    return providerError(502, 'NIM_ERROR', `${words.model} "${model}" is not available on this account.`, { retry: false, fallback: words.canFallback });
  }
  // 5xx and transient 4xx are worth another try; a malformed request
  // (400/413/422) would be rejected by every model, so fail fast.
  const transient = status >= 500 || status === 408;
  const malformed = status === 400 || status === 413 || status === 422;
  return providerError(502, 'NIM_ERROR', `The ${words.service} returned an error. Try again later.`, {
    retry: transient,
    fallback: words.canFallback && (transient || !malformed),
  });
}

async function postJson(path, body, timeoutMs, words) {
  let res;
  try {
    res = await fetch(`${config.nimBaseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.nimApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw providerError(504, 'NIM_TIMEOUT', words.timeout, { retry: true, fallback: words.canFallback });
    }
    throw providerError(502, 'NIM_ERROR', words.unreachable(err), { retry: true, fallback: words.canFallback });
  }

  if (!res.ok) {
    const err = statusError(res.status, body.model, words);
    err.aiStatus = res.status;
    throw err;
  }

  try {
    return await res.json();
  } catch {
    throw providerError(502, 'NIM_ERROR', `The ${words.service} returned an unreadable response. ${words.unreadable}`, { retry: true, fallback: words.canFallback });
  }
}

async function requestCompletion(model, messages, { temperature, maxTokens, timeoutMs }) {
  const data = await postJson('/chat/completions', { model, messages, temperature, max_tokens: maxTokens }, timeoutMs, WORDS.chat);

  const content = data?.choices?.[0]?.message?.content;
  // Reasoning-style models occasionally return empty content. Treat it as a
  // retryable failure — never invent an answer, never return "". The retry loop
  // gives it one more try on the same model, then the other model, then fails.
  if (typeof content !== 'string' || content.trim() === '') {
    throw providerError(502, 'NIM_ERROR', 'The AI model returned an empty response. Try again.', { retry: true, fallback: true });
  }
  return content.trim();
}

async function requestEmbedding(model, texts, timeoutMs) {
  const data = await postJson('/embeddings', { model, input: texts }, timeoutMs, WORDS.embed);

  // Every item carries its own `index`, so place by index instead of trusting
  // response order. The dimension contract (2048) stays with embeddings.js,
  // which owns the index-format message; here we only reject unusable shapes.
  const items = Array.isArray(data?.data) ? data.data : [];
  if (items.length !== texts.length) {
    throw providerError(502, 'NIM_ERROR', `The embedding service returned ${items.length} vectors for ${texts.length} texts.`, RETRY_ONLY);
  }
  const vectors = new Array(texts.length);
  for (const item of items) {
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index >= texts.length) {
      throw providerError(502, 'NIM_ERROR', 'The embedding service returned vectors in an unusable order.', RETRY_ONLY);
    }
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw providerError(502, 'NIM_ERROR', 'The embedding service returned an unusable vector.', RETRY_ONLY);
    }
    vectors[index] = item.embedding;
  }
  return vectors;
}

// --- retry + fallback core --------------------------------------------------
// Shared by both task kinds: try each model in order, retry a model on a
// retryable failure with exponential backoff, move to the next model only when
// the failure is fallback-eligible (never on a rejected API key), then throw the
// last ApiError. `perform(model)` does the one HTTP call for that model.
async function routeCall(task, chain, perform, { attempts, backoffMs }) {
  const perModelAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  const callStartedAt = Date.now();
  let totalAttempts = 0;
  let usedFallback = false;
  let lastError = null;
  let lastInfo = null;

  stats.calls++;
  bump(stats.byTask, task);

  for (let index = 0; index < chain.length; index++) {
    const currentModel = chain[index];

    for (let attempt = 1; attempt <= perModelAttempts; attempt++) {
      totalAttempts++;
      if (attempt > 1) stats.retries++;
      const attemptStartedAt = Date.now();

      try {
        const result = await perform(currentModel);
        const callLatencyMs = Date.now() - callStartedAt;

        stats.successes++;
        bump(stats.byModel, currentModel);
        stats.latency.count++;
        stats.latency.totalMs += callLatencyMs;
        stats.latency.lastMs = callLatencyMs;
        if (callLatencyMs > stats.latency.maxMs) stats.latency.maxMs = callLatencyMs;

        logCall({
          task,
          model: currentModel,
          attempt,
          attempts: totalAttempts,
          outcome: 'ok',
          latencyMs: Date.now() - attemptStartedAt,
          fallback: usedFallback,
          ...(usedFallback ? { fallbackFrom: chain[index - 1] } : {}),
        });
        return result;
      } catch (err) {
        lastError = err;
        lastInfo = classify(err);
        const hasNextModel = lastInfo.fallback && index < chain.length - 1;
        const willRetry = lastInfo.retry && attempt < perModelAttempts;

        logCall({
          task,
          model: currentModel,
          attempt,
          attempts: totalAttempts,
          outcome: willRetry ? 'retry' : hasNextModel ? 'fallback' : 'error',
          code: err?.code ?? 'UNKNOWN',
          ...(err?.aiStatus ? { status: err.aiStatus } : {}),
          latencyMs: Date.now() - attemptStartedAt,
          ...(willRetry || hasNextModel ? { next: hasNextModel && !willRetry ? chain[index + 1] : currentModel } : {}),
        });

        if (!willRetry) break; // this model is exhausted (or not retryable)
        const delay = backoffDelay(backoffMs, attempt);
        if (delay > 0) await sleep(delay);
      }
    }

    // Switch to the other chat model only when the failure is model-agnostic
    // enough to be worth a different model (never for a rejected API key).
    if (!lastInfo?.fallback || index === chain.length - 1) break;
    usedFallback = true;
    stats.fallbacks++;
    const delay = backoffDelay(backoffMs, perModelAttempts);
    if (delay > 0) await sleep(delay);
  }

  stats.failures++;
  throw lastError;
}

// --- public entry points ----------------------------------------------------

/**
 * Run one chat task through the router.
 *
 * @param {string} task     a key of TASKS with kind "chat"
 * @param {Array}  messages OpenAI-style [{ role, content }]
 * @param {object} [options] { model, temperature, maxTokens, timeoutMs, attempts, backoffMs }
 * @returns {Promise<string>} the trimmed model answer
 * @throws {ApiError} NIM_TIMEOUT | NIM_ERROR after every model in the chain fails
 */
export async function complete(task, messages, options = {}) {
  const spec = taskSpec(task);
  if (spec.kind !== 'chat') {
    throw new ApiError(500, 'AI_TASK_NOT_CHAT', `AI task "${task}" is not a chat task; call embed() for embeddings.`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(500, 'AI_BAD_REQUEST', 'complete() needs a non-empty messages array.');
  }

  const {
    model,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = config.nimTimeoutMs,
    attempts = DEFAULT_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
  } = options;

  return routeCall(
    task,
    modelChain(task, model),
    (currentModel) => requestCompletion(currentModel, messages, { temperature, maxTokens, timeoutMs }),
    { attempts, backoffMs },
  );
}

/**
 * Embed texts for the "embed" task. One provider request per call (batching and
 * the 2048-dimension contract belong to embeddings.js, which delegates here).
 * There is no cross-model fallback: a different embedding model would return a
 * different vector size and corrupt the index.
 *
 * @param {string[]} texts
 * @param {object} [options] { model, timeoutMs, attempts, backoffMs }
 * @returns {Promise<number[][]>} one vector per text, in input order
 * @throws {ApiError} NIM_TIMEOUT | NIM_ERROR
 */
export async function embed(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const {
    model,
    timeoutMs = config.nimTimeoutMs,
    attempts = DEFAULT_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
  } = options;

  const embeddingModel = resolveModel('embed', { model });
  return routeCall(
    'embed',
    [embeddingModel],
    (currentModel) => requestEmbedding(currentModel, texts, timeoutMs),
    { attempts, backoffMs },
  );
}
