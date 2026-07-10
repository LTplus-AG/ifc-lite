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
    expect(provider.manifest.permissions.network).toContain('field.dalux.com');
  });

  it('declares apiKey and proxyUrl preferences', () => {
    const prefs = provider.manifest.preferences;
    expect(prefs.find((p) => p.name === 'apiKey')?.required).toBe(true);
    expect(prefs.find((p) => p.name === 'proxyUrl')?.required).toBe(false);
  });

  describe('listProjects', () => {
    it('maps Dalux projects to SourceProject[]', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { Id: 'p1', Name: 'Project Alpha', Description: 'Test project' },
            { Id: 'p2', Name: 'Project Beta' },
          ]),
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const projects = await provider.listProjects(ctx);

      expect(projects).toHaveLength(2);
      expect(projects[0]).toEqual({
        id: 'p1',
        name: 'Project Alpha',
        description: 'Test project',
      });
      expect(projects[1]).toEqual({
        id: 'p2',
        name: 'Project Beta',
        description: undefined,
      });
    });

    it('sends X-API-Key header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      await provider.listProjects(ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects'),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-API-Key': 'test-key-123' }),
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

  describe('testConnection', () => {
    it('returns ok with project count on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { Id: 'p1', Name: 'A' },
            { Id: 'p2', Name: 'B' },
          ]),
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
        if (url.includes('/projects') && !url.includes('/file_areas')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ Id: 'proj1', Name: 'P' }]),
          });
        }
        if (url.includes('/file_areas') && !url.includes('/files') && !url.includes('/folders')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ Id: 'fa1', Name: 'Area' }]),
          });
        }
        if (url.includes('/files')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  Id: 'f1',
                  Name: 'model.ifc',
                  FileAreaId: 'fa1',
                  CurrentRevision: { Id: 'rev-2', Version: 2, CreatedAt: '2026-01-02T00:00:00Z' },
                  Revisions: [],
                },
              ]),
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
