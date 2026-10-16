/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `parseParquet` checks the cache and then fetches the entry the check found
 * (#7676). The check only sees that an entry is on disk; a damaged one passes
 * it and fails the fetch, which answers `404` and drops the entry. That must
 * cost one extra upload, not the load: without the fallback the viewer's
 * non-streaming path failed that load with `NOT_FOUND`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Request shape only: no WASM is needed to tell which requests were made.
vi.mock('./parquet-decoder.js', () => ({
  isParquetAvailable: vi.fn(async () => true),
  decodeParquetGeometry: vi.fn(async () => []),
  decodeOptimizedParquetGeometry: vi.fn(async () => []),
}));

import { IfcServerClient } from './client.js';
import { IfcServerError } from './server-error.js';

const client = () => new IfcServerClient({ baseUrl: 'https://example.invalid' });
const file = () => new File([new Uint8Array([1, 2, 3, 4])], 'x.ifc');

const envelope = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseParquet cached-geometry fallback', () => {
  it('uploads when the cached geometry the check found answers 404', async () => {
    const seen: Array<[string, string]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        seen.push([method, String(url)]);
        if (String(url).includes('/api/v1/cache/check/')) return new Response(null, { status: 200 });
        if (String(url).includes('/api/v1/cache/geometry/')) return envelope(404, 'NOT_FOUND');
        // The upload: answered with a distinct failure so the test can tell
        // that it, and not the 404, is what the caller got back.
        return envelope(503, 'OVERLOADED');
      })
    );

    const error = await client().parseParquet(file()).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(IfcServerError);
    expect((error as IfcServerError).code).toBe('OVERLOADED');
    expect(seen.map(([method, url]) => `${method} ${new URL(url).pathname.replace(/[0-9a-f]{64}/, ':hash')}`)).toEqual([
      'GET /api/v1/cache/check/:hash',
      'GET /api/v1/cache/geometry/:hash',
      'POST /api/v1/parse/parquet',
    ]);
  });

  it('still fails on a cached-geometry error that is not a miss', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
        if (String(url).includes('/api/v1/cache/check/')) return new Response(null, { status: 200 });
        return envelope(503, 'OVERLOADED');
      })
    );

    await expect(client().parseParquet(file())).rejects.toMatchObject({ code: 'OVERLOADED' });
    expect(seen.some((s) => s.startsWith('POST '))).toBe(false);
  });
});
