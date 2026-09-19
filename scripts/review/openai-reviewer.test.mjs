/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_REVIEW_MODEL, OPENAI_TIMEOUT_MS_DEFAULT, requestOpenAiReview, responseText, runOpenAiFallback } from './openai-reviewer.mjs';

const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => JSON.stringify(body) });

test('#3803: Responses API receives the unchanged prompt without tools or storage', async () => {
  let request;
  const text = await requestOpenAiReview({
    prompt: 'the exact fenced review prompt',
    apiKey: 'not-logged',
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return reply({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"findings":[]}' }] }] });
    },
  });
  assert.equal(text, '{"findings":[]}');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.model, OPENAI_REVIEW_MODEL);
  assert.equal(request.body.input, 'the exact fenced review prompt');
  assert.deepEqual(request.body.tools, []);
  assert.equal(request.body.store, false);
  assert.doesNotMatch(JSON.stringify(request.body), /not-logged/);
});

test('responseText handles the raw REST response shape', () => {
  assert.equal(responseText({ output: [{ type: 'message', content: [
    { type: 'output_text', text: 'first' }, { type: 'refusal', refusal: 'no' }, { type: 'output_text', text: ' second' },
  ] }] }), 'first second');
});

test('API errors and incomplete or empty replies fail closed', async () => {
  await assert.rejects(
    requestOpenAiReview({ prompt: 'p', apiKey: 'k', fetchImpl: async () => reply({ error: { message: 'spent' } }, { ok: false, status: 429 }) }),
    /HTTP 429: spent/,
  );
  await assert.rejects(
    requestOpenAiReview({ prompt: 'p', apiKey: 'k', fetchImpl: async () => reply({ status: 'incomplete' }) }),
    /did not complete/,
  );
  await assert.rejects(
    requestOpenAiReview({ prompt: 'p', apiKey: 'k', fetchImpl: async () => reply({ status: 'completed', output: [] }) }),
    /without output text/,
  );
});

test('child wrapper passes the key only through env and returns text', () => {
  let call;
  const text = runOpenAiFallback({ prompt: 'p', apiKey: 'secret', spawn: (...args) => {
    call = args;
    return { status: 0, stdout: ' answer ', stderr: '' };
  } });
  assert.equal(text, 'answer');
  assert.equal(call[2].input, 'p');
  assert.equal(call[2].env.OPENAI_API_KEY, 'secret');
  assert.doesNotMatch(JSON.stringify(call.slice(0, 2)), /secret/);
});

// ============================================ finding-4: the same timeout plumbing as OpenRouter

test('requestOpenAiReview aborts the fetch via the timeoutMs it is given', async () => {
  let seenSignal;
  await requestOpenAiReview({
    prompt: 'p',
    apiKey: 'k',
    timeoutMs: 5000,
    fetchImpl: async (_url, init) => {
      seenSignal = init.signal;
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'completed', output_text: 'ok' }) };
    },
  });
  assert.ok(seenSignal instanceof AbortSignal, 'the request must carry an AbortSignal');
});

test('runOpenAiFallback threads timeoutMs to the child as OPENAI_TIMEOUT_MS and bounds spawnSync itself', () => {
  let call;
  runOpenAiFallback({
    prompt: 'p',
    apiKey: 'k',
    timeoutMs: 5000,
    spawn: (...args) => {
      call = args;
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(call[2].env.OPENAI_TIMEOUT_MS, '5000');
  assert.equal(call[2].timeout, 5000 + 30_000, 'the parent-side spawnSync budget must exceed the child fetch timeout');
});

test('runOpenAiFallback defaults timeoutMs to OPENAI_TIMEOUT_MS_DEFAULT when not given', () => {
  let call;
  runOpenAiFallback({ prompt: 'p', apiKey: 'k', spawn: (...args) => { call = args; return { status: 0, stdout: 'ok', stderr: '' }; } });
  assert.equal(call[2].env.OPENAI_TIMEOUT_MS, String(OPENAI_TIMEOUT_MS_DEFAULT));
});
