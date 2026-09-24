/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a `network.fetch` request is actually issued — shared by
 * the sandbox's `bim.network.fetch` bridge (`bridge-network.ts`) and the
 * `HttpRequest` flow node (`@ifc-lite/flow-nodes`), so the allow-list
 * check, redirect policy, timeout, and body cap live in exactly one
 * implementation rather than two that could drift.
 *
 * Grammar this module enforces (see #5167 phase 3.3):
 *   - `network.fetch:<host-pattern>` grants are matched against
 *     `new URL(url).hostname` ONLY — never the raw URL string — so
 *     userinfo tricks (`user@api.example.com@evil.net`, which `new URL`
 *     parses with hostname `evil.net`) and suffix tricks
 *     (`api.example.com.evil.net`) are rejected by construction: the
 *     grant's per-label pattern (from `@ifc-lite/extensions`' capability
 *     target grammar) must match the hostname label-for-label.
 *   - Only `https:` requests are permitted. `http:`, `file:`, `data:`,
 *     and every other scheme are refused before any grant check runs —
 *     a deliberate scope cut for this phase (see module-level doc in
 *     `bridge-network.ts` for the tradeoff).
 *   - Redirects are refused outright (`redirect: 'manual'`, and a 3xx
 *     response is reported as a denial rather than followed). This is a
 *     conservative simplification of "refuse a redirect to an ungranted
 *     host": it also refuses a redirect to a *granted* host, but it is
 *     the one policy that behaves identically in Node (this module's
 *     runtime) and in a browser, where `Location` on an opaque manual
 *     redirect is not readable at all for a cross-origin response.
 *   - The response body is read incrementally and aborted the instant it
 *     exceeds `maxBytes` — never buffered whole first.
 *   - `Host`, `Cookie`, and the hop-by-hop headers are stripped from the
 *     caller-supplied header set unconditionally.
 */

import { hasCapability, parseCapability, type Capability } from '@ifc-lite/extensions';

export type NetworkMethod = 'GET' | 'POST';

export interface NetworkRequestInit {
  readonly url: string;
  readonly method: NetworkMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Hard wall-clock limit for the whole request, including any denial checks. */
  readonly timeoutMs: number;
  /** Maximum response body size in bytes; exceeding it aborts the read. */
  readonly maxBytes: number;
  /** Caller's own cancellation, combined with the timeout's. */
  readonly signal?: AbortSignal;
}

export interface NetworkResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
}

export class NetworkDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkDeniedError';
  }
}

/** Request headers no caller-supplied value may set — identity/session state the host, not the script, owns. */
const DENYLISTED_HEADERS = new Set([
  'host',
  'cookie',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
]);

/**
 * `AbortSignal.any` landed in Node 20 / evergreen browsers; combine the
 * caller's signal with a timeout signal so either one ends the request.
 */
function combinedSignal(timeoutMs: number, callerSignal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, callerSignal]);
}

/**
 * True iff `grants` includes a `network.fetch:<pattern>` capability whose
 * pattern matches `hostname` label-for-label (see `@ifc-lite/extensions`'
 * capability target grammar — a bare `*` label or a trailing-`*` label
 * matches within that one label; it never spans a `.`).
 */
export function isHostGranted(grants: readonly Capability[], hostname: string): boolean {
  const requested = parseCapability(`network.fetch:${hostname}`);
  if (!requested.ok) return false;
  return hasCapability(grants, requested.value);
}

function assertHttpsAndGranted(url: URL, grants: readonly Capability[]): void {
  if (url.protocol !== 'https:') {
    throw new NetworkDeniedError(`network.fetch refused: only https: URLs are permitted, got "${url.protocol}"`);
  }
  if (!isHostGranted(grants, url.hostname)) {
    throw new NetworkDeniedError(`network.fetch refused: host "${url.hostname}" is not covered by a granted network.fetch:<host> capability`);
  }
}

function sanitizeHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (DENYLISTED_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * True in a browser-like environment (the viewer), false in Node (CLI/MCP).
 * Read lazily, not cached: this only affects the wording of one error
 * message, so there is no reason to freeze it at module-load time.
 */
function isBrowserLike(): boolean {
  return typeof window !== 'undefined' && typeof (window as { document?: unknown }).document !== 'undefined';
}

/**
 * A browser's `fetch` rejects a cross-origin request the target host did
 * not allow via CORS with the SAME generic `TypeError: Failed to fetch` it
 * uses for "the network is down" or "DNS failed" — there is no way to tell
 * those apart from the rejection alone (the browser deliberately does not
 * expose why a cross-origin request failed, for the same reason it hides
 * `Location` on an opaque redirect). Rather than let that generic message
 * reach the graph author as an unexplained failure, name the most likely
 * cause explicitly when running in a browser: this is a documented,
 * necessarily-imprecise heuristic (see `network-request.ts`'s module doc),
 * not a real CORS detection.
 */
function describeFetchFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (isBrowserLike() && err instanceof TypeError) {
    return `${message} (this is usually the browser blocking a cross-origin request because the target host did not send an Access-Control-Allow-Origin header for this request — CORS applies to bim.network.fetch/HttpRequest in the viewer even though the host is granted; run the same graph via the CLI or MCP if the target does not support CORS)`;
  }
  return message;
}

