// aiRouter tests — the module every model call in the app flows through.
//
// Offline by construction: `global.fetch` is replaced for the duration of each
// test with a scripted stub, so nothing ever reaches NVIDIA NIM. The stub records
// the URL, method, headers and parsed body of every attempt, which is what lets
// these tests assert the request shape, the model chain and the retry/fallback
// decisions without a provider.
//
// Covered:
//  - the HTTP-status → (status, code, message) mapping for BOTH endpoints;
//  - the retry/fallback predicate: transient (5xx, 408) retries, malformed
//    (400/413/422) fails fast, and embeddings NEVER swap model;
//  - network failure, timeout/abort, unreadable and unusable response bodies;
//  - the request body and Authorization header actually sent;
//  - TASKS, resolveModel, getStats, and the structured log's no-secrets rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, embed, TASKS, getStats, resolveModel } from '../server/services/aiRouter.js';
import { ApiError } from '../server/middleware/errors.js';
import { config } from '../server/config.js';

// A model id that is guaranteed never to be configured, so a test can pin the
// PRIMARY model of the chain and still observe the router's own fallback pick.
const PRIMARY = 'test/primary-model';
const EMBED_MODEL = config.aiRouter.embedModel;

// The chat fallback is the first configured chat model that is not the primary
// (the source's own `chatModels()` order: tutor first, then assess).
const CHAT_FALLBACK = [config.aiRouter.tutorModel, config.aiRouter.assessModel]
  .find((m) => m && m.trim() !== '' && m !== PRIMARY);

const MESSAGES = [
  { role: 'system', content: 'You are a patient tutor.' },
  { role: 'user', content: 'What is mitosis?' },
];

/** One attempt per model, no backoff sleep (the source treats backoffMs ≤ 0 as
 *  "no sleep"), so every test finishes instantly and stays deterministic. */
const FAST = { attempts: 1, backoffMs: 0 };

const UNREADABLE_MARKER = 'PROVIDER-ECHO-MARKER-9c1f';
const MESSAGE_MARKER = 'STUDENT-TEXT-MARKER-7b2e';
const SECRET_KEY = 'unit-test-key-not-a-real-secret';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const chatOk = (content = 'A short answer.') => jsonResponse({ choices: [{ message: { content } }] });
const embedOk = (vectors = [[0.1], [0.2]]) => jsonResponse({ data: vectors.map((embedding, index) => ({ index, embedding })) });

/** A network-level failure (fetch itself rejected). */
function networkError(message = 'fetch failed') {
  return Object.assign(new TypeError(message), { name: 'TypeError' });
}

/** A fetch rejection that Node reports as a timeout/abort. */
function timeoutError(name = 'TimeoutError') {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name });
}

/**
 * Run one router call against an offline fetch stub. `script` is a Response or
 * `(call, callNumber) => Response | Error`; a returned/thrown Error simulates a
 * network-level failure. The router's console output is captured (kept out of
 * the test output, and inspectable through `lines`).
 *
 * A plain (non-function) Response is CLONED for every attempt: a response body
 * can only be read once, so a retry must never be handed an exhausted body.
 */
