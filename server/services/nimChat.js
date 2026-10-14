// NVIDIA NIM chat client — now a thin adapter over server/services/aiRouter.js.
//
// Every existing caller (quizService, tutorService, organizer,
// flashcardService, onboarding, …) imports `chatCompletion` from here and keeps
// working unchanged: it gains task routing, timeout, retry-with-backoff and
// cross-model fallback for free, because the real work happens in the router.
//
// Dependency direction:  nimChat.js → aiRouter.js. That module never imports
// this one (no cycle), and it owns the actual NIM HTTP call so there is exactly
// one transport in the app.
//
// BACKEND ONLY. The browser never talks to NVIDIA NIM; this module is imported
// by server code and an injected `ai.chatCompletion` seam only (see app.js).
// Model ids come from config, never from here.

import { complete } from './aiRouter.js';

/**
 * Ask a NIM chat model for a completion.
 *
 * @param {Array} messages OpenAI-style [{ role, content }].
 * @param {object} [options]
 *   - `task`        routing task (default 'tutor'); see aiRouter.TASKS.
 *   - `model`       explicit model override — skips task routing, keeps the
 *                   caller's own choice (existing services pass one).
 *   - `temperature`, `maxTokens` generation controls; the router owns their
 *                   defaults, so omitting them here changes nothing.
 * @returns {Promise<string>} the trimmed answer.
 * @throws {ApiError} `NIM_TIMEOUT` (504) or `NIM_ERROR` (502) — the same codes
 *   and user-facing messages this module has always produced.
 */
export async function chatCompletion(messages, { task = 'tutor', model, temperature, maxTokens } = {}) {
  return complete(task, messages, { model, temperature, maxTokens });
}
