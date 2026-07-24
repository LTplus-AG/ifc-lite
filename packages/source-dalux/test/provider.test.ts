/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, KeyValueStore, Logger } from '@ifc-lite/plugin-api';
import { PLUGIN_API_VERSION, satisfiesCaretRange } from '@ifc-lite/plugin-api';
import { DaluxBuildProvider } from '../src/provider.js';
import { fileAreaContainerId, folderContainerId } from '../src/mapping.js';

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
    });
  });

  it('declares only the apiKey preference', () => {
    const prefs = provider.manifest.preferences;
    expect(prefs.find((p) => p.name === 'apiKey')?.required).toBe(true);
    expect(prefs.find((p) => p.name === 'baseUrl')).toBeUndefined();
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
        if (url.includes('/revisions/')) throw new Error('should never call the revisions endpoint for "latest"');
        if (url.includes('/5.0/projects/proj1/file_areas/fa1/files/f1')) {
          return Promise.resolve(
            mockResponse({ json: () => Promise.resolve({ data: { fileId: 'f1', fileName: 'a.ifc', fileAreaId: 'fa1', deleted: false, downloadLink: 'https://cdn.dalux.com/x' } }) }),
          );
        }
        return Promise.resolve(mockResponse({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }));
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.download(ctx, { projectId: 'proj1', containerId: fileAreaContainerId('fa1'), fileId: 'f1', revisionId: 'latest' });
      expect(mockFetch).toHaveBeenCalled();
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

      expect(result.events).toEqual([{ fileId: 'gone', latestRevisionId: 'latest', deleted: true }]);
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
  });
});
