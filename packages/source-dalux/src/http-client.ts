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

interface DaluxPageMetadata {
  readonly totalRemainingItems?: number;
}

interface DaluxPage {
  readonly items: readonly unknown[];
  readonly metadata?: DaluxPageMetadata;
  readonly links?: readonly DaluxPageLink[];
}

/** Upstream response bodies are interpolated into thrown `Error` messages,
 * which reach user-facing toasts unmodified — cap them so a verbose upstream
 * error page doesn't end up as a wall of HTML in the UI. */
const MAX_ERROR_BODY_CHARS = 200;

/** Hard ceiling on pages followed by {@link fetchAllPages}. A server that
 * keeps minting fresh bookmarks (buggy or malicious) would otherwise loop
 * forever; this trades a clear failure for an unbounded hang. */
const MAX_SWEEP_PAGES = 1000;

function truncate(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Thrown when Dalux's bookmark pagination looks broken rather than merely
 * finished — a `nextPage` link with no bookmark, one that echoes the
 * bookmark just used, or a page claiming more items remain while sending no
 * `nextPage` link at all. Callers must not treat this as "no more data": it
 * means the listing is truncated and the caller should say so, not report a
 * clean success with fewer rows than actually exist upstream. */
export class DaluxPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaluxPaginationError';
  }
}

export class BrowserDaluxApiClient {
  constructor(
    private readonly credentials: DaluxCredentials,
    private readonly ctx: PluginContext,
  ) {}

  get baseUrl(): string {
    return this.credentials.baseUrl;
  }

  debug(message: string, details?: Record<string, unknown>): void {
    this.ctx.log.debug(`Dalux ${message}`, details ?? {});
  }

  async get(
    path: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path.startsWith('/') ? `${this.credentials.baseUrl}${path}` : path);
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
      signal,
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
      throw new Error(`Dalux API ${response.status}: ${response.statusText} — ${truncate(body)}`);
    }

    return response.json() as Promise<unknown>;
  }

  async getBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    this.debug('binary GET request', { url });
    const response = await this.ctx.fetch(url, {
      headers: {
        'X-API-KEY': this.credentials.apiKey,
        Accept: '*/*',
      },
      signal,
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
      throw new Error(`Dalux API ${response.status}: ${response.statusText} — ${truncate(body)}`);
    }

    return response.arrayBuffer();
  }
}

/** Normalizes both response shapes a Dalux list endpoint can return: the
 * usual `{ items, metadata?, links? }` envelope, and a bare array (which the
 * vendored library's own single-page schemas tolerate but its `getAllFiles`/
 * `getAllFolders` pagers do not). */
function normalizePage(response: unknown): DaluxPage {
  if (Array.isArray(response)) return { items: response };
  if (response && typeof response === 'object') {
    const page = response as { items?: unknown[]; metadata?: DaluxPageMetadata; links?: DaluxPageLink[] };
    return { items: page.items ?? [], metadata: page.metadata, links: page.links };
  }
  return { items: [] };
}

/**
 * Resolves a `nextPage` link's `bookmark` query param against a base URL.
 *
 * A bare `new URL(href)` throws a `TypeError` on a relative href, and
 * because that throw happens mid-loop it discards every page already
 * fetched — the vendored library's own `utils/pagination.js` guards exactly
 * this parse with try/catch. Unlike that guard, a failure here does not
 * silently mean "no more pages": it throws `DaluxPaginationError` instead,
 * since treating a broken link as a clean end-of-list would report a
 * truncated listing as a success.
 */
