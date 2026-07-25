/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Page, PluginContext } from '@ifc-lite/plugin-api';
import type { GraphPage } from './graph-types.js';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * The only host `graphRequest` will ever attach a bearer token to. A cursor
 * or `@odata.nextLink`/`@odata.deltaLink` is provider-opaque data that gets
 * persisted (in the plugin-api `cursor` string, or in `ctx.storage`) and
 * handed back to us later — if that persisted value were ever tampered with
 * or simply came from an incompatible provider version, this allowlist stops
 * it from smuggling our bearer token to an arbitrary absolute URL.
 */
const ALLOWED_TOKEN_HOSTS = new Set(['graph.microsoft.com']);

/** Anything that can hand this client a bearer token for the active account. */
export interface GraphTokenSource {
  getAccessToken(ctx: PluginContext): Promise<string>;
}

/**
 * Thrown for any non-2xx Graph response. `status` lets callers distinguish
 * cases that need special handling (410 Gone on a delta link, 404 on a
 * deleted item) from a generic failure.
 */
export class GraphApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, statusText: string, body: string, url: string) {
    const throttled = status === 429 || status === 503;
    const prefix = throttled
      ? `Microsoft Graph is still throttling this account after the host's own retries (status ${status})`
      : `Microsoft Graph ${status}: ${statusText}`;
    // `body` here is already truncated by the caller (see `truncateErrorBody`)
    // — this message reaches testConnection results and toasts, so it must
    // stay short even when upstream sends back a verbose HTML error page.
    super(`${prefix} — ${url}${body ? ` — ${body}` : ''}`);
    this.name = 'GraphApiError';
    this.status = status;
    this.url = url;
  }
}

/** Upstream response bodies are interpolated into thrown `Error` messages,
 * which reach user-facing toasts unmodified — cap them so a verbose upstream
 * error page doesn't end up as a wall of HTML in the UI. Mirrors
 * `@ifc-lite/source-dalux`'s `http-client.ts`. */
export const MAX_ERROR_BODY_CHARS = 200;

export function truncateErrorBody(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Hard ceiling on pages followed by {@link graphListAll} and the delta
 * drainer in `delta.ts`. A server that keeps minting fresh bookmarks (buggy
 * or malicious) would otherwise loop forever; this trades a clear failure for
 * an unbounded hang. Mirrors `@ifc-lite/source-dalux`'s `MAX_SWEEP_PAGES`. */
export const MAX_SWEEP_PAGES = 1000;

function resolveUrl(pathOrUrl: string): string {
  if (!pathOrUrl.startsWith('http://') && !pathOrUrl.startsWith('https://')) {
    return `${GRAPH_BASE}${pathOrUrl}`;
  }
  const url = new URL(pathOrUrl);
  if (!ALLOWED_TOKEN_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to attach a Microsoft Graph bearer token to "${url.hostname}" — only ` +
        `${[...ALLOWED_TOKEN_HOSTS].join(', ')} is allowed. This can happen if a persisted ` +
        'cursor was tampered with or came from an incompatible provider version.',
    );
  }
  return pathOrUrl;
}

/**
 * Issues one authenticated Graph request. Never attaches a token to anything
 * but `graph.microsoft.com` — callers must not pass a pre-signed download URL
 * here (use `ctx.fetchPublic` for those, per the plugin-api contract).
 */
export async function graphRequest(
  ctx: PluginContext,
  auth: GraphTokenSource,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await auth.getAccessToken(ctx);
  const url = resolveUrl(pathOrUrl);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  const response = await ctx.fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // The full body is worth keeping for diagnostics; only the message that
    // reaches testConnection/toasts needs to stay short.
    if (body) ctx.log.error(`Microsoft Graph ${response.status} ${response.statusText} at ${url}`, { body });
    throw new GraphApiError(response.status, response.statusText, truncateErrorBody(body), url);
  }
  return response;
}

export async function graphGetJson<T>(
  ctx: PluginContext,
  auth: GraphTokenSource,
  pathOrUrl: string,
  init?: RequestInit,
): Promise<T> {
  const response = await graphRequest(ctx, auth, pathOrUrl, init);
  return response.json() as Promise<T>;
}

/** Graph's own page cap for `/children` listings, per the verified API facts. */
const MAX_PAGE_SIZE = 200;

function withTop(url: string, limit?: number): string {
  if (!limit) return url;
  const resolved = new URL(resolveUrl(url));
  resolved.searchParams.set('$top', String(Math.max(1, Math.min(limit, MAX_PAGE_SIZE))));
  return resolved.toString();
}

/**
 * Fetches one page from a Graph list endpoint and maps it onto the plugin
 * contract's `Page<T>` — `@odata.nextLink` becomes the opaque `cursor`
 * untouched, so the *next* call just re-requests that exact URL with no
 * further query-building.
 */
export async function graphListPage<T>(
  ctx: PluginContext,
  auth: GraphTokenSource,
  baseUrl: string,
  cursor: string | undefined,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<Page<T>> {
  const url = cursor ?? withTop(baseUrl, limit);
  const page = await graphGetJson<GraphPage<T>>(ctx, auth, url, { signal });
  return { items: page.value, cursor: page['@odata.nextLink'] };
}

/**
 * Fetches every page of a Graph list endpoint, following `@odata.nextLink` to
 * completion. Bounded by `MAX_SWEEP_PAGES` and a repeated-link guard: a
 * buggy upstream re-issuing the same `nextLink` forever would otherwise hang
 * this indefinitely rather than fail.
 */
export async function graphListAll<T>(
  ctx: PluginContext,
  auth: GraphTokenSource,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pageCount = 0;
  for (;;) {
    const page = await graphListPage<T>(ctx, auth, baseUrl, cursor, undefined, signal);
    items.push(...page.items);
    if (!page.cursor) break;
    if (page.cursor === cursor) {
      throw new Error(`Graph pagination at ${baseUrl} re-issued the same nextLink — refusing to loop forever`);
    }
    pageCount += 1;
    if (pageCount > MAX_SWEEP_PAGES) {
      throw new Error(`Graph pagination at ${baseUrl} exceeded ${MAX_SWEEP_PAGES} pages without finishing`);
    }
    cursor = page.cursor;
  }
  return items;
}
