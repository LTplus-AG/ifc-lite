/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

export interface DaluxCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Dalux node name (`node2`, ...) when the user is not on the default node.
   *
   * Sent as a query parameter rather than baked into `baseUrl` on purpose:
   * the host only rewrites a URL to the same-origin relay when it still
   * matches the manifest's declared upstream, and Dalux serves no CORS
   * headers, so changing the base URL here would bypass the relay and fail
   * in the browser. The server resolves the name to an origin (#2792).
   */
  readonly node?: string;
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

/** Thrown when Dalux's bookmark pagination looks broken in a way that can't
 * be reconciled with "the listing is simply done": a `nextPage` link with no
 * bookmark, or a bookmark that repeats while the page carrying it still has
 * items on it (see {@link fetchPage}). Callers must not treat this as "no
 * more data": it means the listing is truncated and the caller should say
 * so, not report a clean success with fewer rows than actually exist
 * upstream. */
export class DaluxPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaluxPaginationError';
  }
}

/** Thrown for a non-2xx Dalux API response. Carries the actual HTTP status
 * so callers that need to branch on it (auth-failure detection in
 * `testConnection`, for one) match on `status` rather than on substrings of
 * the interpolated error message — a truncated upstream body can contain
 * digits that happen to look like a status code without being one. */
export class DaluxHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DaluxHttpError';
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

  /**
   * Add the caller's node selector, but ONLY to URLs that go through our relay.
   *
   * Dalux also hands back opaque links (a file's `downloadLink`, `nextPage`
   * hrefs) which can point at a different host such as a CDN and can carry a
   * signature computed over the query string. Those are not routed through the
   * node-aware relay, so adding a parameter would be useless at best and would
   * invalidate a signed URL at worst. They must stay byte-for-byte intact.
   */
  private stampNode(url: URL): void {
    if (!this.credentials.node) return;
    if (url.origin !== new URL(this.credentials.baseUrl).origin) return;
    url.searchParams.set('daluxNode', this.credentials.node);
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
    this.stampNode(url);
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
      throw new DaluxHttpError(
        `Dalux API ${response.status}: ${response.statusText} — ${truncate(body)}`,
        response.status,
      );
    }

    return response.json() as Promise<unknown>;
  }

  async getBinary(rawUrl: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    // Binary downloads take a fully-built URL (revision content, and any
    // `nextPage` link Dalux hands back), so they need the node selector too.
    // Missing it here would send file downloads to the default node while
    // listings went to the user's own — the failure would look like "the file
    // is gone" rather than "wrong host".
    const parsed = new URL(rawUrl);
    this.stampNode(parsed);
    const url = parsed.toString();
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
      throw new DaluxHttpError(
        `Dalux API ${response.status}: ${response.statusText} — ${truncate(body)}`,
        response.status,
      );
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
 * A `nextPage` link, when present, is authoritative and is always followed —
 * even when the page it's attached to has zero items or reports
 * `totalRemainingItems: 0`. That's a legitimate bookmark-pager shape: the
 * server can signal "keep going" via the link while the counters on this
 * particular page look like "done", with the real end only reached once a
 * later page comes back both empty *and* linkless. Treating an empty or
 * remaining-0 page as terminal whenever it still carries a `nextPage` link
 * would silently truncate a listing that in fact had more pages.
 *
 * A `nextPage` link with no bookmark throws {@link DaluxPaginationError}
 * instead of returning as if the page were simply the last one — that shape
 * can't be reconciled with "the listing is done".
 *
 * A `nextPage` link whose bookmark echoes the one just requested is more
 * subtle: `/6.1/projects/.../file_areas/.../files` has been observed live
 * re-sending the same bookmark on what is genuinely the final page (a 0-item
 * page, `totalRemainingItems: 0`) instead of ever omitting the `nextPage`
 * link, matching how the original Dalux Box integration (ifc-lite#1761) and
 * An unofficial third-party reference client (github.com/bruadam/dalux-build,
 * `javascript/src/utils/pagination.js`, `paginate()`) both already treat a
 * repeated bookmark: a clean end, not an error. But Dalux's API is not
 * reliable enough to trust that an echoed bookmark *always* means "done" —
 * only that an echoed bookmark carrying zero items safely does, per what's
 * actually been observed. If the repeating page still has items on it, the
 * server has stopped making forward progress while real data remains
 * unread, which is exactly the truncation this error exists to catch — so
 * that case still throws, it just no longer conflates "bookmark repeated"
 * with "nothing left to read".
 *
 * `metadata.totalRemainingItems` is *not* treated as authoritative for "is
 * this the last page" on its own: Dalux's reference client only ever logs
 * it, and it can be positive on a page that is genuinely the last one — e.g.
 * `/5.1/projects` reporting `1` remaining while describing the sole project
 * and sending no `nextPage` link at all — so erroring on that combination
 * alone would reject a perfectly valid single-project (and single-final-page)
 * response instead of completing the listing.
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
  const nextLink = (page.links ?? []).find((link) => link.rel === 'nextPage');

  client.debug('page received', {
    endpoint,
    cursor,
    itemCount: page.items.length,
    remaining: page.metadata?.totalRemainingItems,
    hasNextLink: Boolean(nextLink),
  });

  // A nextPage link always wins over the item count or the remaining
  // counter: follow it regardless of whether this particular page looks
  // empty or "complete" (see the doc comment above for why that's not a
  // contradiction upstream).
  if (nextLink) {
    const nextCursor = extractBookmark(nextLink.href, client.baseUrl, endpoint);
    if (cursor && nextCursor === cursor) {
      // An echoed bookmark only safely means "done" when this page is
      // actually empty — see the doc comment above. An echo that still
      // carries items means the server is stuck, not finished: treating
      // that as a clean end would silently drop everything past this page.
      if (page.items.length === 0) {
        client.debug('pagination stopped: server echoed the requested bookmark on an empty page', {
          endpoint,
          cursor,
        });
        return { items: page.items, cursor: undefined };
      }
      throw new DaluxPaginationError(
        `Dalux pagination stuck at ${endpoint}: server returned the same bookmark again with ` +
          `${page.items.length} item(s) still on the page`,
      );
    }
    return { items: page.items, cursor: nextCursor };
  }

  // No nextPage link: this is the last page. `metadata.totalRemainingItems`
  // is deliberately not consulted here — see the doc comment above.

  return { items: page.items, cursor: undefined };
}

/**
 * Follows every page of a Dalux bookmark-paginated endpoint and returns the
 * combined items. For callers that genuinely need a whole listing in one
 * shot: `watchRevisions`'s one-sweep-per-file-area poll, and the folder
 * listing in `listContainers` (whose parent-id resolution is only correct
 * against the complete folder set). `listProjects`/`listFiles` must NOT use
 * this — they call {@link fetchPage} once and return that page to the host,
 * so a large tenant or file area is never loaded eagerly.
 *
 * Bounded by `MAX_SWEEP_PAGES` (a server minting endlessly fresh bookmarks
 * can't loop forever) and tracks every bookmark seen across the whole sweep,
 * throwing if one reappears — a longer cycle than the immediate, empty-page
 * echo `fetchPage` already treats as end-of-listing on its own. Unlike that
 * immediate echo, a bookmark resurfacing several pages later means the
 * server is about to hand back content already read under an earlier
 * bookmark instead of making forward progress, which is a stuck listing, not
 * a finished one — regardless of whether the page that reveals the cycle
 * happens to have items on it.
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