/**
 * Read a response body incrementally, aborting the instant the byte cap is
 * exceeded — never via `response.text()`/`arrayBuffer()`, which buffer the
 * whole body before any cap could apply.
 */
async function readCappedBody(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        const keep = value.byteLength - (total - maxBytes);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        await reader.cancel('response exceeded maxBytes');
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(combined), truncated };
}

/**
 * The mechanical part of a request — timeout/signal combination, header
 * sanitisation, the manual-redirect refusal, and the capped body read —
 * with NO scheme or host-grant check. Exported so tests can exercise
 * redirect / oversize-body / timeout behaviour against a real local
 * `node:http` server (plain http, no TLS) without also having to stand up
 * TLS for the test fixture; production code reaches this ONLY through
 * `coreNetworkRequest`, which runs `assertHttpsAndGranted` first. Do not
 * call this directly from a bridge or node — it has no allow-list.
 */
/**
 * The transport a request travels over — `globalThis.fetch` unless a host or
 * a test supplies another. Injecting it changes HOW bytes move, never WHETHER
 * a request is allowed: `coreNetworkRequest` runs the scheme/host-grant check
 * before the transport is ever called.
 */
export type FetchTransport = (url: URL, init: RequestInit) => Promise<Response>;

export async function executeUngatedRequest(
  url: URL, init: Omit<NetworkRequestInit, 'url'>, transport: FetchTransport = (u, i) => fetch(u, i),
): Promise<NetworkResponse> {
  const signal = combinedSignal(init.timeoutMs, init.signal);
  const headers = sanitizeHeaders(init.headers);

  let response: Response;
  try {
    response = await transport(url, {
      method: init.method,
      headers,
      body: init.method === 'GET' ? undefined : init.body,
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    // The caller's own signal first: a cancelled run is not a timeout (#5446 review).
    if (init.signal?.aborted) throw new Error('network.fetch cancelled');
    if (signal.aborted) throw new Error(`network.fetch timed out after ${init.timeoutMs}ms`);
    throw new Error(`network.fetch failed: ${describeFetchFailure(err)}`);
  }

  // `redirect: 'manual'` surfaces a 3xx as an "opaqueredirect" response
  // (status 0, `type: 'opaqueredirect'`) in a browser — `Location` is not
  // readable cross-origin even same-scheme, which is strictly *less* than
  // Node's global fetch exposes (a real 3xx status with a readable
  // `Location` header). Refusing every redirect outright, rather than
  // trying to read and re-validate `Location`, is the one policy that
  // behaves identically in both runtimes: it never depends on being able
  // to read a header a browser will not hand over.
  if (response.status >= 300 && response.status < 400) {
    throw new NetworkDeniedError(`network.fetch refused: server responded with a redirect (${response.status}); redirects are not followed`);
  }
  if (response.type === 'opaqueredirect') {
    throw new NetworkDeniedError('network.fetch refused: server responded with a redirect; redirects are not followed');
  }

  const { text, truncated } = await readCappedBody(response, init.maxBytes);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return { status: response.status, headers: responseHeaders, body: text, truncated };
}

/**
 * Issue one `network.fetch` request. Throws `NetworkDeniedError` for any
 * scheme/host/redirect denial, and a plain `Error` for a timeout or a
 * transport failure.
 */
export async function coreNetworkRequest(
  init: NetworkRequestInit, grants: readonly Capability[], transport?: FetchTransport,
): Promise<NetworkResponse> {
  let url: URL;
  try {
    url = new URL(init.url);
  } catch {
    throw new NetworkDeniedError(`network.fetch refused: "${init.url}" is not a valid URL`);
  }
  assertHttpsAndGranted(url, grants);
  // `total > NaN` is always false, so a NaN cap would read the whole body:
  // every caller's bounds are checked here, where the cap is enforced (#5446 review).
  if (!Number.isFinite(init.maxBytes) || init.maxBytes < 0) {
    throw new RangeError(`network.fetch: maxBytes must be a finite number >= 0, got ${String(init.maxBytes)}`);
  }
  if (!Number.isFinite(init.timeoutMs) || init.timeoutMs < 1) {
    throw new RangeError(`network.fetch: timeoutMs must be a finite number >= 1, got ${String(init.timeoutMs)}`);
  }
  return executeUngatedRequest(url, init, transport);
}
