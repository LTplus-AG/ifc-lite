/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An in-memory stand-in for the Microsoft Graph REST API, wired in as a
 * `PluginContext.fetch` (authenticated calls) and `PluginContext.fetchPublic`
 * (pre-signed download URLs) pair — mirrors `source-dalux`'s
 * `dalux-api-mock.ts`, adapted to Graph's `@odata.nextLink` pagination and
 * its split between an authenticated API host and pre-signed, unauthenticated
 * CDN download URLs.
 */

import type { KeyValueStore, Logger, PluginContext } from '@ifc-lite/plugin-api';

import { resetTokenManagerCache } from '../src/auth.js';

export const GRAPH_MOCK_BASE_URL = 'https://graph.microsoft.com/v1.0';
export const GRAPH_MOCK_DOWNLOAD_HOST = 'https://mock.files.1drv.com';
export const MOCK_ACCESS_TOKEN = 'mock-access-token';

export interface GraphMockItem {
  readonly id: string;
  readonly name: string;
  /** `undefined` means the item sits directly at the drive root. */
  readonly parentId?: string;
  readonly kind: 'folder' | 'file';
  readonly childCount?: number;
  readonly size?: number;
  readonly mimeType?: string;
  readonly cTag?: string;
  /** Bytes served through the mock `@microsoft.graph.downloadUrl`. Files only. */
  readonly content?: string;
  readonly deleted?: boolean;
}

export interface GraphMockVersion {
  readonly id: string;
  readonly size?: number;
  readonly lastModifiedDateTime?: string;
}

export interface GraphMockWorld {
  readonly driveId: string;
  readonly driveName: string;
  readonly items: readonly GraphMockItem[];
  readonly versionsByFileId?: Readonly<Record<string, readonly GraphMockVersion[]>>;
}

export interface GraphMockOptions {
  /** Items per response when the caller doesn't force a smaller `$top`. Default `200`. */
  readonly defaultPageSize?: number;
}

interface MockResponseInit {
  readonly status?: number;
  readonly json?: unknown;
  readonly body?: string;
}

function mockResponse({ status = 200, json, body }: MockResponseInit): Response {
  const text = body ?? (json === undefined ? '' : JSON.stringify(json));
  const encoded = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Error',
    headers: { get: () => (json === undefined ? 'application/octet-stream' : 'application/json') },
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)),
  } as unknown as Response;
}

function itemJson(item: GraphMockItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    cTag: item.cTag ?? `ctag-${item.id}`,
    eTag: `etag-${item.id}`,
    lastModifiedDateTime: '2026-08-06T10:00:00Z',
    lastModifiedBy: { user: { id: 'user-1', displayName: 'Mock User' } },
    parentReference: item.parentId ? { id: item.parentId } : { id: 'root' },
    ...(item.kind === 'folder' ? { folder: { childCount: item.childCount ?? 0 } } : {}),
    ...(item.kind === 'file' ? { file: { mimeType: item.mimeType ?? 'application/octet-stream' } } : {}),
    ...(item.deleted ? { deleted: { state: 'deleted' } } : {}),
    // Only present when the fixture actually gave this file bytes to serve —
    // lets a test model a file Graph reports but exposes no download URL for
    // (`content: undefined`), distinct from a real, downloadable file.
    ...(item.kind === 'file' && !item.deleted && item.content !== undefined
      ? { '@microsoft.graph.downloadUrl': downloadUrlFor(item.id) }
      : {}),
  };
}

/**
 * A real `@microsoft.graph.downloadUrl` carries its authorization *in the
 * query string* (`tempauth=...` on SharePoint/OneDrive-for-Business hosts) —
 * that is what makes the URL pre-authenticated and what makes it a credential.
 * The mock reproduces that shape so a test can assert the secret half never
 * escapes into a log line; {@link GRAPH_MOCK_DOWNLOAD_SECRET} is the part
 * that must never be logged.
 */
export const GRAPH_MOCK_DOWNLOAD_SECRET = 'tempauth-secret-value';

