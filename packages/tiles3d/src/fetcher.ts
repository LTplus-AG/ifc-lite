/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Budgeted, cache-aware, abortable byte fetching shared by traversal and content loading. */

import { finiteNumber, limit } from './limits.js';
import type { UrlPolicy } from './url-policy.js';

/**
 * Minimal response surface the reader needs; the global `fetch` satisfies it.
 * `body` is read as a stream and stopped at the remaining byte budget; a
 * response without `body` is read whole with `arrayBuffer()`, so only a
 * streaming body bounds the memory a single response can take.
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: { getReader(): ReadableStreamDefaultReader<Uint8Array>; cancel?(reason?: unknown): Promise<void> } | null;
  /** Not used for the budget (Content-Length is the encoded size); kept so a response from `fetch` is accepted as is. */
  headers?: { get(name: string): string | null };
  /** Final URL after redirects; re-checked against the URL policy when it differs from the requested one. */
  url?: string;
}

export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

/**
 * Byte cache keyed by absolute URL, for both tileset JSON and tile content.
 * Hits do not count against the request budget.
 */
export interface TilesCache {
  get(url: string): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  set(url: string, bytes: Uint8Array): Promise<void> | void;
}

export interface FetchStats {
  /** Network requests issued (cache hits excluded). */
  requests: number;
  /**
   * Bytes received from the network, counted after transport decompression
   * (what `fetch` hands over), so a gzip-encoded tileset counts at its
   * decompressed size. Never exceeds `maxBytes`.
   */
  bytes: number;
  cacheHits: number;
}

/** Thrown internally when the next request, or the rest of a response, would exceed the budget. */
export class BudgetExhaustedError extends Error {
  constructor(readonly reason: 'requests' | 'bytes') {
    super(`3D Tiles request budget exhausted (${reason})`);
    this.name = 'BudgetExhaustedError';
  }
}

export class HttpError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs} ms: ${url}`);
    this.name = 'TimeoutError';
  }
}

export interface FetcherOptions {
  fetch?: FetchLike;
  cache?: TilesCache;
  maxRequests?: number;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export const DEFAULT_MAX_REQUESTS = 200;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export class BudgetedFetcher {
  readonly stats: FetchStats = { requests: 0, bytes: 0, cacheHits: 0 };
  private readonly fetchImpl: FetchLike;
  private readonly maxRequests: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  /** Set once a response was refused for bytes: no further request is issued. */
  private bytesRefused = false;
  /** URL policy applied to every requested URL and redirect target; set by the reader. */
  policy?: UrlPolicy;

  constructor(private readonly opts: FetcherOptions) {
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('No fetch implementation: pass options.fetch');
    this.fetchImpl = f;
    this.maxRequests = limit(opts.maxRequests, DEFAULT_MAX_REQUESTS, 'maxRequests');
    this.maxBytes = limit(opts.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
    // setTimeout coerces NaN, Infinity and anything above 2^31-1 to ~1 ms, which would time every request out at once.
    this.timeoutMs = finiteNumber(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', 1, 2 ** 31 - 1);
  }

  get signal(): AbortSignal | undefined {
    return this.opts.signal;
  }

  /** Throws the caller's abort reason if the run was aborted. */
  throwIfAborted(): void {
    this.opts.signal?.throwIfAborted();
  }

  /** True when no further network request may be issued. */
  exhausted(): 'requests' | 'bytes' | undefined {
    if (this.stats.requests >= this.maxRequests) return 'requests';
    if (this.bytesRefused || this.stats.bytes >= this.maxBytes) return 'bytes';
    return undefined;
  }

  async get(url: string): Promise<Uint8Array> {
    this.throwIfAborted();
    this.policy?.check(url);
    const cached = await this.opts.cache?.get(url);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    const over = this.exhausted();
    if (over) throw new BudgetExhaustedError(over);
    this.stats.requests++;

    const controller = new AbortController();
    const outer = this.opts.signal;
    const onAbort = (): void => controller.abort(outer?.reason);
    outer?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal, headers: this.opts.headers });
      if (!res.ok) {
        await res.body?.cancel?.().catch(() => undefined);
        throw new HttpError(url, res.status);
      }
      if (res.url && res.url !== url) this.policy?.check(res.url);
      const bytes = await this.readBody(res);
      await this.opts.cache?.set(url, bytes);
      return bytes;
    } catch (err) {
      outer?.throwIfAborted();
      if (timedOut) throw new TimeoutError(url, this.timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  private refuse(): never {
    this.bytesRefused = true;
    throw new BudgetExhaustedError('bytes');
  }

  /** Read a response body, stopping as soon as it would cross the remaining byte budget. */
  private async readBody(res: FetchResponseLike): Promise<Uint8Array> {
    const remaining = (): number => this.maxBytes - this.stats.bytes;
    // Content-Length is deliberately not used to refuse early: it is the encoded transfer size, which for a small or
    // incompressible gzip body exceeds the decoded size the budget counts, and a browser may hide Content-Encoding.
    // The stream below is stopped at the exact decoded count instead.
    if (!res.body || typeof res.body.getReader !== 'function') {
      const whole = new Uint8Array(await res.arrayBuffer());
      if (whole.byteLength > remaining()) this.refuse();
      this.stats.bytes += whole.byteLength;
      return whole;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > remaining()) {
        await reader.cancel().catch(() => undefined);
        this.refuse();
      }
      this.stats.bytes += value.byteLength;
      total += value.byteLength;
      chunks.push(value);
    }
    return concat(chunks, total);
  }
}
