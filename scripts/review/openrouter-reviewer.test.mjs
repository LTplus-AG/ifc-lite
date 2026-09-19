/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_REVIEW_MODELS_DEFAULT,
  OPENROUTER_JUDGE_MODELS_DEFAULT,
  OPENROUTER_TIMEOUT_MS_DEFAULT,
  requestOpenRouterReview,
  requestOpenRouterReviewChain,
  responseText,
  parseModelChain,
  resolveModelChain,
  resolveTimeoutMs,
  runOpenRouterFallback,
} from './openrouter-reviewer.mjs';

const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => JSON.stringify(body) });

/**
 * `AbortSignal.timeout()`'s internal timer is UNREF'D by design (Node docs),
 * so it does not by itself keep the event loop alive. In production that is
 * harmless -- a real stalled fetch holds an open socket, which is its own
 * ref'd handle -- but a test whose fake `fetchImpl` never touches the network
 * has NOTHING else keeping the loop open, so node can decide the loop is
 * "done" and exit while the abort promise is still pending, with node:test
 * reporting `cancelledByParent`/"Promise resolution is still pending" rather
 * than the real assertion. A ref'd interval for the test's duration is the
 * fix; it does not change what is being tested, only whether the process
 * sticks around long enough for the real timer to fire.
 */
async function withEventLoopKeptAlive(fn) {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

test('the chat completions endpoint receives the unchanged prompt as a single user message', async () => {
  let request;
  const text = await requestOpenRouterReview({
    prompt: 'the exact fenced review prompt',
    apiKey: 'not-logged',
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return reply({ choices: [{ message: { content: '{"findings":[]}' } }] });
    },
  });
  assert.equal(text, '{"findings":[]}');
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.body.model, OPENROUTER_REVIEW_MODEL);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'the exact fenced review prompt' }]);
  assert.equal(request.body.max_tokens, 32768);
  assert.deepEqual(request.body.reasoning, { effort: 'high' });
  assert.equal(request.init.headers.authorization, 'Bearer not-logged');
  assert.equal(request.init.headers['HTTP-Referer'], 'https://github.com/LTplus-AG/ifc-lite');
  assert.equal(request.init.headers['X-Title'], 'ifc-lite review lane');
  assert.doesNotMatch(JSON.stringify(request.body), /not-logged/);
});

test('a caller-supplied model overrides the default', async () => {
  let request;
  await requestOpenRouterReview({
    prompt: 'p',
    apiKey: 'k',
    model: 'openai/gpt-5-mini',
    fetchImpl: async (url, init) => {
      request = { body: JSON.parse(init.body) };
      return reply({ choices: [{ message: { content: 'ok' } }] });
    },
  });
  assert.equal(request.body.model, 'openai/gpt-5-mini');
});

test('responseText handles both a plain string and an array of text parts', () => {
  assert.equal(responseText({ content: 'plain string' }), 'plain string');
  assert.equal(responseText({ content: [
    { type: 'text', text: 'first' }, { type: 'reasoning', text: 'skip' }, { type: 'text', text: ' second' },
  ] }), 'first second');
});

test('API errors and empty replies fail closed', async () => {
  await assert.rejects(
    requestOpenRouterReview({ prompt: 'p', apiKey: 'k', fetchImpl: async () => reply({ error: { message: 'no credits' } }, { ok: false, status: 429 }) }),
    /HTTP 429: no credits/,
  );
  await assert.rejects(
    requestOpenRouterReview({ prompt: 'p', apiKey: 'k', fetchImpl: async () => reply({ choices: [{ message: { content: '' } }] }) }),
    /without output text/,
  );
  await assert.rejects(
    requestOpenRouterReview({ prompt: 'p', apiKey: 'k', fetchImpl: async () => reply({}) }),
    /without output text/,
  );
});

test('parseModelChain splits, trims and drops empties, and empty input is []', () => {
  assert.deepEqual(parseModelChain(' a/one , b/two ,, c/three '), ['a/one', 'b/two', 'c/three']);
  assert.deepEqual(parseModelChain(''), []);
  assert.deepEqual(parseModelChain(undefined), []);
});