function extractBookmark(href: string, baseUrl: string, endpoint: string): string {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch (err) {
    throw new DaluxPaginationError(
      `Dalux pagination broken at ${endpoint}: nextPage link "${href}" is not a valid URL ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const bookmark = url.searchParams.get('bookmark');
  if (!bookmark) {
    throw new DaluxPaginationError(`Dalux pagination broken at ${endpoint}: nextPage link has no bookmark`);
  }
  return bookmark;
}

export interface DaluxPageResult {
  readonly items: readonly unknown[];
  /** Dalux's bookmark, passed straight through as the plugin API's opaque
   * cursor. `undefined` means this was the last page. */
  readonly cursor?: string;
}

/**
 * Fetches exactly one page of a Dalux bookmark-paginated endpoint and maps
 * its bookmark onto the plugin API's `cursor`. Deliberately doesn't loop:
 * contract listing methods (`listProjects`, `listContainers`, `listFiles`)
 * page one Dalux call at a time and let the host drive, rather than
 * eagerly loading an entire (potentially huge) tenant into memory before
 * returning the first row.
 *
 * Any condition that would otherwise truncate the listing silently — a
 * `nextPage` link with no bookmark, a bookmark that echoes the one just
 * used, or `metadata.totalRemainingItems > 0` with no `nextPage` link at
 * all — throws {@link DaluxPaginationError} instead of returning as if the
 * page were simply the last one.
 */
export async function fetchPage(
  client: BrowserDaluxApiClient,
  endpoint: string,
  params: Record<string, unknown>,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<DaluxPageResult> {
  const requestParams = cursor ? { ...params, bookmark: cursor } : params;
  const response = await client.get(endpoint, requestParams, signal);
  const page = normalizePage(response);
  const remaining = page.metadata?.totalRemainingItems;
  const nextLink = (page.links ?? []).find((link) => link.rel === 'nextPage');

  client.debug('page received', {
    endpoint,
    cursor,
    itemCount: page.items.length,
    remaining,
    hasNextLink: Boolean(nextLink),
  });

  if (!page.items.length || remaining === 0) {
    if (nextLink) {
      throw new DaluxPaginationError(
        `Dalux pagination inconsistent at ${endpoint}: server reported completion but still sent a nextPage link`,
      );
    }
    return { items: page.items, cursor: undefined };
  }

  if (!nextLink) {
    if (remaining !== undefined && remaining > 0) {
      throw new DaluxPaginationError(
        `Dalux pagination truncated at ${endpoint}: ${remaining} item(s) remain but the server sent no nextPage link`,
      );
    }
    // No metadata at all (e.g. a bare-array response) and no next link:
    // there's nothing more to signal completion with, so this is the end.
    return { items: page.items, cursor: undefined };
  }

  const nextCursor = extractBookmark(nextLink.href, client.baseUrl, endpoint);
  if (cursor && nextCursor === cursor) {
    throw new DaluxPaginationError(
      `Dalux pagination stuck at ${endpoint}: server returned the same bookmark again`,
    );
  }

  return { items: page.items, cursor: nextCursor };
}

/**
 * Follows every page of a Dalux bookmark-paginated endpoint and returns the
 * combined items. For internal callers that genuinely need a whole listing
 * in one shot — currently only `watchRevisions`'s one-sweep-per-file-area
 * poll. The public `FileSourceProvider` listing methods must NOT use this;
 * they call {@link fetchPage} once and return that page to the host.
 *
 * Bounded by `MAX_SWEEP_PAGES` (a server minting endlessly fresh bookmarks
 * can't loop forever) and tracks every bookmark seen across the whole
 * sweep — a longer cycle than the immediate echo `fetchPage` already
 * rejects on its own.
 */
export async function fetchAllPages(
  client: BrowserDaluxApiClient,
  endpoint: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown[]> {
  const items: unknown[] = [];
  const seenBookmarks = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  for (;;) {
    pageCount += 1;
    if (pageCount > MAX_SWEEP_PAGES) {
      throw new DaluxPaginationError(
        `Dalux pagination at ${endpoint} exceeded ${MAX_SWEEP_PAGES} pages without finishing`,
      );
    }

    const page = await fetchPage(client, endpoint, params, cursor, signal);
    items.push(...page.items);

    if (!page.cursor) break;
    if (seenBookmarks.has(page.cursor)) {
      throw new DaluxPaginationError(
        `Dalux pagination at ${endpoint} revisited a bookmark it had already seen`,
      );
    }
    seenBookmarks.add(page.cursor);
    cursor = page.cursor;
  }

  return items;
}
