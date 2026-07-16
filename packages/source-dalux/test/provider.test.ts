/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext, KeyValueStore, Logger } from '@ifc-lite/plugin-api';
import { DaluxBuildProvider } from '../src/provider.js';

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
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockCtx(
  fetchImpl: typeof fetch,
  preferences: Record<string, string> = { apiKey: 'test-key-123' },
): PluginContext {
  return {
    fetch: fetchImpl,
    getPreference: vi.fn((name: string) =>
      Promise.resolve(preferences[name]),
    ),
    storage: createMockStorage(),
    log: createMockLogger(),
  };
}

describe('DaluxBuildProvider', () => {
  let provider: DaluxBuildProvider;

  beforeEach(() => {
    provider = new DaluxBuildProvider();
  });

  it('exposes the dalux-build manifest', () => {
    expect(provider.manifest.name).toBe('dalux-build');
    expect(provider.manifest.title).toBe('Dalux Box');
    expect(provider.manifest.permissions.network).toContain('*.dalux.com');
  });

  it('declares only the apiKey preference', () => {
    const prefs = provider.manifest.preferences;
    expect(prefs.find((p) => p.name === 'apiKey')?.required).toBe(true);
    expect(prefs.find((p) => p.name === 'baseUrl')).toBeUndefined();
    expect(prefs.find((p) => p.name === 'proxyUrl')).toBeUndefined();
  });

  describe('listProjects', () => {
    it('maps Dalux projects to SourceProject[]', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              { data: { projectId: 'p1', projectName: 'Project Alpha' } },
              { data: { projectId: 'p2', projectName: 'Project Beta' } },
            ],
          }),
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const projects = await provider.listProjects(ctx);

      expect(projects).toHaveLength(2);
      expect(projects[0]).toEqual({ id: 'p1', name: 'Project Alpha' });
      expect(projects[1]).toEqual({ id: 'p2', name: 'Project Beta' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://node1.field.dalux.com/service/api/5.1/projects',
        expect.any(Object),
      );
    });

    it('sends X-API-Key header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await provider.listProjects(ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://node1.field.dalux.com/service/api/5.1/projects',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-API-KEY': 'test-key-123' }),
        }),
      );
    });

    it('throws when API key is not configured', async () => {
      const mockFetch = vi.fn();
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch, {});

      await expect(provider.listProjects(ctx)).rejects.toThrow(
        'Dalux API key not configured',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('listContainers', () => {
    it('returns only file areas at the top level, without walking folders', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [{ data: { fileAreaId: 'fa1', fileAreaName: 'Area', fileAreaType: 'Files' } }],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const containers = await provider.listContainers(ctx, 'proj1');

      expect(containers).toEqual([{ id: 'fa1', name: 'Area', meta: { kind: 'file-area' } }]);
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/folders'),
        expect.any(Object),
      );
    });

    it('rebuilds the folder hierarchy from the custom pager when scoped to a file area', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  { data: { folderId: 'root-folder', folderName: 'Root Folder' } },
                  {
                    data: {
                      folderId: 'nested-folder',
                      folderName: 'Nested Folder',
                      parentFolderId: 'root-folder',
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set(
        'container-loc:fa1',
        JSON.stringify({ projectId: 'proj1', fileAreaId: 'fa1' }),
      );

      const folders = await provider.listContainers(ctx, 'proj1', 'fa1');

      expect(folders.map((f) => f.id)).toEqual(['root-folder', 'nested-folder']);
      expect(folders.find((f) => f.id === 'root-folder')?.parentId).toBe('fa1');
      expect(folders.find((f) => f.id === 'nested-folder')?.parentId).toBe('root-folder');
    });

    it('still finds folders when the endpoint responds with a bare array instead of { items }', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                { data: { folderId: 'root-folder', folderName: 'Root Folder' } },
              ]),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set(
        'container-loc:fa1',
        JSON.stringify({ projectId: 'proj1', fileAreaId: 'fa1' }),
      );

      const folders = await provider.listContainers(ctx, 'proj1', 'fa1');

      expect(folders.map((f) => f.id)).toEqual(['root-folder']);
    });

    it('treats blank parentFolderId values as file-area-root folders', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  {
                    data: {
                      folderId: 'root-folder',
                      folderName: 'Root Folder',
                      parentFolderId: '',
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set(
        'container-loc:fa1',
        JSON.stringify({ projectId: 'proj1', fileAreaId: 'fa1' }),
      );

      const folders = await provider.listContainers(ctx, 'proj1', 'fa1');

      expect(folders).toEqual([
        {
          id: 'root-folder',
          name: 'Root Folder',
          parentId: 'fa1',
          meta: { kind: 'folder', fileAreaId: 'fa1' },
        },
      ]);
    });

    it('reattaches folders whose parent points at an unseen Dalux root folder', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  {
                    data: {
                      folderId: 'top-folder',
                      folderName: 'Top Folder',
                      parentFolderId: 'hidden-root-folder',
                    },
                  },
                  {
                    data: {
                      folderId: 'child-folder',
                      folderName: 'Child Folder',
                      parentFolderId: 'top-folder',
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set(
        'container-loc:fa1',
        JSON.stringify({ projectId: 'proj1', fileAreaId: 'fa1' }),
      );

      const folders = await provider.listContainers(ctx, 'proj1', 'fa1');

      expect(folders).toEqual([
        {
          id: 'top-folder',
          name: 'Top Folder',
          parentId: 'fa1',
          meta: { kind: 'folder', fileAreaId: 'fa1' },
        },
        {
          id: 'child-folder',
          name: 'Child Folder',
          parentId: 'top-folder',
          meta: { kind: 'folder', fileAreaId: 'fa1' },
        },
      ]);
    });
  });

  describe('listFiles', () => {
    it("keeps folder selection scoped but lets a file area surface descendant files", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/6.1/projects/proj1/file_areas/fa1/files')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  { data: { fileId: 'root-file', fileName: 'root.ifc', fileAreaId: 'fa1' } },
                  {
                    data: {
                      fileId: 'in-folder',
                      fileName: 'folder.ifc',
                      fileAreaId: 'fa1',
                      folderId: 'folder-a',
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await ctx.storage.set(
        'container-loc:folder-a',
        JSON.stringify({ projectId: 'proj1', fileAreaId: 'fa1', folderId: 'folder-a' }),
      );
      await ctx.storage.set(
        'container-loc:fa1',
        JSON.stringify({ projectId: 'proj1', fileAreaId: 'fa1' }),
      );

      const folderFiles = await provider.listFiles(ctx, 'folder-a');
      expect(folderFiles.map((f) => f.id)).toEqual(['in-folder']);

      const rootFiles = await provider.listFiles(ctx, 'fa1');
      expect(rootFiles.map((f) => f.id)).toEqual(['root-file', 'in-folder']);
    });
  });

  describe('testConnection', () => {
    it('returns ok with project count on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              { data: { projectId: 'p1', projectName: 'A' } },
              { data: { projectId: 'p2', projectName: 'B' } },
            ],
          }),
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const result = await provider.testConnection(ctx);

      expect(result.ok).toBe(true);
      expect(result.projectCount).toBe(2);
      expect(result.message).toContain('2 projects');
    });

    it('returns a helpful message on 403', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('Access denied'),
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const result = await provider.testConnection(ctx);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('API identity lacks access');
    });
  });

  describe('checkRevisions', () => {
    it('detects a new revision and caches the latest', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/5.1/projects')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [{ data: { projectId: 'proj1', projectName: 'P' } }],
              }),
          });
        }
        if (url.endsWith('/5.1/projects/proj1/file_areas')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [{ data: { fileAreaId: 'fa1', fileAreaName: 'Area', fileAreaType: 'Files' } }],
              }),
          });
        }
        if (url.endsWith('/5.1/projects/proj1/file_areas/fa1/folders')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [] }),
          });
        }
        if (url.includes('/6.1/projects/proj1/file_areas/fa1/files')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                items: [
                  {
                    data: {
                      fileId: 'f1',
                      fileName: 'model.ifc',
                      fileAreaId: 'fa1',
                      fileRevisionId: 'rev-2',
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      // Seed the storage with an older revision
      await ctx.storage.set('rev:f1', 'rev-1');
      // Seed the file location cache
      await ctx.storage.set('file-loc:f1', JSON.stringify({ projectId: 'proj1', fileAreaId: 'fa1' }));

      const events = await provider.checkRevisions(ctx, ['f1']);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        fileId: 'f1',
        latestRevisionId: 'rev-2',
        previousRevisionId: 'rev-1',
      });
    });
  });
});
