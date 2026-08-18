/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-origin relay for the Dalux Build API.
 *
 * Dalux sends no CORS headers, so a browser cannot call it directly and the
 * app must forward through its own origin. The naive way to do that is a
 * blanket `vercel.json` rewrite, which is what this replaces: a rewrite turns
 * the deployment into an unauthenticated, method-agnostic proxy into an
 * authenticated per-tenant API. Anyone who learns the URL can drive Dalux
 * through our egress IPs, so Dalux's abuse controls would throttle *us*, and
 * every byte is billed to us.
 *
 * This handler keeps the CORS fix and drops the proxy:
 *
 *   - GET/HEAD only, so no writes can be relayed.
 *   - A caller-supplied `X-API-KEY` is mandatory. The relay holds no
 *     credential of its own, so it can never be used to read data anonymously.
 *   - The upstream path must match one of the API versions the provider
 *     actually calls, so the relay cannot reach admin or write endpoints even
 *     with a valid key.
 *   - Only an explicit header allowlist is forwarded, in both directions.
 *     Cookies never cross in either direction: the relay is same-origin, so
 *     without this the browser's own first-party cookies would be handed to a
 *     third party.
 *
 * Residual risk, deliberately documented rather than papered over: a caller
 * with their own valid Dalux key can still use this to reach Dalux from our
 * IPs, and key-guessing traffic is still anonymised. Neither is fixable in a
 * stateless handler. Put a Vercel WAF rate-limit rule on `/api/dalux` — see
 * the README section this file is referenced from.
 */

export interface DaluxRelayConfig {
  /** Upstream origin, no trailing slash. */
  readonly upstreamOrigin: string;
  /** Upstream base path the allowed path is appended to, no trailing slash. */
  readonly upstreamBasePath: string;
  /**
   * Leading path segments the provider legitimately calls. Anything else is
   * rejected before a request leaves our infrastructure.
   */
  readonly allowedPathPrefixes: readonly string[];
  /** Browser origins allowed to read the response. */
  readonly allowedOrigins: readonly string[];
}

/**
 * Query parameter naming which Dalux node to reach (#2792).
 *
 * Dalux assigns each customer a node and shows it on the same page as the API
 * key, so a user on node2+ could not use Dalux Box at all: the client's URL no
 * longer matched the declared relay upstream, so it was never rewritten to the
 * same-origin relay, and Dalux sends no CORS headers.
 *
 * The client sends the node NAME, never a URL, and the origin is assembled
 * here from {@link DALUX_NODE_PATTERN}. That is deliberate: accepting a
 * caller-supplied base URL would turn this relay into an open proxy that
 * forwards the caller's `X-API-KEY` to any host they name. The whole point of
 * pinning the origin is that the key cannot leave Dalux.
 */
export const DALUX_NODE_PARAM = 'daluxNode';

/** `node1`, `node2`, ... and nothing else. Anchored; no dots, no userinfo. */
const DALUX_NODE_PATTERN = /^node[1-9][0-9]{0,2}$/;

/** Origin for a validated node name. */
function originForNode(node: string): string {
  return `https://${node}.field.dalux.com`;
}

/**
 * Resolve the upstream origin for a request.
 *
 * Returns `null` for a present-but-invalid node so the caller can answer 400
 * rather than silently falling back to node1 — a user whose node was rejected
 * must be told, not quietly pointed at someone else's node where every call
 * would fail authentication in a confusing way.
 */
export function resolveUpstreamOrigin(
  requested: string | null,
  config: DaluxRelayConfig,
): string | null {
  if (requested === null || requested === '') return config.upstreamOrigin;
  if (!DALUX_NODE_PATTERN.test(requested)) return null;
  return originForNode(requested);
}

export const DEFAULT_DALUX_RELAY_CONFIG: DaluxRelayConfig = {
  upstreamOrigin: 'https://node1.field.dalux.com',
  upstreamBasePath: '/service/api',
  // The API versions packages/source-dalux actually calls. Adding a version
  // here is a deliberate act, which is the point.
  allowedPathPrefixes: ['2.0', '5.0', '5.1', '6.1'],
  allowedOrigins: [],
};

/** Request headers forwarded upstream. Notably absent: cookie, authorization. */
const FORWARDED_REQUEST_HEADERS = ['x-api-key', 'accept', 'range', 'if-none-match'];

/** Response headers passed back. Notably absent: set-cookie. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'retry-after',
  'last-modified',
];

export interface DaluxRelayDeps {
  readonly fetchImpl: typeof fetch;
}

/** Thrown when the upstream redirects to a host other than the upstream. */
export class OffHostRedirectError extends Error {
  constructor(readonly location: string) {
    super(`Upstream redirected off-host to ${location}`);
    this.name = 'OffHostRedirectError';
  }
}

const MAX_REDIRECTS = 3;

