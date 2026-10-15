// nimChat tests — the adapter every legacy service imports.
//
// nimChat is now a thin wrapper over aiRouter.complete(): its whole job is to
// forward `task`, `model`, `temperature` and `maxTokens` and hand back the
// router's error. These tests pin that contract, offline: global.fetch is
// replaced with a scripted stub, so the recorded request body IS the assertion.
//
// Covered: the forwarded body for every option shape — including omitted options
// and an explicit 0 (a falsy value is not an absent one, so the router's default
// must NOT replace it) — the returned answer, and the error contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../server/services/nimChat.js';
import { ApiError } from '../server/middleware/errors.js';
import { config } from '../server/config.js';

const MESSAGES = [
  { role: 'system', content: 'You are a patient tutor.' },
  { role: 'user', content: 'What is mitosis?' },
];

function chatResponse(content = 'The answer.') {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Run one adapter call against an offline fetch stub. `script` is a Response or
 * `(call, callNumber) => Response | Error`; a returned Error simulates a
 * network-level failure. A plain Response is cloned per attempt because a
 * response body can only be read once.
 */
async function withNim(script, fn) {
  const realFetch = global.fetch;
  const realLog = { log: console.log, warn: console.warn, error: console.error };
  const calls = [];
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
  const quiet = () => {};
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
    return { ...outcome, calls, models: () => calls.map((c) => c.body?.model) };
  } finally {
    global.fetch = realFetch;
    console.log = realLog.log;
    console.warn = realLog.warn;
    console.error = realLog.error;
  }
}

/** The provider request the router built for the adapter's options. */
async function requestFor(options) {
  const run = await withNim(chatResponse(), () => chatCompletion(MESSAGES, options));
  assert.equal(run.error, null, `unexpected provider failure: ${run.error?.message}`);
  assert.equal(run.calls.length, 1, 'a success costs exactly one provider call');
  return run.calls[0];
}

/* ------------------------------------------------------------------ */
/* 1. the forwarded request body                                       */
/* ------------------------------------------------------------------ */

test('omitted options send the router defaults for the tutor task', async () => {
  const call = await requestFor(undefined);
  assert.equal(call.url, `${config.nimBaseUrl}/chat/completions`);
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, {
    model: config.aiRouter.tutorModel, // task "tutor" (the default)
    messages: MESSAGES,
    temperature: 0.2,
    max_tokens: 1200,
  });
});

test('an empty options object behaves exactly like omitted options', async () => {
  const empty = await requestFor({});
  const omitted = await requestFor(undefined);
  assert.deepEqual(empty.body, omitted.body);
  assert.deepEqual(empty.headers, omitted.headers);
  assert.equal(empty.url, omitted.url);
});

test('explicitly-undefined options also fall back to the router defaults', async () => {
  const call = await requestFor({ task: undefined, model: undefined, temperature: undefined, maxTokens: undefined });
  assert.deepEqual(call.body, {
    model: config.aiRouter.tutorModel,
    messages: MESSAGES,
    temperature: 0.2,
    max_tokens: 1200,
  });
});

test('an explicit 0 is forwarded as 0, not replaced by the router default', async () => {
  // Falsy is not the same as absent: a caller asking for temperature 0 (fully
  // deterministic output) must not silently get 0.2 back.
  const zeroTemp = await requestFor({ temperature: 0 });
  assert.equal(zeroTemp.body.temperature, 0, 'temperature 0 must survive');

  const zeroTokens = await requestFor({ maxTokens: 0 });
  assert.equal(zeroTokens.body.max_tokens, 0, 'maxTokens 0 must survive');

  const bothZero = await requestFor({ temperature: 0, maxTokens: 0 });
  assert.equal(bothZero.body.temperature, 0);
  assert.equal(bothZero.body.max_tokens, 0);
  assert.equal(bothZero.body.model, config.aiRouter.tutorModel, 'the model default still applies');
});

test('explicit generation controls reach the provider unchanged', async () => {
  const call = await requestFor({ temperature: 0.9, maxTokens: 25 });
  assert.equal(call.body.temperature, 0.9);
  assert.equal(call.body.max_tokens, 25);

  const large = await requestFor({ maxTokens: 8000 });
  assert.equal(large.body.max_tokens, 8000);

  const negative = await requestFor({ temperature: -0.5, maxTokens: -1 });
  assert.equal(negative.body.temperature, -0.5, 'the adapter does not second-guess the caller');
  assert.equal(negative.body.max_tokens, -1);
});

test('the task selects the model from the router table', async () => {
  const expected = {
    tutor: config.aiRouter.tutorModel,
    assess: config.aiRouter.assessModel,
    organize: config.aiRouter.assessModel,
    flashcard: config.aiRouter.assessModel,
    summarize: config.aiRouter.tutorModel,
    advice: config.aiRouter.tutorModel,
  };
  for (const [task, model] of Object.entries(expected)) {
    // sequential: one stub at a time
    const call = await requestFor({ task });
    assert.equal(call.body.model, model, `task "${task}" → ${model}`);
    assert.equal(call.body.messages.length, MESSAGES.length);
  }
});

test('an explicit model is kept: the adapter does not re-route it', async () => {
  const call = await requestFor({ task: 'assess', model: 'pinned/chat-model' });
  assert.equal(call.body.model, 'pinned/chat-model', 'the caller\'s own choice wins over the task default');
});

