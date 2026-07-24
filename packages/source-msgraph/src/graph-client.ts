/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Page, PluginContext } from '@ifc-lite/plugin-api';
import type { GraphPage } from './graph-types.js';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

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
    super(`${prefix} — ${url}${body ? ` — ${body}` : ''}`);
    this.name = 'GraphApiError';
    this.status = status;
    this.url = url;
  }
}

function resolveUrl(pathOrUrl: string): string {
  return pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
    ? pathOrUrl
    : `${GRAPH_BASE}${pathOrUrl}`;
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
    throw new GraphApiError(response.status, response.statusText, body, url);
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

/** Fetches every page of a Graph list endpoint, following `@odata.nextLink` to completion. */
export async function graphListAll<T>(
  ctx: PluginContext,
  auth: GraphTokenSource,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await graphListPage<T>(ctx, auth, baseUrl, cursor, undefined, signal);
    items.push(...page.items);
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return items;
}
