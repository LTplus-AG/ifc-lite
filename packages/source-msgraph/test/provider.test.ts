/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KeyValueStore, Logger, PluginContext, SourceAuth } from '@ifc-lite/plugin-api';
import { MsGraphProvider } from '../src/provider.js';
import type { GraphTokenSource } from '../src/graph-client.js';
import { encodeContainerId } from '../src/ids.js';

// ---------------------------------------------------------------------------
// Test doubles. No real MSAL and no real network: `auth.getAccessToken`
// hands back a canned token, and `ctx.fetch`/`ctx.fetchPublic` are plain
// `vi.fn()` mocks the tests script directly. This is deliberate — the
// provider's own contract with the host is that it never touches MSAL or
// the network except through these two seams.
// ---------------------------------------------------------------------------

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

function createFakeAuth(token = 'fake-access-token'): SourceAuth & GraphTokenSource {
  return {
    restore: vi.fn().mockResolvedValue(null),
    signIn: vi.fn().mockResolvedValue({ id: 'user-1', displayName: 'Test User' }),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdentity: vi.fn().mockResolvedValue(null),
    getAccessToken: vi.fn().mockResolvedValue(token),
  };
}

function createMockCtx(
  fetchImpl: typeof fetch,
  fetchPublicImpl: PluginContext['fetchPublic'] = vi.fn(),
  preferences: Record<string, string> = {},
): PluginContext {
  return {
    fetch: fetchImpl,
    fetchPublic: fetchPublicImpl,
    getPreference: vi.fn((name: string) => Promise.resolve(preferences[name])),
    storage: createMockStorage(),
    log: createMockLogger(),
  };
}

function jsonResponse(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    ...overrides,
  };
}

