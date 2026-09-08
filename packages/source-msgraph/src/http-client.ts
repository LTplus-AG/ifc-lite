/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

import { decodeCollectionPage } from './msgraph-types.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/** Upstream response bodies are interpolated into thrown `Error` messages,
 * which reach user-facing toasts unmodified — cap them the same way
 * `source-dalux` does, so a verbose upstream error page doesn't become a
 * wall of HTML in the UI. Never includes the request's own `Authorization`
 * header value, which never reaches this function in the first place —
 * `ctx.fetch` attaches it. */
const MAX_ERROR_BODY_CHARS = 200;

function truncate(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Strips the query string off a URL before it is logged.
 *
 * Only ever applied to pre-signed `@microsoft.graph.downloadUrl` values, where
 * the query string *is* the credential: OneDrive/SharePoint put a `tempauth`
 * token there, and anyone holding the complete URL downloads the bytes with no
 * further authentication. `createPrefixedLogger` gates `debug` behind a flag,
 * but `error` always reaches `console.error` — the output users copy into bug
 * reports. Such a URL is usually expired by the time anyone reads the report;
 * a 5xx from the CDN is precisely the case where it is not.
 *
 * The origin and path are kept, since those are what a failed download
 * actually needs diagnosing (which host served it, which item).
 *
 * Deliberately *not* applied to `get()`'s Graph API URLs: those authenticate
 * with an `Authorization` header, so their query strings hold only `$select`/
 * `$top`/`$skiptoken` — no credential, and genuinely useful when reading a log.
 */
function forLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

/** Thrown for a non-2xx Graph API response. Carries the actual HTTP status so
 * callers can branch on it (auth-failure detection in `testConnection`)
 * rather than on substrings of the (possibly truncated) upstream error body. */
export class GraphHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GraphHttpError';
  }
}

export class BrowserGraphApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly ctx: PluginContext,
  ) {}

  debug(message: string, details?: Record<string, unknown>): void {
    this.ctx.log.debug(`Graph ${message}`, details ?? {});
  }

  /**
   * GETs a Graph API endpoint. `path` is either an absolute URL (used to
   * follow `@odata.nextLink`/`@odata.deltaLink`, which are already
   * fully-qualified) or a path relative to {@link GRAPH_BASE_URL}.
   */
  async get(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(path.startsWith('http') ? path : `${GRAPH_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, value);
    }

    this.debug('GET request', { url: url.toString() });
    const response = await this.ctx.fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
      signal,
    });
    this.debug('GET response', { url: url.toString(), status: response.status, ok: response.ok });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Graph GET failed', { url: url.toString(), status: response.status, body });
      throw new GraphHttpError(`Microsoft Graph ${response.status}: ${response.statusText} — ${truncate(body)}`, response.status);
    }

    return response.json() as Promise<unknown>;
  }

  /**
   * Fetches file bytes from a pre-signed `@microsoft.graph.downloadUrl`
   * through `ctx.fetchPublic` — never `ctx.fetch` / this client's own
   * `Authorization` header. See the doc comment on `download()` in
   * `provider.ts` for why: these URLs are pre-authenticated, invalidated by
   * an `Authorization` header, and hosted on a tenant-specific CDN host
   * outside `permissions.network`.
   */
  async getPublicBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    // Logged without its query string — see `forLog`. The full URL is still
    // what gets fetched; only what is written to the log is trimmed.
    const loggableUrl = forLog(url);
    this.debug('public binary GET request', { url: loggableUrl });
    const response = await this.ctx.fetchPublic(url, { signal });
    this.debug('public binary GET response', { url: loggableUrl, status: response.status, ok: response.ok });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Graph download failed', { url: loggableUrl, status: response.status, body });
      throw new GraphHttpError(`Microsoft Graph download ${response.status}: ${response.statusText} — ${truncate(body)}`, response.status);
    }

    return response.arrayBuffer();
  }
}

export interface GraphPageResult {
  readonly items: readonly unknown[];
  /** `@odata.nextLink`, passed straight through as the plugin API's opaque cursor. */
  readonly cursor?: string;
  /** `@odata.deltaLink` — only present on `/delta` responses once the feed has caught up. */
  readonly deltaLink?: string;
}

/**
 * Fetches exactly one page of a Graph `@odata.nextLink`-paginated endpoint.
 * Deliberately doesn't loop — `listContainers`/`listFiles`/`searchFiles` page
 * one Graph call at a time and let the host drive, the same discipline
 * `source-dalux`'s `fetchPage` documents for the same reason: never eagerly
 * load a whole (potentially huge) drive into memory before returning the
 * first row.
 */
export async function fetchPage(
  client: BrowserGraphApiClient,
  endpointOrCursor: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<GraphPageResult> {
  const response = await client.get(endpointOrCursor, params, signal);
  const decoded = decodeCollectionPage(response);
  return { items: decoded.items, cursor: decoded.nextLink, deltaLink: decoded.deltaLink };
}
