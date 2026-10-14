// api.js — the ONLY file in the frontend allowed to call fetch().
//
// Every function here maps 1:1 to an endpoint in docs/API_CONTRACT.md and
// returns the documented response object. Failures are thrown as ApiError with
// the contract's stable `error.code`, so pages can react to codes instead of
// parsing text.
//
// Mock mode: enabled by `?mock=1` in the URL or `localStorage.socius_mock = '1'`.
// In mock mode nothing touches the network — responses come from
// js/mocks/fixtures.js, and the UI shows a "Demo data" badge.

import { authReady, accessToken, refreshAccessToken, redirectToLoginWithNotice } from './auth.js';

const MOCK_KEY = 'socius_mock';

/** True when the page is running on fixture data instead of the backend. */
export function isMockMode() {
  try {
    const url = new URL(window.location.href);
    const param = url.searchParams.get('mock');
    if (param === '1') { localStorage.setItem(MOCK_KEY, '1'); return true; }
    if (param === '0') { localStorage.removeItem(MOCK_KEY); return false; }
    return localStorage.getItem(MOCK_KEY) === '1';
  } catch {
    return localStorage.getItem(MOCK_KEY) === '1';
  }
}

export class ApiError extends Error {
  constructor(code, message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.data = data; // full response body, when there was one (e.g. QUIZ_ALREADY_ANSWERED)
  }
}

const HTTP_FALLBACKS = {
  400: 'The request was not valid.',
  404: 'Not found.',
  409: 'That was already submitted.',
  413: 'That file is too large.',
  422: 'The content could not be used.',
  500: 'Something went wrong on the server.',
  502: 'The AI service failed to respond.',
  503: 'A service is temporarily unavailable.',
  504: 'The AI service took too long to respond.',
};

/** One real HTTP round trip. Returns { response, data } (data is parsed JSON). */
async function httpRequest(path, { method, body, formData, signal }, token) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin', signal };
  if (formData) {
    // Browser sets the multipart boundary itself — never set Content-Type manually.
    init.body = formData;
  } else {
    init.headers['Content-Type'] = 'application/json';
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  // Private endpoints expect the Supabase access token (see the contract's
  // UNAUTHENTICATED entry). Prototype/mock mode never has a token to attach.
  if (token) init.headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError('NETWORK_ERROR', '', 0);
  }

  const text = await response.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { response, data };
}

async function request(path, { method = 'GET', body, formData, signal } = {}) {
  if (isMockMode()) {
    const { handleMock } = await import('./mocks/fixtures.js');
    try {
      return await handleMock(path, { method, body });
    } catch (error) {
      if (error && error.code) throw new ApiError(error.code, error.message, error.status || 400, error.data || null);
      throw error;
    }
  }

  // Wait for the one-time auth boot (config discovery + session restore).
  // Resolves instantly in prototype mode and never rejects.
  await authReady();

  let { response, data } = await httpRequest(path, { method, body, formData, signal }, accessToken());

  // Expired/invalid token: force one refresh and replay the request. If that
  // is not possible (no session), route the user to sign in again.
  if (!response.ok && response.status === 401 && data && data.error && data.error.code === 'UNAUTHENTICATED') {
    const token = await refreshAccessToken();
    if (token) {
      ({ response, data } = await httpRequest(path, { method, body, formData, signal }, token));
    } else {
      redirectToLoginWithNotice('Your session has expired — sign in again to continue.');
      throw new ApiError('UNAUTHENTICATED', 'Sign in required.', 401);
    }
  }

  if (!response.ok) {
    const envelope = data && data.error ? data.error : {};
    let code = envelope.code || 'INTERNAL';
    let message = envelope.message || HTTP_FALLBACKS[response.status] || 'Request failed.';

    // Vercel (and similar hosts) reject request bodies over their platform cap
    // (~4.5 MB) with a generic 413 before OUR middleware ever runs — the body
    // is plain text/HTML, never our JSON envelope. Say so plainly instead of
    // letting it fall through to the generic fallback message.
    if (response.status === 413 && !data) {
      code = 'FILE_TOO_LARGE';
      message = 'The server rejected this upload because it exceeds the maximum request size for this environment (~4 MB on the cloud demo — use a smaller file). The full-size demo runs on the laptop.';
    }

    throw new ApiError(code, message, response.status, data);
  }
  return data;
}

/** Only include sourceIds when the learner actually picked a filter. */
function withSources(payload, sourceIds) {
  if (Array.isArray(sourceIds) && sourceIds.length > 0) payload.sourceIds = sourceIds;
  return payload;
}

/** Optional sessionId is passed through untouched (server enforces the scope). */
function withSession(payload, sessionId) {
  if (sessionId) payload.sessionId = sessionId;
  return payload;
}

