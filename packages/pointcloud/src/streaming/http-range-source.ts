/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RangeByteSource` over HTTP Range requests (#6869).
 *
 * A COPC file is read a few kilobytes at a time: header, hierarchy pages,
 * then only the octree nodes the camera needs. This source never falls back
 * to downloading the whole file: a server that ignores `Range` (answers 200)
 * is rejected, because silently streaming a multi-gigabyte body into memory
 * is exactly what COPC exists to avoid.
 *
 * Every response is checked against what was asked: status 206, a
 * `Content-Range` whose window matches the request, a body of that length,
 * and a total size that does not change between requests (a file replaced
 * mid-session would otherwise mix bytes from two versions).
 *
 * Cross-origin, `Content-Range` is readable only when the server lists it
 * in `Access-Control-Expose-Headers`, and public buckets often do not (the
 * PDAL/Hobu S3 samples, for one). Then the size comes from a HEAD request's
 * `Content-Length` (CORS-safelisted) and each window is checked by status
 * and exact body length instead.
 */

import type { RangeByteSource } from './types.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpRangeSourceOptions {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Extra request headers (e.g. `Authorization`). `Range` is always set by the source. */
  headers?: Record<string, string>;
  /**
   * Bytes fetched by `open()` and kept: the LAS header and leading VLRs of a
   * COPC file fit in the default, so opening costs a single request.
   */
  prefetchBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_PREFETCH = 64 * 1024;

interface ContentRange {
  start: number;
  last: number;
  total: number;
}

function parseContentRange(value: string | null): ContentRange | null {
  const m = value ? /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value.trim()) : null;
  if (!m) return null;
  const [start, last, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![start, last, total].every(Number.isSafeInteger) || last < start || last >= total) return null;
  return { start, last, total };
}

export class HttpRangeSource implements RangeByteSource {
  private constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike,
    private readonly headers: Record<string, string>,
    readonly size: number,
    private readonly prefix: Uint8Array,
  ) {}

  /** Issue the first range request, learn the file size, keep the prefix. */
  static async open(url: string, options: HttpRangeSourceOptions = {}): Promise<HttpRangeSource> {
    const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    const headers = options.headers ?? {};
    const prefetch = Math.max(1, Math.floor(options.prefetchBytes ?? DEFAULT_PREFETCH));
    const first = await rangeRequest(url, fetchImpl, headers, 0, prefetch, null, options.signal);
    const total = first.total ?? await headContentLength(url, fetchImpl, headers, options.signal);
    // Without Content-Range the prefix can only be trusted up to the size.
    const expected = Math.min(prefetch, total);
    if (first.bytes.length !== expected) {
      throw new Error(`HTTP Range: body length ${first.bytes.length} does not match the requested ${expected} bytes`);
    }
    return new HttpRangeSource(url, fetchImpl, headers, total, first.bytes);
  }

  async read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(end, this.size);
    if (!(safeEnd > safeStart)) return new Uint8Array(0);
    if (safeEnd <= this.prefix.length) return this.prefix.slice(safeStart, safeEnd);
    const res = await rangeRequest(this.url, this.fetchImpl, this.headers, safeStart, safeEnd, this.size, signal);
    return res.bytes;
  }
}

async function rangeRequest(
  url: string,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  start: number,
  end: number,
  expectedTotal: number | null,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; total: number | null }> {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, {
    headers: { ...headers, Range: `bytes=${start}-${end - 1}` },
    signal,
  });
  if (response.status !== 206) {
    // Cancel rather than drain: a 200 would otherwise stream the whole file.
    await response.body?.cancel().catch((err: unknown) => {
      console.warn('[HttpRangeSource] body cancel failed:', err);
    });
    throw new Error(
      `HTTP Range request for bytes ${start}-${end - 1} answered ${response.status}; `
      + 'the server must support Range requests (206 Partial Content) to stream this file',
    );
  }
  const rawRange = response.headers.get('Content-Range');
  if (rawRange === null) {
    // Hidden by CORS (see the file header): fall back to an exact length check.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (expectedTotal !== null && bytes.length !== end - start) {
      throw new Error(`HTTP Range: body length ${bytes.length} does not match the requested ${end - start} bytes`);
    }
    return { bytes, total: null };
  }
  const range = parseContentRange(rawRange);
  if (!range) {
    throw new Error(`HTTP Range response has an invalid Content-Range header (${rawRange})`);
  }
  if (expectedTotal !== null && range.total !== expectedTotal) {
    throw new Error(`HTTP Range: remote file size changed from ${expectedTotal} to ${range.total} bytes`);
  }
  // The server may only shorten the window at end of file.
  const expectedLast = Math.min(end - 1, range.total - 1);
  if (range.start !== start || range.last !== expectedLast) {
    throw new Error(
      `HTTP Range: asked for bytes ${start}-${expectedLast}, Content-Range says ${range.start}-${range.last}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== range.last - range.start + 1) {
    throw new Error(
      `HTTP Range: body length ${bytes.length} does not match Content-Range ${range.start}-${range.last}`,
    );
  }
  return { bytes, total: range.total };
}

async function headContentLength(
  url: string,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<number> {
  const response = await fetchImpl(url, { method: 'HEAD', headers, signal });
  const length = Number(response.headers.get('Content-Length'));
  if (!response.ok || !Number.isSafeInteger(length) || length <= 0) {
    throw new Error('HTTP Range: cannot determine the file size (no readable Content-Range or Content-Length)');
  }
  return length;
}
