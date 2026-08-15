/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeEach } from 'vitest';
import { PLUGIN_API_VERSION, satisfiesCaretRange } from '@ifc-lite/plugin-api';

import { MsGraphProvider } from '../src/provider.js';
import { downloadUrlFor, createGraphMockContext } from './msgraph-api-mock.js';
import type { GraphMockWorld } from './msgraph-api-mock.js';

const WORLD: GraphMockWorld = {
  driveId: 'drive-1',
  driveName: 'Contoso Drive',
  items: [
    { id: 'f-alpha', name: 'Alpha', kind: 'folder', childCount: 1 },
    { id: 'f-beta', name: 'Beta', kind: 'folder', childCount: 0 },
    { id: 'file-1', name: 'model.ifc', parentId: 'f-alpha', kind: 'file', size: 12, cTag: 'ctag-v1', content: 'MODEL-BYTES-1' },
    { id: 'file-2', name: 'readme.txt', parentId: 'f-alpha', kind: 'file', size: 3, content: 'TXT' },
  ],
  versionsByFileId: {
    'file-1': [
      { id: '2.0', size: 12, lastModifiedDateTime: '2026-08-10T00:00:00Z' },
      { id: '1.0', size: 8, lastModifiedDateTime: '2026-08-01T00:00:00Z' },
    ],
  },
};