test('resolveModelChain: plural wins, singular becomes a one-element chain, else the default', () => {
  assert.deepEqual(
    resolveModelChain({ modelsRaw: 'a/one,b/two', modelRaw: 'c/three', defaults: ['z/default'] }),
    ['a/one', 'b/two'],
  );
  assert.deepEqual(resolveModelChain({ modelsRaw: '', modelRaw: 'c/three', defaults: ['z/default'] }), ['c/three']);
  assert.deepEqual(resolveModelChain({ modelsRaw: '', modelRaw: '', defaults: ['z/default'] }), ['z/default']);
});

test('the default chains are the three/two verified models, sonnet and haiku first', () => {
  assert.deepEqual(OPENROUTER_REVIEW_MODELS_DEFAULT, ['anthropic/claude-sonnet-5', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-luna']);
  assert.deepEqual(OPENROUTER_JUDGE_MODELS_DEFAULT, ['openai/gpt-5.4-nano', 'anthropic/claude-haiku-4.5']);
  assert.equal(OPENROUTER_REVIEW_MODEL, OPENROUTER_REVIEW_MODELS_DEFAULT[0]);
});

test('requestOpenRouterReviewChain moves to the next model on failure and reports which one answered', async () => {
  const tried = [];
  const result = await requestOpenRouterReviewChain({
    prompt: 'p',
    apiKey: 'k',
    models: ['a/one', 'b/two', 'c/three'],
    fetchImpl: async (url, init) => {
      const model = JSON.parse(init.body).model;
      tried.push(model);
      if (model !== 'b/two') return reply({ error: { message: 'down' } }, { ok: false, status: 500 });
      return reply({ choices: [{ message: { content: 'the answer' } }] });
    },
  });
  assert.deepEqual(tried, ['a/one', 'b/two']);
  assert.equal(result.text, 'the answer');
  assert.equal(result.model, 'b/two');
});

test('requestOpenRouterReviewChain throws naming every model when all fail', async () => {
  await assert.rejects(
    requestOpenRouterReviewChain({
      prompt: 'p', apiKey: 'k', models: ['a/one', 'b/two'],
      fetchImpl: async () => reply({ error: { message: 'down' } }, { ok: false, status: 500 }),
    }),
    /a\/one:.*b\/two:/s,
  );
});

test('requestOpenRouterReviewChain refuses an empty model list', async () => {
  await assert.rejects(requestOpenRouterReviewChain({ prompt: 'p', apiKey: 'k', models: [] }), /No OpenRouter model configured/);
});

test('child wrapper passes the key and model chain only through env, and returns the model that answered', () => {
  let call;
  const text = runOpenRouterFallback({
    prompt: 'p', apiKey: 'secret', models: ['a/one', 'b/two'],
    spawn: (...args) => {
      call = args;
      return { status: 0, stdout: ' answer ', stderr: 'MODEL_USED:b/two\n' };
    },
  });
  assert.deepEqual(text, { text: 'answer', model: 'b/two' });
  assert.equal(call[2].input, 'p');
  assert.equal(call[2].env.OPENROUTER_API_KEY, 'secret');
  assert.equal(call[2].env.OPENROUTER_REVIEW_MODELS, 'a/one,b/two');
  assert.doesNotMatch(JSON.stringify(call.slice(0, 2)), /secret/);
});

test('a non-zero fallback exit surfaces stderr', () => {
  assert.throws(
    () => runOpenRouterFallback({ prompt: 'p', apiKey: 'k', spawn: () => ({ status: 1, stdout: '', stderr: 'boom' }) }),
    /OpenRouter fallback exited 1: boom/,
  );
});

test('every non-MODEL_USED child stderr line is forwarded to the parent log, even on success', () => {
  // The child's own per-model chain failures (requestOpenRouterReviewChain's
  // "provider openrouter: X failed: ...; trying Y") used to be readable only
  // from result.stderr, which this function discarded once MODEL_USED was
  // extracted. A chain that failed over from model 1 to model 2 then printed
  // nothing at all about model 1's failure in the parent job log.
  const logged = [];
  const origLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    runOpenRouterFallback({
      prompt: 'p', apiKey: 'k', models: ['a/one', 'b/two'],
      spawn: () => ({
        status: 0,
        stdout: 'the answer',
        stderr: 'provider openrouter: a/one failed: HTTP 429; trying b/two\nMODEL_USED:b/two\n',
      }),
    });
  } finally {
    console.log = origLog;
  }
  assert.ok(logged.some((l) => l.includes('a/one failed: HTTP 429')), 'the per-model failure must reach the parent log');
  assert.ok(!logged.some((l) => l.includes('MODEL_USED')), 'the MODEL_USED line is still stripped, not forwarded');
});

// ============================================ finding-3: OpenRouter timeouts

test('resolveTimeoutMs: a valid override wins, an invalid/absent one falls back to the default', () => {
  assert.equal(resolveTimeoutMs('45000'), 45000);
  assert.equal(resolveTimeoutMs(undefined), OPENROUTER_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveTimeoutMs(''), OPENROUTER_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveTimeoutMs('not-a-number'), OPENROUTER_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveTimeoutMs('-5'), OPENROUTER_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveTimeoutMs('0'), OPENROUTER_TIMEOUT_MS_DEFAULT);
  assert.equal(resolveTimeoutMs(undefined, 120000), 120000);
});

test('a stalled OpenRouter request on EVERY model is a named chain failure, not an unbounded hang', async () => {
  // Simulates the exact bug: a fetch that never settles until aborted. Before
  // `AbortSignal.timeout` was wired in, nothing in this file's request options
  // could ever cause that fetch to reject, so this test would hang forever
  // without it -- which is precisely the failure mode reported against the
  // failover loop in production.
  await withEventLoopKeptAlive(() => assert.rejects(
    requestOpenRouterReviewChain({
      prompt: 'p',
      apiKey: 'k',
      models: ['stalled/one', 'stalled/two'],
      timeoutMs: 20,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
    }),
    /Every OpenRouter model failed/,
  ));
});

test('requestOpenRouterReviewWithUsage rejects once its AbortSignal fires, instead of hanging', async () => {
  const controllerSeen = [];
  await withEventLoopKeptAlive(() => assert.rejects(
    requestOpenRouterReview({
      prompt: 'p',
      apiKey: 'k',
      timeoutMs: 10,
      fetchImpl: (url, init) => {
        controllerSeen.push(init.signal);
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        });
      },
    }),
  ));
  assert.equal(controllerSeen.length, 1);
  assert.ok(controllerSeen[0] instanceof AbortSignal);
});

