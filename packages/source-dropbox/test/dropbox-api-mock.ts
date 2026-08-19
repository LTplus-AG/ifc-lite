/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An in-memory stand-in for the Dropbox API, wired in as a
 * `PluginContext.fetch` pair covering both `api.dropboxapi.com` (RPC-style
 * endpoints: listing, revisions, search, account) and
 * `content.dropboxapi.com` (`files/download`, argument in the
 * `Dropbox-API-Arg` header) — mirrors `source-msgraph`'s
 * `msgraph-api-mock.ts`, adapted to Dropbox's single-cursor `list_folder`/
 * `list_folder/continue` pagination and its header-carried download argument.
 *
 * Unlike Graph, this provider never uses `ctx.fetchPublic` — `files/download`
 * is a normal authenticated POST, not a pre-signed CDN URL — so there is no
 * separate "public" mock here.
 */

import type { KeyValueStore, Logger, PluginContext } from '@ifc-lite/plugin-api';

import { resetTokenManagerCache } from '../src/auth.js';

export const DROPBOX_MOCK_ACCESS_TOKEN = 'mock-access-token';

export interface DropboxMockItem {
  readonly id: string;
  readonly name: string;
  /** `undefined` means the item sits directly at the Dropbox root. */
  readonly parentId?: string;
  readonly kind: 'folder' | 'file';
  readonly size?: number;
  readonly rev?: string;
  /** Bytes served through the mock `files/download` for the *current* revision. Files only. */
  readonly content?: string;
  readonly deleted?: boolean;
}

export interface DropboxMockRevision {
  readonly rev: string;
  readonly size?: number;
  readonly server_modified?: string;
  /** Bytes served for `path: "rev:<rev>"` downloads of this historical revision. */
  readonly content?: string;
}

export interface DropboxMockWorld {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
  readonly items: readonly DropboxMockItem[];
  readonly revisionsByFileId?: Readonly<Record<string, readonly DropboxMockRevision[]>>;
}

