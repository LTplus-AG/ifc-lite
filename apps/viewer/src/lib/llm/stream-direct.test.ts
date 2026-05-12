/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { streamOpenAiChat } from './stream-direct.js';

const CODEX_MODEL_ID = 'gpt-5.3-codex';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function withMockFetch<T>(impl: FetchImpl, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function sseResponse(events: string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(new TextEncoder().encode(`data: ${evt}\n\n`));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('streamOpenAiChat (Responses API) reports finish_reason=length when output is truncated', async () => {
  await withMockFetch(
    async () => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }),
      JSON.stringify({
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ]),
    async () => {
      let fullText = '';
      let finishReason: string | null = null;
      await streamOpenAiChat('sk-test', {
        model: CODEX_MODEL_ID,
        messages: [{ role: 'user', content: 'hi' }],
        onChunk: (text) => { fullText += text; },
        onComplete: (text) => { fullText = text; },
        onFinishReason: (reason) => { finishReason = reason; },
        onError: (err) => { throw err; },
      });
      assert.equal(fullText, 'partial');
      assert.equal(finishReason, 'length');
    },
  );
});

test('streamOpenAiChat (Responses API) reports finish_reason=length when incomplete has no reason', async () => {
  await withMockFetch(
    async () => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }),
      JSON.stringify({
        type: 'response.incomplete',
        response: { status: 'incomplete' },
      }),
    ]),
    async () => {
      let finishReason: string | null = null;
      await streamOpenAiChat('sk-test', {
        model: CODEX_MODEL_ID,
        messages: [{ role: 'user', content: 'hi' }],
        onChunk: () => undefined,
        onComplete: () => undefined,
        onFinishReason: (reason) => { finishReason = reason; },
        onError: (err) => { throw err; },
      });
      assert.equal(finishReason, 'length');
    },
  );
});

test('streamOpenAiChat (Responses API) reports finish_reason=stop on normal completion', async () => {
  await withMockFetch(
    async () => sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }),
      JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed' },
      }),
    ]),
    async () => {
      let finishReason: string | null = null;
      await streamOpenAiChat('sk-test', {
        model: CODEX_MODEL_ID,
        messages: [{ role: 'user', content: 'hi' }],
        onChunk: () => undefined,
        onComplete: () => undefined,
        onFinishReason: (reason) => { finishReason = reason; },
        onError: (err) => { throw err; },
      });
      assert.equal(finishReason, 'stop');
    },
  );
});

test('streamOpenAiChat (Responses API) hits the /v1/responses endpoint for codex models', async () => {
  let capturedUrl: string | null = null;
  await withMockFetch(
    async (input) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return sseResponse([
        JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }),
        JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
      ]);
    },
    async () => {
      await streamOpenAiChat('sk-test', {
        model: CODEX_MODEL_ID,
        messages: [{ role: 'user', content: 'hi' }],
        onChunk: () => undefined,
        onComplete: () => undefined,
        onError: (err) => { throw err; },
      });
    },
  );
  assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
});
