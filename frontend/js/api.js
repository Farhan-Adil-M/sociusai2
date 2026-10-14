// api.js — the ONLY module in the frontend that calls fetch().
//
// Pages never call fetch themselves. They use the helpers below, which own the
// whole transport contract in docs/API_CONTRACT.md:
//
//   - JSON envelope: failures throw an ApiError carrying
//     { code, message, status, data } parsed from { error: { code, message } }.
//     `code` is the server's exact code (e.g. QUIZ_ALREADY_ANSWERED); `kind` is
//     that code normalised into the small set the UI themes on (VALIDATION_ERROR,
//     NOT_FOUND, CONFLICT, RATE_LIMITED, UPSTREAM_ERROR, UNAUTHENTICATED,
//     NETWORK_ERROR).
//   - Auth: `Authorization: Bearer <jwt>` on every private call. A 401 forces
//     ONE token refresh + ONE retry, then sends the visitor to the sign-in page.
//   - Timeouts and cancellation: every call accepts { timeoutMs, signal }.
//   - Streaming: apiStream() consumes POST /api/tutor/ask whether the server
//     answers with a normal JSON body or with an SSE stream.
//   - Mock mode (?mock=1 or localStorage.socius_mock = '1'): every call is
//     served from js/mocks/fixtures.js instead of the network, and the UI is
//     expected to label the page as demo data (MOCK_BADGE_TEXT).

import { authReady, accessToken, refreshAccessToken, redirectToLoginWithNotice } from './auth.js';

const MOCK_KEY = 'socius_mock';

/** Label the UI must show while fixture data is being served. */
export const MOCK_BADGE_TEXT = 'Demo data';

// Time to first byte (and to a complete body) per call shape. `timeoutMs: 0`
// turns the timeout off for a call that is allowed to take as long as it needs.
const DEFAULT_TIMEOUT_MS = 60_000; // one serverless invocation (see vercel.json)
const UPLOAD_TIMEOUT_MS = 180_000; // extract + chunk + embed a large document
const STREAM_TIMEOUT_MS = 120_000; // a whole streamed tutor answer
const HEALTH_TIMEOUT_MS = 8_000; // config discovery must not delay the first paint

/** Endpoints that are meant to be reachable signed-out: a 401 from one of these
 *  is its answer (wrong credentials), not an expired session to recover. */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/refresh']);

/** The stable code set the UI themes on (see ApiError.kind). */
export const ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
});

const HTTP_FALLBACKS = {
  400: 'The request was not valid.',
  401: 'Sign in to continue.',
  403: 'You do not have access to that.',
  404: 'Not found.',
  409: 'That was already submitted.',
  413: 'That file is too large.',
  422: 'The content could not be used.',
  429: 'Too many requests — wait a moment and try again.',
  500: 'Something went wrong on the server.',
  502: 'The AI service failed to respond.',
  503: 'A service is temporarily unavailable.',
  504: 'The AI service took too long to respond.',
};

const TIMEOUT_MESSAGE = 'The server took too long to answer. Check your connection and try again.';
const UNREACHABLE_MESSAGE = 'The Socius AI server could not be reached. Check your connection and try again.';

/* ------------------------------------------------------------- mock mode */

/**
 * True when the page is running on fixture data instead of the backend.
 * `?mock=1` turns it on (and remembers it), `?mock=0` turns it off.
 */
export function isMockMode() {
  let stored = false;
  try {
    stored = localStorage.getItem(MOCK_KEY) === '1';
  } catch {
    /* storage blocked — the URL parameter still works below */
  }
  try {
    const param = new URL(window.location.href).searchParams.get('mock');
    if (param === '1') {
      try {
        localStorage.setItem(MOCK_KEY, '1');
      } catch {
        /* storage blocked: this page is still a demo page */
      }
      return true;
    }
    if (param === '0') {
      try {
        localStorage.removeItem(MOCK_KEY);
      } catch {
        /* storage blocked */
      }
      return false;
    }
  } catch {
    /* no URL API — fall back to the stored flag */
  }
  return stored;
}