describe('MsGraphProvider', () => {
  let provider: MsGraphProvider;

  beforeEach(() => {
    provider = new MsGraphProvider();
  });

  it('exposes a manifest that satisfies the host contract version', () => {
    expect(provider.manifest.name).toBe('msgraph-onedrive');
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, provider.manifest.api)).toBe(true);
    expect(provider.manifest.auth).toBe('interactive');
    expect(provider.auth).toBeDefined();
    expect(provider.manifest.permissions.network).toEqual(
      expect.arrayContaining(['graph.microsoft.com', 'login.microsoftonline.com']),
    );
    expect(provider.manifest.permissions.publicNetwork).toEqual(
      expect.arrayContaining(['*.sharepoint.com', '*.files.1drv.com']),
    );
  });

  it('declares an honest capabilities block: history is listable but not downloadable', () => {
    expect(provider.manifest.capabilities).toEqual({
      containerListing: 'direct-children',
      listFilesIsRecursive: false,
      revisionHistory: true,
      downloadHistoricalRevisions: false,
      changeDetection: true,
      search: true,
    });
  });

  it('declares clientId as required and tenant as optional with a "common" default', () => {
    const prefs = provider.manifest.preferences;
    const clientId = prefs.find((p) => p.name === 'clientId');
    const tenant = prefs.find((p) => p.name === 'tenant');
    expect(clientId?.required).toBe(true);
    expect(tenant?.required).toBe(false);
    expect(tenant?.default).toBe('common');
  });

  describe('listProjects', () => {
    it('returns exactly one project: the signed-in user\'s own drive', async () => {
      const ctx = createGraphMockContext(WORLD);
      const page = await provider.listProjects(ctx);

      expect(page.items).toEqual([
        { id: 'me', name: 'Contoso Drive', meta: { driveId: 'drive-1', driveType: 'business', owner: 'Mock Owner' } },
      ]);
      expect(page.cursor).toBeUndefined();
    });
  });

  describe('listContainers', () => {
    it('returns the drive root\'s folders with no parentId at the top level', async () => {
      const ctx = createGraphMockContext(WORLD);
      const page = await provider.listContainers(ctx, 'me', undefined);

      expect(page.items.map((c) => c.id).sort()).toEqual(['f-alpha', 'f-beta']);
      for (const container of page.items) expect(container.parentId).toBeUndefined();
    });

    it('scopes to a folder\'s own children and never returns files', async () => {
      const ctx = createGraphMockContext(WORLD);
      const page = await provider.listContainers(ctx, 'me', 'f-alpha');
      expect(page.items).toEqual([]); // f-alpha has only files as children in this world
    });
  });

  describe('listFiles', () => {
    it('lists only file items in the queried folder, never its parent folder itself', async () => {
      const ctx = createGraphMockContext(WORLD);
      const page = await provider.listFiles(ctx, 'me', 'f-alpha');
      expect(page.items.map((f) => f.id).sort()).toEqual(['file-1', 'file-2']);
      for (const file of page.items) expect(file.containerId).toBe('f-alpha');
    });

    it('applies namePatterns using the shared glob matcher', async () => {
      const ctx = createGraphMockContext(WORLD);
      const page = await provider.listFiles(ctx, 'me', 'f-alpha', { namePatterns: ['*.ifc'] });
      expect(page.items.map((f) => f.id)).toEqual(['file-1']);
    });

    it('threads an AbortSignal through to the underlying request', async () => {
      const ctx = createGraphMockContext(WORLD);
      const controller = new AbortController();
      controller.abort();
      await expect(provider.listFiles(ctx, 'me', 'f-alpha', undefined, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });

  describe('searchFiles', () => {
    it('matches file names case-insensitively and reports the item\'s real parent as containerId', async () => {
      const ctx = createGraphMockContext(WORLD);
      const page = await provider.searchFiles!(ctx, 'me', 'MODEL');
      expect(page.items.map((f) => f.id)).toEqual(['file-1']);
      expect(page.items[0].containerId).toBe('f-alpha');
    });
  });

  describe('download', () => {
    it('fetches the pre-signed downloadUrl via fetchPublic, not the authenticated client', async () => {
      const ctx = createGraphMockContext(WORLD);
      const buf = await provider.download(ctx, { projectId: 'me', containerId: 'f-alpha', fileId: 'file-1' });
      expect(new TextDecoder().decode(buf)).toBe('MODEL-BYTES-1');
    });

    it('rejects a historical revisionId instead of silently serving current bytes', async () => {
      const ctx = createGraphMockContext(WORLD);
      await expect(
        provider.download(ctx, { projectId: 'me', containerId: 'f-alpha', fileId: 'file-1', revisionId: '1.0' }),
      ).rejects.toThrow('cannot download historical revision');
    });

    it('accepts a revisionId that matches the current revision', async () => {
      const ctx = createGraphMockContext(WORLD);
      const buf = await provider.download(ctx, {
        projectId: 'me',
        containerId: 'f-alpha',
        fileId: 'file-1',
        revisionId: 'ctag-v1',
      });
      expect(new TextDecoder().decode(buf)).toBe('MODEL-BYTES-1');
    });

    it('throws when the item exposes no download URL', async () => {
      const noUrlWorld: GraphMockWorld = {
        ...WORLD,
        items: [...WORLD.items, { id: 'file-nourl', name: 'x.ifc', parentId: 'f-alpha', kind: 'file' }],
      };
      const ctx = createGraphMockContext(noUrlWorld);
      await expect(
        provider.download(ctx, { projectId: 'me', containerId: 'f-alpha', fileId: 'file-nourl' }),
      ).rejects.toThrow('does not expose a download URL');
    });

    it('never sends an Authorization header to the download URL host', async () => {
      const ctx = createGraphMockContext(WORLD);
      let sawAuthHeader = false;
      const originalFetchPublic = ctx.fetchPublic;
      const wrappedCtx = {
        ...ctx,
        fetchPublic: (url: string, init?: Parameters<typeof originalFetchPublic>[1]) => {
          // `PublicFetchInit` only carries `signal`/`range` — there is no
          // header field to smuggle an Authorization value through even if
          // this test tried to. Confirms the shape rather than a live check.
          if (init && 'headers' in (init as Record<string, unknown>)) sawAuthHeader = true;
          return originalFetchPublic(url, init);
        },
      };
      await provider.download(wrappedCtx, { projectId: 'me', containerId: 'f-alpha', fileId: 'file-1' });
      expect(sawAuthHeader).toBe(false);
      expect(downloadUrlFor('file-1')).toContain('file-1');
    });
  });

  describe('listRevisions', () => {
    it('maps Graph driveItemVersions, newest first as Graph itself orders them', async () => {
      const ctx = createGraphMockContext(WORLD);
      const page = await provider.listRevisions!(ctx, { projectId: 'me', containerId: 'f-alpha', fileId: 'file-1' });
      expect(page.items.map((r) => r.id)).toEqual(['2.0', '1.0']);
      expect(page.items[0].sizeBytes).toBe(12);
    });
  });

  describe('watchRevisions', () => {
    it('reports no event for a file whose cTag has not changed', async () => {
      const ctx = createGraphMockContext(WORLD);
      const result = await provider.watchRevisions!(ctx, [
        { projectId: 'me', containerId: 'f-alpha', fileId: 'file-1', revisionId: 'ctag-v1' },
      ]);
      expect(result.events).toEqual([]);
      expect(result.cursor).toBeDefined();
    });

    it('reports an event when the tracked revisionId differs from the delta feed\'s current one', async () => {
      const ctx = createGraphMockContext(WORLD);
      const result = await provider.watchRevisions!(ctx, [
        { projectId: 'me', containerId: 'f-alpha', fileId: 'file-1', revisionId: 'stale-tag' },
      ]);
      expect(result.events).toEqual([{ fileId: 'file-1', latestRevisionId: 'ctag-v1', previousRevisionId: 'stale-tag' }]);
    });

    it('reports a deleted event for a tracked file the feed marks deleted', async () => {
      const deletedWorld: GraphMockWorld = {
        ...WORLD,
        items: WORLD.items.map((i) => (i.id === 'file-2' ? { ...i, deleted: true } : i)),
      };
      const ctx = createGraphMockContext(deletedWorld);
      const result = await provider.watchRevisions!(ctx, [
        { projectId: 'me', containerId: 'f-alpha', fileId: 'file-2', revisionId: 'some-tag' },
      ]);
      expect(result.events).toEqual([{ fileId: 'file-2', latestRevisionId: expect.any(String), deleted: true }]);
    });

    it('ignores refs the delta feed does not mention', async () => {
      const ctx = createGraphMockContext(WORLD);
      const result = await provider.watchRevisions!(ctx, [
        { projectId: 'me', containerId: 'f-alpha', fileId: 'file-unknown', revisionId: 'x' },
      ]);
      expect(result.events).toEqual([]);
    });
  });

  describe('testConnection', () => {
    it('returns ok on success', async () => {
      const ctx = createGraphMockContext(WORLD);
      const result = await provider.testConnection!(ctx);
      expect(result.ok).toBe(true);
    });

    it('returns a helpful message when the access token is rejected (401)', async () => {
      const ctx = createGraphMockContext(WORLD);
      // Corrupt the stored token so the mock's Authorization check fails —
      // exercises the auth-failure branch of testConnection without needing
      // a real expired/invalid Microsoft Graph token.
      await ctx.storage.set(
        'msgraph:tokens',
        JSON.stringify({ accessToken: 'wrong-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
      );
      const result = await provider.testConnection!(ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Sign-in expired');
    });
  });

  describe('auth-failure handling in ordinary calls', () => {
    it('listProjects surfaces a GraphHttpError with status 401 rather than a generic failure', async () => {
      const ctx = createGraphMockContext(WORLD);
      await ctx.storage.set(
        'msgraph:tokens',
        JSON.stringify({ accessToken: 'wrong-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
      );
      await expect(provider.listProjects(ctx)).rejects.toMatchObject({ name: 'GraphHttpError', status: 401 });
    });

    it('createClient throws a clear error when no clientId preference is configured', async () => {
      const ctx = createGraphMockContext(WORLD);
      const noClientCtx = { ...ctx, getPreference: () => Promise.resolve(undefined) };
      await expect(provider.listProjects(noClientCtx)).rejects.toThrow('no Azure AD application (client) ID');
    });
  });
});