/**
 * Fetches `target`, following 3xx redirects manually but ONLY while they stay
 * on the upstream host, so the forwarded `X-API-KEY` can never leave it.
 *
 * fetch's own `redirect: 'follow'` strips `Authorization`/`Cookie` on a
 * cross-origin hop but keeps custom headers, which would hand the caller's key
 * to whatever host an open redirect names. A same-host redirect (e.g. a
 * download endpoint bouncing within `node1.field.dalux.com`) is still legal and
 * is followed; anything off-host throws {@link OffHostRedirectError}.
 */
async function followSameHost(
  fetchImpl: typeof fetch,
  target: URL,
  init: { method: string; headers: Headers },
): Promise<Response> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current.toString(), { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    const next = new URL(location, current);
    if (next.origin !== target.origin) throw new OffHostRedirectError(next.toString());
    current = next;
  }
  throw new Error(`Exceeded ${MAX_REDIRECTS} same-host redirects`);
}

function jsonError(status: number, message: string, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

function corsHeaders(origin: string | null, config: DaluxRelayConfig): Record<string, string> {
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'X-API-KEY, Accept, Range, If-None-Match',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/**
 * Validates the caller-supplied path and returns the upstream path, or null.
 *
 * Rejects traversal and absolute/protocol-relative forms. Decoding happens
 * before the checks so that an encoded `..` cannot slip past, and the result is
 * re-encoded per segment so legitimate names containing spaces still work.
 */
export function resolveUpstreamPath(rawPath: string, config: DaluxRelayConfig): string | null {
  if (!rawPath) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.startsWith('/') || decoded.includes('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;

  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment === '')) return null;

  const [version] = segments;
  if (!config.allowedPathPrefixes.includes(version)) return null;

  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

export function createDaluxRelayHandler(
  config: DaluxRelayConfig,
  deps: DaluxRelayDeps,
): (request: Request) => Promise<Response> {
  return async function handleDaluxRelay(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin, config);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonError(405, 'Only GET and HEAD are relayed', cors);
    }

    // A browser always sends Origin on a cross-origin request. Same-origin
    // requests may omit it, so this cannot be a general auth check, but it does
    // reject the obvious case of another site pointing at this endpoint.
    if (origin && !config.allowedOrigins.includes(origin)) {
      return jsonError(403, 'Origin not allowed', {});
    }

    const apiKey = request.headers.get('x-api-key');
    if (!apiKey?.trim()) {
      return jsonError(401, 'Missing X-API-KEY. This relay holds no credentials of its own.', cors);
    }

    const url = new URL(request.url);
    // Vercel rewrites `/api/dalux/:path*` onto this function carrying the tail
    // as `?path=`; the local dev server hits the pathname directly. Accept
    // both so dev and production cannot diverge on which paths are allowed.
    const rawPath = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/dalux\/?/, '');
    const upstreamPath = resolveUpstreamPath(rawPath, config);
    if (!upstreamPath) {
      return jsonError(400, 'Path is not a relayable Dalux Build endpoint', cors);
    }

    // `path` and the node selector are OUR routing parameters, not Dalux query
    // params. Forwarding them would put them in the upstream query string.
    const forwardedParams = new URLSearchParams(url.search);
    forwardedParams.delete('path');
    forwardedParams.delete(DALUX_NODE_PARAM);
    const query = forwardedParams.toString();

    const upstreamOrigin = resolveUpstreamOrigin(url.searchParams.get(DALUX_NODE_PARAM), config);
    if (upstreamOrigin === null) {
      return jsonError(400, 'Unknown Dalux node', cors);
    }

    const upstream = new URL(
      `${upstreamOrigin}${config.upstreamBasePath}/${upstreamPath}${query ? `?${query}` : ''}`,
    );

    const forwardedHeaders = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) forwardedHeaders.set(name, value);
    }

    let response: Response;
    try {
      response = await followSameHost(deps.fetchImpl, upstream, {
        method: request.method,
        headers: forwardedHeaders,
      });
    } catch (err) {
      if (err instanceof OffHostRedirectError) {
        // A 3xx pointing off the upstream host would, if followed, re-send the
        // caller's X-API-KEY to that host — fetch strips Authorization/Cookie
        // across origins but NOT a custom header. Refuse rather than leak.
        return jsonError(502, 'Upstream redirected off-host; refusing to forward credentials', cors);
      }
      // Never include the request headers here: they carry the caller's key.
      const reason = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Upstream request failed: ${reason}`, cors);
    }

    const responseHeaders = new Headers(cors);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('cache-control', 'no-store');

    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}

/** Parses `DALUX_RELAY_ALLOWED_ORIGINS` (comma-separated) into config. */
export function loadDaluxRelayConfig(env: Record<string, string | undefined>): DaluxRelayConfig {
  const raw = env.DALUX_RELAY_ALLOWED_ORIGINS ?? env.APP_URL ?? '';
  const allowedOrigins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return { ...DEFAULT_DALUX_RELAY_CONFIG, allowedOrigins };
}
