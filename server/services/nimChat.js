// NVIDIA NIM chat client (OpenAI-compatible /chat/completions).
// Every model ID and the endpoint come from .env — verified against our account.

import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';

export async function chatCompletion(messages, { model = config.nimChatModel, temperature = 0.2, maxTokens = 1200 } = {}) {
  let res;
  try {
    res = await fetch(`${config.nimBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.nimApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(config.nimTimeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ApiError(504, 'NIM_TIMEOUT', 'The AI model did not respond in time. Try again.');
    }
    throw new ApiError(502, 'NIM_ERROR', `Could not reach the AI provider: ${err.message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw new ApiError(502, 'NIM_ERROR', 'AI provider rate limit reached. Wait a moment and try again.');
    if (res.status === 401 || res.status === 403) throw new ApiError(502, 'NIM_ERROR', 'AI provider rejected the API key. Check NIM_API_KEY in .env.');
    if (res.status === 404) throw new ApiError(502, 'NIM_ERROR', `AI model "${model}" is not available on this account.`);
    console.error(`[nim] chat ${res.status}:`, detail.slice(0, 300));
    throw new ApiError(502, 'NIM_ERROR', 'The AI provider returned an error. Try again later.');
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content;

  // The reasoning-style models occasionally return empty content once in a
  // while. Retry ONCE, then fail loudly — never invent an answer.
  if (!content || content.trim() === '') {
    const retry = await fetch(`${config.nimBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.nimApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(config.nimTimeoutMs),
    }).catch(() => null);
    content = retry?.ok ? (await retry.json())?.choices?.[0]?.message?.content : null;
  }

  if (!content || content.trim() === '') {
    throw new ApiError(502, 'NIM_ERROR', 'The AI model returned an empty response. Try again.');
  }
  return content.trim();
}
