// Embeddings for the whole app: the SAME model must embed documents and
// questions, or retrieval silently breaks. This module owns three things:
//   1. batching + input order (callers get one vector per text, in order),
//   2. the dimension contract (vectors must be EMBED_DIMENSION long),
//   3. error mapping to the app's ApiError codes (NIM_TIMEOUT / NIM_ERROR).
// The provider request itself is delegated to the multi-model router
// (server/services/aiRouter.js, task "embed") when it exists, and falls back to
// a direct NVIDIA NIM call otherwise — so the module always works.
//
// Current model produces 2048-dimension vectors (verified live 2026-10-12).
// The store (server/store/*) independently re-checks the length and owns the
// VECTOR_DIMENSION_MISMATCH case for an index built by a different model.

import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';

// Texts per provider request. Smaller batches respect rate limits; the order of
// the returned vectors always matches the order of the input texts.
const DEFAULT_BATCH_SIZE = 16;

// Hard contract for the configured embedding model. A vector of any other size
// would corrupt the index irrecoverably, so it is rejected here, before storage.
const EMBED_DIMENSION = 2048;

// One-time, lazy resolution of the router's `embed` task. It is a dynamic import
// so this file keeps loading (direct path) while aiRouter.js is absent or fails.
let routerEmbedPromise = null;

function loadRouterEmbed() {
  if (!routerEmbedPromise) {
    routerEmbedPromise = import('./aiRouter.js')
      .then((mod) => {
        if (typeof mod?.embed === 'function') return mod.embed;
        // The file exists but does not expose the agreed task — fall back, but
        // say so once so the wiring gap is visible in the logs.
        console.warn('[embeddings] aiRouter.js has no embed() export — using the direct NIM path.');
        return null;
      })
      .catch(() => null); // router not written yet: direct path is the fallback
  }
  return routerEmbedPromise;
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/** Timeout → 504; any other provider failure → 502. Never leaks a raw body. */
function timeoutError() {
  return new ApiError(504, 'NIM_TIMEOUT', 'The embedding service did not respond in time. Try again.');
}

function unreachableError() {
  return new ApiError(502, 'NIM_ERROR', 'Could not reach the embedding service. Check the server connection and try again.');
}

/** One returned vector: non-empty and exactly EMBED_DIMENSION numbers long. */
function validateVector(vector, model) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new ApiError(502, 'NIM_ERROR', 'The embedding service returned an unusable vector.');
  }
  if (vector.length !== EMBED_DIMENSION) {
    throw new ApiError(502, 'NIM_ERROR',
      `The embedding model "${model}" returned ${vector.length}-dimension vectors, but this index stores ${EMBED_DIMENSION}. `
      + 'Check NIM_EMBED_MODEL / AI_EMBED_MODEL; if the model changed on purpose, run "npm run reindex".');
  }
  return vector;
}

/**
 * OpenAI-compatible /embeddings body → vectors in input order. Each item carries
 * its own `index`, so we place by index instead of trusting the response order.
 */
function orderedVectors(data, count, model) {
  const items = Array.isArray(data?.data) ? data.data : [];
  if (items.length !== count) {
    throw new ApiError(502, 'NIM_ERROR',
      `The embedding service returned ${items.length} vectors for ${count} texts.`);
  }
  const vectors = new Array(count);
  for (const item of items) {
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new ApiError(502, 'NIM_ERROR', 'The embedding service returned vectors in an unusable order.');
    }
    vectors[index] = validateVector(item.embedding, model);
  }
  return vectors;
}

/** Direct NVIDIA NIM call — the fallback when the router is not available yet. */
async function directEmbed(batch, model) {
  let res;
  try {
    res = await fetch(`${config.nimBaseUrl}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.nimApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
      signal: AbortSignal.timeout(config.nimTimeoutMs),
    });
  } catch (err) {
    throw isTimeout(err) ? timeoutError() : unreachableError();
  }

  if (!res.ok) {
    // The raw upstream body stays in the server log only.
    const detail = await res.text().catch(() => '');
    console.error(`[nim] embeddings ${res.status}:`, detail.slice(0, 300));
    if (res.status === 429) throw new ApiError(502, 'NIM_ERROR', 'Embedding service rate limit reached. Try again shortly.');
    if (res.status === 401 || res.status === 403) throw new ApiError(502, 'NIM_ERROR', 'Embedding service rejected the API key. Check NIM_API_KEY in .env.');
    if (res.status === 404) throw new ApiError(502, 'NIM_ERROR', `Embedding model "${model}" is not available on this account.`);
    throw new ApiError(502, 'NIM_ERROR', 'The embedding service returned an error. Try again later.');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(502, 'NIM_ERROR', 'The embedding service returned an unreadable response. Try again later.');
  }
  return orderedVectors(data, batch.length, model);
}

/** Embed one batch through the router when present, else directly. */
async function embedBatch(batch, model) {
  const routerEmbed = await loadRouterEmbed();
  if (!routerEmbed) return directEmbed(batch, model);

  let vectors;
  try {
    // Contract with A11's router: embed(texts, { model }) → number[][] of the
    // same length as `texts`, in input order. The router performs the provider
    // request itself; it must NOT call back into this module.
    vectors = await routerEmbed(batch, { model });
  } catch (err) {
    if (err instanceof ApiError) throw err; // the router already mapped it
    console.error('[embeddings] router embed failed:', err);
    throw isTimeout(err) ? timeoutError() : new ApiError(502, 'NIM_ERROR', 'The embedding service returned an error. Try again later.');
  }

  if (!Array.isArray(vectors) || vectors.length !== batch.length) {
    throw new ApiError(502, 'NIM_ERROR', 'The AI router returned an unexpected embedding response.');
  }
  return vectors.map((vector) => validateVector(vector, model));
}

/**
 * Embed many texts. Returns one vector per text, in the same order, using
 * batches of `batchSize`. An empty (or non-array) input resolves to `[]` with no
 * network call.
 */
export async function embedTexts(texts, { model = config.aiRouter.embedModel, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;

  const vectors = [];
  for (let start = 0; start < texts.length; start += size) {
    const batch = texts.slice(start, start + size);
    vectors.push(...await embedBatch(batch, model));
  }
  return vectors;
}

/** Embed a single text (a search query). */
export async function embedQuery(text) {
  const [vector] = await embedTexts([text]);
  return vector;
}