/** Serve a call from the fixtures, mapping fixture errors onto ApiError. */
async function mockRequest(path, { method = 'GET', body } = {}) {
  let handleMock;
  try {
    ({ handleMock } = await import('./mocks/fixtures.js'));
  } catch (error) {
    console.warn('[api] demo fixtures failed to load:', error?.message ?? error);
    throw new ApiError(
      'NOT_FOUND',
      'Demo data is unavailable: frontend/js/mocks/fixtures.js could not be loaded.',
      404,
      null,
    );
  }
  try {
    return await handleMock(path, { method, body });
  } catch (error) {
    if (error?.code) {
      throw new ApiError(
        error.code,
        error.message || 'Demo data could not answer that request.',
        error.status || 400,
        error.data ?? null,
      );
    }
    throw error;
  }
}

/* --------------------------------------------------------------- failures */

/**
 * Normalise an error code + HTTP status into the small set the UI themes on.
 * The exact server code is still available as ApiError.code.
 */
export function classifyError(code, status = 0) {
  const name = typeof code === 'string' ? code : '';
  if (name === 'NETWORK_ERROR' || status === 0) return 'NETWORK_ERROR';
  if (name === 'UNAUTHENTICATED' || status === 401) return 'UNAUTHENTICATED';
  if (name === 'RATE_LIMITED' || status === 429) return 'RATE_LIMITED';
  if (name === 'QUIZ_ALREADY_ANSWERED' || name === 'ONBOARDING_COMPLETE' || status === 409) return 'CONFLICT';
  if (name.endsWith('_NOT_FOUND') || status === 404) return 'NOT_FOUND';
  if (status >= 500 || name.startsWith('NIM_') || name === 'CHROMA_UNAVAILABLE' || name === 'STORAGE_FETCH_FAILED') {
    return 'UPSTREAM_ERROR';
  }
  if (status === 400 || status === 413 || status === 422) return 'VALIDATION_ERROR';
  return 'UNKNOWN'; // a code/status this client does not know yet
}

/** One failure shape for the whole frontend. */
export class ApiError extends Error {
  constructor(code, message, status = 0, data = null) {
    super(message || HTTP_FALLBACKS[status] || 'Request failed.');
    this.name = 'ApiError';
    this.code = code; // exact server code (or NETWORK_ERROR / INTERNAL)
    this.kind = classifyError(code, status); // one of ERROR_CODES
    this.status = status;
    this.data = data; // full parsed body when there was one (e.g. a 409's `result`)
  }
}

/** Turn a non-2xx response into the contract's error envelope. */
function toApiError(response, data) {
  const envelope = data && typeof data === 'object' && data.error ? data.error : null;

  // Vercel-style hosts reject bodies over their platform cap before our
  // middleware runs, so the reply is plain text, never our JSON envelope —
  // say so plainly instead of falling through to a generic message.
  if (response.status === 413 && !data) {
    return new ApiError(
      'FILE_TOO_LARGE',
      'The server rejected this upload because it exceeds the maximum request size for this environment '
        + '(~4 MB on the cloud demo — use a smaller file). The full-size demo runs on the laptop.',
      413,
      null,
    );
  }

  return new ApiError(
    envelope?.code || 'INTERNAL',
    envelope?.message || HTTP_FALLBACKS[response.status] || 'Request failed.',
    response.status,
    data,
  );
}

/* ------------------------------------------------------------ transport */

/**
 * Combine the caller's signal with an internal deadline, so one plan covers
 * "the user navigated away" and "the request hung".
 */
function abortPlan(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }

  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cancel() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forward);
    },
  };
}

/** Map a thrown fetch/body error onto either the caller's abort or ApiError. */
function toRequestError(error, plan) {
  if (plan.didTimeOut()) return new ApiError('NETWORK_ERROR', TIMEOUT_MESSAGE, 0, null);
  if (error?.name === 'AbortError') return error; // the caller cancelled on purpose
  return new ApiError('NETWORK_ERROR', UNREACHABLE_MESSAGE, 0, null);
}

