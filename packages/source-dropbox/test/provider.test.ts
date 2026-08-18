/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeEach } from 'vitest';
import { PLUGIN_API_VERSION, satisfiesCaretRange } from '@ifc-lite/plugin-api';

import { DropboxProvider } from '../src/provider.js';
import { decodeSearchResult } from '../src/dropbox-types.js';
import { clampPageSize, clampRevisionsPageSize, clampSearchPageSize } from '../src/mapping.js';
import { createDropboxMockContext } from './dropbox-api-mock.js';
import type { DropboxMockWorld } from './dropbox-api-mock.js';

const WORLD: DropboxMockWorld = {
  accountId: 'account-1',
  displayName: 'Mock User',
  email: 'mock@example.com',
  items: [
    { id: 'id:f-alpha', name: 'Alpha', kind: 'folder' },
    { id: 'id:f-beta', name: 'Beta', kind: 'folder' },
    { id: 'id:file-1', name: 'model.ifc', parentId: 'id:f-alpha', kind: 'file', size: 12, rev: 'rev-v2', content: 'MODEL-BYTES-1' },
    { id: 'id:file-2', name: 'readme.txt', parentId: 'id:f-alpha', kind: 'file', size: 3, content: 'TXT' },
  ],
  revisionsByFileId: {
    'id:file-1': [
      { rev: 'rev-v2', size: 12, server_modified: '2026-08-10T00:00:00Z', content: 'MODEL-BYTES-1' },
      { rev: 'rev-v1', size: 8, server_modified: '2026-08-01T00:00:00Z', content: 'MODEL-BYTES-1-OLD' },
    ],
    // Five revisions, newest first, matching real Dropbox's own ordering —
    // exercises `before_rev`/`has_more` cursor-following across more than
    // one page boundary (the reviewer's repro: `limit: 2` over 5 revisions).
    'id:file-many-revs': [
      { rev: 'rev-5', size: 50, server_modified: '2026-08-05T00:00:00Z' },
      { rev: 'rev-4', size: 40, server_modified: '2026-08-04T00:00:00Z' },
      { rev: 'rev-3', size: 30, server_modified: '2026-08-03T00:00:00Z' },
      { rev: 'rev-2', size: 20, server_modified: '2026-08-02T00:00:00Z' },
      { rev: 'rev-1', size: 10, server_modified: '2026-08-01T00:00:00Z' },
    ],
  },
};

