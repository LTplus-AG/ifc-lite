/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { drainSseBuffer, streamChat } from './stream-client.js';

test('drainSseBuffer flushes a final unterminated SSE event', () => {
  const drained = drainSseBuffer('data: {"choices":[{"delta":{"content":"tail"}}]}', true);
  assert.deepEqual(drained.events, ['data: {"choices":[{"delta":{"content":"tail"}}]}']);
  assert.equal(drained.remainder, '');
});

test('streamChat processes the final SSE event even without trailing blank line', async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"length"}]}',
  ];

  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Usage-Limit': '3',
      'X-Usage-Used': '1',
      'X-Usage-Pct': '33',
      'X-Usage-Reset': '1700000000',
    },
  });

  try {
    let fullText = '';
    let finishReason: string | null = null;
    await streamChat({
      proxyUrl: '/api/chat',
      model: 'openai/gpt-free',
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (text) => { fullText += text; },
      onComplete: (text) => { fullText = text; },
      onFinishReason: (reason) => { finishReason = reason; },
      onError: (error) => { throw error; },
    });

    assert.equal(fullText, 'Hello world');
    assert.equal(finishReason, 'length');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat surfaces request timeout errors', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutCallback: () => void = () => {
    throw new Error('timeout callback not registered');
  };

  globalThis.setTimeout = (((fn: TimerHandler) => {
    timeoutCallback = fn as () => void;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason ?? new Error('aborted'));
    }, { once: true });
  });

  try {
    let capturedMessage: string | null = null;
    const promise = streamChat({
      proxyUrl: '/api/chat',
      model: 'openai/gpt-free',
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: () => undefined,
      onComplete: () => undefined,
      onError: (error) => { capturedMessage = error.message; },
    });
    timeoutCallback();
    await promise;
    assert.equal(capturedMessage, 'Chat request timed out. Please try again.');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('a retired model still tells the user what they can actually do (#2886)', async () => {
  // The free Devstral window closed and the provider answered with migration
  // advice aimed at whoever configures routing: "migrate to the paid slug".
  // Nobody can do that from the viewer. The branch that adds "switch model"
  // used to run only when the provider said nothing, so the users handed the
  // most confusing message were told the least about their options.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      code: 'provider_model_not_found',
      model: 'mistralai/devstral-2512',
      providerMessage:
        'The free Devstral 2 2512 period has ended. To continue using this model, please migrate to the paid slug: mistralai/devstral-2512',
    }),
    { status: 502, headers: { 'Content-Type': 'application/json' } },
  );

  try {
    let captured: string | null = null;
    await streamChat({
      proxyUrl: '/api/chat',
      model: 'mistralai/devstral-2512',
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: () => undefined,
      onComplete: () => undefined,
      onError: (error) => { captured = error.message; },
    });

    const message = captured as string | null;
    assert.ok(message, 'expected an error to surface');
    assert.match(message, /mistralai\/devstral-2512/, 'the dead model should be named');
    assert.match(message, /free Devstral 2 2512 period has ended/, "the provider's explanation is worth keeping");
    assert.match(message, /[Ss]witch model/, 'the one action available in this app must be stated');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
