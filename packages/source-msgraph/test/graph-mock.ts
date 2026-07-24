/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { vi } from 'vitest';
import type { KeyValueStore, Logger, PluginContext, SourceAuth } from '@ifc-lite/plugin-api';
import type { GraphTokenSource } from '../src/graph-client.js';

// ============================================================================
// A tiny, deterministic, in-memory Microsoft Graph double — enough of `/me`,
// `/me/drives`, `/drives/{id}/root(|/items/{id})/children`, `/versions`,
// `/versions/{id}/content` and `/root/search|delta` to run the shared
// `@ifc-lite/source-fixture` conformance suite against `MsGraphProvider`
// without ever hitting a real tenant. Not a general Graph emulator — every
// route here exists because one conformance check exercises it.
// ============================================================================

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DOWNLOAD_HOST = 'https://contoso.sharepoint.com/download';

export interface MockFile {
  readonly id: string;
  readonly name: string;
  readonly cTag: string;
  readonly versions?: ReadonlyArray<{ readonly id: string; readonly content: string }>;
}

export interface MockFolder {
  readonly id: string;
  readonly name: string;
  readonly files?: readonly MockFile[];
  readonly folders?: readonly MockFolder[];
}

export interface MockDrive {
  readonly id: string;
  readonly name: string;
  readonly rootFolders?: readonly MockFolder[];
}

export interface MockWorld {
  readonly drives: readonly MockDrive[];
}

/** The world the conformance suite runs against: two drives, nested folders, one file with two distinct-byte revisions. */
export const CONFORMANCE_WORLD: MockWorld = {
  drives: [
    {
      id: 'drive-1',
      name: 'Documents',
      rootFolders: [
        {
          id: 'folder-a',
          name: 'Models',
          files: [
            {
              id: 'file-1',
              name: 'model.ifc',
              cTag: 'ctag-2.0',
              versions: [
                { id: '2.0', content: 'the newer IFC bytes for file-1' },
                { id: '1.0', content: 'the older IFC bytes for file-1' },
              ],
            },
            { id: 'file-2', name: 'federated.ifcx', cTag: 'ctag-file-2' },
          ],
          folders: [{ id: 'folder-b', name: 'Archive' }],
        },
      ],
    },
    { id: 'drive-2', name: 'Empty drive' },
  ],
};

function findFolder(world: MockWorld, driveId: string, folderId: string): MockFolder | undefined {
  const drive = world.drives.find((d) => d.id === driveId);
  const stack = [...(drive?.rootFolders ?? [])];
  while (stack.length > 0) {
    const folder = stack.pop()!;
    if (folder.id === folderId) return folder;
    stack.push(...(folder.folders ?? []));
  }
  return undefined;
}

function findFile(world: MockWorld, driveId: string, fileId: string): MockFile | undefined {
  const drive = world.drives.find((d) => d.id === driveId);
  const stack = [...(drive?.rootFolders ?? [])];
  while (stack.length > 0) {
    const folder = stack.pop()!;
    const file = folder.files?.find((f) => f.id === fileId);
    if (file) return file;
    stack.push(...(folder.folders ?? []));
  }
  return undefined;
}

interface ChildEntry {
  readonly id: string;
  readonly name: string;
  readonly folder?: { childCount: number };
  readonly file?: { mimeType: string };
  readonly cTag?: string;
}

function childrenOf(world: MockWorld, driveId: string, parentKey: 'root' | string): ChildEntry[] {
  const drive = world.drives.find((d) => d.id === driveId);
  const folders = parentKey === 'root' ? (drive?.rootFolders ?? []) : (findFolder(world, driveId, parentKey)?.folders ?? []);
  const files = parentKey === 'root' ? [] : (findFolder(world, driveId, parentKey)?.files ?? []);

  // Files first: a conformance check requests a single-item page (`limit: 1`)
  // and expects at least one *file* in it — if a folder sorted first, that
  // page would come back empty after `listFiles`'s own folder filter.
  return [
    ...files.map((f) => ({ id: f.id, name: f.name, file: { mimeType: 'application/octet-stream' }, cTag: f.cTag })),
    ...folders.map((f) => ({ id: f.id, name: f.name, folder: { childCount: (f.files?.length ?? 0) + (f.folders?.length ?? 0) } })),
  ];
}

/** Reads `$top`/`_skip` off a URL and slices `items`, attaching a `_skip`-carrying nextLink of the same URL when more remain. */
function paginate<T>(url: URL, items: readonly T[]): { value: T[]; '@odata.nextLink'?: string } {
  const top = Number(url.searchParams.get('$top')) || items.length || 1;
  const skip = Number(url.searchParams.get('_skip')) || 0;
  const page = items.slice(skip, skip + top);
  const hasMore = skip + top < items.length;
  if (!hasMore) return { value: page };

  const next = new URL(url.toString());
  next.searchParams.set('_skip', String(skip + top));
  next.searchParams.set('$top', String(top));
  return { value: page, '@odata.nextLink': next.toString() };
}

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}

