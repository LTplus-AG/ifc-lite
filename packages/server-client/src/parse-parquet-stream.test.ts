/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';

// `parseParquetStream` decodes real Parquet bytes for 'batch' events, which
// isn't the point of this test (reader-lock cleanup on the error path). Stub
// the decoder module so the stream logic runs without a real WASM payload.
vi.mock('./parquet-decoder.js', () => ({
  isParquetAvailable: vi.fn(async () => true),
  decodeParquetGeometry: vi.fn(async () => []),
  decodeOptimizedParquetGeometry: vi.fn(async () => []),
}));

import { IfcServerClient } from './client.js';

/** Build a Response whose body streams `chunks` as SSE text. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function client(): IfcServerClient {
  return new IfcServerClient({ baseUrl: 'https://example.invalid' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseParquetStream', () => {
  it('releases the response body reader when the stream reports a terminal error', async () => {
    // First call: cache-check (miss, so the streaming upload path runs).
    // Second call: the parquet-stream upload itself, whose SSE body carries
    // a terminal `error` event — the same shape `parseStream` already
    // handles by releasing its reader in a `finally`.
    const streamResponse = sseResponse([
      frame({ type: 'start', cache_key: 'abc', total_estimate: 2 }),
      frame({ type: 'error', message: 'boom', code: 'E_BOOM' }),
    ]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 })) // cache/check miss
      .mockResolvedValueOnce(streamResponse); // parquet-stream upload
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().parseParquetStream(new ArrayBuffer(4), () => {}),
    ).rejects.toThrow(/boom/);

    // The reader acquired via `response.body.getReader()` must be released
    // on this throwing path, exactly as `parseStream`'s `finally` block does.
    expect(streamResponse.body?.locked).toBe(false);
  });
});

describe('getCached', () => {
  it('sends the configured bearer token, like every other request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ cache_key: 'k', meshes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const authedClient = new IfcServerClient({
      baseUrl: 'https://example.invalid',
      token: 'secret-token',
    });
    await authedClient.getCached('some-key');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string> | undefined;
    // `/api/v1/cache/{key}` is a protected route on the server (auth
    // middleware covers all `protected_routes`), so a configured token must
    // be sent here exactly as it is on `parse`, `parseParquet`, etc.
    expect(headers?.Authorization).toBe('Bearer secret-token');
  });
});