/**
 * One HTTP round trip, body not read yet (apiStream needs the live Response).
 * The returned `plan` must be cancelled by the caller when the body is done.
 */
async function send(path, options = {}) {
  const {
    method = 'GET',
    body,
    formData,
    token,
    signal,
    timeoutMs,
    accept = 'application/json',
  } = options;

  const plan = abortPlan(signal, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const init = {
    method,
    headers: { Accept: accept },
    credentials: 'same-origin',
    signal: plan.signal,
  };

  if (formData) {
    // The browser sets the multipart boundary itself — never set Content-Type.
    init.body = formData;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (token) init.headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(path, init);
    return { response, plan };
  } catch (error) {
    plan.cancel();
    throw toRequestError(error, plan);
  }
}

/** Send and fully read the body (text → JSON). Returns { response, data }. */
async function exchange(path, options) {
  const { response, plan } = await send(path, options);
  try {
    const text = await response.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null; // not our JSON envelope (proxy error page, empty 204, …)
      }
    }
    return { response, data };
  } catch (error) {
    throw toRequestError(error, plan);
  } finally {
    plan.cancel();
  }
}

/** Read a response body as JSON without throwing on a non-JSON body. */
async function readJson(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The path without its query string (used for the public-endpoint check). */
function pathOnly(path) {
  return String(path).split('?')[0];
}

/**
 * The one request pipeline. `options`:
 *   { signal, timeoutMs, anonymous }
 * `anonymous: true` skips the auth boot and sends no token — used only by
 * auth.js to read /api/health before auth exists (calling it from there would
 * otherwise recurse: this module waits for authReady()).
 */
async function request(path, options = {}) {
  if (isMockMode()) return mockRequest(path, options);

  if (options.anonymous) {
    const { response, data } = await exchange(path, options);
    if (!response.ok) throw toApiError(response, data);
    return data;
  }

  // Config discovery + session restore happen once per page load; this resolves
  // immediately in prototype mode and never rejects.
  await authReady();

  let { response, data } = await exchange(path, { ...options, token: accessToken() });

  // Expired/invalid token: refresh once and replay the request once. If that is
  // not possible, route the visitor back to sign in.
  if (response.status === 401 && !PUBLIC_PATHS.has(pathOnly(path))) {
    const token = await refreshAccessToken();
    if (token) ({ response, data } = await exchange(path, { ...options, token }));
    if (response.status === 401) {
      redirectToLoginWithNotice('Your session has expired — sign in again to continue.');
      throw new ApiError('UNAUTHENTICATED', 'Sign in required.', 401, data);
    }
  }

  if (!response.ok) throw toApiError(response, data);
  return data;
}

/* --------------------------------------------------------- public surface */

/** GET a contract path, e.g. apiGet('/api/sources') → { sources, … }. */
export function apiGet(path, options = {}) {
  return request(path, { ...options, method: 'GET' });
}

/** POST JSON, e.g. apiPost('/api/sessions', { title }). */
export function apiPost(path, body, options = {}) {
  return request(path, { ...options, method: 'POST', body });
}

/** PATCH JSON (partial update), e.g. apiPatch('/api/sessions/ses_1', { title }). */
export function apiPatch(path, body, options = {}) {
  return request(path, { ...options, method: 'PATCH', body });
}

/** DELETE (with an optional body, which the contract never needs but allows). */
export function apiDelete(path, body, options = {}) {
  return request(path, { ...options, method: 'DELETE', body });
}

/** multipart/form-data POST, e.g. apiUpload('/api/sources/upload', form). */
export function apiUpload(path, formData, options = {}) {
  if (typeof FormData === 'undefined' || !(formData instanceof FormData)) {
    return Promise.reject(
      new ApiError('VALIDATION_ERROR', 'apiUpload expects a FormData object.', 400, null),
    );
  }
  return request(path, {
    ...options,
    method: 'POST',
    formData,
    timeoutMs: options.timeoutMs ?? UPLOAD_TIMEOUT_MS,
  });
}

/**
 * GET used ONLY by auth.js while it boots (config discovery). It deliberately
 * sends no Authorization header and never touches the auth pipeline.
 */
export function anonymousGet(path, options = {}) {
  return request(path, {
    ...options,
    method: 'GET',
    anonymous: true,
    timeoutMs: options.timeoutMs ?? HEALTH_TIMEOUT_MS,
  });
}

/* ------------------------------------------------------------- streaming */

/** The text a streamed JSON chunk contributes, or '' for a final response object. */
function deltaTextOf(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.delta,
    payload.token,
    payload.text,
    payload.content,
    payload.choices?.[0]?.delta?.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

/**
 * Consume an SSE body, calling onDelta(text) for every chunk.
 * Returns the server's final JSON object when it sent one, else the
 * concatenated text as { answer, citations: [] }.
 */
async function readEventStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aggregate = '';
  let emitted = false;
  let final = null;

  const emit = (text) => {
    if (!text) return;
    onDelta(text);
    aggregate += text;
    emitted = true;
  };

  const handleLine = (line) => {
    const text = line.trim();
    if (!text || text.startsWith(':')) return; // comment/keep-alive
    if (!text.startsWith('data:')) return; // event:/id:/retry: carry no answer text
    const payload = text.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let parsed = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = null;
    }

    if (parsed === null) {
      // A plain-text SSE endpoint: `data: some words`.
      emit(payload);
      return;
    }

    emit(deltaTextOf(parsed));

    // The last event that looks like the complete contract object wins; when a
    // server sends only that object (no deltas), it still reaches the UI.
    if (typeof parsed.answer === 'string' || Array.isArray(parsed.citations)) {
      final = parsed;
      if (!emitted) emit(parsed.answer);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } finally {
    reader.releaseLock?.();
  }

  return final ?? { answer: aggregate, citations: [] };
}

/**
 * Ask the tutor with streaming enabled: `onDelta(text)` is called as text
 * arrives and the promise resolves with the final response object (the same
 * shape POST /api/tutor/ask documents). It works unchanged against a server
 * that answers with one plain JSON body, so pages do not need to care which
 * transport the deployment uses.
 */
export async function apiStream(path, body, onDelta, options = {}) {
  if (typeof onDelta !== 'function') {
    throw new ApiError('VALIDATION_ERROR', 'apiStream needs an onDelta(text) callback.', 400, null);
  }

  if (isMockMode()) {
    const data = await mockRequest(path, { method: 'POST', body });
    if (typeof data?.answer === 'string' && data.answer) onDelta(data.answer);
    return data;
  }

  await authReady();
  const sendOptions = {
    method: 'POST',
    body,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? STREAM_TIMEOUT_MS,
    accept: 'text/event-stream, application/json',
  };

  let attempt = await send(path, { ...sendOptions, token: accessToken() });
  if (attempt.response.status === 401 && !PUBLIC_PATHS.has(pathOnly(path))) {
    const token = await refreshAccessToken();
    if (token) {
      attempt.plan.cancel();
      attempt = await send(path, { ...sendOptions, token });
    }
    if (attempt.response.status === 401) {
      attempt.plan.cancel();
      redirectToLoginWithNotice('Your session has expired — sign in again to continue.');
      throw new ApiError('UNAUTHENTICATED', 'Sign in required.', 401, null);
    }
  }

  const { response, plan } = attempt;
  try {
    if (!response.ok) throw toApiError(response, await readJson(response));

    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('text/event-stream') || !response.body) {
      // This deployment does not stream: deliver the documented JSON answer.
      const data = await readJson(response);
      if (!data) throw new ApiError('UPSTREAM_ERROR', 'The server sent an empty answer.', response.status, null);
      if (typeof data.answer === 'string' && data.answer) onDelta(data.answer);
      return data;
    }

    return await readEventStream(response.body, onDelta);
  } catch (error) {
    // A real API failure keeps its envelope; anything else is transport.
    if (error instanceof ApiError) throw error;
    throw toRequestError(error, plan);
  } finally {
    plan.cancel();
  }
}