describe('DropboxProvider', () => {
  let provider: DropboxProvider;

  beforeEach(() => {
    provider = new DropboxProvider();
  });

  it('exposes a manifest that satisfies the host contract version', () => {
    expect(provider.manifest.name).toBe('dropbox');
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, provider.manifest.api)).toBe(true);
    expect(provider.manifest.auth).toBe('interactive');
    expect(provider.auth).toBeDefined();
    // Exact, not `arrayContaining`: the point of the allowlist is what it
    // leaves out. `www.dropbox.com` serves only the authorization page, which
    // is navigated to in a popup and never fetched, so it must not be here.
    expect(provider.manifest.permissions.network).toEqual([
      'api.dropboxapi.com',
      'content.dropboxapi.com',
    ]);
    expect(provider.manifest.permissions.publicNetwork).toBeUndefined();
  });

  it('declares an honest capabilities block: revisions are both listable and downloadable', () => {
    expect(provider.manifest.capabilities).toEqual({
      containerListing: 'direct-children',
      listFilesIsRecursive: false,
      revisionHistory: true,
      downloadHistoricalRevisions: true,
      changeDetection: true,
      search: true,
    });
  });

  it('declares clientId as a required preference', () => {
    const prefs = provider.manifest.preferences;
    const clientId = prefs.find((p) => p.name === 'clientId');
    expect(clientId?.required).toBe(true);
  });

  describe('listProjects', () => {
    it("returns exactly one project: the signed-in user's own Dropbox", async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.listProjects(ctx);

      expect(page.items).toEqual([{ id: 'me', name: "Mock User's Dropbox", meta: { accountId: 'account-1' } }]);
      expect(page.cursor).toBeUndefined();
    });
  });

  describe('listContainers', () => {
    it('returns the account root\'s folders with no parentId at the top level', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.listContainers(ctx, 'me', undefined);

      expect(page.items.map((c) => c.id).sort()).toEqual(['id:f-alpha', 'id:f-beta']);
      for (const container of page.items) expect(container.parentId).toBeUndefined();
    });

    it("scopes to a folder's own children and never returns files", async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.listContainers(ctx, 'me', 'id:f-alpha');
      expect(page.items).toEqual([]); // f-alpha has only files as children in this world
    });
  });

  describe('listFiles', () => {
    it('lists only file items in the queried folder, never its parent folder itself', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.listFiles(ctx, 'me', 'id:f-alpha');
      expect(page.items.map((f) => f.id).sort()).toEqual(['id:file-1', 'id:file-2']);
      for (const file of page.items) expect(file.containerId).toBe('id:f-alpha');
    });

    it('applies namePatterns using the shared glob matcher', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.listFiles(ctx, 'me', 'id:f-alpha', { namePatterns: ['*.ifc'] });
      expect(page.items.map((f) => f.id)).toEqual(['id:file-1']);
    });

    it('paginates across a real page boundary when limit forces one', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const first = await provider.listFiles(ctx, 'me', 'id:f-alpha', undefined, { limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.cursor).toBeDefined();

      const second = await provider.listFiles(ctx, 'me', 'id:f-alpha', undefined, { limit: 1, cursor: first.cursor });
      expect(second.items).toHaveLength(1);
      expect(second.cursor).toBeUndefined();

      const combined = [...first.items, ...second.items].map((f) => f.id).sort();
      expect(combined).toEqual(['id:file-1', 'id:file-2']);
    });

    it('threads an AbortSignal through to the underlying request', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const controller = new AbortController();
      controller.abort();
      await expect(provider.listFiles(ctx, 'me', 'id:f-alpha', undefined, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });

  describe('searchFiles', () => {
    it("matches file names case-insensitively and reports the file's real parent folder as containerId", async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.searchFiles!(ctx, 'me', 'MODEL');
      expect(page.items.map((f) => f.id)).toEqual(['id:file-1']);
      expect(page.items[0].containerId).toBe('/alpha');
    });

    // `SearchMatchV2.metadata` is the `MetadataV2` union — `{".tag":
    // "metadata", "metadata": {…}}` — so the entry to decode sits one level
    // below `match.metadata`. Decoding the wrapper itself throws on the
    // missing `name`, and `searchFiles` is the one list path that does not
    // run through `convertListLenient`, so nothing catches it: the whole
    // promise rejects on every real search response.
    it('decodes matches through the MetadataV2 union wrapper real search_v2 responses carry', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.searchFiles!(ctx, 'me', 'model');
      expect(page.items.map((f) => f.id)).toEqual(['id:file-1']);
    });

    // The other `MetadataV2` variants must be skipped rather than decoded or
    // thrown on — the union is open, and a `search_v2` response carrying one
    // must not cost the caller every other match in the page.
    it('skips non-"metadata" MetadataV2 variants instead of throwing', () => {
      const result = decodeSearchResult({
        matches: [
          { metadata: { '.tag': 'other' } },
          { metadata: { '.tag': 'metadata', metadata: { '.tag': 'file', id: 'id:ok', name: 'ok.ifc', path_lower: '/alpha/ok.ifc', rev: 'r1' } } },
        ],
        has_more: false,
      });
      expect(result.matches.map((m) => m.metadata.id)).toEqual(['id:ok']);
    });

    // Dropbox declares `SearchOptions.max_results` as
    // `UInt64(min_value=1, max_value=1000)` — a *different*, lower ceiling
    // than `list_folder`'s 2000. The shared conformance suite's bulk pass
    // sends `limit: 10_000`, which `clampPageSize` would forward as 10000
    // and the real API answers 400.
    it('clamps a search limit above Dropbox\'s 1000 max_results ceiling', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.searchFiles!(ctx, 'me', 'model', undefined, { limit: 10_000 });
      expect(page.items.map((f) => f.id)).toEqual(['id:file-1']);
    });
  });

  describe('page-size clamps', () => {
    it('clamps search to 1000 and list_folder to 2000, and defaults each', () => {
      expect(clampSearchPageSize(10_000)).toBe(1000);
      expect(clampSearchPageSize(500)).toBe(500);
      expect(clampSearchPageSize(undefined)).toBe(100);
      // list_folder keeps its own, higher ceiling — the two must not be
      // collapsed onto one constant.
      expect(clampPageSize(10_000)).toBe(2000);
    });

    // `0 < limit < 1` used to floor to `0` via `Math.floor`, which every one
    // of these Dropbox endpoints rejects (`min_value=1`); clamp up to 1
    // rather than sending an out-of-range `limit`/`max_results`.
    it('clamps a sub-1 limit up to 1, not down to 0', () => {
      expect(clampPageSize(0.5)).toBe(1);
      expect(clampSearchPageSize(0.5)).toBe(1);
      expect(clampRevisionsPageSize(0.5)).toBe(1);
    });
  });

  describe('download', () => {
    it('downloads current bytes via files/download when no revisionId is given', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const buf = await provider.download(ctx, { projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-1' });
      expect(new TextDecoder().decode(buf)).toBe('MODEL-BYTES-1');
    });

    it('downloads a specific historical revision via the "rev:<id>" path form', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const buf = await provider.download(ctx, {
        projectId: 'me',
        containerId: 'id:f-alpha',
        fileId: 'id:file-1',
        revisionId: 'rev-v1',
      });
      expect(new TextDecoder().decode(buf)).toBe('MODEL-BYTES-1-OLD');
    });

    it('throws (via DropboxHttpError) for an unknown file', async () => {
      const ctx = createDropboxMockContext(WORLD);
      await expect(
        provider.download(ctx, { projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:does-not-exist' }),
      ).rejects.toMatchObject({ name: 'DropboxHttpError' });
    });
  });

  describe('listRevisions', () => {
    it('maps Dropbox revisions, newest first as Dropbox itself orders them', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const page = await provider.listRevisions!(ctx, { projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-1' });
      expect(page.items.map((r) => r.id)).toEqual(['rev-v2', 'rev-v1']);
      expect(page.items[0].sizeBytes).toBe(12);
      // Only 2 revisions exist and the default page size (10) comfortably
      // covers them, so `has_more` is false and there is no next page.
      expect(page.cursor).toBeUndefined();
    });

    // Regression test for the bug this replaces: `listRevisions()` used to
    // never read `has_more`/send `before_rev`, so a file with more revisions
    // than fit in one page was silently and permanently truncated with no
    // way to reach the rest. `files/list_revisions` *does* paginate — via
    // `before_rev`/`has_more`, not an opaque cursor token, but a real
    // continuation mechanism (Dropbox's `files.stone` API spec).
    it('follows before_rev/has_more to reach revisions past the first page', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const ref = { projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-many-revs' };

      const firstPage = await provider.listRevisions!(ctx, ref, { limit: 2 });
      expect(firstPage.items.map((r) => r.id)).toEqual(['rev-5', 'rev-4']);
      expect(firstPage.cursor).toBe('rev-4');

      const allIds: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await provider.listRevisions!(ctx, ref, { limit: 2, cursor });
        allIds.push(...page.items.map((r) => r.id));
        if (!page.cursor) break;
        cursor = page.cursor;
      }

      expect(allIds).toEqual(['rev-5', 'rev-4', 'rev-3', 'rev-2', 'rev-1']);
    });

    // Regression test: the cursor must follow the *raw* last entry, not the
    // last surviving decoded one. If a malformed row happens to be the last
    // one on a page, deriving `before_rev` from the decoded array would
    // strand the rest of the history (`has_more: true`, but no cursor to
    // continue from) — or, on a page with only some malformed rows, repeat a
    // page. Reproduced here by corrupting the last raw entry's `name` so it
    // fails to decode while `has_more` stays true.
    it('derives the next cursor from the raw last entry even when it fails to decode', async () => {
      const base = createDropboxMockContext(WORLD);
      const ref = { projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-many-revs' };
      const warnings: unknown[] = [];
      const ctx = {
        ...base,
        log: {
          ...base.log,
          warn: (...args: unknown[]) => warnings.push(args),
        },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const href = typeof input === 'string' ? input : input.toString();
          if (!href.includes('/files/list_revisions')) return base.fetch(input, init);

          const response = await base.fetch(input, init);
          const payload = await response.json();
          const entries = payload.entries as Array<Record<string, unknown>>;
          // Corrupt the last (oldest-of-page) raw entry so it fails to decode.
          delete entries[entries.length - 1].name;
          return new Response(JSON.stringify(payload), {
            status: response.status,
            headers: response.headers,
          });
        }) as typeof fetch,
      };

      const page = await provider.listRevisions!(ctx, ref, { limit: 2 });

      // The malformed row was dropped, but the other one on the page decoded fine.
      expect(page.items.map((r) => r.id)).toEqual(['rev-5']);
      expect(warnings.length).toBe(1);
      // The cursor still follows the raw last entry (`rev-4`), not the last
      // *decoded* one (`rev-5`) — otherwise the next page would restart at
      // `rev-5` and repeat it forever.
      expect(page.cursor).toBe('rev-4');
    });

    // Regression test: `decodeFileMetadataStrict` must reject a non-`"file"`
    // discriminator rather than relabeling it. `files/list_revisions` is
    // documented to only ever return `FileMetadata`, but a decoder that
    // trusts that instead of checking `.tag` would silently accept a
    // malformed/future response shape as a file.
    it('drops a revision entry whose ".tag" is not "file" instead of relabeling it', async () => {
      const base = createDropboxMockContext(WORLD);
      const ref = { projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-many-revs' };
      const warnings: unknown[] = [];
      const ctx = {
        ...base,
        log: { ...base.log, warn: (...args: unknown[]) => warnings.push(args) },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const href = typeof input === 'string' ? input : input.toString();
          if (!href.includes('/files/list_revisions')) return base.fetch(input, init);

          const response = await base.fetch(input, init);
          const payload = await response.json();
          const entries = payload.entries as Array<Record<string, unknown>>;
          entries[0]['.tag'] = 'folder';
          return new Response(JSON.stringify(payload), { status: response.status, headers: response.headers });
        }) as typeof fetch,
      };

      const page = await provider.listRevisions!(ctx, ref, { limit: 2 });

      expect(page.items.map((r) => r.id)).toEqual(['rev-4']);
      expect(warnings.length).toBe(1);
    });
  });

  describe('watchRevisions', () => {
    it('reports no events and just a baseline cursor on the first call (no prior cursor)', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const result = await provider.watchRevisions!(ctx, [
        { projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-1', revisionId: 'rev-v2' },
      ]);
      expect(result.events).toEqual([]);
      expect(result.cursor).toBeDefined();
    });

    it("reports an event when a tracked file's revision changed since the baseline cursor", async () => {
      const baselineCtx = createDropboxMockContext(WORLD);
      const baseline = await provider.watchRevisions!(baselineCtx, []);

      const updatedWorld: DropboxMockWorld = {
        ...WORLD,
        items: [...WORLD.items, { id: 'id:file-1', name: 'model.ifc', parentId: 'id:f-alpha', kind: 'file', size: 20, rev: 'rev-v3', content: 'MODEL-BYTES-1-v3' }],
      };
      const continuedCtx = createDropboxMockContext(updatedWorld);
      const result = await provider.watchRevisions!(
        continuedCtx,
        [{ projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-1', revisionId: 'rev-v2' }],
        baseline.cursor,
      );

      expect(result.events).toEqual([{ fileId: 'id:file-1', latestRevisionId: 'rev-v3', previousRevisionId: 'rev-v2' }]);
    });

    it('ignores refs the continued feed does not mention', async () => {
      const baselineCtx = createDropboxMockContext(WORLD);
      const baseline = await provider.watchRevisions!(baselineCtx, []);

      const updatedWorld: DropboxMockWorld = {
        ...WORLD,
        items: [...WORLD.items, { id: 'id:file-1', name: 'model.ifc', parentId: 'id:f-alpha', kind: 'file', size: 20, rev: 'rev-v3', content: 'x' }],
      };
      const continuedCtx = createDropboxMockContext(updatedWorld);
      const result = await provider.watchRevisions!(
        continuedCtx,
        [{ projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-unknown', revisionId: 'x' }],
        baseline.cursor,
      );
      expect(result.events).toEqual([]);
    });

    it('does not attempt to match deletions to a tracked ref (Dropbox deleted entries carry no id)', async () => {
      const baselineCtx = createDropboxMockContext(WORLD);
      const baseline = await provider.watchRevisions!(baselineCtx, []);

      const updatedWorld: DropboxMockWorld = {
        ...WORLD,
        items: [...WORLD.items, { id: 'id:file-2', name: 'readme.txt', parentId: 'id:f-alpha', kind: 'file', deleted: true }],
      };
      const continuedCtx = createDropboxMockContext(updatedWorld);
      const result = await provider.watchRevisions!(
        continuedCtx,
        [{ projectId: 'me', containerId: 'id:f-alpha', fileId: 'id:file-2', revisionId: 'some-rev' }],
        baseline.cursor,
      );
      // The mock renders this as a real `DeletedMetadata` entry (`.tag:
      // "deleted"`, no `id` field) — `provider.ts` skips any non-`"file"`
      // entry when matching against tracked refs, so this never reaches (and
      // could not correctly reach) the id-based match at all. See the doc
      // comment on `watchRevisions()` in `provider.ts`.
      expect(result.events).toEqual([]);
    });
  });

  describe('testConnection', () => {
    it('returns ok on success', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const result = await provider.testConnection!(ctx);
      expect(result.ok).toBe(true);
    });

    it('returns a helpful message when the access token is rejected (401)', async () => {
      const ctx = createDropboxMockContext(WORLD);
      await ctx.storage.set(
        'dropbox:tokens',
        JSON.stringify({ accessToken: 'wrong-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
      );
      const result = await provider.testConnection!(ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Sign-in expired');
    });
  });

  describe('auth-failure handling in ordinary calls', () => {
    it('listProjects surfaces a DropboxHttpError with status 401 rather than a generic failure', async () => {
      const ctx = createDropboxMockContext(WORLD);
      await ctx.storage.set(
        'dropbox:tokens',
        JSON.stringify({ accessToken: 'wrong-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
      );
      await expect(provider.listProjects(ctx)).rejects.toMatchObject({ name: 'DropboxHttpError', status: 401 });
    });

    it('createClient throws a clear error when no clientId preference is configured', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const noClientCtx = { ...ctx, getPreference: () => Promise.resolve(undefined) };
      await expect(provider.listProjects(noClientCtx)).rejects.toThrow('no app key');
    });
  });
});
