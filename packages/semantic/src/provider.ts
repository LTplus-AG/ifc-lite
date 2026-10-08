/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { coreNetworkRequest, createLoopbackHostGrant, type FetchTransport } from '@ifc-lite/sandbox/network';
import { parseCapability } from '@ifc-lite/extensions';
import { Parser as RdfParser } from 'n3';
import { assertReadOnlyQuery } from './query.js';
import { parseResults } from './results.js';
import { LIMITS, type SparqlResults } from './types.js';
export interface ProviderReadOptions {
  endpoint: string; host: string; kind: 'json' | 'select' | 'construct'; query?: string;
  loopbackHttpOrigin?: string;
  bearer?: string; authorizedGraphs?: readonly string[]; relayProvider?: string; timeoutMs?: number; maxBytes?: number;
}
export type ProviderResult = { source: string; retrievedAt: string } & (
  | { kind: 'json'; value: unknown } | { kind: 'select'; value: SparqlResults }
  | { kind: 'construct'; value: string; format: 'text/turtle'; quadCount: number });
export interface SemanticProvider { read(options: ProviderReadOptions, signal?: AbortSignal): Promise<ProviderResult> }
/** Inspect decoded strings and keys so JSON escapes cannot conceal a credential. */
function assertNoCredential(value: unknown, bearer: string | undefined): void {
  if (!bearer) return;
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && item.includes(bearer)) throw new Error('Provider response contained a credential');
    if (Array.isArray(item)) for (const nested of item) pending.push(nested);
    else if (item !== null && typeof item === 'object') for (const [key, nested] of Object.entries(item)) pending.push(key, nested);
  }
}
export function createSemanticProvider(transport?: FetchTransport): SemanticProvider {
  return { async read(options, signal) {
    const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs; const maxBytes = options.maxBytes ?? LIMITS.bytes;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMITS.bytes) throw new Error('Invalid semantic provider limits');
    if (options.relayProvider !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(options.relayProvider)) throw new Error('Invalid relay provider id');
    const capability = options.loopbackHttpOrigin !== undefined
      ? { ok: true as const, value: createLoopbackHostGrant(options.host) } : parseCapability(`network.fetch:${options.host}`);
    if (!capability.ok) throw new Error('Enter a valid explicitly granted hostname');
    const endpoint = new URL(options.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Endpoint credentials must be supplied separately; query parameters and fragments are disabled');
    if (options.kind !== 'json' && (!options.query || assertReadOnlyQuery(options.query, options.authorizedGraphs) !== options.kind)) throw new Error('Query kind does not match provider request');
    if (options.bearer !== undefined && (!options.bearer || /[\r\n]/u.test(options.bearer))) throw new Error('Invalid bearer credential');
    const headers: Record<string, string> = { Accept: options.kind === 'construct' ? 'text/turtle' : options.kind === 'select' ? 'application/sparql-results+json' : 'application/json' };
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
    if (options.relayProvider) headers['Content-Type'] = 'application/json';
    else if (options.kind !== 'json') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const response = await coreNetworkRequest({ url: options.endpoint, loopbackHttpOrigin: options.loopbackHttpOrigin, method: options.relayProvider || options.kind !== 'json' ? 'POST' : 'GET', headers,
      body: options.relayProvider ? JSON.stringify({ providerId: options.relayProvider, kind: options.kind, query: options.query })
        : options.kind === 'json' ? undefined : new URLSearchParams({ query: options.query! }).toString(),
      signal, maxBytes, timeoutMs }, [capability.value], transport);
    if (response.status < 200 || response.status >= 300) throw new Error(`Endpoint returned HTTP ${response.status}`);
    if (response.truncated) throw new Error('Endpoint response exceeded semantic byte limit');
    if (options.bearer && response.body.includes(options.bearer)) throw new Error('Provider response contained a credential');
    const contentType = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1].split(';')[0].trim().toLowerCase();
    const allowedContent = options.kind === 'construct' ? ['text/turtle'] : options.kind === 'select' ? ['application/sparql-results+json', 'application/json'] : ['application/json', 'application/ld+json'];
    if (!contentType || !allowedContent.includes(contentType)) throw new Error('Unsupported semantic provider content type');
    const source = new URL(endpoint.href); source.search = ''; source.hash = '';
    const provenance = { source: source.href, retrievedAt: new Date().toISOString() };
    if (options.kind === 'construct') {
      const quads = new RdfParser({ format: 'text/turtle' }).parse(response.body);
      if (quads.length > LIMITS.quads) throw new Error('CONSTRUCT response exceeded quad limit');
      if (options.bearer) for (const quad of quads) assertNoCredential([quad.subject.value, quad.predicate.value, quad.object.value, quad.graph.value], options.bearer);
      return { ...provenance, kind: 'construct', value: response.body, format: 'text/turtle', quadCount: quads.length };
    }
    let value: unknown;
    try { value = JSON.parse(response.body); }
    catch { throw new Error('Invalid semantic provider JSON'); }
    assertNoCredential(value, options.bearer);
    return options.kind === 'select' ? { ...provenance, kind: 'select', value: parseResults(value) } : { ...provenance, kind: 'json', value };
  } };
}
/** Compatibility helper for existing JSON/SELECT integrations. Credentials are never persisted. */
export async function request(endpoint: string, host: string, signal?: AbortSignal, query?: string, transport?: FetchTransport,
  options: Pick<ProviderReadOptions, 'bearer' | 'authorizedGraphs' | 'relayProvider' | 'loopbackHttpOrigin'> = {}): Promise<unknown> {
  const kind = query === undefined ? 'json' : assertReadOnlyQuery(query, options.authorizedGraphs);
  const result = await createSemanticProvider(transport).read({ endpoint, host, kind, query, ...options }, signal);
  if (result.kind === 'select') return { head: { vars: result.value.columns }, results: { bindings: result.value.rows } };
  return result.value;
}
