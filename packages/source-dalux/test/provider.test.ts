/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, KeyValueStore, Logger } from '@ifc-lite/plugin-api';
import { PLUGIN_API_VERSION, satisfiesCaretRange } from '@ifc-lite/plugin-api';
import { DaluxBuildProvider } from '../src/provider.js';
import { LATEST_REVISION, fileAreaContainerId, folderContainerId } from '../src/mapping.js';

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

function createMockCtx(
  fetchImpl: typeof fetch,
  preferences: Record<string, string> = { apiKey: 'test-key-123' },
): PluginContext {
  return {
    fetch: fetchImpl,
    fetchPublic: vi.fn(() => Promise.reject(new Error('fetchPublic not used in these tests'))),
    getPreference: vi.fn((name: string) => Promise.resolve(preferences[name])),
    storage: createMockStorage(),
    log: createMockLogger(),
  };
}

function mockResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: () => Promise.resolve(undefined),
    text: () => Promise.resolve(''),
    ...overrides,
  };
}

describe('DaluxBuildProvider', () => {
  let provider: DaluxBuildProvider;

  beforeEach(() => {
    provider = new DaluxBuildProvider();
  });

  it('exposes a manifest that satisfies the host contract version', () => {
    expect(provider.manifest.name).toBe('dalux-build');
    expect(provider.manifest.title).toBe('Dalux Box');
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, provider.manifest.api)).toBe(true);
    expect(provider.manifest.auth).toBe('preferences');
    expect(provider.manifest.permissions.network).toContain('*.dalux.com');
  });

  it('declares an honest relay and capabilities block', () => {
    expect(provider.manifest.permissions.relay).toEqual({
      upstream: 'https://node1.field.dalux.com/service/api',
      path: '/api/dalux',
    });
    expect(provider.manifest.capabilities).toEqual({
      containerListing: 'flat-subtree',
      listFilesIsRecursive: true,
      revisionHistory: false,
      downloadHistoricalRevisions: true,
      changeDetection: true,
      search: false,
      // #2613: Dalux opts into the eager file sweep -- its own UI has no
      // per-folder "load more files" concept, so the host must keep draining
      // a folder's file listing in full rather than paging it incrementally.
      eagerFileSweep: true,
    });
  });

  it('declares apiKey as required and baseUrl as optional', () => {
    // baseUrl was deliberately absent until #2792: Dalux assigns each customer
    // a node and prints its base URL beside the API key, so everyone not on
    // node1 was locked out of Dalux Box entirely. It stays OPTIONAL so the
    // node1 majority is unaffected and sends no node parameter at all.
    const prefs = provider.manifest.preferences;
    expect(prefs.find((p) => p.name === 'apiKey')?.required).toBe(true);
    expect(prefs.find((p) => p.name === 'baseUrl')?.required).toBe(false);
  });

  describe('listProjects', () => {
    it('maps Dalux projects to a Page<SourceProject> and pages one call at a time', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [
                { data: { projectId: 'p1', projectName: 'Project Alpha' } },
                { data: { projectId: 'p2', projectName: 'Project Beta' } },
              ],
              metadata: { totalRemainingItems: 5 },
              links: [{ rel: 'nextPage', href: 'https://node1.field.dalux.com/service/api/5.1/projects?bookmark=p3' }],
            }),
        }),
      );

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listProjects(ctx);

      expect(page.items).toEqual([
        { id: 'p1', name: 'Project Alpha' },
        { id: 'p2', name: 'Project Beta' },
      ]);
      expect(page.cursor).toBe('p3');
      // One HTTP call per page, not an eager crawl of the whole tenant.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://node1.field.dalux.com/service/api/5.1/projects',
        expect.objectContaining({ headers: expect.objectContaining({ 'X-API-KEY': 'test-key-123' }) }),
      );
    });

    it('drops an individually invalid project record instead of failing the whole page', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [
                { data: { projectId: 'p1', projectName: 'Good' } },
                { data: { projectId: 'p2' /* missing projectName */ } },
              ],
            }),
        }),
      );

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listProjects(ctx);

      expect(page.items).toEqual([{ id: 'p1', name: 'Good' }]);
      expect(ctx.log.warn).toHaveBeenCalled();
    });

    it('throws when API key is not configured', async () => {
      const mockFetch = vi.fn();
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch, {});

      await expect(provider.listProjects(ctx)).rejects.toThrow('Dalux API key not configured');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('listContainers', () => {
    it('returns only file areas at the top level, without walking folders', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas')) {
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({ items: [{ data: { fileAreaId: 'fa1', fileAreaName: 'Area', fileAreaType: 'Files' } }] }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve([]) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listContainers(ctx, 'proj1');

      expect(page.items).toEqual([{ id: 'fa1', name: 'Area', meta: { kind: 'file-area' } }]);
      expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('/folders'), expect.any(Object));
    });

    it('rebuilds the folder hierarchy under a composite container id when scoped to a file area', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({
                  items: [
                    { data: { folderId: 'root-folder', folderName: 'Root Folder' } },
                    { data: { folderId: 'nested-folder', folderName: 'Nested Folder', parentFolderId: 'root-folder' } },
                  ],
                }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve([]) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listContainers(ctx, 'proj1', fileAreaContainerId('fa1'));

      const rootFolderId = folderContainerId('fa1', 'root-folder');
      const nestedFolderId = folderContainerId('fa1', 'nested-folder');
      expect(page.items.map((c) => c.id)).toEqual([rootFolderId, nestedFolderId]);
      expect(page.items.find((c) => c.id === rootFolderId)?.parentId).toBe(fileAreaContainerId('fa1'));
      expect(page.items.find((c) => c.id === nestedFolderId)?.parentId).toBe(rootFolderId);
    });

    it('still finds folders when the endpoint responds with a bare array instead of { items }', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve(
            mockResponse({ json: () => Promise.resolve([{ data: { folderId: 'root-folder', folderName: 'Root Folder' } }]) }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve([]) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listContainers(ctx, 'proj1', fileAreaContainerId('fa1'));
      expect(page.items.map((c) => c.id)).toEqual([folderContainerId('fa1', 'root-folder')]);
    });

    it('treats blank parentFolderId values as file-area-root folders', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({ items: [{ data: { folderId: 'root-folder', folderName: 'Root Folder', parentFolderId: '' } }] }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve([]) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listContainers(ctx, 'proj1', fileAreaContainerId('fa1'));

      expect(page.items).toEqual([
        {
          id: folderContainerId('fa1', 'root-folder'),
          name: 'Root Folder',
          parentId: fileAreaContainerId('fa1'),
          meta: { kind: 'folder', fileAreaId: 'fa1' },
        },
      ]);
    });

    it('reattaches folders whose parent points at an unseen Dalux root folder', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({
                  items: [
                    { data: { folderId: 'top-folder', folderName: 'Top Folder', parentFolderId: 'hidden-root-folder' } },
                    { data: { folderId: 'child-folder', folderName: 'Child Folder', parentFolderId: 'top-folder' } },
                  ],
                }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve([]) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listContainers(ctx, 'proj1', fileAreaContainerId('fa1'));

      expect(page.items).toEqual([
        {
          id: folderContainerId('fa1', 'top-folder'),
          name: 'Top Folder',
          parentId: fileAreaContainerId('fa1'),
          meta: { kind: 'folder', fileAreaId: 'fa1' },
        },
        {
          id: folderContainerId('fa1', 'child-folder'),
          name: 'Child Folder',
          parentId: folderContainerId('fa1', 'top-folder'),
          meta: { kind: 'folder', fileAreaId: 'fa1' },
        },
      ]);
    });

    it('keeps a folder nested under a parent that only appears on a later Dalux page', async () => {
      // Dalux hands back folders one bookmark page at a time, and a child can
      // land on an earlier page than its parent. Rewriting such a child to the
      // file-area root is permanent: the host appends later pages to the list
      // it already has (`useSourceCatalogSync` merges `[...current.items,
      // ...page.items]`) and never re-asks the provider to re-resolve them.
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/5.1/projects/proj1/file_areas/fa1/folders')) {
          const isSecondPage = url.includes('bookmark=page-2');
          if (!isSecondPage) {
            return Promise.resolve(
              mockResponse({
                json: () =>
                  Promise.resolve({
                    items: [
                      { data: { folderId: 'child-folder', folderName: 'Child Folder', parentFolderId: 'late-parent' } },
                    ],
                    links: [
                      {
                        rel: 'nextPage',
                        href: 'https://node1.field.dalux.com/service/api/5.1/projects/proj1/file_areas/fa1/folders?bookmark=page-2',
                      },
                    ],
                  }),
              }),
            );
          }
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({ items: [{ data: { folderId: 'late-parent', folderName: 'Late Parent' } }] }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve([]) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listContainers(ctx, 'proj1', fileAreaContainerId('fa1'));

      const childId = folderContainerId('fa1', 'child-folder');
      const parentId = folderContainerId('fa1', 'late-parent');
      expect(page.items.map((c) => c.id).sort()).toEqual([childId, parentId].sort());
      expect(page.items.find((c) => c.id === childId)?.parentId).toBe(parentId);
    });
  });

  describe('listFiles', () => {
    it('keeps folder selection scoped but lets a file area surface descendant files', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/6.1/projects/proj1/file_areas/fa1/files')) {
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({
                  items: [
                    { data: { fileId: 'root-file', fileName: 'root.ifc', fileAreaId: 'fa1' } },
                    { data: { fileId: 'in-folder', fileName: 'folder.ifc', fileAreaId: 'fa1', folderId: 'folder-a' } },
                  ],
                }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve([]) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const folderFiles = await provider.listFiles(ctx, 'proj1', folderContainerId('fa1', 'folder-a'));
      expect(folderFiles.items.map((f) => f.id)).toEqual(['in-folder']);

      const areaFiles = await provider.listFiles(ctx, 'proj1', fileAreaContainerId('fa1'));
      expect(areaFiles.items.map((f) => f.id)).toEqual(['root-file', 'in-folder']);
    });

    it('applies namePatterns using the shared glob matcher', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [
                { data: { fileId: 'f1', fileName: 'model.IFC', fileAreaId: 'fa1' } },
                { data: { fileId: 'f2', fileName: 'a.ifc.bak', fileAreaId: 'fa1' } },
                { data: { fileId: 'f3', fileName: 'plan(1).ifc', fileAreaId: 'fa1' } },
                { data: { fileId: 'f4', fileName: 'a+b.ifc', fileAreaId: 'fa1' } },
                { data: { fileId: 'f5', fileName: 'ab.ifc', fileAreaId: 'fa1' } },
              ],
            }),
        }),
      );

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const page = await provider.listFiles(ctx, 'proj1', fileAreaContainerId('fa1'), {
        namePatterns: ['*.ifc'],
      });

      // model.IFC matches case-insensitively; a.ifc.bak does not (the
      // pattern is anchored, so a trailing ".bak" excludes it); the
      // parenthesis/plus in plan(1).ifc and a+b.ifc are just literal
      // characters here, not regex syntax, so both still end in ".ifc" and
      // match the wildcard like any other name would.
      expect(page.items.map((f) => f.id).sort()).toEqual(['f1', 'f3', 'f4', 'f5']);

      // Used as literal patterns (no wildcard), the parenthesis/plus must
      // NOT be interpreted as regex metacharacters: "a+b.ifc" as a raw
      // regex would also match "ab.ifc" (`+` meaning "one or more of the
      // preceding character"), but as a literal it must match only the
      // exact name.
      const literalMatch = await provider.listFiles(ctx, 'proj1', fileAreaContainerId('fa1'), {
        namePatterns: ['plan(1).ifc', 'a+b.ifc'],
      });
      expect(literalMatch.items.map((f) => f.id).sort()).toEqual(['f3', 'f4']);
    });

    it('threads an AbortSignal through to the underlying request', async () => {
      const controller = new AbortController();
      const mockFetch = vi.fn().mockResolvedValue(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.listFiles(ctx, 'proj1', fileAreaContainerId('fa1'), undefined, { signal: controller.signal });

      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
    });
  });

  describe('download', () => {
    it('downloads a specific revision directly when the ref carries a real revisionId', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.download(ctx, {
        projectId: 'proj1',
        containerId: fileAreaContainerId('fa1'),
        fileId: 'f1',
        revisionId: 'rev-9',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://node1.field.dalux.com/service/api/2.0/projects/proj1/file_areas/fa1/files/f1/revisions/rev-9/content',
        expect.any(Object),
      );
    });

    it('falls back to the metadata + downloadLink path when revisionId is omitted', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/5.0/projects/proj1/file_areas/fa1/files/f1')) {
          return Promise.resolve(
            mockResponse({ json: () => Promise.resolve({ data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', deleted: false, downloadLink: 'https://cdn.dalux.com/x' } }) }),
          );
        }
        if (url === 'https://cdn.dalux.com/x') {
          return Promise.resolve(mockResponse({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
        }
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const buf = await provider.download(ctx, { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1' });
      expect(buf.byteLength).toBe(8);
    });

    it('treats the LATEST_REVISION sentinel the same as an omitted revisionId, never hitting /revisions/.../content', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/revisions/')) throw new Error('should never call the revisions endpoint for the sentinel');
        if (url.includes('/5.0/projects/proj1/file_areas/fa1/files/f1')) {
          return Promise.resolve(
            mockResponse({ json: () => Promise.resolve({ data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', deleted: false, downloadLink: 'https://cdn.dalux.com/x' } }) }),
          );
        }
        return Promise.resolve(mockResponse({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }));
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.download(ctx, { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1', revisionId: LATEST_REVISION });
      expect(mockFetch).toHaveBeenCalled();
    });

    it('does NOT reroute a real revision id that happens to be the plain string "latest" (sentinel collision guard)', async () => {
      // The sentinel deliberately isn't the plain string "latest" — a file
      // legitimately versioned with that literal label must still be
      // fetched from /revisions/.../content, not silently redirected to
      // "current bytes" as if no revision id had been given at all.
      const mockFetch = vi.fn().mockResolvedValue(mockResponse({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.download(ctx, {
        projectId: 'proj1',
        containerId: fileAreaContainerId('fa1'),
        fileId: 'f1',
        revisionId: 'latest',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/revisions/latest/content'),
        expect.any(Object),
      );
    });

    it('builds the revision-content URL from the client base URL, not a separate constant', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.download(ctx, {
        projectId: 'proj1',
        containerId: fileAreaContainerId('fa1'),
        fileId: 'f1',
        revisionId: 'rev-9',
      });

      const [calledUrl] = mockFetch.mock.calls[0] as [string];
      expect(calledUrl.startsWith(provider.manifest.permissions.relay!.upstream)).toBe(true);
    });

    it('throws when the file exposes no download link', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({ json: () => Promise.resolve({ data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', deleted: false } }) }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await expect(
        provider.download(ctx, { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1' }),
      ).rejects.toThrow('does not expose a download link');
    });
  });

  describe('watchRevisions', () => {
    it('detects a new revision, grouping refs from the same file area into a single sweep', async () => {
      let filesCalls = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/6.1/projects/proj1/file_areas/fa1/files')) {
          filesCalls += 1;
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({
                  items: [
                    { data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', fileRevisionId: 'rev-2', deleted: false } },
                    { data: { fileId: 'f2', fileName: 'b.ifc', fileAreaId: 'fa1', fileRevisionId: 'rev-1', deleted: false } },
                  ],
                }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa1:f1', 'rev-1');
      await ctx.storage.set('rev:proj1:fa1:f2', 'rev-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1' },
        { projectId: 'proj1', containerId: folderContainerId('fa1', 'folder-a'), fileId: 'f2' },
      ]);

      expect(result.events).toEqual([{ fileId: 'f1', latestRevisionId: 'rev-2', previousRevisionId: 'rev-1' }]);
      expect(filesCalls).toBe(1);
      expect(result.cursor).toBeUndefined();
    });

    it('reports a deleted event when a tracked file no longer appears', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa1:gone', 'rev-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'gone' },
      ]);

      expect(result.events).toEqual([{ fileId: 'gone', latestRevisionId: LATEST_REVISION, deleted: true }]);
    });

    it('watches a contentHash-only file for changes even though it has no fileRevisionId', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [
                { data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', contentHash: 'hash-2', deleted: false } },
              ],
            }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa1:f1', 'hash-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1' },
      ]);

      expect(result.events).toEqual([{ fileId: 'f1', latestRevisionId: 'hash-2', previousRevisionId: 'hash-1' }]);
    });

    it('does not falsely emit an event for a contentHash-only file whose hash has not changed', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [
                { data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', contentHash: 'hash-1', deleted: false } },
              ],
            }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa1:f1', 'hash-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1' },
      ]);

      expect(result.events).toEqual([]);
    });

    it('emits an event on the very first poll when upstream has moved past the ref revision (empty cache)', async () => {
      // Before the first successful poll there is no cache entry for the file.
      // Comparing against "nothing" and then storing the new value would swallow
      // that change permanently: the ref's own revisionId is the baseline the
      // host is currently holding, so it is what upstream must be compared to.
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [
                { data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', fileRevisionId: 'rev-2', deleted: false } },
              ],
            }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      expect(await ctx.storage.get('rev:proj1:fa1:f1')).toBeUndefined();

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1', revisionId: 'rev-1' },
      ]);

      expect(result.events).toEqual([{ fileId: 'f1', latestRevisionId: 'rev-2', previousRevisionId: 'rev-1' }]);
      expect(await ctx.storage.get('rev:proj1:fa1:f1')).toBe('rev-2');
    });

    it('stays silent on the first poll when upstream still matches the ref revision', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [
                { data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', fileRevisionId: 'rev-1', deleted: false } },
              ],
            }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1', revisionId: 'rev-1' },
      ]);

      expect(result.events).toEqual([]);
      expect(await ctx.storage.get('rev:proj1:fa1:f1')).toBe('rev-1');
    });

    it('reports deleted for a definitive 404 on the file-area sweep', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 404, statusText: 'Not Found', text: () => Promise.resolve('file area deleted') }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa-gone:f1', 'rev-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa-gone'), fileId: 'f1' },
      ]);

      expect(result.events).toEqual([{ fileId: 'f1', latestRevisionId: LATEST_REVISION, deleted: true }]);
    });

    it('does NOT report deletion when an area sweep fails transiently (500), leaving the baseline intact', async () => {
      // `deleted: true` is contractually "the file is gone upstream" and the
      // host surfaces it as "N source files are gone upstream". A 500, a
      // timeout or an aborted relay says nothing about the file existing, so
      // the area's refs are skipped for this poll instead.
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 500, statusText: 'Internal Server Error', text: () => Promise.resolve('upstream boom') }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa1:f1', 'rev-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1' },
      ]);

      expect(result.events).toEqual([]);
      expect(ctx.log.warn).toHaveBeenCalled();
      expect(await ctx.storage.get('rev:proj1:fa1:f1')).toBe('rev-1');
    });

    it('does NOT report deletion when the sweep fails for a non-HTTP reason (aborted/network)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa1:f1', 'rev-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1' },
      ]);

      expect(result.events).toEqual([]);
      expect(await ctx.storage.get('rev:proj1:fa1:f1')).toBe('rev-1');
    });

    it('isolates a failed area sweep: other areas still report events instead of the whole call rejecting', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/file_areas/fa-broken/')) {
          return Promise.reject(new Error('Dalux API 404: Not Found — file area deleted'));
        }
        if (url.includes('/file_areas/fa-ok/')) {
          return Promise.resolve(
            mockResponse({
              json: () =>
                Promise.resolve({
                  items: [{ data: { fileId: 'ok-file', fileName: 'ok.ifc', fileAreaId: 'fa-ok', fileRevisionId: 'rev-2', deleted: false } }],
                }),
            }),
          );
        }
        return Promise.resolve(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa-ok:ok-file', 'rev-1');
      await ctx.storage.set('rev:proj1:fa-broken:broken-file', 'rev-1');

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa-ok'), fileId: 'ok-file' },
        { projectId: 'proj1', containerId: fileAreaContainerId('fa-broken'), fileId: 'broken-file' },
      ]);

      // The healthy area's event survives the broken area's failure.
      expect(result.events).toContainEqual({ fileId: 'ok-file', latestRevisionId: 'rev-2', previousRevisionId: 'rev-1' });
      expect(ctx.log.warn).toHaveBeenCalled();

      // The healthy area's cache was advanced...
      expect(await ctx.storage.get('rev:proj1:fa-ok:ok-file')).toBe('rev-2');
      // ...but the broken area's cache is left untouched, so a retry next
      // poll compares against the same baseline instead of silently having
      // already "seen" whatever change caused the failure.
      expect(await ctx.storage.get('rev:proj1:fa-broken:broken-file')).toBe('rev-1');
    });

    it('still advances a healthy area\'s cache even when a later area throws (buffer-then-commit is not all-or-nothing across areas)', async () => {
      // Buffering exists to stop a cache from being advanced past a change
      // whose event then gets lost — not to make one area's failure roll
      // back another, healthy area's already-detected event too. Areas are
      // isolated independently (per-area try/catch), so fa-ok's write must
      // still land even though fa-broken's sweep throws.
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/file_areas/fa-broken/')) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve(
          mockResponse({
            json: () =>
              Promise.resolve({
                items: [{ data: { fileId: 'ok-file', fileName: 'ok.ifc', fileAreaId: 'fa-ok', fileRevisionId: 'rev-2', deleted: false } }],
              }),
          }),
        );
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set('rev:proj1:fa-ok:ok-file', 'rev-1');

      await provider.watchRevisions(ctx, [
        { projectId: 'proj1', containerId: fileAreaContainerId('fa-ok'), fileId: 'ok-file' },
        { projectId: 'proj1', containerId: fileAreaContainerId('fa-broken'), fileId: 'broken-file' },
      ]);

      expect(await ctx.storage.get('rev:proj1:fa-ok:ok-file')).toBe('rev-2');
    });
  });

  describe('testConnection', () => {
    it('returns ok with project count on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          json: () =>
            Promise.resolve({ items: [{ data: { projectId: 'p1', projectName: 'A' } }, { data: { projectId: 'p2', projectName: 'B' } }] }),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const result = await provider.testConnection(ctx);

      expect(result.ok).toBe(true);
      expect(result.projectCount).toBe(2);
      expect(result.message).toContain('2 projects');
    });

    it('returns a helpful message on 403', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 403, statusText: 'Forbidden', text: () => Promise.resolve('Access denied') }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const result = await provider.testConnection(ctx);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('API identity lacks access');
    });

    it('returns a helpful message on 401', async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 401, statusText: 'Unauthorized', text: () => Promise.resolve('') }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const result = await provider.testConnection(ctx);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('API identity lacks access');
    });

    it('does not misclassify a 500 whose body happens to mention "401" as an auth failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: () => Promise.resolve('upstream trace: handler for route /v401/x threw at line 403'),
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const result = await provider.testConnection(ctx);

      expect(result.ok).toBe(false);
      expect(result.message).not.toContain('API identity lacks access');
      expect(result.message).toContain('500');
    });
  });

  // ─── the baseUrl preference actually reaches the wire (#2792) ────────────
  // The node plumbing is well covered on both sides, but the JOIN between them
  // is one line in createClient. Reverting just that line left every other test
  // in this PR green, which is the whole defect family this repo keeps hitting.

  describe('baseUrl preference', () => {
    it('sends the node selector on requests when a non-default base URL is set', async () => {
      const seen: string[] = [];
      const fetchImpl = vi.fn((url: string) => {
        seen.push(String(url));
        return Promise.resolve(mockResponse({ json: () => Promise.resolve({ data: [] }) }));
      }) as unknown as typeof fetch;

      const ctx = createMockCtx(fetchImpl, {
        apiKey: 'test-key-123',
        baseUrl: 'https://node2.field.dalux.com/service/api',
      });
      await provider.listProjects(ctx);

      expect(seen.length, 'no request was made').toBeGreaterThan(0);
      expect(
        seen[0],
        `the baseUrl preference never reached the request: ${seen[0]}`,
      ).toContain('daluxNode=node2');
    });

    it('sends no selector at all when the preference is absent', async () => {
      // The node1 majority must be byte-for-byte unaffected.
      const seen: string[] = [];
      const fetchImpl = vi.fn((url: string) => {
        seen.push(String(url));
        return Promise.resolve(mockResponse({ json: () => Promise.resolve({ data: [] }) }));
      }) as unknown as typeof fetch;

      await provider.listProjects(createMockCtx(fetchImpl, { apiKey: 'test-key-123' }));

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).not.toContain('daluxNode');
    });
  });
});
