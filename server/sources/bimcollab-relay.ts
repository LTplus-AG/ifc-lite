/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-origin Documents relay. A blanket upstream rewrite would expose a
 * method-agnostic proxy through our egress IPs, billed to our deployment.
 * Instead, only enumerated reads with a caller's bearer are allowed. No
 * credentials are held here; cookies never cross in either direction.
 * Valid-token abuse still needs a WAF rate limit on /api/bimcollab.
 */
import { BIMCOLLAB_REGISTERED_REDIRECT_URIS } from '../bcf/oauth-token-relay.js';
import { bimcollabSpaceOrigin } from '../shared/bimcollab-space.js';
import { readIndex, readLimitedText } from './bimcollab-relay-index.js';

export interface BimcollabRelayConfig {
  readonly allowedOrigins: readonly string[];
}
export interface BimcollabRelayDeps { readonly fetchImpl: typeof fetch }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = '[A-Za-z0-9_-]+';
const DOC_PATHS = [
  /^(?:project-structure|projects|project-phases)$/,
  new RegExp(`^(?:projects|project-phases)/${ID}/(?:documents|document-sets)$`),
  new RegExp(`^documents/${ID}(?:/(?:document-versions|download))?$`),
  new RegExp(`^document-versions/${ID}(?:/download)?$`),
];
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified'];

export type BimcollabRoute = { target: URL; spaceGuid?: string; index: boolean; download?: boolean };

/** No decoding: tokens need no escapes, so encoded separators cannot sneak in. */
export function resolveBimcollabRoute(path: string): BimcollabRoute | null {
  if (path.includes('..') || path.includes('%') || path.includes('//')) return null;
  const parts = path.split('/');
  if (parts[0] === 'docs' && GUID.test(parts[1] ?? '')) {
    const rest = parts.slice(2).join('/');
    if (!DOC_PATHS.some(pattern => pattern.test(rest))) return null;
    return {
      target: new URL(`https://api.eu.bimcollab.com/spaces/${parts[1]}/documents/v1/${rest}`),
      spaceGuid: parts[1], index: false,
    };
  }
  if (parts[0] !== 'space') return null;
  const origin = bimcollabSpaceOrigin(parts[1] ?? '');
  if (!origin) return null;
  if (parts.length === 3 && parts[2] === 'index') {
    return { target: new URL(`${origin}/documents/api/documentapi/getdocuments`), index: true };
  }
  if (parts.length === 4 && parts[2] === 'download' && positiveInteger(parts[3])) {
    return { target: new URL(`${origin}/documents/da/location/0/project/0/documentinstance/download/${parts[3]}`), index: false, download: true };
  }
  return null;
}

export function positiveInteger(value: string | null): boolean {
  return value !== null && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    ...cors, 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } });
}

/** Manual redirects never leak the bearer to another origin, even on download. */
async function fetchRestricted(fetchImpl: typeof fetch, target: URL, init: RequestInit): Promise<Response> {
  let current = target;
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetchImpl(current.toString(), { ...init, redirect: 'manual', credentials: 'omit' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Redirect without location');
    const next = new URL(location, current);
    // An off-origin login URL is still rejected, never followed with credentials.
    if (next.origin !== target.origin || next.username || next.password) throw new Error('Off-host redirect');
    // BIMcollab's login lives at /identity/login, and under /documents for the
    // document-management app (`/documents/Identity/Account/Login`, measured).
    if (/^(?:\/documents)?\/(?:Identity\/Account\/Login|identity\/login)(?:\/|$)/i.test(next.pathname)) {
      return new Response(null, { status: 401 });
    }
    // Index POST is a fixed operation, not a redirectable write primitive.
    if (init.method === 'POST') throw new Error('Index redirected');
    current = next;
  }
  throw new Error('Too many redirects');
}

export function createBimcollabRelayHandler(config: BimcollabRelayConfig, deps: BimcollabRelayDeps) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const allowed = !origin || config.allowedOrigins.includes(origin);
    const cors: Record<string, string> = origin && allowed ? {
      'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Authorization, Accept',
      'access-control-expose-headers': RESPONSE_HEADERS.join(', '),
      'access-control-max-age': '600', vary: 'Origin',
    } : {};
    if (!allowed) return json(403, { error: 'Origin not allowed' }, {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'Only GET and HEAD are relayed' }, cors);
    const authorization = request.headers.get('authorization');
    if (!authorization || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(authorization)) {
      return json(401, { error: 'unauthorized' }, cors);
    }
    const url = new URL(request.url);
    const path = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/bimcollab\/?/, '');
    // Vercel's rewrite (`/api/bimcollab?path=:path*`) percent-encodes the
    // slashes it carries, so the DECODED value is what gets validated: the
    // resolver refuses any remaining `%`, `..`, `//` and non-allowlisted
    // segments, which also covers double-encoded separators.
    const route = resolveBimcollabRoute(path);
    if (!route) return json(400, { error: 'Path is not a relayable BIMcollab endpoint' }, cors);
    const headers = new Headers({ authorization, accept: request.headers.get('accept') ?? 'application/json' });
    if (route.spaceGuid) headers.set('bimcollab-space-guid', route.spaceGuid);
    if (route.index && request.method === 'HEAD') return json(405, { error: 'Index requires GET' }, cors);
    const params = url.searchParams;
    if (route.index && (!positiveInteger(params.get('locationId'))
      || (params.has('projectId') && !positiveInteger(params.get('projectId')))
      || [...params.keys()].some(key => !['path', 'locationId', 'projectId'].includes(key))
      || ['locationId', 'projectId'].some(key => params.getAll(key).length > 1))) {
      return json(400, { error: 'Invalid index selection' }, cors);
    }
    if (!route.index) {
      // Preserve the caller's query encoding and ordering; drop only routing metadata.
      route.target.search = url.search.slice(1).split('&').filter(entry => {
        const key = entry.split('=')[0];
        return new URLSearchParams(`${key}=`).keys().next().value !== 'path';
      }).join('&');
    }
    try {
      const send = (init: RequestInit) => fetchRestricted(deps.fetchImpl, route.target, { ...init, signal: request.signal });
      if (route.index) {
        const result = await readIndex(send, headers, Number(params.get('locationId')),
          params.has('projectId') ? Number(params.get('projectId')) : undefined);
        return json(result.status, result.body, cors);
      }
      const response = await send({ method: request.method, headers });
      // A model download never answers HTML; an HTML 200 is a login or error page.
      if (route.download && response.ok && /^text\/html\b/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        return json(401, { error: 'unauthorized' }, cors);
      }
      if (!response.ok) {
        const detail = await readLimitedText(response, 4096);
        return json(response.status, { error: response.status === 401 ? 'unauthorized' : 'upstream_error', detail }, cors);
      }
      const responseHeaders = new Headers({ ...cors, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders.set(name, value);
      }
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      // Deliberately generic: upstream exceptions can contain URLs and tokens,
      // so only the error class is logged.
      console.warn('[bimcollab-relay] upstream request failed:', error instanceof Error ? error.name : typeof error);
      return json(502, { error: 'Upstream request failed' }, cors);
    }
  };
}

export function loadBimcollabRelayConfig(env: Record<string, string | undefined>): BimcollabRelayConfig {
  const defaults = BIMCOLLAB_REGISTERED_REDIRECT_URIS.map(uri => new URL(uri).origin);
  const raw = env.BIMCOLLAB_RELAY_ALLOWED_ORIGINS ?? [env.APP_URL, ...defaults].filter(Boolean).join(',');
  return { allowedOrigins: raw.split(',').map(value => value.trim()).filter(Boolean) };
}