export interface DropboxMockOptions {
  /** Entries per response when the caller doesn't force a smaller `limit`. Default `200`. */
  readonly defaultPageSize?: number;
  /** Called with the routed API path (e.g. `"files/get_metadata"`) on every
   *  request this mock answers — lets a test count calls to a specific
   *  endpoint (e.g. asserting a batched round trip isn't made once per
   *  search match). */
  readonly onRequest?: (path: string) => void;
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

/** Renders an item marked `deleted: true` as real Dropbox's `DeletedMetadata`
 *  — `name`/`path_lower` only, deliberately **no `id`** (real Dropbox never
 *  includes one on a deleted entry). Only used for the flat/watch-mode
 *  continuation feed; a scoped `list_folder` browse still just omits deleted
 *  items outright, matching a real folder listing. */
function deletedJson(world: DropboxMockWorld, item: DropboxMockItem): Record<string, unknown> {
  return { '.tag': 'deleted', name: item.name, path_lower: pathLowerOf(world, item) };
}

function itemJson(world: DropboxMockWorld, item: DropboxMockItem): Record<string, unknown> {
  if (item.kind === 'folder') {
    return { '.tag': 'folder', id: item.id, name: item.name, path_lower: pathLowerOf(world, item) };
  }
  return {
    '.tag': 'file',
    id: item.id,
    name: item.name,
    path_lower: pathLowerOf(world, item),
    size: item.size ?? 0,
    rev: item.rev ?? `rev-${item.id}`,
    client_modified: '2026-08-06T10:00:00Z',
    server_modified: '2026-08-06T10:00:00Z',
    content_hash: `hash-${item.id}`,
  };
}

/** Walks the mock world's `parentId` chain to build the same nested
 *  `path_lower` shape real Dropbox metadata carries — needed so
 *  `searchResultParentPath` (in `mapping.ts`) has a real parent path to
 *  derive from, not just a bare filename. */
function pathLowerOf(world: DropboxMockWorld, item: DropboxMockItem): string {
  const segments: string[] = [item.name.toLowerCase()];
  let current: DropboxMockItem | undefined = item;
  while (current?.parentId) {
    const parent = findItem(world, current.parentId);
    if (!parent) break;
    segments.unshift(parent.name.toLowerCase());
    current = parent;
  }
  return `/${segments.join('/')}`;
}

function findItem(world: DropboxMockWorld, id: string): DropboxMockItem | undefined {
  return world.items.find((item) => item.id === id);
}

/** Looks up a mock item by its lower-cased path (`files/get_metadata`
 *  accepts a `path_lower`/`path_display` just as readily as an `id` — see
 *  `pathArgFor`'s doc comment in `mapping.ts`), used to resolve a search
 *  result's parent-path lookup back to the folder that owns it. */
function findItemByPath(world: DropboxMockWorld, path: string): DropboxMockItem | undefined {
  if (!path) return undefined;
  const lower = path.toLowerCase();
  return world.items.find((item) => pathLowerOf(world, item) === lower);
}

function childrenOf(world: DropboxMockWorld, parentId: string | undefined): DropboxMockItem[] {
  return world.items.filter((item) => item.parentId === parentId);
}

/**
 * This mock's cursor is opaque to the provider (as real Dropbox cursors are)
 * but needs to remember, between a `list_folder`/`get_latest_cursor` call
 * and its matching `list_folder/continue`, both a pagination offset *and*
 * which listing it's continuing:
 *  - `parentId` (`undefined` for the account root) — a `list_folder` page
 *    boundary, scoped to one folder's direct children.
 *  - `flat: true` — a `list_folder/get_latest_cursor`/watch-mode continuation,
 *    which (matching the real `recursive: true` call `watchRevisions` makes
 *    in `provider.ts`) walks *every* item in `world`, not just one folder's
 *    children. Without this distinction, continuing a watch cursor would
 *    incorrectly fall back to listing only root-level items.
 */
interface EncodedCursor {
  readonly offset: number;
  readonly parentId?: string;
  readonly flat?: true;
  /** Search-only: real Dropbox's `search/continue_v2` cursor implicitly
   *  remembers the query the initial `search_v2` call was for — this mock
   *  has to carry it explicitly since it re-derives matches from `world`
   *  on every call rather than holding server-side state. */
  readonly query?: string;
}

function encodeCursor(offset: number, extra: Omit<EncodedCursor, 'offset'> = {}): string {
  return JSON.stringify({ offset, ...extra } satisfies EncodedCursor);
}

function decodeCursor(cursor: string): EncodedCursor {
  const parsed = JSON.parse(cursor) as EncodedCursor;
  return {
    offset: typeof parsed.offset === 'number' ? parsed.offset : 0,
    parentId: typeof parsed.parentId === 'string' ? parsed.parentId : undefined,
    flat: parsed.flat === true ? true : undefined,
    query: typeof parsed.query === 'string' ? parsed.query : undefined,
  };
}

/** Slices a `limit`-paginated page of pre-computed rows, honoring the
 *  caller's own `limit` — Dropbox genuinely supports client-controlled page
 *  size for `list_folder`/`search_v2`, unlike Dalux. Returns the literal
 *  `entries`/`cursor`/`has_more` keys real Dropbox responses use. */
function paginate(rows: readonly Record<string, unknown>[], limit: number, offset: number): { value: unknown[]; nextOffset: number; hasMore: boolean } {
  const slice = rows.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return { value: slice, nextOffset, hasMore: nextOffset < rows.length };
}

function readJsonBody(init: RequestInit | undefined): unknown {
  if (!init?.body) return undefined;
  try {
    return JSON.parse(init.body as string);
  } catch {
    return undefined;
  }
}

/**
 * Builds a `fetch` serving `world` over the `api.dropboxapi.com` RPC routes
 * this provider actually calls. Checks the `Authorization` header against
 * {@link DROPBOX_MOCK_ACCESS_TOKEN} and answers `401` on a mismatch, so
 * auth-failure handling has something real to exercise. Unrouted paths
 * answer `404` rather than an empty result, so a provider change that starts
 * calling an endpoint this mock doesn't model fails loudly.
 */
export function createDropboxApiMock(world: DropboxMockWorld, options: DropboxMockOptions = {}): typeof fetch {
  const defaultPageSize = options.defaultPageSize ?? 200;

  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization');
    if (authorization !== `Bearer ${DROPBOX_MOCK_ACCESS_TOKEN}`) {
      return Promise.resolve(mockResponse({ status: 401, body: 'invalid_access_token' }));
    }

    const href = typeof input === 'string' ? input : input.toString();
    const path = new URL(href).pathname.replace(/^\/2\//, '');
    const body = readJsonBody(init) as Record<string, unknown> | undefined;
    options.onRequest?.(path);

    if (path === 'files/get_metadata') {
      const requestedPath = typeof body?.path === 'string' ? body.path : '';
      const item = findItemByPath(world, requestedPath) ?? findItem(world, requestedPath);
      if (!item || item.deleted) {
        return Promise.resolve(mockResponse({ status: 409, body: 'path/not_found' }));
      }
      return Promise.resolve(mockResponse({ json: itemJson(world, item) }));
    }

    if (path === 'users/get_current_account') {
      return Promise.resolve(
        mockResponse({ json: { account_id: world.accountId, name: { display_name: world.displayName }, email: world.email } }),
      );
    }

    if (path === 'files/list_folder' || path === 'files/list_folder/continue') {
      let parentId: string | undefined;
      let offset = 0;
      let flat = false;

      if (path === 'files/list_folder/continue') {
        const cursor = typeof body?.cursor === 'string' ? body.cursor : undefined;
        if (!cursor) return Promise.resolve(mockResponse({ status: 409, body: 'invalid_cursor' }));
        const decoded = decodeCursor(cursor);
        offset = decoded.offset;
        parentId = decoded.parentId;
        flat = decoded.flat === true;
      } else {
        const requestedPath = typeof body?.path === 'string' ? body.path : '';
        parentId = requestedPath === '' ? undefined : requestedPath;
        if (parentId && !findItem(world, parentId)) {
          return Promise.resolve(mockResponse({ status: 409, body: 'path/not_found' }));
        }
      }

      const rows = (flat ? world.items : childrenOf(world, parentId))
        .filter((i) => flat || !i.deleted)
        .map((item) => (item.deleted ? deletedJson(world, item) : itemJson(world, item)));
      const limit = typeof body?.limit === 'number' ? body.limit : defaultPageSize;
      const page = paginate(rows, limit, offset);
      const cursor = encodeCursor(page.nextOffset, flat ? { flat: true } : { parentId });
      return Promise.resolve(mockResponse({ json: { entries: page.value, cursor, has_more: page.hasMore } }));
    }

    if (path === 'files/list_folder/get_latest_cursor') {
      // The real endpoint returns only a cursor, never entries — this mock's
      // cursor points at the current end of the flat (non-deleted) item
      // list, matching the domain `flat: true` continuation slices in the
      // block above, so a subsequent `list_folder/continue` naturally
      // reports nothing until a *different* `PluginContext` built against a
      // world with more items past that point is used to continue it (the
      // pattern the "reports an event" tests in `provider.test.ts` use,
      // since the cursor itself carries no reference back to this call's
      // `world`).
      const flatCount = world.items.filter((i) => !i.deleted).length;
      return Promise.resolve(mockResponse({ json: { cursor: encodeCursor(flatCount, { flat: true }) } }));
    }

    if (path === 'files/list_revisions') {
      const fileId = typeof body?.path === 'string' ? body.path : '';
      const allRevisions = world.revisionsByFileId?.[fileId] ?? [];
      const limit = typeof body?.limit === 'number' ? body.limit : 10;

      // Mirrors real Dropbox's `before_rev`: "only return revisions prior to
      // before_rev" — since `entries` here (like the real API) is ordered
      // newest-first, "prior to" means everything *after* that rev's index.
      // A `before_rev` naming a rev this mock doesn't know about (already
      // paged past, or never existed) yields no further rows rather than
      // silently restarting from the top.
      const beforeRev = typeof body?.before_rev === 'string' ? body.before_rev : undefined;
      const startIndex = beforeRev
        ? (() => {
            const idx = allRevisions.findIndex((r) => r.rev === beforeRev);
            return idx === -1 ? allRevisions.length : idx + 1;
          })()
        : 0;

      const remaining = allRevisions.slice(startIndex);
      const page = remaining.slice(0, limit);
      const hasMore = remaining.length > limit;
      const entries = page.map((r) => ({
        '.tag': 'file',
        id: fileId,
        name: findItem(world, fileId)?.name ?? fileId,
        rev: r.rev,
        size: r.size,
        server_modified: r.server_modified,
      }));
      return Promise.resolve(mockResponse({ json: { is_deleted: false, entries, has_more: hasMore } }));
    }

    if (path === 'files/search_v2' || path === 'files/search/continue_v2') {
      let offset = 0;
      let query = '';

      if (path === 'files/search/continue_v2') {
        const cursor = typeof body?.cursor === 'string' ? body.cursor : undefined;
        if (!cursor) return Promise.resolve(mockResponse({ status: 409, body: 'invalid_cursor' }));
        const decoded = decodeCursor(cursor);
        offset = decoded.offset;
        query = decoded.query ?? '';
      } else {
        query = typeof body?.query === 'string' ? body.query.toLowerCase() : '';
      }

      // A fresh query re-derives the full match set; `continue_v2` reuses
      // whatever the initial call would have matched — the query itself is
      // round-tripped through the cursor (see `EncodedCursor.query`'s doc
      // comment) rather than persisted server-side, since this mock has no
      // server-side session to hold it in between calls.
      const allFiles = world.items.filter((i) => !i.deleted && i.kind === 'file');
      const matched = query ? allFiles.filter((i) => i.name.toLowerCase().includes(query)) : allFiles;
      // `SearchMatchV2.metadata` is the `MetadataV2` *union*, not a bare
      // `Metadata` — real responses nest the entry one level down under a
      // `".tag": "metadata"` wrapper. Emitting the wrapper (rather than the
      // bare entry an earlier version of this mock produced) is what makes
      // this fixture match a real `files/search_v2` response body.
      const rows = matched.map((item) => ({ metadata: { '.tag': 'metadata', metadata: itemJson(world, item) } }));
      const optionsRaw = body?.options as Record<string, unknown> | undefined;
      const limit = typeof optionsRaw?.max_results === 'number' ? optionsRaw.max_results : defaultPageSize;
      // Real Dropbox validates `SearchOptions.max_results` against its
      // declared `UInt64(min_value=1, max_value=1000)` range and answers 400
      // for an out-of-range value — see `MAX_SEARCH_PAGE_SIZE` in
      // `mapping.ts`. Enforced here so a provider that fails to clamp fails
      // loudly in tests instead of only against the real API.
      if (limit > 1000) {
        return Promise.resolve(mockResponse({ status: 400, body: `Error in call to API function "files/search_v2": request body: options.max_results: expected integer <= 1000, got ${limit}` }));
      }
      const page = paginate(rows, limit, offset);
      const cursor = encodeCursor(page.nextOffset, { query });
      return Promise.resolve(mockResponse({ json: { matches: page.value, cursor, has_more: page.hasMore } }));
    }

    return Promise.resolve(mockResponse({ status: 404, body: `unrouted: ${path}` }));
  }) as typeof fetch;
}

