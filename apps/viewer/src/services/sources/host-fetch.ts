/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RelayDeclaration } from '@ifc-lite/plugin-api';

// ============================================================================
// Fetch guards shared by the host's authenticated (`ctx.fetch`) and public
// (`ctx.fetchPublic`) fetch wrappers: host allowlist matching, the same-origin
// relay rewrite, and bounded 429/503 retry. Kept pure and dependency-free so
// they can be unit-tested without constructing a `SourceHost`.
// ============================================================================

// ---------------------------------------------------------------------------
// Relay registry — same-origin routes the app's own server actually forwards
// upstream, mirroring `vercel.json`'s rewrites and `vite.config.ts`'s dev
// proxy exactly. A provider's `manifest.permissions.relay` is checked against
// this at registration time (see `source-host.ts`); it is never trusted
// un-verified, so a provider cannot declare a relay that doesn't exist in
// production and silently start sending same-origin requests nowhere.
// ---------------------------------------------------------------------------

export const CONFIGURED_RELAY_ROUTES: ReadonlyMap<string, string> = new Map([
  ['/api/dalux', 'https://node1.field.dalux.com/service/api'],
]);

/**
 * Returns an error message if `relay` doesn't match a configured route
 * exactly (both `path` and `upstream` must agree), or `undefined` if it's
 * fine. Called once at `register()`, not on every request.
 */
export function validateRelayDeclaration(relay: RelayDeclaration): string | undefined {
  const configuredUpstream = CONFIGURED_RELAY_ROUTES.get(relay.path);
  if (configuredUpstream === relay.upstream) return undefined;

  const known = [...CONFIGURED_RELAY_ROUTES.entries()]
    .map(([path, upstream]) => `${path} -> ${upstream}`)
    .join(', ') || '(none configured)';
  return (
    `declares relay "${relay.path}" -> "${relay.upstream}", which does not match a route ` +
    `this host actually has configured. Configured relay routes: ${known}`
  );
}

/**
 * Rewrites `url` to its same-origin relay path if it targets the declared
 * upstream.
 *
 * Matching happens on the parsed, normalized URL rather than the raw caller
 * string for two reasons:
 *
 * 1. A plain `startsWith` has no path boundary. `relay.upstream` ending in
 *    `/service/api` would then also match `/service/apixyz` or
 *    `/service/api.evil.example`, because both share the same leading
 *    characters as `/service/api` without a `/` separating them. Requiring
 *    the byte right after the matched prefix to be `/`, `?`, `#`, or
 *    end-of-string closes that.
 * 2. Rewriting from the raw string would also copy along anything the caller
 *    embedded in it — `.` / `..` segments included — into the same-origin
 *    relay path this returns, where the server resolves the upstream a
 *    second time. Parsing with `new URL()` first normalizes those away
 *    before any rewrite happens.
 */
export function applyRelay(url: string, relay: RelayDeclaration | undefined, origin: string): string {
  if (!relay) return url;

  const normalized = new URL(url).toString();
  const upstream = relay.upstream.replace(/\/+$/, '');
  if (!normalized.startsWith(upstream)) return url;

  const rest = normalized.slice(upstream.length);
  if (rest !== '' && !rest.startsWith('/') && !rest.startsWith('?') && !rest.startsWith('#')) return url;

  return `${origin}${relay.path}${rest}`;
}

// ---------------------------------------------------------------------------
// Host allowlist matching
// ---------------------------------------------------------------------------

/**
 * Every outbound request from a source provider must be https — providers
 * only ever declare bare hostnames (no scheme) in `permissions.network`, and
 * silently permitting a downgrade to plaintext http for an otherwise-allowed
 * host would defeat the point of allowlisting it.
 */
export function isHttpsUrl(parsed: URL): boolean {
  return parsed.protocol === 'https:';
}

/** `*.example.com` matches any subdomain and the apex; anything else matches exactly. */
export function isAllowedHost(allowedDomains: readonly string[], hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase();

  return allowedDomains.some((pattern) => {
    const normalizedPattern = pattern.toLowerCase();
    if (normalizedPattern.startsWith('*.')) {
      const suffix = normalizedPattern.slice(2);
      return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === normalizedPattern;
  });
}

// ---------------------------------------------------------------------------
// Bounded retry on 429/503 with Retry-After
// ---------------------------------------------------------------------------

/** Total real fetch attempts, including the first — bounds worst-case load on a struggling upstream. */
export const MAX_FETCH_ATTEMPTS = 3;
/** Total time this wrapper will spend waiting across all retries of one call. */
export const MAX_TOTAL_RETRY_WAIT_MS = 30_000;

/**
 * Retries `attemptFetch` while it keeps returning `429`/`503` responses that
 * carry a `Retry-After` header, honoring that header's delay, up to
 * `MAX_FETCH_ATTEMPTS` total tries and `MAX_TOTAL_RETRY_WAIT_MS` of total
 * waiting. A `429`/`503` with no `Retry-After` is returned immediately on the
 * first attempt: without a server-given delay there is no principled wait
 * time, and blind retrying risks hammering an already-overloaded upstream.
 */
export async function fetchWithBoundedRetry(
  attemptFetch: () => Promise<Response>,
  signal: AbortSignal | null | undefined,
  method: string = 'GET',
): Promise<Response> {
  // Only replay idempotent requests. A 429/503 says the request was throttled,
  // NOT that it had no effect — an upstream that accepted a POST and then shed
  // load would get the body a second time, double-creating whatever it
  // described. GET/HEAD are safe to repeat by definition; everything else gets
  // exactly one attempt and the throttled response is handed back to the
  // provider to deal with.
  const upper = method.toUpperCase();
  const isIdempotent = upper === 'GET' || upper === 'HEAD';

  let totalWaitedMs = 0;

  for (let attempt = 1; ; attempt++) {
    const response = await attemptFetch();
    if (response.status !== 429 && response.status !== 503) return response;
    if (!isIdempotent) return response;

    const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
    if (retryAfterMs === undefined) return response;
    if (attempt >= MAX_FETCH_ATTEMPTS) return response;

    const waitMs = Math.min(retryAfterMs, MAX_TOTAL_RETRY_WAIT_MS - totalWaitedMs);
    if (waitMs <= 0) return response;

    totalWaitedMs += waitMs;
    await delay(waitMs, signal);
  }
}

/** Accepts either a `Retry-After: <seconds>` or a `Retry-After: <HTTP-date>` header value. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(headerValue);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/** Waits `ms` milliseconds, rejecting early if `signal` aborts mid-wait. */
export function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
