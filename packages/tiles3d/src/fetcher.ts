/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Budgeted, cache-aware, abortable byte fetching shared by traversal and content loading. */

/** Minimal response surface the reader needs; the global `fetch` satisfies it. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
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
  /** Bytes received from the network (after transport decompression). */
  bytes: number;
  cacheHits: number;
}

/** Thrown internally when the next request would exceed the budget. */
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

export const DEFAULT_MAX_REQUESTS = 200;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export class BudgetedFetcher {
  readonly stats: FetchStats = { requests: 0, bytes: 0, cacheHits: 0 };
  private readonly fetchImpl: FetchLike;
  private readonly maxRequests: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: FetcherOptions) {
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('No fetch implementation: pass options.fetch');
    this.fetchImpl = f;
    this.maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    if (this.stats.bytes >= this.maxBytes) return 'bytes';
    return undefined;
  }

  async get(url: string): Promise<Uint8Array> {
    this.throwIfAborted();
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
      if (!res.ok) throw new HttpError(url, res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      this.stats.bytes += bytes.byteLength;
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
}