test('the request carries only the OpenAI-compatible fields', async () => {
  const call = await requestFor({ task: 'assess' });
  assert.deepEqual(Object.keys(call.body),
    ['model', 'messages', 'temperature', 'max_tokens'], 'no task tag, no stream flag, no extra fields');
  assert.deepEqual(Object.keys(call.headers).sort(), ['Authorization', 'Content-Type']);
  assert.equal(call.headers.Authorization, `Bearer ${config.nimApiKey}`, 'the key goes in the header, from config');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.ok(!config.nimApiKey || !JSON.stringify(call.body).includes(config.nimApiKey),
    'the key never appears in the body');
});

test('the messages array is forwarded as-is, and the options object is not mutated', async () => {
  const options = { task: 'assess', temperature: 0.3, maxTokens: 7 };
  const frozenCopy = JSON.stringify(options);
  const call = await withNim(chatResponse(), () => chatCompletion(MESSAGES, options));
  assert.equal(call.error, null);
  assert.deepEqual(call.calls[0].body.messages, MESSAGES);
  assert.equal(JSON.stringify(options), frozenCopy, 'the adapter leaves the caller\'s options alone');
});

/* ------------------------------------------------------------------ */
/* 2. the answer                                                       */
/* ------------------------------------------------------------------ */

test('a successful call returns the trimmed answer', async () => {
  const run = await withNim(chatResponse('  Mitosis produces two identical cells.  '),
    () => chatCompletion(MESSAGES));
  assert.equal(run.error, null);
  assert.equal(run.value, 'Mitosis produces two identical cells.');
});

test('an empty answer is the router\'s decision, and it is surfaced', async () => {
  const run = await withNim(chatResponse('   '), () => chatCompletion(MESSAGES));
  assert.ok(run.error instanceof ApiError);
  assert.equal(run.error.code, 'NIM_ERROR');
  assert.equal(run.error.message, 'The AI model returned an empty response. Try again.');
});

/* ------------------------------------------------------------------ */
/* 3. the error contract                                               */
/* ------------------------------------------------------------------ */

test('provider failures are propagated as the router\'s ApiError, unchanged', async () => {
  // The message/counts are the router's retry + fallback decisions, inherited by
  // the adapter for free: 401/403 fail for every model, so one call; 404 is
  // model-specific, so the other model is tried; 429 is transient, so both
  // models get both attempts.
  const tutor = config.aiRouter.tutorModel;
  const assess = config.aiRouter.assessModel;
  const cases = [
    [401, 'AI provider rejected the API key. Check NIM_API_KEY in .env.', [tutor]],
    [403, 'AI provider rejected the API key. Check NIM_API_KEY in .env.', [tutor]],
    [404, `AI model "${assess}" is not available on this account.`, [tutor, assess]],
    [429, 'AI provider rate limit reached. Wait a moment and try again.', [tutor, tutor, assess, assess]],
  ];
  for (const [status, message, models] of cases) {
    // sequential: one stub at a time
    const run = await withNim(new Response(JSON.stringify({ error: 'detail' }), { status }),
      () => chatCompletion(MESSAGES));
    assert.ok(run.error instanceof ApiError, `${status} → an ApiError`);
    assert.equal(run.error.status, 502, `${status} → 502`);
    assert.equal(run.error.code, 'NIM_ERROR', `${status} → NIM_ERROR`);
    assert.equal(run.error.message, message, `${status} → message`);
    assert.deepEqual(run.models(), models, `${status} → the router's own attempt sequence`);
  }
});

test('a timeout keeps the NIM_TIMEOUT code and its student-facing message', async () => {
  const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const run = await withNim(abort, () => chatCompletion(MESSAGES));
  assert.ok(run.error instanceof ApiError);
  assert.equal(run.error.status, 504);
  assert.equal(run.error.code, 'NIM_TIMEOUT');
  assert.equal(run.error.message, 'The AI model did not respond in time. Try again.');
});

test('a network failure keeps the NIM_ERROR code', async () => {
  const run = await withNim(Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }),
    () => chatCompletion(MESSAGES));
  assert.equal(run.error.status, 502);
  assert.equal(run.error.code, 'NIM_ERROR');
  assert.equal(run.error.message, 'Could not reach the AI provider: fetch failed');
});

test('argument errors the router rejects are surfaced with their own status and code', async () => {
  const cases = [
    ['unknown task', () => chatCompletion(MESSAGES, { task: 'nope' }), 500, 'AI_TASK_UNKNOWN'],
    ['the embed task', () => chatCompletion(MESSAGES, { task: 'embed' }), 500, 'AI_TASK_NOT_CHAT'],
    ['no messages', () => chatCompletion(), 500, 'AI_BAD_REQUEST'],
    ['empty messages', () => chatCompletion([], { task: 'tutor' }), 500, 'AI_BAD_REQUEST'],
    ['non-array messages', () => chatCompletion('hello'), 500, 'AI_BAD_REQUEST'],
  ];
  for (const [label, call, status, code] of cases) {
    // sequential, no provider needed
    const run = await withNim(chatResponse(), call);
    assert.ok(run.error instanceof ApiError, `${label} → an ApiError`);
    assert.equal(run.error.status, status, `${label} → status`);
    assert.equal(run.error.code, code, `${label} → code`);
    assert.equal(run.calls.length, 0, `${label}: rejected before any provider call`);
  }
});