/**
 * Serves `content.dropboxapi.com/2/files/download` — reads `path` out of the
 * `Dropbox-API-Arg` request header (never a query param or body), matching
 * real Dropbox's content-endpoint convention. `path` is either a known
 * item's `id` (current content) or `"rev:<rev>"` (historical content, looked
 * up in `revisionsByFileId`).
 */
export function createDropboxContentMock(world: DropboxMockWorld): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization');
    if (authorization !== `Bearer ${DROPBOX_MOCK_ACCESS_TOKEN}`) {
      return Promise.resolve(mockResponse({ status: 401, body: 'invalid_access_token' }));
    }

    const argHeader = headers.get('Dropbox-API-Arg');
    if (!argHeader) return Promise.resolve(mockResponse({ status: 400, body: 'missing Dropbox-API-Arg' }));
    let arg: { path?: string };
    try {
      arg = JSON.parse(argHeader) as { path?: string };
    } catch {
      return Promise.resolve(mockResponse({ status: 400, body: 'malformed Dropbox-API-Arg' }));
    }
    const path = arg.path ?? '';

    if (path.startsWith('rev:')) {
      const rev = path.slice('rev:'.length);
      for (const [, revisions] of Object.entries(world.revisionsByFileId ?? {})) {
        const match = revisions.find((r) => r.rev === rev);
        if (match) {
          if (match.content === undefined) return Promise.resolve(mockResponse({ status: 409, body: 'path/not_found' }));
          return Promise.resolve(mockResponse({ body: match.content }));
        }
      }
      return Promise.resolve(mockResponse({ status: 409, body: 'path/not_found' }));
    }

    const item = findItem(world, path);
    if (!item || item.kind !== 'file' || item.deleted) {
      return Promise.resolve(mockResponse({ status: 409, body: 'path/not_found' }));
    }
    if (item.content === undefined) return Promise.resolve(mockResponse({ status: 409, body: 'path/not_found' }));
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
 * A `PluginContext` backed by {@link createDropboxApiMock}/{@link createDropboxContentMock},
 * pre-seeded with a still-valid stored token so `createClient()` never needs
 * an interactive sign-in or a real token refresh to run a listing/download
 * call. Routes `ctx.fetch` to the right mock based on the request's host,
 * since (unlike msgraph) this provider sends both RPC and content requests
 * through the same `ctx.fetch` — there is no separate `ctx.fetchPublic` path
 * to split them across.
 */
