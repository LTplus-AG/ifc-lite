/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one HTTP path every request in this package takes: injected `fetch`,
 * an optional cache hook, a per-host request-rate limit, and retries with
 * truncated exponential backoff plus jitter, as geo.admin.ch's own guidance
 * asks of clients (https://docs.geo.admin.ch/get-started/retry.html).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A cached response body. Only successful (200/206) responses are cached. */
export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/**
 * Cache hook. The key is the URL plus the `Range` header, if any. A
 * `Map`-backed object, IndexedDB or a file cache all fit.
 */
export interface ResponseCache {
  get(key: string): Promise<CachedResponse | undefined> | CachedResponse | undefined;
  set(key: string, value: CachedResponse): Promise<void> | void;
}

export interface HttpOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  cache?: ResponseCache;
  /**
   * Maximum requests per second to any one host. Default 5: the rate
   * ifc-site settled on against api3.geo.admin.ch. The FSDI terms ask for
   * fair use but publish no number.
   */
  requestsPerSecond?: number;
  /** Retries after the first attempt. Default 5. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles per retry. Default 1000. */
  baseDelayMs?: number;
  /** Cap on one backoff delay in ms, before jitter. Default 32000. */
  maxDelayMs?: number;
  /** Sent as `User-Agent` where the runtime allows it (not browsers). Generic by default. */
  userAgent?: string;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; returns ms. */
  now?: () => number;
  /** Injected for tests; returns [0, 1). */
  random?: () => number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip the cache for this request (read and write). */
  noCache?: boolean;
}

export const DEFAULT_USER_AGENT = 'ifc-lite-geodata-ch';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch (err) {
    throw new HttpError(`invalid URL: ${String(err)}`, url, null);
  }
}

function isBrowser(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== 'undefined';
}

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly cache?: ResponseCache;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly userAgent: string;
  private readonly sleepImpl?: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  /** Next permitted send time per host. */
  private readonly nextSlot = new Map<string, number>();
  /** Requests actually sent over the network (cache hits excluded). */
  requestCount = 0;

  constructor(options: HttpOptions = {}) {
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error('No fetch implementation: pass options.fetch');
    this.fetchImpl = f;
    this.cache = options.cache;
    const rps = options.requestsPerSecond ?? 5;
    if (!(rps > 0)) throw new Error('requestsPerSecond must be > 0');
    this.minIntervalMs = 1000 / rps;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 32000;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.sleepImpl = options.sleep;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return this.sleepImpl ? this.sleepImpl(ms) : defaultSleep(ms, signal);
  }

  /** Reserve the next send slot for `host` and wait for it. */
  private async throttle(host: string, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + this.minIntervalMs);
    await this.sleep(slot - now, signal);
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, this.maxDelayMs);
    }
    const exp = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    return exp + this.random() * this.baseDelayMs;
  }

  /** GET `url`, returning status, headers and body. Throws `HttpError` on a non-2xx final status. */
  async get(url: string, options: RequestOptions = {}): Promise<CachedResponse> {
    const range = options.headers?.Range ?? options.headers?.range;
    const key = range ? `${url}#range=${range}` : url;
    if (this.cache && !options.noCache) {
      const hit = await this.cache.get(key);
      if (hit) return hit;
    }
    const headers: Record<string, string> = { ...options.headers };
    if (!isBrowser()) headers['User-Agent'] = this.userAgent;
    const host = hostOf(url);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      await this.throttle(host, options.signal);
      let res: Response;
      try {
        this.requestCount++;
        res = await this.fetchImpl(url, { headers, signal: options.signal });
      } catch (err) {
        if (options.signal?.aborted) throw err;
        lastError = err;
        if (attempt < this.maxRetries) await this.sleep(this.backoffMs(attempt, null), options.signal);
        continue;
      }
      if (res.ok) {
        const out: CachedResponse = {
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: await res.arrayBuffer(),
        };
        if (this.cache && !options.noCache) await this.cache.set(key, out);
        return out;
      }
      const body = await res.text().catch((err: unknown) => `<unreadable body: ${String(err)}>`);
      if (!RETRYABLE_STATUS.has(res.status) || attempt === this.maxRetries) {
        throw new HttpError(`GET ${url} failed with HTTP ${res.status}`, url, res.status, body.slice(0, 500));
      }
      lastError = new HttpError(`HTTP ${res.status}`, url, res.status);
      await this.sleep(this.backoffMs(attempt, res.headers.get('retry-after')), options.signal);
    }
    throw new HttpError(
      `GET ${url} failed after ${this.maxRetries + 1} attempts: ${String(lastError)}`,
      url,
      lastError instanceof HttpError ? lastError.status : null,
    );
  }

  async getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.get(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
    const text = new TextDecoder().decode(res.body);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new HttpError(`GET ${url} returned invalid JSON: ${String(err)}`, url, res.status, text.slice(0, 500));
    }
  }
}

/** Build a query string from defined values. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  return sp.toString();
}