test('requestOpenRouterReviewChain moves to the NEXT model when one aborts on timeout', async () => {
  let calls = 0;
  const result = await withEventLoopKeptAlive(() => requestOpenRouterReviewChain({
    prompt: 'p',
    apiKey: 'k',
    models: ['slow/model', 'fast/model'],
    timeoutMs: 10,
    fetchImpl: (url, init) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        });
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'clean' } }] }) });
    },
  }));
  assert.equal(result.model, 'fast/model');
  assert.equal(result.text, 'clean');
});

test('runOpenRouterFallback sets a spawnSync timeout that covers the whole model chain, and forwards OPENROUTER_TIMEOUT_MS', () => {
  let call;
  runOpenRouterFallback({
    prompt: 'p', apiKey: 'k', models: ['a/one', 'b/two'], timeoutMs: 1000,
    spawn: (...args) => { call = args; return { status: 0, stdout: 'ok', stderr: '' }; },
  });
  assert.equal(call[2].timeout, 1000 * 2 + 30_000);
  assert.equal(call[2].env.OPENROUTER_TIMEOUT_MS, '1000');
});

test('runOpenRouterFallback reports a killed child as a named timeout failure, not a bare exit code', () => {
  assert.throws(
    () => runOpenRouterFallback({
      prompt: 'p', apiKey: 'k', models: ['a/one'], timeoutMs: 1000,
      spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
    }),
    /killed by signal SIGTERM/,
  );
});