describe('MsGraphProvider', () => {
  let provider: MsGraphProvider;
  let auth: SourceAuth & GraphTokenSource;

  beforeEach(() => {
    auth = createFakeAuth();
    provider = new MsGraphProvider(auth);
  });

  it('declares the ms-graph manifest with the documented capabilities and permissions', () => {
    expect(provider.manifest.name).toBe('ms-graph');
    expect(provider.manifest.auth).toBe('interactive');
    expect(provider.manifest.permissions.network).toEqual(['graph.microsoft.com', 'login.microsoftonline.com']);
    expect(provider.manifest.permissions.publicNetwork).toEqual([
      '*.sharepoint.com',
      '*.1drv.com',
      '*.microsoftpersonalcontent.com',
    ]);
    expect(provider.manifest.capabilities.containerListing).toBe('direct-children');
    expect(provider.manifest.capabilities.listFilesIsRecursive).toBe(false);
    expect(provider.manifest.capabilities.projectsAreDiscoverableOnly).toBe(true);
    const clientId = provider.manifest.preferences.find((p) => p.name === 'clientId');
    expect(clientId?.required).toBe(true);
    const authority = provider.manifest.preferences.find((p) => p.name === 'authority');
    expect(authority?.default).toBe('https://login.microsoftonline.com/common');
  });

  describe('listProjects', () => {
    it('pages /me/followedSites via @odata.nextLink, returning it as the Page cursor, without duplicating "My OneDrive" on later pages', async () => {
      const nextLink = 'https://graph.microsoft.com/v1.0/me/followedSites?$skiptoken=abc';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url === nextLink) {
          return Promise.resolve(jsonResponse({ value: [{ id: 'site-2', displayName: 'Site Two' }] }));
        }
        return Promise.resolve(
          jsonResponse({ value: [{ id: 'site-1', displayName: 'Site One' }], '@odata.nextLink': nextLink }),
        );
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const firstPage = await provider.listProjects(ctx);
      expect(firstPage.items.map((p) => p.name)).toEqual(['My OneDrive', 'Site One']);
      expect(firstPage.cursor).toBe(nextLink);

      const secondPage = await provider.listProjects(ctx, { cursor: firstPage.cursor });
      expect(secondPage.items.map((p) => p.name)).toEqual(['Site Two']);
      expect(secondPage.cursor).toBeUndefined();
    });

    it('pages /sites?search= the same way, threading the cursor across calls', async () => {
      const nextLink = 'https://graph.microsoft.com/v1.0/sites?search=proj&$skiptoken=abc';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url === nextLink) {
          return Promise.resolve(jsonResponse({ value: [{ id: 'site-b', displayName: 'Project B' }] }));
        }
        return Promise.resolve(
          jsonResponse({ value: [{ id: 'site-a', displayName: 'Project A' }], '@odata.nextLink': nextLink }),
        );
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const firstPage = await provider.listProjects(ctx, { query: 'proj' });
      expect(firstPage.items.map((p) => p.name)).toEqual(['Project A']);
      expect(firstPage.cursor).toBe(nextLink);

      const secondPage = await provider.listProjects(ctx, { query: 'proj', cursor: firstPage.cursor });
      expect(secondPage.items.map((p) => p.name)).toEqual(['Project B']);
      expect(secondPage.cursor).toBeUndefined();
    });

    it('surfaces a followedSites failure once mid-pagination instead of silently reporting a truncated listing as complete', async () => {
      const cursor = 'https://graph.microsoft.com/v1.0/me/followedSites?$skiptoken=abc';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
        text: () => Promise.resolve('boom'),
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await expect(provider.listProjects(ctx, { cursor })).rejects.toThrow();
    });
  });

  describe('listContainers', () => {
    it('lists drives at the top level for a site project', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ value: [{ id: 'drive-1', name: 'Documents', driveType: 'documentLibrary' }] }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const page = await provider.listContainers(ctx, 'site:contoso.sharepoint.com,g1,g2');

      expect(page.items).toEqual([
        { id: 'drive-1', name: 'Documents', hasChildren: undefined, meta: { kind: 'drive', driveType: 'documentLibrary' } },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com%2Cg1%2Cg2/drives',
        expect.any(Object),
      );
    });

    it('follows @odata.nextLink for direct-children pagination and maps it to the opaque cursor', async () => {
      const nextLink = 'https://graph.microsoft.com/v1.0/drives/d1/root/children?$skiptoken=abc';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url === nextLink) {
          return Promise.resolve(
            jsonResponse({ value: [{ id: 'f2', name: 'page2.ifc', file: { mimeType: 'application/octet-stream' } }] }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            value: [{ id: 'f1', name: 'page1.ifc', file: { mimeType: 'application/octet-stream' } }],
            '@odata.nextLink': nextLink,
          }),
        );
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const firstPage = await provider.listFiles(ctx, 'onedrive:me', 'd1');
      expect(firstPage.items.map((f) => f.id)).toEqual(['f1']);
      expect(firstPage.cursor).toBe(nextLink);

      const secondPage = await provider.listFiles(ctx, 'onedrive:me', 'd1', undefined, { cursor: firstPage.cursor });
      expect(secondPage.items.map((f) => f.id)).toEqual(['f2']);
      expect(secondPage.cursor).toBeUndefined();
      expect(mockFetch).toHaveBeenLastCalledWith(nextLink, expect.any(Object));
    });

    it('reports only folders (direct children), not files, from a drive/folder container', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          value: [
            { id: 'folder-1', name: 'Drawings', folder: { childCount: 2 } },
            { id: 'file-1', name: 'model.ifc', file: { mimeType: 'application/octet-stream' } },
          ],
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const page = await provider.listContainers(ctx, 'onedrive:me', 'drive-1');
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: 'drive-1::folder-1', name: 'Drawings', parentId: 'drive-1' });
    });

    it("falls back to /me/drive when /me/drives comes back empty (consumer accounts)", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/me/drives')) return Promise.resolve(jsonResponse({ value: [] }));
        if (url.endsWith('/me/drive')) return Promise.resolve(jsonResponse({ id: 'personal-drive', name: 'OneDrive' }));
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const page = await provider.listContainers(ctx, 'onedrive:me');
      expect(page.items).toEqual([
        { id: 'personal-drive', name: 'OneDrive', hasChildren: undefined, meta: { kind: 'drive', driveType: undefined } },
      ]);
    });
  });

  describe('listFiles', () => {
    it('lists direct children only for a drive-root container', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ value: [{ id: 'f1', name: 'model.ifc', file: { mimeType: 'application/octet-stream' } }] }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.listFiles(ctx, 'onedrive:me', 'drive-1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/drives/drive-1/root/children',
        expect.any(Object),
      );
    });

    it('lists direct children for a nested folder container, deriving the drive id from the composite container id', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.listFiles(ctx, 'onedrive:me', encodeContainerId('drive-1', 'folder-9'));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/drives/drive-1/items/folder-9/children',
        expect.any(Object),
      );
    });

    it('excludes folder entries, keeping only items with a file facet', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          value: [
            { id: 'folder-1', name: 'Sub', folder: { childCount: 0 } },
            { id: 'file-1', name: 'model.ifc', file: { mimeType: 'application/octet-stream' } },
          ],
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const page = await provider.listFiles(ctx, 'onedrive:me', 'drive-1');
      expect(page.items.map((f) => f.id)).toEqual(['file-1']);
    });

    it('applies the host-supplied namePatterns filter', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          value: [
            { id: 'f1', name: 'model.ifc', file: { mimeType: 'application/octet-stream' } },
            { id: 'f2', name: 'report.docx', file: { mimeType: 'application/vnd.openxmlformats' } },
          ],
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const page = await provider.listFiles(ctx, 'onedrive:me', 'drive-1', { namePatterns: ['*.ifc'] });
      expect(page.items.map((f) => f.name)).toEqual(['model.ifc']);
    });

    it('attaches the bearer token from auth.getAccessToken to every Graph request', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.listFiles(ctx, 'onedrive:me', 'drive-1');
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer fake-access-token');
      expect(auth.getAccessToken).toHaveBeenCalledWith(ctx);
    });
  });

  describe('searchFiles', () => {
    it('rejects Graph content-match false positives via the name-suffix fallback', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/me/drives')) return Promise.resolve(jsonResponse({ value: [{ id: 'd1' }] }));
        if (url.includes("root/search(q='ifc')")) {
          return Promise.resolve(
            jsonResponse({
              value: [
                // Content match only — "ifc" appears in the STEP text, not the name.
                { id: 'i1', name: 'meeting-notes.docx', file: { mimeType: 'application/msword' } },
                { id: 'i2', name: 'structural.ifc', file: { mimeType: 'application/octet-stream' } },
              ],
            }),
          );
        }
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const page = await provider.searchFiles(ctx, 'onedrive:me', 'ifc');
      expect(page.items.map((f) => f.name)).toEqual(['structural.ifc']);
    });

    it('escapes single quotes in the query before building the OData filter', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/me/drives')) return Promise.resolve(jsonResponse({ value: [{ id: 'd1' }] }));
        return Promise.resolve(jsonResponse({ value: [] }));
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await provider.searchFiles(ctx, 'onedrive:me', "o'brien");
      const searchCall = mockFetch.mock.calls.find(([url]) => (url as string).includes('root/search'));
      expect(searchCall?.[0]).toContain(encodeURIComponent("o''brien"));
    });
  });

  describe('download', () => {
    it('resolves the pre-authenticated downloadUrl then fetches it with fetchPublic and NO Authorization header', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ id: 'item-1', '@microsoft.graph.downloadUrl': 'https://contoso.sharepoint.com/download?tempauth=abc' }),
      );
      const mockFetchPublic = vi.fn().mockResolvedValue(
        jsonResponse(undefined, { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch, mockFetchPublic);

      const bytes = await provider.download(ctx, {
        projectId: 'onedrive:me',
        containerId: 'drive-1',
        fileId: 'item-1',
      });

      expect(bytes.byteLength).toBe(8);
      expect(mockFetchPublic).toHaveBeenCalledTimes(1);
      const [publicUrl, publicInit] = mockFetchPublic.mock.calls[0] as [string, RequestInit | undefined];
      expect(publicUrl).toBe('https://contoso.sharepoint.com/download?tempauth=abc');
      // The whole point of the two-step dance: no Authorization header ever
      // reaches the pre-signed URL, on this or any other request path.
      const publicHeaders = new Headers(publicInit?.headers);
      expect(publicHeaders.has('Authorization')).toBe(false);
      expect(JSON.stringify(publicInit ?? {})).not.toContain('Authorization');

      // The metadata lookup, by contrast, does carry the bearer token.
      const [, metaInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(new Headers(metaInit.headers).get('Authorization')).toBe('Bearer fake-access-token');
    });

    it('treats a revisionId equal to the current cTag as a latest-content download', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'item-1',
          cTag: 'ctag-current',
          '@microsoft.graph.downloadUrl': 'https://contoso.sharepoint.com/download?tempauth=abc',
        }),
      );
      const mockFetchPublic = vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3, 4])),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch, mockFetchPublic);

      const bytes = await provider.download(ctx, {
        projectId: 'onedrive:me',
        containerId: 'drive-1',
        fileId: 'item-1',
        revisionId: 'ctag-current',
      });

      expect(bytes.byteLength).toBe(4);
      expect(mockFetchPublic).toHaveBeenCalledTimes(1);
    });

    it('refuses a historical version rather than issuing a request a browser cannot complete', async () => {
      // `/versions/{id}/content` answers 302, and a browser cannot follow that
      // while sending Authorization (preflight + redirect is prohibited).
      // driveItemVersion carries no downloadUrl to fall back to, so the only
      // honest outcome is a clear refusal.
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'item-1',
          cTag: 'ctag-current',
          '@microsoft.graph.downloadUrl': 'https://contoso.sharepoint.com/download?tempauth=abc',
        }),
      );
      const mockFetchPublic = vi.fn();
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch, mockFetchPublic);

      await expect(
        provider.download(ctx, {
          projectId: 'onedrive:me',
          containerId: 'drive-1',
          fileId: 'item-1',
          revisionId: '1.0',
        }),
      ).rejects.toThrow(/historical versions|Cannot download version/i);

      expect(mockFetchPublic).not.toHaveBeenCalled();
      // Crucially, it must not have attempted the redirecting endpoint either.
      const attempted = mockFetch.mock.calls.map(([url]) => String(url));
      expect(attempted.some((url) => url.includes('/versions/'))).toBe(false);
    });

    it('throws a clear error when the metadata response has no downloadUrl', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'item-1' }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      await expect(
        provider.download(ctx, { projectId: 'onedrive:me', containerId: 'drive-1', fileId: 'item-1' }),
      ).rejects.toThrow(/pre-authenticated download URL/);
    });

    it('propagates an AbortError from fetchPublic instead of swallowing it', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ id: 'item-1', '@microsoft.graph.downloadUrl': 'https://contoso.sharepoint.com/d' }),
      );
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const mockFetchPublic = vi.fn().mockRejectedValue(abortError);
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch, mockFetchPublic);
      const controller = new AbortController();
      controller.abort();

      await expect(
        provider.download(
          ctx,
          { projectId: 'onedrive:me', containerId: 'drive-1', fileId: 'item-1' },
          { signal: controller.signal },
        ),
      ).rejects.toThrow('aborted');
      const [, publicInit] = mockFetchPublic.mock.calls[0] as [string, RequestInit];
      expect(publicInit.signal).toBe(controller.signal);
    });

    it('truncates a long fetchPublic error body in the thrown message, but logs the full body', async () => {
      const longBody = 'x'.repeat(2000);
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ id: 'item-1', '@microsoft.graph.downloadUrl': 'https://contoso.sharepoint.com/d' }),
      );
      const mockFetchPublic = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(longBody),
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch, mockFetchPublic);

      await expect(
        provider.download(ctx, { projectId: 'onedrive:me', containerId: 'drive-1', fileId: 'item-1' }),
      ).rejects.toThrow(/x{200}…/);

      try {
        await provider.download(ctx, { projectId: 'onedrive:me', containerId: 'drive-1', fileId: 'item-1' });
        throw new Error('expected download to reject');
      } catch (err) {
        // The whole raw 2000-char body must not have reached the thrown
        // message — only ~200 chars plus the surrounding explanation.
        expect((err as Error).message.length).toBeLessThan(500);
      }
      expect(ctx.log.error).toHaveBeenCalledWith(expect.any(String), { body: longBody });
    });
  });

  describe('listRevisions', () => {
    it('maps SharePoint version labels ("1.0", "2.0") to opaque string revision ids, newest first as Graph returns them', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          value: [
            { id: '2.0', lastModifiedDateTime: '2026-02-01T00:00:00Z', size: 200 },
            { id: '1.0', lastModifiedDateTime: '2026-01-01T00:00:00Z', size: 100 },
          ],
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const page = await provider.listRevisions(ctx, { projectId: 'onedrive:me', containerId: 'drive-1', fileId: 'item-1' });
      expect(page.items.map((r) => r.id)).toEqual(['2.0', '1.0']);
      expect(page.items[0].label).toContain('2.0');
    });
  });

  describe('watchRevisions', () => {
    it('seeds a deltaLink via token=latest on the first call, without emitting synthetic events', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=xyz' }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(ctx, [
        { projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' },
      ]);

      expect(result.events).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=latest',
        expect.any(Object),
      );
      const state = JSON.parse(result.cursor ?? '{}') as Record<string, string>;
      expect(state.d1).toBe('https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=xyz');
    });

    it('round-trips the cursor across nextLink pages and reports changed tracked files', async () => {
      const seededCursor = JSON.stringify({ d1: 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=seed' });
      const midLink = 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=mid';
      const finalDeltaLink = 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=final';

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('tok=seed')) {
          return Promise.resolve(
            jsonResponse({ value: [{ id: 'f1', cTag: 'ctag-2' }], '@odata.nextLink': midLink }),
          );
        }
        if (url.includes('tok=mid')) {
          return Promise.resolve(
            jsonResponse({ value: [{ id: 'f2', cTag: 'ctag-other' }], '@odata.deltaLink': finalDeltaLink }),
          );
        }
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(
        ctx,
        [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }],
        seededCursor,
      );

      // f2 changed upstream too, but nothing tracked references it — must not appear.
      expect(result.events).toEqual([{ fileId: 'f1', latestRevisionId: 'ctag-2', previousRevisionId: 'ctag-1' }]);
      const state = JSON.parse(result.cursor ?? '{}') as Record<string, string>;
      expect(state.d1).toBe(finalDeltaLink);
    });

    it('resyncs silently on a 410 Gone instead of throwing', async () => {
      const staleCursor = JSON.stringify({ d1: 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=stale' });
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('tok=stale')) {
          return Promise.resolve({
            ok: false,
            status: 410,
            statusText: 'Gone',
            headers: { get: () => null },
            text: () => Promise.resolve('resyncRequired'),
          });
        }
        if (url.includes('token=latest')) {
          return Promise.resolve(
            jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=fresh' }),
          );
        }
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(
        ctx,
        [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }],
        staleCursor,
      );

      expect(result.events).toEqual([]);
      const state = JSON.parse(result.cursor ?? '{}') as Record<string, string>;
      expect(state.d1).toBe('https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=fresh');
      expect(ctx.log.warn).toHaveBeenCalled();
    });

    it('treats a JSON "null" cursor as no baseline rather than crashing on Object.keys(null)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=fresh' }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(
        ctx,
        [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }],
        'null',
      );

      expect(result.events).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=latest',
        expect.any(Object),
      );
    });

    it('treats a JSON array cursor as no baseline rather than crashing', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=fresh' }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(
        ctx,
        [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }],
        '[1,2,3]',
      );

      expect(result.events).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=latest',
        expect.any(Object),
      );
    });

    it('drops a cursor entry whose value is not a string instead of crashing on link.startsWith later', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=fresh' }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      // A corrupted/tampered cursor: `d1`'s value is a number, not a deltaLink string.
      const corruptedCursor = JSON.stringify({ d1: 123 });

      const result = await provider.watchRevisions(
        ctx,
        [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }],
        corruptedCursor,
      );

      expect(result.events).toEqual([]);
      // The bad entry is dropped, so d1 has no baseline and gets reseeded via token=latest.
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=latest',
        expect.any(Object),
      );
    });

    it('drops a 404/403 drive from the cursor and keeps other drives\' events instead of throwing out of the loop', async () => {
      const seededCursor = JSON.stringify({
        d1: 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=healthy',
        d2: 'https://graph.microsoft.com/v1.0/drives/d2/root/delta?tok=dead',
      });
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('tok=healthy')) {
          return Promise.resolve(
            jsonResponse({
              value: [{ id: 'f1', cTag: 'ctag-2' }],
              '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=next',
            }),
          );
        }
        if (url.includes('tok=dead')) {
          return Promise.resolve({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            headers: { get: () => null },
            text: () => Promise.resolve('drive not found'),
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(
        ctx,
        [
          { projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' },
          { projectId: 'onedrive:me', containerId: 'd2', fileId: 'f2', revisionId: 'ctag-x' },
        ],
        seededCursor,
      );

      // d1's event survives even though d2 blew up.
      expect(result.events).toEqual([{ fileId: 'f1', latestRevisionId: 'ctag-2', previousRevisionId: 'ctag-1' }]);
      const state = JSON.parse(result.cursor ?? '{}') as Record<string, string>;
      expect(state.d1).toBe('https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=next');
      // d2 is gone from the cursor, so it won't be re-polled and re-fail forever.
      expect(state.d2).toBeUndefined();
      expect(ctx.log.warn).toHaveBeenCalled();
    });

    it('does not emit an event for a tracked item whose cTag in the delta feed is unchanged (e.g. a rename)', async () => {
      const seededCursor = JSON.stringify({ d1: 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=seed' });
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          // Same cTag the host already has loaded (`revisionId: 'ctag-1'` below) —
          // only the name changed upstream.
          value: [{ id: 'f1', cTag: 'ctag-1', name: 'renamed.ifc' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=after-rename',
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(
        ctx,
        [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }],
        seededCursor,
      );

      expect(result.events).toEqual([]);
    });

    it('does not re-fire on a second metadata-only delta hit even though the ref the host holds never advanced', async () => {
      // Reuses one ctx (and therefore one ctx.storage) across two polls, the
      // way the host actually calls watchRevisions repeatedly.
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('tok=seed')) {
          return Promise.resolve(
            jsonResponse({
              value: [{ id: 'f1', cTag: 'ctag-2' }],
              '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=after-1',
            }),
          );
        }
        if (url.includes('tok=after-1')) {
          // A second, purely cosmetic change (e.g. moved to another folder) —
          // the content, and therefore the cTag, is exactly what it was after
          // the first poll already reported it.
          return Promise.resolve(
            jsonResponse({
              value: [{ id: 'f1', cTag: 'ctag-2' }],
              '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=after-2',
            }),
          );
        }
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      // The host never downloaded the new content, so its own ref is still
      // pinned to the original revision for both polls.
      const refs = [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }];

      const firstResult = await provider.watchRevisions(
        ctx,
        refs,
        JSON.stringify({ d1: 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=seed' }),
      );
      expect(firstResult.events).toEqual([{ fileId: 'f1', latestRevisionId: 'ctag-2', previousRevisionId: 'ctag-1' }]);

      const secondResult = await provider.watchRevisions(ctx, refs, firstResult.cursor);
      // Without the fix this would fire again (item still appears in the
      // delta feed) even though nothing has changed since the first report.
      expect(secondResult.events).toEqual([]);
    });

    it('still emits deleted:true for a tracked item that disappears, and clears its cached cTag', async () => {
      const seededCursor = JSON.stringify({ d1: 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=seed' });
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          value: [{ id: 'f1', deleted: { state: 'deleted' } }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?tok=after-delete',
        }),
      );
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.watchRevisions(
        ctx,
        [{ projectId: 'onedrive:me', containerId: 'd1', fileId: 'f1', revisionId: 'ctag-1' }],
        seededCursor,
      );

      expect(result.events).toEqual([{ fileId: 'f1', latestRevisionId: 'f1', previousRevisionId: 'ctag-1', deleted: true }]);
      expect(ctx.storage.delete).toHaveBeenCalledWith('msgraph:ctag:d1:f1');
    });
  });

  describe('abort handling', () => {
    it('forwards the caller signal to the underlying Graph fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const controller = new AbortController();

      await provider.listFiles(ctx, 'onedrive:me', 'drive-1', undefined, { signal: controller.signal });
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBe(controller.signal);
    });

    it('propagates an AbortError from the Graph fetch rather than swallowing it', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const mockFetch = vi.fn().mockRejectedValue(abortError);
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
      const controller = new AbortController();

      await expect(
        provider.listFiles(ctx, 'onedrive:me', 'drive-1', undefined, { signal: controller.signal }),
      ).rejects.toThrow('aborted');
    });
  });

  describe('testConnection', () => {
    it('reports the signed-in user and location count on success', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/me')) return Promise.resolve(jsonResponse({ id: 'u1', displayName: 'Ada Lovelace' }));
        if (url.includes('followedSites')) return Promise.resolve(jsonResponse({ value: [] }));
        throw new Error(`unexpected url ${url}`);
      });
      const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

      const result = await provider.testConnection(ctx);
      expect(result.ok).toBe(true);
      expect(result.message).toContain('Ada Lovelace');
      expect(result.projectCount).toBe(1); // "My OneDrive" always present
    });

    it('surfaces a GraphAuthExpiredError message instead of a raw MSAL failure', async () => {
      const expiredAuth: SourceAuth & GraphTokenSource = {
        ...createFakeAuth(),
        getAccessToken: vi.fn().mockRejectedValue(new Error('Microsoft sign-in expired. Please sign in again.')),
      };
      const expiredProvider = new MsGraphProvider(expiredAuth);
      const ctx = createMockCtx(vi.fn() as unknown as typeof fetch);

      const result = await expiredProvider.testConnection(ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('sign in again');
    });
  });
});