export function downloadUrlFor(fileId: string): string {
  return `${GRAPH_MOCK_DOWNLOAD_HOST}/${encodeURIComponent(fileId)}?tempauth=${GRAPH_MOCK_DOWNLOAD_SECRET}`;
}

/** Slices a `$top`-paginated page, honoring the caller's own `$top` — unlike
 *  Dalux, Graph genuinely supports client-controlled page size. Returns the
 *  literal `@odata.nextLink` key Graph responses use — the provider's
 *  decoder (`decodeCollectionPage` in `msgraph-types.ts`) reads exactly that
 *  key, not a friendlier alias. */
function paginate(
  rows: readonly Record<string, unknown>[],
  url: URL,
  defaultPageSize: number,
): { value: unknown[]; '@odata.nextLink'?: string } {
  const top = Number(url.searchParams.get('$top') ?? defaultPageSize) || defaultPageSize;
  const skip = Number(url.searchParams.get('$skiptoken') ?? 0) || 0;
  const slice = rows.slice(skip, skip + top);
  const next = skip + slice.length;
  const hasMore = next < rows.length;

  if (!hasMore) return { value: slice };

  const nextUrl = new URL(url.toString());
  nextUrl.searchParams.set('$skiptoken', String(next));
  return { value: slice, '@odata.nextLink': nextUrl.toString() };
}

function findItem(world: GraphMockWorld, id: string): GraphMockItem | undefined {
  return world.items.find((item) => item.id === id);
}

function childrenOf(world: GraphMockWorld, parentId: string | undefined): GraphMockItem[] {
  return world.items.filter((item) => (parentId === undefined || parentId === 'root' ? item.parentId === undefined : item.parentId === parentId));
}

/**
 * Builds a `fetch` serving `world` over the Graph routes this provider
 * actually calls. Checks the `Authorization` header against
 * {@link MOCK_ACCESS_TOKEN} and answers `401` on a mismatch, so
 * auth-failure handling has something real to exercise. Unrouted paths
 * answer `404` rather than an empty listing, so a provider change that
 * starts calling an endpoint this mock doesn't model fails loudly.
 */
export function createGraphApiMock(world: GraphMockWorld, options: GraphMockOptions = {}): typeof fetch {
  const defaultPageSize = options.defaultPageSize ?? 200;

  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'object' && input !== null && 'url' in input ? (input as Request) : undefined;
    const href = request ? request.url : input.toString();
    const signal = init?.signal ?? request?.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    const headers = new Headers(init?.headers ?? request?.headers);
    const authorization = headers.get('Authorization');
    if (authorization !== `Bearer ${MOCK_ACCESS_TOKEN}`) {
      return Promise.resolve(mockResponse({ status: 401, body: 'invalid_token' }));
    }

    const url = new URL(href);
    const path = url.pathname.replace(/^\/v1\.0\/?/, '');

    if (path === 'me' || path === 'me/') {
      return Promise.resolve(
        mockResponse({ json: { id: 'user-1', displayName: 'Mock User', mail: 'mock@example.com' } }),
      );
    }

    if (path === 'me/drive') {
      return Promise.resolve(
        mockResponse({ json: { id: world.driveId, name: world.driveName, driveType: 'business', owner: { user: { displayName: 'Mock Owner' } } } }),
      );
    }

    if (path === 'me/drive/root/delta') {
      const rows = world.items.map(itemJson);
      const page = paginate(rows, url, defaultPageSize);
      return Promise.resolve(
        mockResponse({
          json: page['@odata.nextLink']
            ? { value: page.value, '@odata.nextLink': page['@odata.nextLink'] }
            : { value: page.value, '@odata.deltaLink': `${GRAPH_MOCK_BASE_URL}/me/drive/root/delta?token=done` },
        }),
      );
    }

    if (path === 'me/drive/root/children') {
      const rows = childrenOf(world, undefined).filter((i) => !i.deleted).map(itemJson);
      return Promise.resolve(mockResponse({ json: paginate(rows, url, defaultPageSize) }));
    }

    const searchMatch = path.match(/^me\/drive\/root\/search\(q='(.*)'\)$/);
    if (searchMatch) {
      const query = decodeURIComponent(searchMatch[1]).replace(/''/g, "'").toLowerCase();
      const rows = world.items
        .filter((i) => !i.deleted && i.kind === 'file' && i.name.toLowerCase().includes(query))
        .map(itemJson);
      return Promise.resolve(mockResponse({ json: paginate(rows, url, defaultPageSize) }));
    }

    const childrenMatch = path.match(/^me\/drive\/items\/([^/]+)\/children$/);
    if (childrenMatch) {
      const parentId = decodeURIComponent(childrenMatch[1]);
      if (!findItem(world, parentId)) return Promise.resolve(mockResponse({ status: 404, body: 'no such item' }));
      const rows = childrenOf(world, parentId).filter((i) => !i.deleted).map(itemJson);
      return Promise.resolve(mockResponse({ json: paginate(rows, url, defaultPageSize) }));
    }

    const versionsMatch = path.match(/^me\/drive\/items\/([^/]+)\/versions$/);
    if (versionsMatch) {
      const fileId = decodeURIComponent(versionsMatch[1]);
      const versions = world.versionsByFileId?.[fileId] ?? [];
      return Promise.resolve(mockResponse({ json: { value: versions } }));
    }

    const itemMatch = path.match(/^me\/drive\/items\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      const item = findItem(world, id);
      if (!item) return Promise.resolve(mockResponse({ status: 404, body: 'no such item' }));
      return Promise.resolve(mockResponse({ json: itemJson(item) }));
    }

    return Promise.resolve(mockResponse({ status: 404, body: `unrouted: ${url.pathname}` }));
  }) as typeof fetch;
}

