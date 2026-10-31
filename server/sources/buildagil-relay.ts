/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-origin relay for buildagil's openCDE API (`/api/buildagil/*`).
 * openapi.buildagil.com answers no CORS preflight (404, measured 2026-10-30),
 * so a browser can reach neither its API nor its token endpoint.
 *
 * Two route families (`buildagil-routes.ts`):
 *   - `oauth2/token`: the provider's form grants. The deployment's client
 *     secret is added here (`buildagil-token.ts`); it never reaches the browser.
 *   - `1.0/…`: enumerated reads, plus the read-only `POST 1.0/search`, each
 *     with the caller's bearer. No credential is held for these.
 *
 * Like the BIMcollab and Dalux relays: header allowlists both ways, no
 * cookies, manual redirects, streamed downloads, generic error logging.
 * Valid-token abuse still needs a WAF rate limit on /api/buildagil.
 */
import { forwardTokenGrant, readCapped } from '../shared/oauth-token-forward.js';
import { readLimitedText } from './bimcollab-relay-index.js';
import { BUILDAGIL_API_ORIGIN, isDownloadStorageUrl, relayedQuery, resolveBuildagilRoute } from './buildagil-routes.js';
import { BUILDAGIL_REGISTERED_REDIRECT_URIS, BUILDAGIL_TOKEN_URL, readBuildagilGrant, type BuildagilClientConfig } from './buildagil-token.js';

export interface BuildagilRelayConfig extends BuildagilClientConfig {
  readonly allowedOrigins: readonly string[];
  readonly upstreamTimeoutMs: number;
  /** Cap on token and search request bodies and on the token response. */
  readonly maxBodyBytes: number;
}
export interface BuildagilRelayDeps { readonly fetchImpl: typeof fetch }

const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified', 'retry-after'];
const MAX_SEARCH_BODY_BYTES = 64 * 1024;

function json(status: number, body: unknown, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    ...cors, 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...extra,
  } });
}

/**
 * Follows at most three redirects by hand. The bearer goes only to the API
 * origin. A download may hop to Azure blob storage (a pre-signed URL), which
 * is fetched WITHOUT the bearer; an Entra login redirect means the token was
 * not accepted. Anything else off-host is refused.
 */
