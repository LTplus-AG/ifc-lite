/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

export interface DaluxCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
}

interface DaluxPageLink {
  readonly rel: string;
  readonly href: string;
}

interface DaluxPage {
  readonly items?: readonly unknown[];
  readonly metadata?: { readonly totalRemainingItems?: number };
  readonly links?: readonly DaluxPageLink[];
}

export class BrowserDaluxApiClient {
  constructor(
    private readonly credentials: DaluxCredentials,
    private readonly ctx: PluginContext,
  ) {}

  debug(message: string, details?: Record<string, unknown>): void {
    this.ctx.log.debug(`Dalux ${message}`, details ?? {});
  }

  async get(path: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(
      path.startsWith('/')
        ? `${this.credentials.baseUrl}${path}`
        : path,
    );
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    this.debug('GET request', { url: url.toString(), params });
    const response = await this.ctx.fetch(url.toString(), {
      headers: {
        'X-API-KEY': this.credentials.apiKey,
        Accept: 'application/json',
      },
    });
    this.debug('GET response', {
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Dalux GET failed', {
        url: url.toString(),
        status: response.status,
        statusText: response.statusText,
        body,
      });
      throw new Error(`Dalux API ${response.status}: ${response.statusText} — ${body}`);
    }

    return response.json() as Promise<unknown>;
  }

  async getBinary(url: string): Promise<ArrayBuffer> {
    this.debug('binary GET request', { url });
    const response = await this.ctx.fetch(url, {
      headers: {
        'X-API-KEY': this.credentials.apiKey,
        Accept: '*/*',
      },
    });
    this.debug('binary GET response', {
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Dalux binary GET failed', {
        url,
        status: response.status,
        statusText: response.statusText,
        body,
      });
      throw new Error(`Dalux API ${response.status}: ${response.statusText} — ${body}`);
    }

    return response.arrayBuffer();
  }
}

/**
 * Follows bookmark pagination across every page of a Dalux list endpoint.
 *
 * Deliberately doesn't reuse `dalux-build-api`'s own `getAllFiles`/
 * `getAllFolders`/`utils/pagination.js`: those read each page as
 * `response.items` only, without the bare-array normalization the
 * library's own `listResponseSchema` applies for single-page reads: an
 * endpoint that responds with a bare array instead of the
 * `{ items, metadata, links }` envelope would silently paginate to zero
 * results. This treats both shapes as equivalent.
 */
export async function fetchAllPages(
  client: BrowserDaluxApiClient,
  endpoint: string,
  params: Record<string, unknown> = {},
): Promise<unknown[]> {
  const items: unknown[] = [];
  let currentParams = { ...params };
  const seenBookmarks = new Set<string>();
  let pageIndex = 0;

  for (;;) {
    const response = await client.get(endpoint, currentParams);
    const page: DaluxPage = Array.isArray(response)
      ? { items: response }
      : ((response as DaluxPage | null) ?? {});
    const pageItems = page.items ?? [];
    pageIndex += 1;
    client.debug('page received', {
      endpoint,
      pageIndex,
      params: currentParams,
      itemCount: pageItems.length,
      remaining: page.metadata?.totalRemainingItems ?? 0,
      links: (page.links ?? []).map((link) => link.rel),
      bareArray: Array.isArray(response),
    });
    items.push(...pageItems);

    const remaining = page.metadata?.totalRemainingItems ?? 0;
    const nextLink = (page.links ?? []).find((link) => link.rel === 'nextPage');
    if (!pageItems.length || remaining === 0 || !nextLink) {
      client.debug('pagination complete', {
        endpoint,
        pageIndex,
        totalItems: items.length,
        stopReason: !pageItems.length
          ? 'empty-page'
          : remaining === 0
            ? 'no-remaining-items'
            : 'no-next-link',
      });
      break;
    }

    const bookmark = new URL(nextLink.href).searchParams.get('bookmark');
    if (!bookmark || seenBookmarks.has(bookmark)) {
      client.debug('pagination stopped before next page', {
        endpoint,
        pageIndex,
        bookmark,
        duplicateBookmark: Boolean(bookmark && seenBookmarks.has(bookmark)),
      });
      break;
    }
    seenBookmarks.add(bookmark);
    currentParams = { ...params, bookmark };
  }

  return items;
}
