/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which buildagil openCDE endpoints the relay forwards, and how. Pure, so
 * every refusal is testable without a request. Only what the documents
 * source reads is listed; anything else is a 400, never a pass-through.
 */

export const BUILDAGIL_API_ORIGIN = 'https://openapi.buildagil.com';

const ID = '[A-Za-z0-9_-]{1,128}';
const DOCUMENT = `1\\.0/projects/${ID}/documents/${ID}`;

export type BuildagilRoute =
  | { kind: 'token' }
  | { kind: 'api'; method: 'GET'; target: URL; queryKeys: readonly string[]; download: boolean }
  | { kind: 'api'; method: 'POST'; target: URL; queryKeys: readonly string[]; download: false };

const GET_ROUTES: readonly { pattern: RegExp; queryKeys: readonly string[]; download: boolean }[] = [
  { pattern: /^1\.0\/projects$/, queryKeys: [], download: false },
  { pattern: new RegExp(`^1\\.0/projects/${ID}/documents$`), queryKeys: ['$filter', '$orderby', '$top'], download: false },
  { pattern: new RegExp(`^${DOCUMENT}$`), queryKeys: [], download: true },
  { pattern: new RegExp(`^${DOCUMENT}/metadata$`), queryKeys: [], download: false },
  { pattern: new RegExp(`^${DOCUMENT}/versions$`), queryKeys: [], download: false },
  { pattern: new RegExp(`^${DOCUMENT}/versions/(?:0|[1-9][0-9]{0,8})$`), queryKeys: [], download: true },
];

/**
 * The route for a relay path (what follows `/api/buildagil/`) and method, or
 * null. No decoding: ids need no escapes, so an encoded separator or a dot
 * segment can never reach the upstream path.
 */
export function resolveBuildagilRoute(path: string, method: string): BuildagilRoute | null {
  if (path.includes('..') || path.includes('%') || path.includes('//')) return null;
  if (path === 'oauth2/token') return method === 'POST' ? { kind: 'token' } : null;
  if (path === '1.0/search') {
    return method === 'POST'
      ? { kind: 'api', method: 'POST', target: new URL(`${BUILDAGIL_API_ORIGIN}/${path}`), queryKeys: [], download: false }
      : null;
  }
  if (method !== 'GET' && method !== 'HEAD') return null;
  const route = GET_ROUTES.find(({ pattern }) => pattern.test(path));
  return route
    ? { kind: 'api', method: 'GET', target: new URL(`${BUILDAGIL_API_ORIGIN}/${path}`), queryKeys: route.queryKeys, download: route.download }
    : null;
}

/**
 * The caller's query, minus the rewrite's `path`, if every key is allowed
 * once at most; null otherwise. The caller's encoding and order are kept.
 */
export function relayedQuery(search: string, allowed: readonly string[]): string | null {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const entry of search.replace(/^\?/, '').split('&')) {
    if (entry === '') continue;
    const key = new URLSearchParams(`${entry.split('=')[0]}=`).keys().next().value ?? '';
    if (key === 'path') continue;
    if (!allowed.includes(key) || seen.has(key) || entry.length > 2048) return null;
    seen.add(key);
    kept.push(entry);
  }
  return kept.join('&');
}

/** Storage hosts a document download may redirect to, fetched without the bearer. */
export function isDownloadStorageUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && url.port === ''
    && /^[a-z0-9-]{1,63}\.blob\.core\.windows\.net$/.test(url.hostname);
}