async function fetchRestricted(fetchImpl: typeof fetch, target: URL, init: RequestInit, download: boolean): Promise<Response> {
  let current = target;
  let headers = new Headers(init.headers);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetchImpl(current.toString(), { ...init, headers, redirect: 'manual', credentials: 'omit' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Redirect without location');
    // A search POST is not a redirectable operation.
    if (init.method === 'POST') throw new Error('Search redirected');
    const next = new URL(location, current);
    if (next.hostname === 'login.microsoftonline.com') return new Response(null, { status: 401 });
    if (next.origin === BUILDAGIL_API_ORIGIN && current.origin === BUILDAGIL_API_ORIGIN && !next.username && !next.password) {
      current = next;
      continue;
    }
    if (!download || !isDownloadStorageUrl(next)) throw new Error('Off-host redirect');
    if (current.origin !== BUILDAGIL_API_ORIGIN && next.origin !== current.origin) throw new Error('Storage redirected off-host');
    headers = new Headers({ accept: headers.get('accept') ?? '*/*' });
    current = next;
  }
  throw new Error('Too many redirects');
}

export function createBuildagilRelayHandler(config: BuildagilRelayConfig, deps: BuildagilRelayDeps) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const allowed = !origin || config.allowedOrigins.includes(origin);
    const cors: Record<string, string> = origin && allowed ? {
      'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Accept, Content-Type',
      'access-control-expose-headers': RESPONSE_HEADERS.join(', '),
      'access-control-max-age': '600', vary: 'Origin',
    } : {};
    if (!allowed) return json(403, { error: 'Origin not allowed' }, {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    // Vercel's rewrite (`/api/buildagil?path=:path*`) carries the path in the
    // query; the dev server passes the original URL.
    const path = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/buildagil\/?/, '');
    const route = resolveBuildagilRoute(path, request.method);
    if (!route) return json(400, { error: 'Not a relayable buildagil endpoint' }, cors);

    if (route.kind === 'token') {
      const form = await readBuildagilGrant(request, config);
      if (form instanceof Response) return form;
      return forwardTokenGrant({
        tokenUrl: BUILDAGIL_TOKEN_URL, form, clientSecret: config.clientSecret,
        vendor: 'buildagil', logTag: '[buildagil-relay]',
        upstreamTimeoutMs: config.upstreamTimeoutMs, maxBodyBytes: config.maxBodyBytes, fetchImpl: deps.fetchImpl,
      });
    }

    const authorization = request.headers.get('authorization');
    if (!authorization || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(authorization)) {
      return json(401, { error: 'unauthorized' }, cors);
    }
    const query = relayedQuery(url.search, route.queryKeys);
    if (query === null) return json(400, { error: 'Query parameters are not allowed for this endpoint' }, cors);
    route.target.search = query;
    const headers = new Headers({ authorization, accept: request.headers.get('accept') ?? 'application/json' });
    let body: string | undefined;
    if (route.method === 'POST') {
      // Browsers attach Origin to every POST; one without it is not the viewer.
      if (!origin) return json(403, { error: 'Origin required' }, cors);
      if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(415, { error: 'Content-Type must be application/json' }, cors);
      }
      const read = await readCapped(request.body, request.headers.get('content-length'), MAX_SEARCH_BODY_BYTES);
      if (!read.ok) return json(read.reason === 'too_large' ? 413 : 400, { error: 'Request body too large or not UTF-8' }, cors);
      body = read.text;
      headers.set('content-type', 'application/json');
    }
    try {
      const response = await fetchRestricted(deps.fetchImpl, route.target,
        { method: request.method, headers, body, signal: request.signal }, route.download);
      if (!response.ok) {
        const detail = await readLimitedText(response, 4096);
        const retryAfter = response.headers.get('retry-after');
        return json(response.status, { error: response.status === 401 ? 'unauthorized' : 'upstream_error', detail }, cors,
          retryAfter && (response.status === 429 || response.status === 503) ? { 'retry-after': retryAfter } : {});
      }
      const responseHeaders = new Headers({ ...cors, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders.set(name, value);
      }
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      // Deliberately generic: upstream exceptions can contain URLs and tokens.
      console.warn('[buildagil-relay] upstream request failed:', error instanceof Error ? error.name : typeof error);
      return json(502, { error: 'Upstream request failed' }, cors);
    }
  };
}

function originOf(uri: string): string | undefined {
  try {
    return new URL(uri).origin;
  } catch {
    console.warn('[buildagil-relay] ignoring a redirect URI that is not a URL:', uri);
    return undefined;
  }
}

function listFromEnv(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Server-only env (never `VITE_*`, which is compiled into the bundle):
 *
 *   BUILDAGIL_CLIENT_ID               required for sign-in
 *   BUILDAGIL_CLIENT_SECRET           required for sign-in
 *   BUILDAGIL_REDIRECT_URIS           comma-separated; default: the registered callbacks
 *   BUILDAGIL_RELAY_ALLOWED_ORIGINS   comma-separated; default: APP_URL + the callbacks' origins
 */
export function loadBuildagilRelayConfig(env: Record<string, string | undefined>): BuildagilRelayConfig {
  const redirects = listFromEnv(env.BUILDAGIL_REDIRECT_URIS);
  const allowedRedirectUris = redirects.length > 0 ? redirects : [...BUILDAGIL_REGISTERED_REDIRECT_URIS];
  const origins = listFromEnv(env.BUILDAGIL_RELAY_ALLOWED_ORIGINS);
  const defaults = [env.APP_URL, ...allowedRedirectUris.map(originOf)].filter((value): value is string => !!value);
  return {
    clientId: (env.BUILDAGIL_CLIENT_ID ?? '').trim(),
    clientSecret: (env.BUILDAGIL_CLIENT_SECRET ?? '').trim(),
    allowedRedirectUris,
    allowedOrigins: origins.length > 0 ? origins : [...new Set(defaults)],
    upstreamTimeoutMs: 10_000,
    maxBodyBytes: 16 * 1024,
  };
}