/** Builds `ctx.fetch` + `ctx.fetchPublic` implementations backed by `CONFORMANCE_WORLD`. */
export function createGraphMock(world: MockWorld = CONFORMANCE_WORLD) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    checkAborted(init?.signal);
    const path = url.pathname.replace(/^\/v1\.0/, '');

    if (path === '/me') return jsonResponse({ id: 'user-1', displayName: 'Conformance User' });
    if (path === '/me/followedSites') return jsonResponse({ value: [] });

    if (path === '/me/drives') {
      return jsonResponse(paginate(url, world.drives.map((d) => ({ id: d.id, name: d.name, driveType: 'business' }))));
    }

    const rootChildren = /^\/drives\/([^/]+)\/root\/children$/.exec(path);
    if (rootChildren) return jsonResponse(paginate(url, childrenOf(world, rootChildren[1], 'root')));

    const itemChildren = /^\/drives\/([^/]+)\/items\/([^/]+)\/children$/.exec(path);
    if (itemChildren) return jsonResponse(paginate(url, childrenOf(world, itemChildren[1], itemChildren[2])));

    const itemMeta = /^\/drives\/([^/]+)\/items\/([^/]+)$/.exec(path);
    if (itemMeta && url.searchParams.get('select')?.includes('downloadUrl')) {
      const [, driveId, itemId] = itemMeta;
      return jsonResponse({ id: itemId, '@microsoft.graph.downloadUrl': `${DOWNLOAD_HOST}/${driveId}/${itemId}` });
    }

    const versions = /^\/drives\/([^/]+)\/items\/([^/]+)\/versions$/.exec(path);
    if (versions) {
      const file = findFile(world, versions[1], versions[2]);
      const list = (file?.versions ?? []).map((v) => ({ id: v.id, lastModifiedDateTime: '2026-01-01T00:00:00Z' }));
      return jsonResponse(paginate(url, list));
    }

    const versionContent = /^\/drives\/([^/]+)\/items\/([^/]+)\/versions\/([^/]+)\/content$/.exec(path);
    if (versionContent) {
      const file = findFile(world, versionContent[1], versionContent[2]);
      const version = file?.versions?.find((v) => v.id === versionContent[3]);
      if (!version) return new Response('not found', { status: 404, statusText: 'Not Found' });
      return new Response(new TextEncoder().encode(version.content), { status: 200, statusText: 'OK' });
    }

    const search = /^\/drives\/([^/]+)\/root\/search\(q='(.*)'\)$/.exec(path);
    if (search) {
      const [, driveId] = search;
      const drive = world.drives.find((d) => d.id === driveId);
      const allFiles: ChildEntry[] = [];
      const stack = [...(drive?.rootFolders ?? [])];
      while (stack.length > 0) {
        const folder = stack.pop()!;
        for (const file of folder.files ?? []) {
          allFiles.push({ id: file.id, name: file.name, file: { mimeType: 'application/octet-stream' }, cTag: file.cTag });
        }
        stack.push(...(folder.folders ?? []));
      }
      return jsonResponse({ value: allFiles });
    }

    const delta = /^\/drives\/([^/]+)\/root\/delta$/.exec(path);
    if (delta) {
      const driveId = delta[1];
      return jsonResponse({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/drives/${driveId}/root/delta?token=seeded` });
    }

    throw new Error(`Unhandled mock Graph request: ${url.toString()}`);
  };

  const fetchPublicImpl: PluginContext['fetchPublic'] = async (url, init) => {
    checkAborted(init?.signal);
    const match = /^https:\/\/contoso\.sharepoint\.com\/download\/([^/]+)\/([^/]+)$/.exec(url);
    if (!match) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const [, driveId, itemId] = match;
    const file = findFile(world, driveId, itemId);
    // "Latest" is whichever version sorts first in the fixture's own list —
    // matching how the real endpoint always serves current content.
    const latest = file?.versions?.[0]?.content ?? `${itemId}-latest-bytes`;
    return new Response(new TextEncoder().encode(latest), { status: 200, statusText: 'OK' });
  };

  return { fetch: fetchImpl, fetchPublic: fetchPublicImpl };
}

function createMockStorage(): KeyValueStore {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve([...store.keys()])),
  };
}

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export function createConformanceContext(world: MockWorld = CONFORMANCE_WORLD): PluginContext {
  const { fetch: fetchImpl, fetchPublic } = createGraphMock(world);
  return {
    fetch: fetchImpl,
    fetchPublic,
    getPreference: vi.fn(() => Promise.resolve(undefined)),
    storage: createMockStorage(),
    log: createMockLogger(),
  };
}

/** A no-op-interactive `SourceAuth` + `GraphTokenSource`: always "signed in", no MSAL involved. */
export function createConformanceAuth(): SourceAuth & GraphTokenSource {
  return {
    restore: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Conformance User' }),
    signIn: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Conformance User' }),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdentity: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Conformance User' }),
    getAccessToken: vi.fn().mockResolvedValue('conformance-fake-token'),
  };
}
