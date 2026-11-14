/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A `ProcessedModelRef` opens a stored result by hash.
 *
 * Like the hash probe (`parse-parquet-stream-probe.test.ts`) the contract is a
 * NEGATIVE: the source file never leaves, or even exists in, this process. So
 * every test pins how many requests were made and that none carried a body. A
 * miss must stay a miss; falling back to an upload would have nothing to send.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The decoders are irrelevant to request shape; stub them so no WASM is needed.
vi.mock('./parquet-decoder.js', () => ({
  isParquetAvailable: vi.fn(async () => true),
  decodeParquetGeometry: vi.fn(async () => []),
  decodeOptimizedParquetGeometry: vi.fn(async () => []),
}));

import { IfcServerClient } from './client.js';
import { IfcServerError } from './server-error.js';
import { isProcessedModelRef, normalizeProcessedModelHash } from './processed-model.js';

const sha256 = 'a'.repeat(64);
const ref = { sha256, bytes: 46_000_000 };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

function streamResponse(): Response {
  return new Response(
    frame({ type: 'start', cache_key: `${sha256}-default`, total_estimate: 0 })
      + frame({ type: 'complete', stats: { total_meshes: 0 }, metadata: { schema_version: 'IFC4' } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

type Call = [string, RequestInit];
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (): Call[] => fetchMock.mock.calls.map((c) => [String(c[0]), (c[1] ?? {}) as RequestInit]);
// A same-origin path is a valid base: a host serves the processing server behind its own proxy.
const client = () => new IfcServerClient({ baseUrl: '/processor', token: 'secret' });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('isProcessedModelRef', () => {
  it('tells a reference from the sources that carry bytes', () => {
    expect(isProcessedModelRef(ref)).toBe(true);
    expect(isProcessedModelRef(new ArrayBuffer(4))).toBe(false);
    expect(isProcessedModelRef(new File([new Uint8Array(4)], 'x.ifc'))).toBe(false);
    expect(isProcessedModelRef({ sha256 })).toBe(false);
  });
});

describe('parseParquetStream with a processed-model reference', () => {
  it('asks by hash in one request that carries no body', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse());
    const result = await client().parseParquetStream(ref, () => {});

    expect(result.cache_key).toBe(`${sha256}-default`);
    expect(calls()).toHaveLength(1);
    const [url, init] = calls()[0];
    expect(url.startsWith('/processor/api/v1/parse/parquet-stream?')).toBe(true);
    expect(new URLSearchParams(url.split('?')[1]).get('sha256')).toBe(sha256);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('fails on a miss instead of falling back to an upload', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"not cached","code":"NOT_FOUND"}', { status: 404 }));
    const miss = client().parseParquetStream(ref, () => {});
    await expect(miss).rejects.toBeInstanceOf(IfcServerError);
    await expect(miss).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(calls()).toHaveLength(1);
    expect(calls()[0][1].body).toBeUndefined();
  });
});

describe('parseParquet with a processed-model reference', () => {
  it('fails on a miss with one bodiless GET: no cache check, no upload', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const miss = client().parseParquet(ref);
    await expect(miss).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(calls()).toHaveLength(1);
    const [url, init] = calls()[0];
    expect(url.startsWith(`/processor/api/v1/cache/geometry/${sha256}`)).toBe(true);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });
});

describe('normalizeProcessedModelHash', () => {
  it('lowercases a SHA-256 and refuses anything else', () => {
    expect(normalizeProcessedModelHash(sha256)).toBe(sha256);
    expect(normalizeProcessedModelHash(sha256.toUpperCase())).toBe(sha256);
    for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(62)}/x`, 'g'.repeat(64), 64]) expect(normalizeProcessedModelHash(bad)).toBe(null);
  });
});

describe('an upper-case hash', () => {
  it('is asked for in lower case, the form the server keys results by', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse());
    await client().parseParquetStream({ sha256: sha256.toUpperCase(), bytes: 1 }, () => {});
    expect(new URLSearchParams(calls()[0][0].split('?')[1]).get('sha256')).toBe(sha256);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(client().parseParquet({ sha256: sha256.toUpperCase(), bytes: 1 })).rejects.toMatchObject({ status: 404 });
    expect(calls()[1][0]).toContain(`/cache/geometry/${sha256}`);
  });
});

describe('a malformed hash', () => {
  // The hash becomes a path segment and a query value; anything else never reaches the network.
  for (const bad of ['', `${'a'.repeat(60)}/../x`, 'a'.repeat(63), 'g'.repeat(64)]) {
    it(`is refused before any request: ${JSON.stringify(bad.slice(0, 12))}`, async () => {
      await expect(client().parseParquet({ sha256: bad, bytes: 1 })).rejects.toThrow(/SHA-256 of its source file/);
      await expect(client().parseParquetStream({ sha256: bad, bytes: 1 }, () => {})).rejects.toThrow(/SHA-256 of its source file/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