/** "/api/sessions?category=research&q=black" — empty params are omitted. */
function withQuery(path, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '' && value !== false) {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export const api = {
  // GET /api/health
  getHealth: () => request('/api/health'),

  // GET /api/sources  (?sessionId=unsorted | ses_… filters to one place)
  listSources: ({ sessionId } = {}) => request(withQuery('/api/sources', { sessionId })),

  // POST /api/sources/upload (multipart, one field: file)
  // Supabase-storage ingest path: 25 MB files without serverless body limits
  ingestFromStorage: (storagePath, { title, sizeBytes } = {}) =>
    request('/api/sources/storage-ingest', {
      method: 'POST',
      body: { storagePath, title, sizeBytes },
    }),

  uploadSource: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/api/sources/upload', { method: 'POST', formData: form });
  },

  // POST /api/sources/webpage
  addWebpage: ({ url, title, text }) =>
    request('/api/sources/webpage', { method: 'POST', body: { url, ...(title ? { title } : {}), text } }),

  // POST /api/tutor/ask — optional approach: one-off style override (v1.4)
  askTutor: ({ question, sourceIds, sessionId, approach }) => {
    const payload = withSession(withSources({ question }, sourceIds), sessionId);
    if (approach) payload.approach = approach;
    return request('/api/tutor/ask', { method: 'POST', body: payload });
  },

  // POST /api/flashcards/generate
  generateFlashcards: ({ topic, count, sourceIds, sessionId }) =>
    request('/api/flashcards/generate', {
      method: 'POST',
      body: withSession(withSources({ topic, count }, sourceIds), sessionId),
    }),

  // POST /api/quiz/generate
  generateQuiz: ({ topic, questionCount, difficulty, sourceIds, sessionId }) => {
    const payload = withSession(withSources({ topic, questionCount }, sourceIds), sessionId);
    if (difficulty) payload.difficulty = difficulty;
    return request('/api/quiz/generate', { method: 'POST', body: payload });
  },

  // POST /api/quiz/:quizId/answer
  answerQuiz: (quizId, answers) =>
    request(`/api/quiz/${encodeURIComponent(quizId)}/answer`, { method: 'POST', body: { answers } }),

  // GET /api/learner/progress
  getProgress: () => request('/api/learner/progress'),

  /* ------------------------------------------------------ study sessions */

  // GET /api/sessions?category=&q=&sort=recent|alpha|active&includeArchived=
  listSessions: ({ q, category, sort, includeArchived } = {}) =>
    request(withQuery('/api/sessions', { q, category, sort, includeArchived })),

  // POST /api/sessions
  createSession: ({ title, category, description, tags }) =>
    request('/api/sessions', {
      method: 'POST',
      body: {
        title,
        ...(category ? { category } : {}),
        ...(description ? { description } : {}),
        ...(Array.isArray(tags) && tags.length ? { tags } : {}),
      },
    }),

  // GET /api/sessions/:id → { session, sources, decks }
  getSession: (sessionId) =>
    request(`/api/sessions/${encodeURIComponent(sessionId)}`),

  // PATCH /api/sessions/:id — any subset of title/category/description/tags/status
  updateSession: (sessionId, patch) =>
    request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: patch }),

  /* ---------------------------------------------------- source organisation */

  // PATCH /api/sources/:id — { sessionId, title, tags } (manual move/edit)
  updateSource: (sourceId, patch) =>
    request(`/api/sources/${encodeURIComponent(sourceId)}`, { method: 'PATCH', body: patch }),

  // POST /api/sources/:id/suggest-organization → { sourceId, applicable, suggestion }
  suggestOrganization: (sourceId, { description } = {}) =>
    request(`/api/sources/${encodeURIComponent(sourceId)}/suggest-organization`, {
      method: 'POST',
      body: description ? { description } : {},
    }),

  // POST /api/sources/:id/accept-suggestion → { source, session }
  acceptSuggestion: (sourceId) =>
    request(`/api/sources/${encodeURIComponent(sourceId)}/accept-suggestion`, { method: 'POST', body: {} }),

  /* -------------------------------------------------------- flashcard decks */

  // GET /api/decks?sessionId=&category=&q=&sort=recent|alpha|active
  listDecks: ({ sessionId, category, q, sort } = {}) =>
    request(withQuery('/api/decks', { sessionId, category, q, sort })),

  // GET /api/decks/:deckId → { deck, cards }
  getDeck: (deckId) =>
    request(`/api/decks/${encodeURIComponent(deckId)}`),

  // PATCH /api/decks/:deckId/cards/:idx — { status: new|known|review }
  updateCardStatus: (deckId, idx, status) =>
    request(`/api/decks/${encodeURIComponent(deckId)}/cards/${idx}`, {
      method: 'PATCH',
      body: { status },
    }),

  // DELETE /api/decks/:deckId → 204
  deleteDeck: (deckId) =>
    request(`/api/decks/${encodeURIComponent(deckId)}`, { method: 'DELETE' }),

  /* ------------------------------------------------ learner profile (v1.4) */

  // GET /api/profile → { profile } (state "new" with empty arrays when unset)
  getProfile: () => request('/api/profile'),

  // POST /api/onboarding/message — { message: string (1–800) | null to start }
  // → { reply, state, questionsAsked, done }
  sendOnboardingMessage: (message) =>
    request('/api/onboarding/message', {
      method: 'POST',
      body: message === null ? { message: null } : { message },
    }),

  // POST /api/onboarding/skip exists in the API contract (used by tests and
  // available to clients), but the UI never calls it: the intro is mandatory.

  // PATCH /api/profile — any subset of { interests, goals, purpose,
  // preferences, subjects }; each provided key replaces that value wholesale
  updateProfile: (patch) =>
    request('/api/profile', { method: 'PATCH', body: patch }),

  // DELETE /api/profile → 204, no body. An empty body makes request() resolve
  // to null (text is '' → JSON.parse is skipped → data stays null) — that is
  // the success value here, not a failure.
  deleteProfile: () => request('/api/profile', { method: 'DELETE' }),
};
