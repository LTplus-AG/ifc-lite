/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which buildagil openCDE endpoints the relay forwards, and how. Pure, so
 * every refusal is testable without a request. Only what the documents
 * source and the BCF topics client use is listed; anything else is a 400,
 * never a pass-through.
 */

export const BUILDAGIL_API_ORIGIN = 'https://openapi.buildagil.com';

const ID = '[A-Za-z0-9_-]{1,128}';
const PROJECT = `1\\.0/projects/${ID}`;
const DOCUMENT = `${PROJECT}/documents/${ID}`;
const TOPICS = `${PROJECT}/topics`;
const TOPIC = `${TOPICS}/${ID}`;
const VIEWPOINT = `${TOPIC}/viewpoints/${ID}`;

/** Search, topic and comment bodies are small JSON. */
export const BUILDAGIL_JSON_BODY_BYTES = 64 * 1024;
/** A new viewpoint carries its snapshot inline as base64, so several MB. */
export const BUILDAGIL_VIEWPOINT_BODY_BYTES = 16 * 1024 * 1024;

export type BuildagilRoute =
  | { kind: 'token' }
  | { kind: 'api'; method: 'GET'; target: URL; queryKeys: readonly string[]; download: boolean }
  | { kind: 'api'; method: 'POST' | 'PUT'; target: URL; queryKeys: readonly string[]; download: false; maxBodyBytes: number };

const re = (source: string) => new RegExp(`^${source}$`);

const GET_ROUTES: readonly { pattern: RegExp; queryKeys: readonly string[]; download: boolean }[] = [
  { pattern: /^1\.0\/projects$/, queryKeys: [], download: false },
  { pattern: re(PROJECT), queryKeys: [], download: false },
  { pattern: re(`${PROJECT}/extensions`), queryKeys: [], download: false },
  { pattern: re(`${PROJECT}/documents`), queryKeys: ['$filter', '$orderby', '$top'], download: false },
  { pattern: re(DOCUMENT), queryKeys: [], download: true },
  { pattern: re(`${DOCUMENT}/metadata`), queryKeys: [], download: false },
  { pattern: re(`${DOCUMENT}/versions`), queryKeys: [], download: false },
  { pattern: re(`${DOCUMENT}/versions/(?:0|[1-9][0-9]{0,8})`), queryKeys: [], download: true },
  // `$skip` is ignored upstream (measured 2026-11-02), so it is not offered.
  { pattern: re(TOPICS), queryKeys: ['$filter', '$orderby', '$top', '$expand'], download: false },
  { pattern: re(TOPIC), queryKeys: ['$expand'], download: false },
  { pattern: re(`${TOPIC}/comments`), queryKeys: [], download: false },
  { pattern: re(`${TOPIC}/viewpoints`), queryKeys: [], download: false },
  { pattern: re(VIEWPOINT), queryKeys: [], download: false },
  // Snapshots are small images served by the API itself: no storage hop.
  { pattern: re(`${VIEWPOINT}/(?:selection|coloring|visibility|snapshot)`), queryKeys: [], download: false },
];

const WRITE_ROUTES: readonly { method: 'POST' | 'PUT'; pattern: RegExp; maxBodyBytes: number }[] = [
  { method: 'POST', pattern: /^1\.0\/search$/, maxBodyBytes: BUILDAGIL_JSON_BODY_BYTES },
  { method: 'POST', pattern: re(TOPICS), maxBodyBytes: BUILDAGIL_JSON_BODY_BYTES },
  // Topic update: buildagil accepts PUT and PATCH; the BCF client sends PUT.
  { method: 'PUT', pattern: re(TOPIC), maxBodyBytes: BUILDAGIL_JSON_BODY_BYTES },
  { method: 'POST', pattern: re(`${TOPIC}/comments`), maxBodyBytes: BUILDAGIL_JSON_BODY_BYTES },
  { method: 'POST', pattern: re(`${TOPIC}/viewpoints`), maxBodyBytes: BUILDAGIL_VIEWPOINT_BODY_BYTES },
];

/**
 * The route for a relay path (what follows `/api/buildagil/`) and method, or
 * null. No decoding: ids need no escapes, so an encoded separator or a dot
 * segment can never reach the upstream path.
 */
export function resolveBuildagilRoute(path: string, method: string): BuildagilRoute | null {
  if (path.includes('..') || path.includes('%') || path.includes('//')) return null;
  if (path === 'oauth2/token') return method === 'POST' ? { kind: 'token' } : null;
  const target = () => new URL(`${BUILDAGIL_API_ORIGIN}/${path}`);
  if (method === 'POST' || method === 'PUT') {
    const write = WRITE_ROUTES.find((route) => route.method === method && route.pattern.test(path));
    return write
      ? { kind: 'api', method, target: target(), queryKeys: [], download: false, maxBodyBytes: write.maxBodyBytes }
      : null;
  }
  if (method !== 'GET' && method !== 'HEAD') return null;
  const route = GET_ROUTES.find(({ pattern }) => pattern.test(path));
  return route
    ? { kind: 'api', method: 'GET', target: target(), queryKeys: route.queryKeys, download: route.download }
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
