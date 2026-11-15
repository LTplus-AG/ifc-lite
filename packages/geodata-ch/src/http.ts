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
  /**
   * Cap on one backoff delay in ms, before jitter. Default 32000. It also caps
   * `Retry-After` (seconds or HTTP-date): a longer server-requested wait is
   * cut to this, so raise it to honour long waits in full.
   */
  maxDelayMs?: number;
  /**
   * Sent as `User-Agent` only where the runtime allows it without a CORS
   * preflight: Node, Deno and Bun. Never sent from browsers or web workers.
   * Generic by default; `null` sends none.
   */
  userAgent?: string | null;
  /**
   * Per-attempt timeout in ms, covering headers and body. A stalled socket
   * aborts the attempt with an `HttpTimeoutError`, which is retried like any
   * other transient failure within `maxRetries`. Default 30 000; `0` or
   * `Infinity` disables it.
   */
  timeoutMs?: number;
  /** Injected for tests. Receives the request's abort signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests; returns epoch ms (also the reference for an HTTP-date `Retry-After`). */
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

/** A single attempt exceeded `timeoutMs`. `status` is `null`. */
export class HttpTimeoutError extends HttpError {
  constructor(
    url: string,
    readonly timeoutMs: number,
  ) {
    super(`GET ${url} timed out after ${timeoutMs} ms`, url, null);
    this.name = 'HttpTimeoutError';
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip the cache for this request (read and write). */
  noCache?: boolean;
  /**
   * Called once per network send (each retry is a send, a cache hit is none).
   * Lets a caller count the requests its own call put on the wire, which the
   * shared `requestCount` cannot do while other calls run on the same client.
   */
  onSend?: () => void;
}

export const DEFAULT_USER_AGENT = 'ifc-lite-geodata-ch';
export const DEFAULT_TIMEOUT_MS = 30_000;

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

/**
 * `User-Agent` may be set where the runtime is a server runtime (Node, Deno,
 * Bun). Detected by capability, not by the absence of `document`: a web
 * worker has no `document` yet forbids or preflights the header, so any
 * browser-like global rules it out even when a bundler polyfills `process`.
 */
export function canSetUserAgent(): boolean {
  const g = globalThis as {
    window?: unknown;
    document?: unknown;
    WorkerGlobalScope?: unknown;
    Deno?: unknown;
    Bun?: unknown;
    process?: { versions?: { node?: string } };
  };
  if (g.window !== undefined || g.document !== undefined || g.WorkerGlobalScope !== undefined) return false;
  return g.Deno !== undefined || g.Bun !== undefined || typeof g.process?.versions?.node === 'string';
}

/** One attempt's signal: aborts on the caller's signal or on the timeout, and says which. */
function attemptSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; timedOut: () => boolean; dispose: () => void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: caller, timedOut: () => false, dispose: () => {} };
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const ctl = new AbortController();
  const onTimeout = (): void => ctl.abort(timeout.reason);
  const onCaller = (): void => ctl.abort(caller?.reason);
  timeout.addEventListener('abort', onTimeout, { once: true });
  if (caller?.aborted) onCaller();
  else caller?.addEventListener('abort', onCaller, { once: true });
  return {
    signal: ctl.signal,
    timedOut: () => timeout.aborted && !caller?.aborted,
    dispose: () => {
      timeout.removeEventListener('abort', onTimeout);
      caller?.removeEventListener('abort', onCaller);
    },
  };
}

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly cache?: ResponseCache;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly userAgent: string | null;
  private readonly timeoutMs: number;
  private readonly sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
    this.userAgent = canSetUserAgent() ? (options.userAgent === undefined ? DEFAULT_USER_AGENT : options.userAgent) : null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(this.timeoutMs >= 0)) throw new Error('timeoutMs must be >= 0');
    this.sleepImpl = options.sleep;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return this.sleepImpl ? this.sleepImpl(ms, signal) : defaultSleep(ms, signal);
  }

  /** Reserve the next send slot for `host` and wait for it. */
  private async throttle(host: string, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + this.minIntervalMs);
    await this.sleep(slot - now, signal);
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter?.trim();
    if (ra) {
      // Seconds form, or an HTTP-date (RFC 9110 §10.2.3); both capped like the backoff.
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, this.maxDelayMs);
      const at = Date.parse(ra);
      if (Number.isFinite(at)) return Math.min(Math.max(at - this.now(), 0), this.maxDelayMs);
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
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    const host = hostOf(url);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      await this.throttle(host, options.signal);
      const attemptCtl = attemptSignal(options.signal, this.timeoutMs);
      let retryAfter: string | null = null;
      try {
        this.requestCount++;
        options.onSend?.();
        const res = await this.fetchImpl(url, { headers, signal: attemptCtl.signal });
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
        retryAfter = res.headers.get('retry-after');
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (err instanceof HttpError && err.status !== null) throw err; // final non-retryable status
        lastError = attemptCtl.timedOut() ? new HttpTimeoutError(url, this.timeoutMs) : err;
      } finally {
        attemptCtl.dispose();
      }
      if (attempt < this.maxRetries) await this.sleep(this.backoffMs(attempt, retryAfter), options.signal);
    }
    if (lastError instanceof HttpTimeoutError) throw lastError;
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