async function runNim(script, fn) {
  const realFetch = global.fetch;
  const realLog = { log: console.log, warn: console.warn, error: console.error };
  const calls = [];
  const lines = [];

  global.fetch = async (url, init) => {
    const call = {
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const reply = typeof script === 'function' ? script(call, calls.length) : script;
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply.clone() : reply;
  };

  const quiet = (...args) => lines.push(args.map((part) => (typeof part === 'string' ? part : String(part))).join(' '));
  console.log = quiet;
  console.warn = quiet;
  console.error = quiet;

  try {
    const outcome = { value: undefined, error: null };
    try {
      outcome.value = await fn();
    } catch (err) {
      outcome.error = err;
    }
    return { ...outcome, calls, models: () => calls.map((c) => c.body?.model), lines };
  } finally {
    global.fetch = realFetch;
    console.log = realLog.log;
    console.warn = realLog.warn;
    console.error = realLog.error;
  }
}

/** The router's thrown failure: an ApiError with the exact status/code/message
 *  the HTTP error envelope will show, so routes keep one error shape. */
function assertApiError(err, status, code, message) {
  assert.ok(err instanceof ApiError, `expected an ApiError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.status, status, `status for ${code}`);
  assert.equal(err.code, code, `code for status ${status}`);
  assert.equal(err.message, message, `message for ${code}`);
}

/** The routing metadata the retry/fallback core reads off the error. */
function assertRouting(err, { retry, fallback }) {
  assert.equal(err.aiRetry, retry, `aiRetry for ${err.code} (${err.aiStatus})`);
  assert.equal(err.aiFallback, fallback, `aiFallback for ${err.code} (${err.aiStatus})`);
}

/* ------------------------------------------------------------------ */
/* 1. HTTP status mapping — chat endpoint                              */
/* ------------------------------------------------------------------ */

// status → [message, aiRetry, aiFallback]. The message is what the student sees,
// so it is asserted verbatim; `{model}` is replaced with the model that produced
// the FINAL error (the last one tried), which matters only for 404 — the one
// model-specific message.
//
// The predicate: 400/413/422 are "malformed" (every model would reject them), so
// they neither retry nor fall back; 5xx and 408 are transient (retry + fallback);
// 404 is model-specific, so it is not retried but IS offered to the other chat
// model; 401/403 mean a bad key, which no other model can fix either.
const CHAT_STATUS_TABLE = [
  [400, 'The AI provider returned an error. Try again later.', false, false],
  [401, 'AI provider rejected the API key. Check NIM_API_KEY in .env.', false, false],
  [403, 'AI provider rejected the API key. Check NIM_API_KEY in .env.', false, false],
  [404, 'AI model "{model}" is not available on this account.', false, true],
  [408, 'The AI provider returned an error. Try again later.', true, true],
  [409, 'The AI provider returned an error. Try again later.', false, true],
  [413, 'The AI provider returned an error. Try again later.', false, false],
  [422, 'The AI provider returned an error. Try again later.', false, false],
  [429, 'AI provider rate limit reached. Wait a moment and try again.', true, true],
  [500, 'The AI provider returned an error. Try again later.', true, true],
  [502, 'The AI provider returned an error. Try again later.', true, true],
  [503, 'The AI provider returned an error. Try again later.', true, true],
  [504, 'The AI provider returned an error. Try again later.', true, true],
];

test('chat endpoint: every mapped HTTP status → status, code, message, routing flags and model chain', async (t) => {
  for (const [status, template, retry, fallback] of CHAT_STATUS_TABLE) {
    // sequential: the chain order must not interleave
    await t.test(`HTTP ${status}`, async () => {
      // The provider body carries a marker: the router must never read or log it.
      const { error, calls, models, lines } = await runNim(
        () => jsonResponse({ error: `upstream detail ${UNREADABLE_MARKER}` }, status),
        () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }),
      );
      assertApiError(error, 502, 'NIM_ERROR', template.replace('{model}', models().at(-1)));
      assert.equal(error.aiStatus, status, 'the upstream status is kept for logging');
      assertRouting(error, { retry, fallback });
      assert.deepEqual(models(), fallback ? [PRIMARY, CHAT_FALLBACK] : [PRIMARY],
        'a fallback-eligible failure is offered to the other chat model');
      assert.equal(calls.length, fallback ? 2 : 1, 'one attempt per model with attempts: 1');
      assert.ok(!lines.some((line) => line.includes(UNREADABLE_MARKER)), 'the provider body is never logged');
    });
  }
});

/* ------------------------------------------------------------------ */
/* 2. HTTP status mapping — embedding endpoint (never falls back)      */
/* ------------------------------------------------------------------ */

// The embedding wording, and aiFallback is false for EVERY status: swapping the
// embedding model would change the vector size and corrupt the index.
const EMBED_STATUS_TABLE = [
  [400, 'The embedding service returned an error. Try again later.', false],
  [401, 'Embedding service rejected the API key. Check NIM_API_KEY in .env.', false],
  [403, 'Embedding service rejected the API key. Check NIM_API_KEY in .env.', false],
  [404, `Embedding model "{model}" is not available on this account.`, false],
  [408, 'The embedding service returned an error. Try again later.', true],
  [409, 'The embedding service returned an error. Try again later.', false],
  [413, 'The embedding service returned an error. Try again later.', false],
  [422, 'The embedding service returned an error. Try again later.', false],
  [429, 'Embedding service rate limit reached. Try again shortly.', true],
  [500, 'The embedding service returned an error. Try again later.', true],
  [502, 'The embedding service returned an error. Try again later.', true],
  [503, 'The embedding service returned an error. Try again later.', true],
  [504, 'The embedding service returned an error. Try again later.', true],
];

test('embed endpoint: every mapped HTTP status → status, code, message, and never a fallback', async (t) => {
  for (const [status, message, retry] of EMBED_STATUS_TABLE) {
    // sequential, one stub at a time
    await t.test(`HTTP ${status}`, async () => {
      const { error, calls, models } = await runNim(
        () => jsonResponse({ error: 'upstream detail' }, status),
        () => embed(['alpha', 'beta'], FAST),
      );
      assertApiError(error, 502, 'NIM_ERROR', message.replace('{model}', EMBED_MODEL));
      assert.equal(error.aiStatus, status, 'the upstream status is kept for logging');
      assert.equal(error.aiFallback, false, 'the embedding model is never swapped for another one');
      assert.equal(error.aiRetry, retry, 'retryability is unchanged by the no-fallback rule');
      assert.deepEqual(models(), [EMBED_MODEL], 'the embedding chain has exactly one model');
      assert.equal(calls.length, 1, 'one attempt per model with attempts: 1');
    });
  }
});

test('a malformed request (400/413/422) fails fast — no retry, no fallback, on both endpoints', async () => {
  for (const status of [400, 413, 422]) {
    // sequential: a shared stub would interleave
    const chat = await runNim(jsonResponse({ error: 'bad request' }, status),
      () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }));
    assert.equal(chat.error.aiRetry, false, `chat ${status} must not retry`);
    assert.equal(chat.error.aiFallback, false, `chat ${status} must not fall back`);
    assert.equal(chat.calls.length, 1, `chat ${status} costs one call`);

    const embeds = await runNim(jsonResponse({ error: 'bad request' }, status),
      () => embed(['alpha'], FAST));
    assert.equal(embeds.error.aiRetry, false, `embed ${status} must not retry`);
    assert.equal(embeds.error.aiFallback, false, `embed ${status} must not fall back`);
    assert.equal(embeds.calls.length, 1, `embed ${status} costs one call`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. transient failures retry, then fall back                         */
/* ------------------------------------------------------------------ */

test('a transient 5xx retries the SAME model first, then hands the call to the other chat model', async () => {
  const before = getStats();
  const { error, calls, models } = await runNim(
    () => jsonResponse({ error: 'overloaded' }, 503),
    () => complete('tutor', MESSAGES, { model: PRIMARY, backoffMs: 0 }), // default attempts = 2
  );
  assertApiError(error, 502, 'NIM_ERROR', 'The AI provider returned an error. Try again later.');
  assertRouting(error, { retry: true, fallback: true });
  assert.deepEqual(models(), [PRIMARY, PRIMARY, CHAT_FALLBACK, CHAT_FALLBACK],
    'two attempts on the primary, then two on the fallback model');
  assert.equal(calls.length, 4);

  const after = getStats();
  assert.equal(after.retries - before.retries, 2, 'each second attempt counts as a retry');
  assert.equal(after.fallbacks - before.fallbacks, 1, 'one model switch');
  assert.equal(after.failures - before.failures, 1, 'one failed call overall');
});

test('a transient embedding failure retries the SAME model and never swaps models', async () => {
  const before = getStats();
  const { error, models } = await runNim(
    () => jsonResponse({ error: 'overloaded' }, 503),
    () => embed(['alpha', 'beta'], { backoffMs: 0 }), // default attempts = 2
  );
  assertApiError(error, 502, 'NIM_ERROR', 'The embedding service returned an error. Try again later.');
  assert.equal(error.aiFallback, false);
  assert.deepEqual(models(), [EMBED_MODEL, EMBED_MODEL], 'both attempts stay on the embedding model');

  const after = getStats();
  assert.equal(after.retries - before.retries, 1);
  assert.equal(after.fallbacks - before.fallbacks, 0, 'no embedding fallback ever');
});

test('a fallback that succeeds is recorded as a success on the second model', async () => {
  const before = getStats();
  const { value, error, models } = await runNim(
    (call, n) => (n === 1 ? jsonResponse({ error: 'unavailable' }, 500) : chatOk('The fallback answer.')),
    () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }),
  );
  assert.equal(error, null, 'the call as a whole succeeded');
  assert.equal(value, 'The fallback answer.');
  assert.deepEqual(models(), [PRIMARY, CHAT_FALLBACK]);

  const after = getStats();
  assert.equal(after.successes - before.successes, 1);
  assert.equal(after.failures - before.failures, 0);
  assert.equal(after.fallbacks - before.fallbacks, 1);
  assert.equal(after.byModel[CHAT_FALLBACK] - (before.byModel[CHAT_FALLBACK] ?? 0), 1);
  assert.equal(after.byModel[PRIMARY] ?? 0, before.byModel[PRIMARY] ?? 0, 'a model that never succeeded is not counted');
});

test('a chat fallback is a configured chat model — never the embedding model', async () => {
  assert.ok(CHAT_FALLBACK, 'a fallback chat model is configured (config.aiRouter)');
  const { models } = await runNim(jsonResponse({ error: 'overloaded' }, 503),
    () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }));
  assert.deepEqual(models(), [PRIMARY, CHAT_FALLBACK]);
  assert.ok(!EMBED_MODEL || !models().includes(EMBED_MODEL), 'the embedding model must never serve a chat fallback');
});

test('the last model\'s error is the one surfaced when the whole chain fails', async () => {
  const { error, models } = await runNim(
    () => jsonResponse({ error: 'nope' }, 502),
    () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }),
  );
  assert.equal(models().at(-1), CHAT_FALLBACK);
  assertApiError(error, 502, 'NIM_ERROR', 'The AI provider returned an error. Try again later.');
});

test('an unexpected (non-provider) error is not retried on the same model but is offered to the other one', async () => {
  // A response object whose `ok` accessor throws stands in for a runtime bug:
  // classify() sees no aiRetry/aiFallback metadata, so it must not spend another
  // paid call on the same model, but lets the other model try once.
  const hostile = { get ok() { throw new Error('runtime blew up'); } };
  const before = getStats();
  const { error, models } = await runNim(hostile, () => complete('tutor', MESSAGES, { model: PRIMARY, backoffMs: 0 }));
  assert.ok(!(error instanceof ApiError), 'the raw error is not remapped');
  assert.equal(error.message, 'runtime blew up');
  assert.deepEqual(models(), [PRIMARY, CHAT_FALLBACK], 'no retry on the same model, one try on the next');

  const after = getStats();
  assert.equal(after.fallbacks - before.fallbacks, 1, 'the other model was tried once');
  assert.equal(after.failures - before.failures, 1, 'one failed call overall');
  assert.equal(after.retries - before.retries, 0, 'a bug is never retried on the same model');
});

/* ------------------------------------------------------------------ */
/* 4. network, timeout, unreadable and empty bodies                    */
/* ------------------------------------------------------------------ */

test('a network failure maps to NIM_ERROR 502 and is retryable', async () => {
  const chat = await runNim(networkError('fetch failed'),
    () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }));
  assertApiError(chat.error, 502, 'NIM_ERROR', 'Could not reach the AI provider: fetch failed');
  assertRouting(chat.error, { retry: true, fallback: true });
  assert.equal(chat.calls.length, 2, 'the other model is tried');

  const embeds = await runNim(networkError('ECONNREFUSED'), () => embed(['alpha'], FAST));
  assertApiError(embeds.error, 502, 'NIM_ERROR', 'Could not reach the embedding service. Check the server connection and try again.');
  assertRouting(embeds.error, { retry: true, fallback: false });
  assert.equal(embeds.calls.length, 1, 'no fallback for embeddings');
});

test('a timeout or abort maps to NIM_TIMEOUT 504 on both endpoints', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    // sequential: one stub at a time
    const chat = await runNim(timeoutError(name), () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }));
    assertApiError(chat.error, 504, 'NIM_TIMEOUT', 'The AI model did not respond in time. Try again.');
    assertRouting(chat.error, { retry: true, fallback: true });

    // sequential: one stub at a time
    const embeds = await runNim(timeoutError(name), () => embed(['alpha'], FAST));
    assertApiError(embeds.error, 504, 'NIM_TIMEOUT', 'The embedding service did not respond in time. Try again.');
    assertRouting(embeds.error, { retry: true, fallback: false });
  }
});

test('a non-JSON response body maps to NIM_ERROR 502 on both endpoints', async () => {
  // A function script: a Response body can only be read ONCE, so every attempt
  // must get a fresh one (this case falls back, so it makes two attempts).
  const chat = await runNim(() => new Response('<html>gateway error</html>', { status: 200 }),
    () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }));
  assertApiError(chat.error, 502, 'NIM_ERROR', 'The AI provider returned an unreadable response. Try again.');
  assertRouting(chat.error, { retry: true, fallback: true });

  const embeds = await runNim(() => new Response('not json at all', { status: 200 }), () => embed(['alpha'], FAST));
  assertApiError(embeds.error, 502, 'NIM_ERROR', 'The embedding service returned an unreadable response. Try again later.');
  assertRouting(embeds.error, { retry: true, fallback: false });
});

test('empty or non-string chat content is rejected instead of returning an empty answer', async () => {
  const cases = [
    ['empty string', { choices: [{ message: { content: '' } }] }],
    ['whitespace only', { choices: [{ message: { content: '   \n  ' } }] }],
    ['null content', { choices: [{ message: { content: null } }] }],
    ['missing message key', { choices: [{ finish_reason: 'length' }] }],
    ['no choices at all', { foo: 'bar' }],
    ['content is not a string', { choices: [{ message: { content: 42 } }] }],
  ];
  for (const [label, payload] of cases) {
    // sequential: one stub at a time
    const run = await runNim(() => jsonResponse(payload), () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }));
    assertApiError(run.error, 502, 'NIM_ERROR', 'The AI model returned an empty response. Try again.');
    assertRouting(run.error, { retry: true, fallback: true });
    assert.equal(run.calls.length, 2, `${label}: the other model may still answer`);
  }
});

test('a successful answer is trimmed, and the messages are forwarded verbatim', async () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: MESSAGE_MARKER, name: 'student' }];
  const run = await runNim(chatOk('   the trimmed answer   '), () => complete('tutor', messages, FAST));
  assert.equal(run.error, null);
  assert.equal(run.value, 'the trimmed answer');
  assert.deepEqual(run.calls[0].body.messages, messages, 'the message array is sent unchanged');
});

/* ------------------------------------------------------------------ */
/* 5. embedding response-shape rejections                              */
/* ------------------------------------------------------------------ */

test('embed: too few/many vectors is rejected with the exact counts', async () => {
  const run = await runNim(
    jsonResponse({ data: [{ index: 0, embedding: [0.1] }] }),
    () => embed(['alpha', 'beta'], FAST),
  );
  assertApiError(run.error, 502, 'NIM_ERROR', 'The embedding service returned 1 vectors for 2 texts.');
  assertRouting(run.error, { retry: true, fallback: false });
});

test('embed: a missing data array counts as zero vectors', async () => {
  const run = await runNim(jsonResponse({}), () => embed(['alpha', 'beta', 'gamma'], FAST));
  assertApiError(run.error, 502, 'NIM_ERROR', 'The embedding service returned 0 vectors for 3 texts.');
});

test('embed: an out-of-range or non-integer index is rejected as unusable order', async () => {
  const badIndexes = [5, -1, 1.5, '1', null];
  for (const index of badIndexes) {
    // sequential: one stub at a time
    const run = await runNim(
      jsonResponse({ data: [{ index, embedding: [0.1] }, { index: 1, embedding: [0.2] }] }),
      () => embed(['alpha', 'beta'], FAST),
    );
    assertApiError(run.error, 502, 'NIM_ERROR', 'The embedding service returned vectors in an unusable order.');
    assertRouting(run.error, { retry: true, fallback: false });
  }
});

test('embed: a missing or empty vector is rejected', async () => {
  const cases = [
    ['missing embedding', { data: [{ index: 0 }, { index: 1, embedding: [0.2] }] }],
    ['empty array', { data: [{ index: 0, embedding: [] }, { index: 1, embedding: [0.2] }] }],
    ['not an array', { data: [{ index: 0, embedding: '0.1' }, { index: 1, embedding: [0.2] }] }],
    ['not an object', { data: [{ index: 0, embedding: {} }, { index: 1, embedding: [0.2] }] }],
  ];
  for (const [label, payload] of cases) {
    // sequential: one stub at a time
    const run = await runNim(jsonResponse(payload), () => embed(['alpha', 'beta'], FAST));
    assertApiError(run.error, 502, 'NIM_ERROR', 'The embedding service returned an unusable vector.');
    assertRouting(run.error, { retry: true, fallback: false });
    assert.equal(run.calls.length, 1, `${label}: attempts: 1 means one call`);
  }
});

test('embed: vectors are placed by their own index, not by response order', async () => {
  const run = await runNim(
    jsonResponse({ data: [{ index: 2, embedding: [0.3] }, { index: 0, embedding: [0.1] }, { index: 1, embedding: [0.2] }] }),
    () => embed(['alpha', 'beta', 'gamma'], FAST),
  );
  assert.equal(run.error, null);
  assert.deepEqual(run.value, [[0.1], [0.2], [0.3]], 'one vector per text, in input order');
});

test('embed: an unusable shape is retried on the same model, never swapped', async () => {
  const before = getStats();
  const run = await runNim(() => jsonResponse({ data: [] }), () => embed(['alpha', 'beta'], { backoffMs: 0 }));
  assertApiError(run.error, 502, 'NIM_ERROR', 'The embedding service returned 0 vectors for 2 texts.');
  assert.deepEqual(run.models(), [EMBED_MODEL, EMBED_MODEL]);
  const after = getStats();
  assert.equal(after.retries - before.retries, 1);
  assert.equal(after.fallbacks - before.fallbacks, 0);
});

test('embed: an empty (or non-array) input makes no provider call at all', async () => {
  for (const input of [[], undefined, null, 'text']) {
    // sequential: one stub at a time
    const run = await runNim(embedOk(), () => embed(input, FAST));
    assert.deepEqual(run.value, [], `input ${JSON.stringify(input)} → []`);
    assert.equal(run.calls.length, 0, 'no provider call for an empty batch');
  }
});

test('embed: the request body carries the model and the input texts only', async () => {
  const run = await runNim(embedOk(), () => embed(['alpha', 'beta'], { model: 'pinned/embed-model' }));
  assert.equal(run.error, null);
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.calls[0].body, { model: 'pinned/embed-model', input: ['alpha', 'beta'] });
});

/* ------------------------------------------------------------------ */
/* 6. the request that is actually sent                                */
/* ------------------------------------------------------------------ */

test('chat: the request sends the OpenAI-compatible body, both headers and nothing else', async () => {
  const run = await runNim(chatOk(), () => complete('tutor', MESSAGES, FAST));
  assert.equal(run.error, null);
  assert.equal(run.calls.length, 1);

  const call = run.calls[0];
  assert.equal(call.url, `${config.nimBaseUrl}/chat/completions`);
  assert.equal(call.method, 'POST');
  assert.deepEqual(Object.keys(call.headers).sort(), ['Authorization', 'Content-Type']);
  assert.equal(call.headers.Authorization, `Bearer ${config.nimApiKey}`);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, {
    model: config.aiRouter.tutorModel,
    messages: MESSAGES,
    temperature: 0.2, // DEFAULT_TEMPERATURE
    max_tokens: 1200, // DEFAULT_MAX_TOKENS
  });
});

test('chat: explicit options reach the body; only an explicit model skips routing', async () => {
  const run = await runNim(chatOk(), () => complete('assess', MESSAGES, {
    temperature: 0.9,
    maxTokens: 42,
    timeoutMs: 5,
    attempts: 1,
    backoffMs: 0,
  }));
  assert.deepEqual(run.calls[0].body, {
    model: config.aiRouter.assessModel, // the assess task's own model
    messages: MESSAGES,
    temperature: 0.9,
    max_tokens: 42,
  });

  const pinned = await runNim(chatOk(), () => complete('assess', MESSAGES, { model: 'pinned/chat-model', ...FAST }));
  assert.equal(pinned.calls[0].body.model, 'pinned/chat-model', 'an explicit model is kept, not re-routed');
  assert.equal(pinned.calls.length, 1);
});

/* ------------------------------------------------------------------ */
/* 7. argument validation (no provider call)                           */
/* ------------------------------------------------------------------ */

test('complete() rejects unknown, non-chat and malformed arguments before any call', async () => {
  const cases = [
    ['unknown task', () => complete('nope', MESSAGES, FAST), 500, 'AI_TASK_UNKNOWN', 'Unknown AI task "nope".'],
    ['embed task through complete()', () => complete('embed', MESSAGES, FAST), 500, 'AI_TASK_NOT_CHAT', 'AI task "embed" is not a chat task; call embed() for embeddings.'],
    ['missing messages', () => complete('tutor', undefined, FAST), 500, 'AI_BAD_REQUEST', 'complete() needs a non-empty messages array.'],
    ['empty messages', () => complete('tutor', [], FAST), 500, 'AI_BAD_REQUEST', 'complete() needs a non-empty messages array.'],
    ['non-array messages', () => complete('tutor', 'hello', FAST), 500, 'AI_BAD_REQUEST', 'complete() needs a non-empty messages array.'],
  ];
  for (const [label, fn, status, code, message] of cases) {
    // sequential, no provider involved
    const run = await runNim(chatOk(), fn);
    assertApiError(run.error, status, code, message);
    assert.equal(run.calls.length, 0, `${label}: rejected before any provider call`);
  }
});

test('every task in TASKS resolves to its configured model, and unknown tasks throw', () => {
  assert.ok(Object.isFrozen(TASKS), 'the task table is frozen');
  for (const [task, spec] of Object.entries(TASKS)) {
    assert.ok(Object.isFrozen(spec), `${task} spec is frozen`);
    assert.ok(spec.kind === 'chat' || spec.kind === 'embed', `${task} has a known kind`);
    const configured = config.aiRouter[spec.modelKey];
    if (configured) {
      assert.equal(resolveModel(task), configured, `${task} → config.aiRouter.${spec.modelKey}`);
    } else {
      assert.throws(() => resolveModel(task), (err) => err.code === 'AI_MODEL_UNCONFIGURED',
        `unconfigured ${task} reports the missing config key`);
    }
  }
  assert.throws(() => resolveModel('nope'), (err) => err.status === 500 && err.code === 'AI_TASK_UNKNOWN');
});

test('resolveModel prefers an explicit model, trims it, and ignores a blank or non-string one', () => {
  assert.equal(resolveModel('tutor', { model: 'pinned/model' }), 'pinned/model');
  assert.equal(resolveModel('tutor', { model: '  padded/model  ' }), 'padded/model');
  assert.equal(resolveModel('tutor', { model: '' }), config.aiRouter.tutorModel, 'blank falls back to the config');
  assert.equal(resolveModel('tutor', { model: '   ' }), config.aiRouter.tutorModel);
  assert.equal(resolveModel('tutor', { model: 42 }), config.aiRouter.tutorModel, 'a non-string is ignored');
  assert.equal(resolveModel('tutor'), config.aiRouter.tutorModel);
  assert.equal(resolveModel('organize'), config.aiRouter.assessModel, 'organize shares the assess model');
  assert.equal(resolveModel('embed'), config.aiRouter.embedModel);
});

test('an unconfigured model reports AI_MODEL_UNCONFIGURED and makes no call', async () => {
  const saved = config.aiRouter.tutorModel;
  config.aiRouter.tutorModel = '';
  try {
    const run = await runNim(chatOk(), () => complete('tutor', MESSAGES, FAST));
    assertApiError(run.error, 500, 'AI_MODEL_UNCONFIGURED',
      'No model configured for task "tutor" (config.aiRouter.tutorModel).');
    assert.equal(run.calls.length, 0, 'rejected before the router starts');
  } finally {
    config.aiRouter.tutorModel = saved;
  }
});

/* ------------------------------------------------------------------ */
/* 8. usage stats                                                      */
/* ------------------------------------------------------------------ */

test('getStats counts calls, successes, failures, retries, fallbacks, tasks and models', async () => {
  const before = getStats();

  await runNim(chatOk(), () => complete('tutor', MESSAGES, FAST));
  await runNim(() => jsonResponse({ error: 'boom' }, 500), () => complete('assess', MESSAGES, { model: PRIMARY, backoffMs: 0 }));
  await runNim(embedOk([[0.5]]), () => embed(['alpha'], FAST));

  const after = getStats();
  assert.equal(after.calls - before.calls, 3);
  assert.equal(after.successes - before.successes, 2);
  assert.equal(after.failures - before.failures, 1);
  assert.equal(after.retries - before.retries, 2, 'both models used their second attempt');
  assert.equal(after.fallbacks - before.fallbacks, 1);
  assert.equal(after.byTask.tutor - (before.byTask.tutor ?? 0), 1);
  assert.equal(after.byTask.assess - (before.byTask.assess ?? 0), 1);
  assert.equal(after.byTask.embed - (before.byTask.embed ?? 0), 1);
  assert.equal(after.byModel[config.aiRouter.tutorModel] - (before.byModel[config.aiRouter.tutorModel] ?? 0), 1);
  assert.equal(after.byModel[EMBED_MODEL] - (before.byModel[EMBED_MODEL] ?? 0), 1);
  assert.equal(after.byModel[config.aiRouter.assessModel] ?? 0, before.byModel[config.aiRouter.assessModel] ?? 0,
    'a model that only ever failed is not counted in byModel');
  assert.equal(after.latencyMs.samples - before.latencyMs.samples, 2, 'one latency sample per successful call');
  assert.ok(after.latencyMs.max >= after.latencyMs.avg, 'max is never below the average');
  assert.ok(after.latencyMs.last >= 0, 'latency is measured, never negative');
});

test('getStats returns a copy, not the live counters', () => {
  const snapshot = getStats();
  snapshot.calls = 999999;
  snapshot.byTask.injected = 1;
  snapshot.latencyMs.samples = 999999;
  const fresh = getStats();
  assert.notEqual(fresh.calls, 999999);
  assert.equal(fresh.byTask.injected, undefined);
  assert.notEqual(fresh.latencyMs.samples, 999999);
  assert.deepEqual(Object.keys(fresh).sort(),
    ['byModel', 'byTask', 'calls', 'failures', 'fallbacks', 'latencyMs', 'retries', 'successes']);
});

/* ------------------------------------------------------------------ */
/* 9. structured logging                                               */
/* ------------------------------------------------------------------ */

test('the structured log records the outcome and never the key, the prompt or the provider body', async () => {
  const savedKey = config.nimApiKey;
  config.nimApiKey = SECRET_KEY;
  try {
    const messages = [{ role: 'user', content: MESSAGE_MARKER }];

    // A chain that fails everywhere: two attempts on the primary model, then the
    // same on the fallback model.
    const failed = await runNim(() => jsonResponse({ error: UNREADABLE_MARKER }, 500),
      () => complete('tutor', messages, { model: PRIMARY, backoffMs: 0 })); // default attempts = 2

    assert.equal(failed.calls.length, 4, 'two models × two attempts');
    assert.equal(failed.calls[0].headers.Authorization, `Bearer ${SECRET_KEY}`, 'the key is sent, in the header only');

    assert.equal(failed.lines.length, 4, 'one line per attempt');
    const entries = failed.lines.map((line) => JSON.parse(line));
    for (const entry of entries) {
      assert.equal(entry.scope, 'aiRouter');
      assert.ok(['ok', 'retry', 'fallback', 'error'].includes(entry.outcome), `outcome ${entry.outcome}`);
      assert.equal(entry.code, 'NIM_ERROR');
      assert.equal(entry.status, 500, 'the upstream status is logged for diagnosis');
      assert.equal(typeof entry.latencyMs, 'number');
      assert.ok(!lineHas(entry, SECRET_KEY), 'the API key must never be logged');
    }
    assert.deepEqual(entries.map((e) => e.outcome), ['retry', 'fallback', 'retry', 'error']);
    assert.deepEqual(entries.map((e) => e.model), [PRIMARY, PRIMARY, CHAT_FALLBACK, CHAT_FALLBACK]);
    assert.deepEqual(entries.map((e) => e.attempt), [1, 2, 1, 2], 'each model has its own attempt counter');
    assert.equal(entries[3].attempts, 4, 'the running attempt count is carried across models');
    assert.equal(entries[0].next, PRIMARY, 'a retry names the same model as next');
    assert.equal(entries[1].outcome, 'fallback', 'the primary is exhausted, so the line announces the switch');
    assert.equal(entries[1].next, CHAT_FALLBACK, 'and it names the next model');
    assert.equal(entries[3].next, undefined, 'no "next" once the chain is exhausted');

    const raw = failed.lines.join('\n');
    assert.ok(!raw.includes(SECRET_KEY), 'no log line contains the API key');
    assert.ok(!raw.includes(MESSAGE_MARKER), 'no log line contains the prompt text');
    assert.ok(!raw.includes(UNREADABLE_MARKER), 'no log line contains the provider body');

    // A success on the fallback model records which model answered, and where it
    // fell back from.
    const recovered = await runNim(
      (call, n) => (n === 1 ? jsonResponse({ error: 'unavailable' }, 500) : chatOk('The fallback answer.')),
      () => complete('tutor', MESSAGES, { ...FAST, model: PRIMARY }),
    );
    assert.equal(recovered.value, 'The fallback answer.');
    const okEntry = JSON.parse(recovered.lines.at(-1));
    assert.equal(okEntry.outcome, 'ok');
    assert.equal(okEntry.model, CHAT_FALLBACK);
    assert.equal(okEntry.fallback, true, 'a fallback success says so');
    assert.equal(okEntry.fallbackFrom, PRIMARY);
    assert.equal(okEntry.next, undefined, 'no "next" on a success');
    assert.ok(!lineHas(okEntry, SECRET_KEY), 'the key is not logged on success either');
    assert.ok(!lineHas(okEntry, 'The fallback answer.'), 'the model answer is not logged either');
  } finally {
    config.nimApiKey = savedKey;
  }
});

function lineHas(entry, needle) {
  return JSON.stringify(entry).includes(needle);
}
