/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { HttpRangeSource } from './http-range-source.js';

/** Deterministic file body: byte i = (i * 31 + 7) & 0xff. */
function body(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

interface ServerOptions {
  /** Ignore Range and answer 200 with the full body. */
  ignoreRange?: boolean;
  /** Report this total instead of the real one. */
  claimTotal?: number;
  /**
   * Behave like a CORS response without `Access-Control-Expose-Headers`:
   * the browser hides Content-Range, but Content-Length stays readable.
   */
  hideContentRange?: boolean;
}

/**
 * A small RFC 9110 byte-range server over an in-memory body: it parses the
 * request's Range header and answers 206 + Content-Range like S3/nginx do.
 */
function rangeServer(file: Uint8Array, opts: ServerOptions = {}) {
  const requests: string[] = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'HEAD') {
      requests.push('HEAD');
      return new Response(null, { status: 200, headers: { 'Content-Length': String(file.length) } });
    }
    const range = new Headers(init?.headers).get('Range') ?? '';
    requests.push(range);
    if (opts.ignoreRange) return new Response(file.slice(), { status: 200 });
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response('bad range', { status: 400 });
    const start = Number(m[1]);
    const last = Math.min(Number(m[2]), file.length - 1);
    if (start >= file.length) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.length}` } });
    }
    const slice = file.slice(start, last + 1);
    const headers: Record<string, string> = opts.hideContentRange
      ? {}
      : { 'Content-Range': `bytes ${start}-${last}/${opts.claimTotal ?? file.length}` };
    return new Response(slice, { status: 206, headers });
  };
  return { fetchImpl, requests };
}

describe('HttpRangeSource (#6869)', () => {
  it('learns the size from Content-Range and returns exactly the requested window', async () => {
    const file = body(10_000);
    const server = rangeServer(file);
    const src = await HttpRangeSource.open('https://example.test/a.copc.laz', { fetch: server.fetchImpl, prefetchBytes: 512 });
    expect(src.size).toBe(10_000);
    const got = await src.read(4_000, 4_100);
    expect(Array.from(got)).toEqual(Array.from(file.subarray(4_000, 4_100)));
    expect(server.requests.at(-1)).toBe('bytes=4000-4099');
  });

  it('serves reads inside the prefetched prefix without another request', async () => {
    const file = body(10_000);
    const server = rangeServer(file);
    const src = await HttpRangeSource.open('https://example.test/a', { fetch: server.fetchImpl, prefetchBytes: 1_024 });
    const before = server.requests.length;
    const header = await src.read(0, 375);
    const vlr = await src.read(375, 589);
    expect(server.requests.length).toBe(before);
    expect(Array.from(header)).toEqual(Array.from(file.subarray(0, 375)));
    expect(Array.from(vlr)).toEqual(Array.from(file.subarray(375, 589)));
  });

  it('clamps reads at the end of the file like BlobByteSource', async () => {
    const file = body(2_000);
    const src = await HttpRangeSource.open('https://example.test/a', { fetch: rangeServer(file).fetchImpl, prefetchBytes: 64 });
    expect(Array.from(await src.read(1_990, 5_000))).toEqual(Array.from(file.subarray(1_990)));
    expect((await src.read(3_000, 4_000)).length).toBe(0);
  });

  it('rejects a server that ignores Range instead of downloading the whole file', async () => {
    const server = rangeServer(body(4_096), { ignoreRange: true });
    await expect(HttpRangeSource.open('https://example.test/a', { fetch: server.fetchImpl }))
      .rejects.toThrow(/Range/);
  });

  it('rejects a response whose Content-Range does not match the request', async () => {
    const file = body(10_000);
    const honest = rangeServer(file).fetchImpl;
    let calls = 0;
    // Honest for open(), then answers a different window than was asked for.
    const liar = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++;
      if (calls === 1) return honest(url, init);
      return new Response(new Uint8Array(100), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-99/10000' },
      });
    };
    const src = await HttpRangeSource.open('https://example.test/a', { fetch: liar, prefetchBytes: 16 });
    await expect(src.read(500, 600)).rejects.toThrow(/Content-Range/);
  });

  it('rejects a body shorter than its Content-Range claims', async () => {
    const short = async (): Promise<Response> => new Response(new Uint8Array(10), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-15/10000' },
    });
    await expect(HttpRangeSource.open('https://example.test/a', { fetch: short, prefetchBytes: 16 }))
      .rejects.toThrow(/length/);
  });

  it('rejects a total size that changes between requests (file replaced mid-read)', async () => {
    const file = body(10_000);
    let calls = 0;
    const server = rangeServer(file);
    const changing = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++;
      if (calls === 1) return server.fetchImpl(url, init);
      return rangeServer(file, { claimTotal: 12_000 }).fetchImpl(url, init);
    };
    const src = await HttpRangeSource.open('https://example.test/a', { fetch: changing, prefetchBytes: 16 });
    await expect(src.read(100, 200)).rejects.toThrow(/size changed/);
  });

  it('works when CORS hides Content-Range: size from HEAD, window checked by length', async () => {
    const file = body(10_000);
    const server = rangeServer(file, { hideContentRange: true });
    const src = await HttpRangeSource.open('https://example.test/a', { fetch: server.fetchImpl, prefetchBytes: 256 });
    expect(src.size).toBe(10_000);
    expect(server.requests).toContain('HEAD');
    expect(Array.from(await src.read(9_000, 9_100))).toEqual(Array.from(file.subarray(9_000, 9_100)));
    expect(Array.from(await src.read(9_950, 20_000))).toEqual(Array.from(file.subarray(9_950)));
  });

  it('with Content-Range hidden, a body of the wrong length is still rejected', async () => {
    const file = body(10_000);
    const honest = rangeServer(file, { hideContentRange: true }).fetchImpl;
    let ranged = 0;
    const short = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'HEAD' || ranged++ === 0) return honest(url, init);
      return new Response(new Uint8Array(7), { status: 206 });
    };
    const src = await HttpRangeSource.open('https://example.test/a', { fetch: short, prefetchBytes: 16 });
    await expect(src.read(100, 200)).rejects.toThrow(/length/);
  });

  it('honours an aborted signal before issuing a request', async () => {
    const server = rangeServer(body(1_000));
    const src = await HttpRangeSource.open('https://example.test/a', { fetch: server.fetchImpl, prefetchBytes: 16 });
    const ctrl = new AbortController();
    ctrl.abort();
    const before = server.requests.length;
    await expect(src.read(100, 200, ctrl.signal)).rejects.toThrow(/abort/i);
    expect(server.requests.length).toBe(before);
  });
});
