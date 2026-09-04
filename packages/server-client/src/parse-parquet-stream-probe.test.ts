/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `parseParquetStream` presents the file's SHA-256 before it presents the file
 * (issue #3901).
 *
 * The point of the feature is a NEGATIVE: on a cache hit the upload never
 * happens. A test that only checks the happy result would pass with the probe
 * deleted and the upload always running, so each test here pins how many
 * requests were made and whether any of them carried a body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The batch decoder is irrelevant to request shape; stub it so no WASM is
// needed and 'batch' events resolve to empty mesh lists.
vi.mock('./parquet-decoder.js', () => ({
  isParquetAvailable: vi.fn(async () => true),
  decodeParquetGeometry: vi.fn(async () => []),
  decodeOptimizedParquetGeometry: vi.fn(async () => []),
}));

import { IfcServerClient } from './client.js';

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** A complete, minimal parquet-stream SSE response. */
function streamResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of [
        frame({ type: 'start', cache_key: 'key-default', total_estimate: 3 }),
        frame({ type: 'progress', processed: 0, total: 3 }),
        frame({ type: 'batch', data: '', mesh_count: 2, batch_number: 1 }),
        frame({ type: 'progress', processed: 3, total: 3 }),
        frame({
          type: 'complete',
          stats: { total_meshes: 2 },
          metadata: { schema: 'IFC4' },
        }),
      ]) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Every fetch call as [url, init]. */
type Call = [string, RequestInit];

function calls(mock: ReturnType<typeof vi.fn>): Call[] {
  return mock.mock.calls.map((c) => [String(c[0]), (c[1] ?? {}) as RequestInit]);
}

const client = () => new IfcServerClient({ baseUrl: 'https://example.invalid' });
const file = () => new File([new Uint8Array([1, 2, 3, 4])], 'x.ifc');

beforeEach(() => {
  // Fake timers so the probe's header budget can be measured without waiting
  // it out. Every other test here resolves fetch immediately and never arms a
  // timer, so this is inert for them.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parseParquetStream hash probe', () => {
  it('replays from the probe on a hit, and never uploads the file', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse());
    vi.stubGlobal('fetch', fetchMock);

    const batches: number[] = [];
    const result = await client().parseParquetStream(file(), (b) =>
      batches.push(b.batch_number),
    );

    expect(result.cache_key).toBe('key-default');
    expect(batches).toEqual([1]);

    // ONE request, and it carried no body. This is the mutation check: an
    // implementation that probed and then uploaded anyway, or that skipped the
    // probe entirely, changes this count.
    const made = calls(fetchMock);
    expect(made).toHaveLength(1);
    const [url, init] = made[0];
    expect(url).toContain('/api/v1/parse/parquet-stream');
    expect(url).toContain('sha256=');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('falls back to the multipart upload when the probe answers 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(streamResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().parseParquetStream(file(), () => {});
    expect(result.total_meshes).toBe(0);

    const made = calls(fetchMock);
    expect(made).toHaveLength(2);
    // The probe: hash, no body.
    expect(made[0][0]).toContain('sha256=');
    expect(made[0][1].body).toBeUndefined();
    // The upload: body, and NO hash — the server keys off the bytes when a
    // body is present, so sending one would only invite the two to disagree.
    expect(made[1][1].body).toBeInstanceOf(FormData);
    expect(made[1][0]).not.toContain('sha256=');
  });

  it('surfaces a genuine probe failure instead of quietly uploading', async () => {
    // A 500 is not "not cached". Retrying it as a full upload would turn a
    // server fault into a silent 40 MB transfer.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'boom', code: 'INTERNAL_ERROR' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(streamResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().parseParquetStream(file(), () => {}),
    ).rejects.toThrow(/boom/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A server built before #3901 still declares the route's body as multipart,
  // so a bodyless POST is rejected by the extractor (400 InvalidBoundary in
  // axum) rather than reaching the handler. This client is published to npm
  // and pointed at a self-hosted baseUrl, so a client ahead of its server is
  // ordinary — and it must degrade to the upload, not break the load.
  it.each([
    ['an older server that rejects the bodyless POST', 400],
    ['a proxy that refuses the method', 405],
    ['a server that refuses the media type', 415],
    ['a server that has not implemented the probe', 501],
    ['admission shedding', 503],
  ])('uploads when the probe is not answered: %s', async (_label, status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(streamResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().parseParquetStream(file(), () => {});
    expect(result.cache_key).toBe('key-default');
    expect(calls(fetchMock)).toHaveLength(2);
    expect(calls(fetchMock)[1][1].body).toBeInstanceOf(FormData);
  });

  it('uploads when the probe never answers at all', async () => {
    // A probe that throws (timed out, connection refused) says nothing about
    // the cache. Uploading is what would have happened without it.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockResolvedValueOnce(streamResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().parseParquetStream(file(), () => {});
    expect(result.cache_key).toBe('key-default');
    expect(calls(fetchMock)).toHaveLength(2);
    expect(calls(fetchMock)[1][1].body).toBeInstanceOf(FormData);
  });

  it('gives the probe a short header budget, not the full request timeout', async () => {
    // The probe exists to be cheaper than the upload. Letting it inherit the
    // request timeout means a slow server delays the upload by the whole
    // budget and then fails it, so the load dies where it used to succeed.
    // The replay body still gets the full budget, which is why the two share
    // one AbortController instead of a per-request AbortSignal.timeout.
    let probeSignal: AbortSignal | undefined;
    let probeSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      probeSent = resolve;
    });
    // Never resolves: the point is what happens while the server says nothing.
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      probeSignal ??= init.signal ?? undefined;
      probeSent();
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const timeout = 300_000;
    void new IfcServerClient({ baseUrl: 'https://example.invalid', timeout })
      .parseParquetStream(file(), () => {})
      .catch(() => {});

    // The local hash is not timer-driven, so this settles on its own.
    await sent;
    expect(probeSignal).toBeDefined();
    expect(probeSignal?.aborted).toBe(false);

    // Just under the probe budget: still waiting.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(probeSignal?.aborted).toBe(false);

    // At the probe budget: given up on, far short of the request timeout.
    await vi.advanceTimersByTimeAsync(1);
    expect(probeSignal?.aborted).toBe(true);
    expect(timeout).toBeGreaterThan(5_000);
  });

  it('sends the layout signal on the probe, since it selects the cache entry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await client()
      .parseParquetStream(file(), () => {}, { tessellationQuality: 'high' })
      .catch(() => {});

    const [probeUrl] = calls(fetchMock)[0];
    // A hash paired with the wrong layout or quality names a different blob,
    // so all three have to travel together.
    expect(probeUrl).toContain('parquet_layout=shared-shapes');
    expect(probeUrl).toContain('tessellation_quality=high');
    expect(probeUrl).toContain('sha256=');
  });
});
