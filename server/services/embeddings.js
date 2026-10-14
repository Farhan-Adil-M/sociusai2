// NVIDIA NIM embeddings client (/embeddings).
// The SAME model must embed documents and questions, or retrieval breaks.
// Current model produces 2048-dimension vectors (verified live 2026-10-12).

import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';

const BATCH_SIZE = 32;

export async function embedTexts(texts, { model = config.nimEmbedModel } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const vectors = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    let res;
    try {
      res = await fetch(`${config.nimBaseUrl}/embeddings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.nimApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(config.nimTimeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ApiError(504, 'NIM_TIMEOUT', 'The embedding service did not respond in time. Try again.');
      }
      throw new ApiError(502, 'NIM_ERROR', `Could not reach the embedding service: ${err.message}`);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 429) throw new ApiError(502, 'NIM_ERROR', 'Embedding service rate limit reached. Try again shortly.');
      if (res.status === 401 || res.status === 403) throw new ApiError(502, 'NIM_ERROR', 'Embedding service rejected the API key.');
      if (res.status === 404) throw new ApiError(502, 'NIM_ERROR', `Embedding model "${model}" is not available on this account.`);
      console.error(`[nim] embeddings ${res.status}:`, detail.slice(0, 300));
      throw new ApiError(502, 'NIM_ERROR', 'The embedding service returned an error. Try again later.');
    }

    const data = await res.json();
    const ordered = [...data.data].sort((a, b) => a.index - b.index);
    for (const item of ordered) {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new ApiError(502, 'NIM_ERROR', 'The embedding service returned an unusable vector.');
      }
      vectors.push(item.embedding);
    }
  }
  return vectors;
}

export async function embedQuery(text) {
  const [vector] = await embedTexts([text]);
  return vector;
}