/** Serves pre-signed `@microsoft.graph.downloadUrl` bytes — never checks for
 *  an `Authorization` header, since `ctx.fetchPublic` strips it (that's the
 *  entire point of using this path instead of `/content`). */
export function createGraphPublicMock(world: GraphMockWorld): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input.toString();
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    const url = new URL(href);
    const fileId = decodeURIComponent(url.pathname.slice(1));
    const item = world.items.find((i) => i.id === fileId && i.kind === 'file');
    if (!item || item.content === undefined) return Promise.resolve(mockResponse({ status: 404, body: 'no such file' }));
    return Promise.resolve(mockResponse({ body: item.content }));
  }) as typeof fetch;
}

function createMemoryStorage(seed: Record<string, string> = {}): KeyValueStore {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: (key) => Promise.resolve(store.get(key)),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...store.keys()]),
  };
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A `PluginContext` backed by {@link createGraphApiMock}/{@link createGraphPublicMock},
 * pre-seeded with a still-valid stored token so `createClient()` never needs
 * an interactive sign-in or a real token refresh to run a listing/download
 * call.
 *
 * Also drops the provider's process-wide `TokenManager` cache (see the
 * `managerCache` doc in `src/auth.ts`). That cache is keyed on
 * `(clientId, tenant)` — deliberately, so that concurrent refreshes across
 * separate host contexts collapse onto one — and every context this factory
 * builds reports the same `mock-client-id`/`common` pair. Resetting here makes
 * "a fresh mock context gets a fresh manager" structural: a test cannot obtain
 * a context without it, so no test can silently inherit the previous one's
 * storage or `fetch` by forgetting a `beforeEach`.
 */
export function createGraphMockContext(world: GraphMockWorld, options: GraphMockOptions = {}): PluginContext {
  resetTokenManagerCache();

  const tokens = {
    accessToken: MOCK_ACCESS_TOKEN,
    refreshToken: 'mock-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  return {
    fetch: createGraphApiMock(world, options),
    fetchPublic: (url, init) => createGraphPublicMock(world)(url, init as RequestInit | undefined),
    getPreference: (name: string) => {
      if (name === 'clientId') return Promise.resolve('mock-client-id');
      if (name === 'tenant') return Promise.resolve('common');
      return Promise.resolve(undefined);
    },
    storage: createMemoryStorage({ 'msgraph:tokens': JSON.stringify(tokens) }),
    log: silentLogger,
  };
}
