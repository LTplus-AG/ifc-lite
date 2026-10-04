/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Node-only authenticated relay. Provider URLs and credentials are host configuration, never caller input. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { assertNetworkEndpoint, type FetchTransport } from '@ifc-lite/sandbox/network';
import { createSemanticProvider } from './provider.js';
import { assertReadOnlyQuery } from './query.js';

export interface RelayProvider {
  endpoint: string;
  grantedHost: string;
  loopbackHttpOrigin?: string;
  kind: 'json' | 'sparql';
  /** Resolved at request time from an environment/keychain; never serialized in responses. */
  bearerToken?: () => string | undefined;
}
export interface RelayOptions {
  providers: Readonly<Record<string, RelayProvider>>;
  clientToken: string;
  allowedOrigins: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Test transport changes byte movement, never HTTPS/grant/redirect authorization. */
  transport?: FetchTransport;
}
const REQUEST_LIMIT = 300000;
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function jsonError(status: number, message: string, headers: Headers): Response {
  headers.set('Content-Type', 'application/json');
  if (status === 401) headers.set('WWW-Authenticate', 'Bearer realm="ifc-lite-semantic"');
  if (status === 405) headers.set('Allow', 'POST, OPTIONS');
  return new Response(JSON.stringify({ error: message }), { status, headers });
}
async function readBody(request: Request, signal: AbortSignal): Promise<string> {
  if (!request.body) throw new Error('Missing body');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel('Request cancelled').catch(() => console.error('Relay request stream cancellation failed')); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > REQUEST_LIMIT) { await reader.cancel('Body limit'); throw new Error('Request exceeds byte limit'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
/** Mount behind HTTPS; requests authorize a fixed provider id, not an arbitrary proxy destination. */
export function createSemanticRelay(options: RelayOptions): (request: Request) => Promise<Response> {
  if (options.clientToken.length < 32 || options.clientToken.length > 4096 || /[\r\n]/.test(options.clientToken)) throw new Error('Relay client token must contain 32–4096 characters');
  const clientToken = options.clientToken;
  const timeoutMs = options.timeoutMs ?? 15000; const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) throw new Error('Relay limits are invalid');
  if (options.allowedOrigins.length > 100 || Object.keys(options.providers).length > 100) throw new Error('Relay configuration exceeds the 100 origin/provider limit');
  const origins = new Set(options.allowedOrigins);
  for (const origin of origins) { const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Allowed origins must be exact HTTPS origins'); }
  const providers = new Map<string, RelayProvider>();
  for (const [id, provider] of Object.entries(options.providers)) {
    const url = new URL(provider.endpoint);
    assertNetworkEndpoint(provider.endpoint, provider.loopbackHttpOrigin);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || url.username || url.password || url.search || url.hash
      || url.hostname !== provider.grantedHost || !['json', 'sparql'].includes(provider.kind)) throw new Error('Provider requires a fixed authorized endpoint and exact hostname grant');
    providers.set(id, { ...provider });
  }
  return async request => {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    const origin = request.headers.get('Origin');
    if (origin && !origins.has(origin)) return jsonError(403, 'Origin is not authorized', headers);
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    if (new URL(request.url).protocol !== 'https:') return jsonError(400, 'HTTPS required', headers);
    if (request.method === 'OPTIONS') {
      if (!origin || request.headers.get('Access-Control-Request-Method') !== 'POST') return jsonError(403, 'Invalid preflight', headers);
      headers.set('Access-Control-Allow-Methods', 'POST'); headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') return jsonError(405, 'POST required', headers);
    if (!sameSecret(request.headers.get('Authorization') ?? '', `Bearer ${clientToken}`)) return jsonError(401, 'Unauthorized', headers);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return jsonError(415, 'JSON required', headers);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    let body: unknown;
    try { body = JSON.parse(await readBody(request, signal)) as unknown; } catch { return jsonError(signal.aborted ? 408 : 400, 'Invalid or oversized request', headers); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, 'Invalid relay request', headers);
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['providerId', 'kind', 'query'].includes(key)) || typeof input.providerId !== 'string'
      || !['json', 'select', 'construct'].includes(String(input.kind))) return jsonError(400, 'Invalid relay request', headers);
    const provider = providers.get(input.providerId);
    if (!provider) return jsonError(404, 'Unknown provider', headers);
    if ((input.kind === 'json') !== (provider.kind === 'json') || (input.kind === 'json' ? input.query !== undefined : typeof input.query !== 'string')) return jsonError(400, 'Provider kind mismatch', headers);
    try {
      if (typeof input.query === 'string') {
        const kind = assertReadOnlyQuery(input.query);
        if (kind.toLowerCase() !== input.kind) return jsonError(400, 'Query kind mismatch', headers);
      }
    } catch { return jsonError(400, 'Only bounded SELECT/CONSTRUCT without SERVICE or FROM is allowed', headers); }
    try {
      const result = await createSemanticProvider(options.transport).read({ endpoint: provider.endpoint, host: provider.grantedHost,
        loopbackHttpOrigin: provider.loopbackHttpOrigin, kind: input.kind as 'json' | 'select' | 'construct', query: typeof input.query === 'string' ? input.query : undefined,
        bearer: provider.bearerToken?.(), timeoutMs, maxBytes }, signal);
      headers.set('Content-Type', result.kind === 'construct' ? result.format
        : result.kind === 'select' ? 'application/sparql-results+json' : 'application/json');
      const payload = result.kind === 'construct' ? result.value : result.kind === 'select'
        ? JSON.stringify({ head: { vars: result.value.columns }, results: { bindings: result.value.rows } }) : JSON.stringify(result.value);
      return new Response(payload, { headers });
    } catch { return jsonError(signal.aborted ? 504 : 502, signal.aborted ? 'Provider request timed out or was cancelled' : 'Provider request failed', headers); }
  };
}
export { createSemanticRelayServer } from './server-listener.js';
