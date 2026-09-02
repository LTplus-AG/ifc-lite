/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFetch, jsonResponse } from '@/test/fetch-stub.js';
import { streamAnthropicChat, streamOpenAiChat } from './stream-direct.js';

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

/**
 * `streamAnthropicChat` is the path the viewer chat actually uses, and it had no
 * test at all: every header assertion lived on `createAnthropicClient` driving
 * `messages.create`, while this function calls `messages.stream`. The bug this
 * whole change exists to fix could therefore be reintroduced here with the suite
 * fully green. These drive the real function through a stubbed fetch and read
 * what went out.
 */

function anthropicSse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const HELLO_STREAM: Array<Record<string, unknown>> = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

async function streamOnce(
  credentials: { apiKey: string; workspaceId: string },
  respond: () => Response,
): Promise<{ headers: Headers; text: string; error: Error | null }> {
  const captured = captureFetch(respond);
  let text = '';
  let error: Error | null = null;
  try {
    await streamAnthropicChat(credentials, {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be brief',
      onChunk: () => undefined,
      onComplete: (full: string) => { text = full; },
      onError: (err: Error) => { error = err; },
    });
  } finally {
    captured.restore();
  }
  return { headers: captured.sent[0], text, error };
}

test('streamAnthropicChat sends anthropic-workspace-id on the streaming path', async () => {
  const { headers, text, error } = await streamOnce(
    { apiKey: 'sk-ant-test', workspaceId: 'wrkspc_01abc' },
    () => anthropicSse(HELLO_STREAM),
  );
  assert.equal(error, null);
  assert.equal(text, 'hi');
  assert.equal(headers.get('anthropic-workspace-id'), 'wrkspc_01abc');
});

test('streamAnthropicChat omits the header when no workspace is configured', async () => {
  const { headers, error } = await streamOnce(
    { apiKey: 'sk-ant-test', workspaceId: '' },
    () => anthropicSse(HELLO_STREAM),
  );
  assert.equal(error, null);
  assert.equal(headers.has('anthropic-workspace-id'), false);
});

test('streamAnthropicChat explains a workspace 400 instead of dumping the body', async () => {
  const { error } = await streamOnce(
    { apiKey: 'sk-ant-test', workspaceId: '' },
    () => jsonResponse({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'anthropic-workspace-id is required when authenticating with an identity-linked API key.',
      },
    }, 400),
  );
  assert.ok(error, 'expected the 400 to surface through onError');
  assert.match(error.message, /several workspaces/);
});

test('streamAnthropicChat surfaces an unusable workspace id through onError', async () => {
  // createAnthropicClient throws for a value a header cannot carry; that must
  // reach onError like any other failure rather than escaping the call.
  const { error } = await streamOnce(
    { apiKey: 'sk-ant-test', workspaceId: 'wrkspc_\u200Babc' },
    () => anthropicSse(HELLO_STREAM),
  );
  assert.ok(error, 'expected the rejected workspace id to reach onError');
  assert.match(error.message, /does not belong in one/);
});

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

// The `acceptsSamplingParams` default was inverted (send only where flagged),
// which changes the request body for every BYOK model and had no coverage.
// Nothing else asserts what actually reaches the provider.
test('sampling params are sent only for models flagged acceptsSamplingParams', async () => {
  const bodyFor = async (model: string): Promise<Record<string, unknown>> => {
    let captured: Record<string, unknown> = {};
    await withMockFetch(
      async (_input, init) => {
        captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return sseResponse(['[DONE]']);
      },
      () => streamOpenAiChat('test-key', {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        onChunk: () => {},
        onComplete: () => {},
        onError: () => {},
      } as unknown as Parameters<typeof streamOpenAiChat>[1]),
    );
    return captured;
  };

  // gpt-5.6-sol carries no flag, so it must not receive a temperature.
  const reasoning = await bodyFor('gpt-5.6-sol');
  assert.equal('temperature' in reasoning, false, 'reasoning models reject temperature with a 400');

  // An id absent from the registry must fail closed the same way.
  const unknown = await bodyFor('some/model-not-in-the-registry');
  assert.equal('temperature' in unknown, false, 'an unknown model must not be sent sampling params');
});
