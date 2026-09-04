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

import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
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

  it('surfaces a non-404 probe failure instead of quietly uploading', async () => {
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

  it('uploads directly when the probe is skipped', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamResponse());
    vi.stubGlobal('fetch', fetchMock);

    await client().parseParquetStream(file(), () => {}, { skipCacheProbe: true });

    const made = calls(fetchMock);
    expect(made).toHaveLength(1);
    expect(made[0][0]).not.toContain('sha256=');
    expect(made[0][1].body).toBeInstanceOf(FormData);
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