export function createDropboxMockContext(world: DropboxMockWorld, options: DropboxMockOptions = {}): PluginContext {
  // `createTokenManager` caches one manager per app key for the lifetime of
  // the module, and every mock context here uses the same `mock-client-id`.
  // Without this reset a test would inherit the PREVIOUS test's manager — and
  // with it that manager's `ctx.storage`, so a fresh context's seeded tokens
  // would be ignored in favour of a stale suite-wide store.
  resetTokenManagerCache();

  const tokens = {
    accessToken: DROPBOX_MOCK_ACCESS_TOKEN,
    refreshToken: 'mock-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  const apiMock = createDropboxApiMock(world, options);
  const contentMock = createDropboxContentMock(world);

  const fetchImpl: typeof fetch = (input, init) => {
    const href = typeof input === 'string' ? input : input.toString();
    const isContentHost = href.startsWith('https://content.dropboxapi.com/');
    return (isContentHost ? contentMock : apiMock)(input, init);
  };

  return {
    fetch: fetchImpl,
    fetchPublic: () => {
      throw new Error('DropboxProvider must never call ctx.fetchPublic — see manifest.ts');
    },
    getPreference: (name: string) => {
      if (name === 'clientId') return Promise.resolve('mock-client-id');
      return Promise.resolve(undefined);
    },
    storage: createMemoryStorage({ 'dropbox:tokens': JSON.stringify(tokens) }),
    log: silentLogger,
  };
}
