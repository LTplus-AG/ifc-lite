/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the cached-catalog / abort-controller interaction
 * (PR #1976 review thread on `useSourceCatalogSync.ts:256`).
 *
 * `openFileArea` aborts the in-flight controller and (correctly) nulls the
 * ref immediately after, specifically because `applyCachedCatalog` can
 * return early WITHOUT `beginGeneration()` ever replacing it -- leaving a
 * stale, already-aborted controller behind would otherwise hand every later
 * `abortRef.current?.signal` read a pre-aborted signal. `resetCatalog` had
 * the same shape of gap and is fixed the same way here.
 *
 * Note on what this test can and cannot isolate: `applyCachedCatalog` only
 * ever returns `true` for a provider whose capabilities are BOTH
 * `containerListing: 'flat-subtree'` AND `listFilesIsRecursive: true` -- and
 * for exactly that capability pair, `openContainer`'s own `needChildren` /
 * `needFiles` checks are unconditionally `false` (a flat-subtree recursive
 * catalog never needs a per-container fetch). So the stale-signal defect
 * can't be isolated through `openContainer`/`loadMore*` for a cache-eligible
 * provider -- every entry point that sets `areaRef.current` (`openFileArea`,
 * `syncFileArea`) also freshly manages `abortRef.current` on its own before
 * any consumer can observe it. What IS directly observable, and is what
 * these tests assert, is the user-visible contract: a cache hit renders
 * immediately, and a manual sync afterward performs a real fetch and
 * updates the catalog -- never a silent no-op.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  FileSourceProvider,
  ListOptions,
  ListProjectsOptions,
  Page,
  PluginContext,
  PluginManifest,
  SourceContainer,
  SourceFile,
  SourceProject,
} from '@ifc-lite/plugin-api';
import { saveSourceCatalogCache } from '@/lib/sources/persistence';
import { useSourceCatalogSync } from './useSourceCatalogSync.js';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

const localStorageMock = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageMock });

const ctx: PluginContext = {
  fetch: (() => Promise.reject(new Error('not exercised'))) as typeof fetch,
  fetchPublic: () => Promise.reject(new Error('not exercised')),
  getPreference: () => Promise.resolve(undefined),
  storage: {
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

function manifest(overrides: Partial<PluginManifest['capabilities']> = {}): PluginManifest {
  return {
    name: 'fixture-provider',
    title: 'Fixture Provider',
    api: '^2.0.0',
    permissions: { network: ['fixture.example.com'] },
    auth: 'preferences',
    preferences: [],
    capabilities: {
      containerListing: 'flat-subtree',
      listFilesIsRecursive: true,
      revisionHistory: false,
      downloadHistoricalRevisions: false,
      changeDetection: false,
      search: false,
      ...overrides,
    },
    contributes: { fileSources: [] },
  };
}

/** A provider whose `listContainers`/`listFiles` are swappable per test so a
 *  "fresh sync after a cache hit" call can be told apart from the cached
 *  data it's overwriting. */
class FakeProvider implements FileSourceProvider {
  readonly manifest: PluginManifest;
  listContainersCalls = 0;
  listFilesCalls = 0;
  containers: readonly SourceContainer[];
  files: readonly SourceFile[];

  constructor(caps?: Partial<PluginManifest['capabilities']>) {
    this.manifest = manifest(caps);
    this.containers = [{ id: 'folder-1', name: 'Folder 1', parentId: 'area-1' }];
    this.files = [
      { id: 'file-1', name: 'Model.ifc', containerId: 'area-1', currentRevisionId: 'rev-1', sizeBytes: 10 },
    ];
  }

  async listProjects(
    _ctx: PluginContext,
    _options?: ListProjectsOptions,
  ): Promise<Page<SourceProject>> {
    return { items: [] };
  }

  async listContainers(
    _ctx: PluginContext,
    _projectId: string,
    _parentId: string,
    _options?: ListOptions,
  ): Promise<Page<SourceContainer>> {
    this.listContainersCalls += 1;
    return { items: this.containers };
  }

  async listFiles(
    _ctx: PluginContext,
    _projectId: string,
    _containerId: string,
    _filter: unknown,
    _options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    this.listFilesCalls += 1;
    return { items: this.files };
  }

  download(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('not exercised'));
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

interface Harness {
  readonly hook: ReturnType<typeof useSourceCatalogSync>;
}

function renderCatalogSync(provider: FileSourceProvider): { get: () => Harness['hook'] } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: Harness['hook'] | null = null;

  function Probe() {
    latest = useSourceCatalogSync({ provider, ctx, setError: () => {} });
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });
  mounted.push({ root, container });

  return {
    get: () => {
      if (!latest) throw new Error('hook has not rendered yet');
      return latest;
    },
  };
}

describe('useSourceCatalogSync -- cached-catalog path (#1976)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount(); });
      container.remove();
    }
    localStorageMock.clear();
  });

  it('a cache hit renders the cached catalog without calling the provider', async () => {
    const provider = new FakeProvider();
    saveSourceCatalogCache(
      provider.manifest.name,
      'project-1',
      'area-1',
      [{ id: 'folder-cached', name: 'Cached Folder', parentId: 'area-1' }],
      [{ id: 'file-cached', name: 'Cached.ifc', containerId: 'area-1', currentRevisionId: 'rev-0', sizeBytes: 1 }],
    );

    const harness = renderCatalogSync(provider);
    await act(async () => {
      harness.get().openFileArea('project-1', 'area-1');
    });

    assert.equal(provider.listContainersCalls, 0, 'cache hit must not fetch containers');
    assert.equal(provider.listFilesCalls, 0, 'cache hit must not fetch files');
    assert.deepEqual(harness.get().folders.map((f) => f.id), ['folder-cached']);
    assert.deepEqual(harness.get().allFiles.map((f) => f.id), ['file-cached']);
    assert.ok(harness.get().catalogUpdatedAt !== null);
  });

  it('a manual sync after a cache hit actually runs and replaces the cached data', async () => {
    const provider = new FakeProvider();
    saveSourceCatalogCache(
      provider.manifest.name,
      'project-1',
      'area-1',
      [{ id: 'folder-cached', name: 'Cached Folder', parentId: 'area-1' }],
      [{ id: 'file-cached', name: 'Cached.ifc', containerId: 'area-1', currentRevisionId: 'rev-0', sizeBytes: 1 }],
    );

    const harness = renderCatalogSync(provider);
    await act(async () => {
      harness.get().openFileArea('project-1', 'area-1');
    });
    assert.equal(provider.listContainersCalls, 0);

    // The equivalent of the user clicking "Sync now" right after a
    // cache-restored file area -- this must hit the network for real, not
    // silently resolve against a pre-aborted signal.
    await act(async () => {
      await harness.get().syncFileArea('project-1', 'area-1');
    });

    assert.equal(provider.listContainersCalls, 1, 'manual sync after a cache hit must call the provider');
    assert.equal(provider.listFilesCalls, 1, 'manual sync after a cache hit must call the provider');
    assert.deepEqual(harness.get().folders.map((f) => f.id), ['folder-1']);
    assert.deepEqual(harness.get().allFiles.map((f) => f.id), ['file-1']);
    assert.equal(harness.get().loadingFolders, false);
    assert.equal(harness.get().loadingFiles, false);
    assert.equal(harness.get().syncing, false);
  });

  it('resetCatalog followed by reopening the same cached area still renders and can still sync', async () => {
    const provider = new FakeProvider();
    saveSourceCatalogCache(
      provider.manifest.name,
      'project-1',
      'area-1',
      [{ id: 'folder-cached', name: 'Cached Folder', parentId: 'area-1' }],
      [{ id: 'file-cached', name: 'Cached.ifc', containerId: 'area-1', currentRevisionId: 'rev-0', sizeBytes: 1 }],
    );

    const harness = renderCatalogSync(provider);
    await act(async () => {
      harness.get().openFileArea('project-1', 'area-1');
    });

    act(() => {
      harness.get().resetCatalog();
    });
    assert.deepEqual(harness.get().folders, []);
    assert.deepEqual(harness.get().allFiles, []);

    // Re-entering the same file area must hit the cache again, then a
    // manual sync must still perform a real, non-aborted fetch.
    await act(async () => {
      harness.get().openFileArea('project-1', 'area-1');
    });
    assert.deepEqual(harness.get().folders.map((f) => f.id), ['folder-cached']);

    await act(async () => {
      await harness.get().syncFileArea('project-1', 'area-1');
    });
    assert.equal(provider.listContainersCalls, 1, 'sync after reset + reopen must reach the provider');
    assert.deepEqual(harness.get().folders.map((f) => f.id), ['folder-1']);
  });
});

/**
 * Coverage for #2613: gating the eager file sweep on `capabilities.eagerFileSweep`.
 *
 * `eagerFileSweep` defaults to off, so a provider that doesn't set it gets
 * ordinary incremental file paging (one page eagerly, `loadMoreFiles` for the
 * rest) -- the same shape folders already have via `loadMoreFolders`. Only a
 * provider that opts in (Dalux, in production) keeps the full up-front drain.
 *
 * `PagedFileProvider` serves `pages` of files in order, one page per call,
 * threading the cursor exactly like `sourceCatalogPaging.test.ts`'s
 * `providerOf` helper -- so a bug that stops paginating after the first call
 * (undetected by a single-page fixture) or that fetches every page
 * regardless of the capability (undetected by a fixture with only one page)
 * would both be caught.
 */
function pagedManifest(eagerFileSweep: boolean | undefined): PluginManifest {
  return manifest({
    containerListing: 'direct-children',
    listFilesIsRecursive: false,
    ...(eagerFileSweep !== undefined ? { eagerFileSweep } : {}),
  });
}

class PagedFileProvider implements FileSourceProvider {
  readonly manifest: PluginManifest;
  listFilesCalls: Array<string | undefined> = [];
  readonly containers: readonly SourceContainer[] = [];

  constructor(
    private readonly pages: readonly SourceFile[][],
    eagerFileSweep: boolean | undefined,
  ) {
    this.manifest = pagedManifest(eagerFileSweep);
  }

  async listProjects(): Promise<Page<SourceProject>> {
    return { items: [] };
  }

  async listContainers(): Promise<Page<SourceContainer>> {
    return { items: this.containers };
  }

  async listFiles(
    _ctx: PluginContext,
    _projectId: string,
    _containerId: string,
    _filter: unknown,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const cursor = options?.cursor;
    this.listFilesCalls.push(cursor);
    const idx = cursor === undefined ? 0 : Number(cursor);
    const isLast = idx >= this.pages.length - 1;
    return { items: this.pages[idx] ?? [], cursor: isLast ? undefined : String(idx + 1) };
  }

  download(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('not exercised'));
  }
}

function fileOf(id: string): SourceFile {
  return { id, name: `${id}.ifc`, containerId: 'area-1', currentRevisionId: `${id}-rev`, sizeBytes: 1 };
}

describe('useSourceCatalogSync -- eagerFileSweep gate (#2613)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount(); });
      container.remove();
    }
    localStorageMock.clear();
  });

  it('Dalux-shaped provider (eagerFileSweep: true) still drains every page up front, unchanged', async () => {
    const pages = [[fileOf('a')], [fileOf('b')], [fileOf('c')]];
    const provider = new PagedFileProvider(pages, true);
    const harness = renderCatalogSync(provider);

    await act(async () => {
      harness.get().openFileArea('project-1', 'area-1');
    });

    // The sweep must have followed every cursor in one go, with nothing left
    // to page manually -- this is the "must not change at all" contract.
    assert.deepEqual(provider.listFilesCalls, [undefined, '1', '2'], 'every page must be fetched eagerly');
    assert.deepEqual(harness.get().allFiles.map((f) => f.id), ['a', 'b', 'c']);
    assert.equal(harness.get().hasMoreFiles(null), false, 'a fully-swept catalog has nothing left to load more of');
  });

  it('a provider without eagerFileSweep gets only the first page, and loadMoreFiles fetches the next', async () => {
    const pages = [[fileOf('a')], [fileOf('b')], [fileOf('c')]];
    const provider = new PagedFileProvider(pages, undefined);
    const harness = renderCatalogSync(provider);

    await act(async () => {
      harness.get().openFileArea('project-1', 'area-1');
    });

    assert.deepEqual(provider.listFilesCalls, [undefined], 'only the first page should be fetched up front');
    assert.deepEqual(harness.get().allFiles.map((f) => f.id), ['a']);
    assert.equal(harness.get().hasMoreFiles(null), true, 'a cursor is outstanding after the first page');

    await act(async () => {
      harness.get().loadMoreFiles(null);
    });
    await act(async () => {}); // flush the async loadMoreFiles body

    assert.deepEqual(provider.listFilesCalls, [undefined, '1'], 'loadMoreFiles must thread the prior cursor');
    assert.deepEqual(harness.get().allFiles.map((f) => f.id), ['a', 'b']);
    assert.equal(harness.get().hasMoreFiles(null), true, 'one more page remains');

    await act(async () => {
      harness.get().loadMoreFiles(null);
    });
    await act(async () => {});

    assert.deepEqual(provider.listFilesCalls, [undefined, '1', '2']);
    assert.deepEqual(harness.get().allFiles.map((f) => f.id), ['a', 'b', 'c']);
    assert.equal(harness.get().hasMoreFiles(null), false, 'the last page has no cursor');
  });

  it('explicitly setting eagerFileSweep: false behaves the same as omitting it', async () => {
    const pages = [[fileOf('a')], [fileOf('b')]];
    const provider = new PagedFileProvider(pages, false);
    const harness = renderCatalogSync(provider);

    await act(async () => {
      harness.get().openFileArea('project-1', 'area-1');
    });

    assert.deepEqual(provider.listFilesCalls, [undefined]);
    assert.equal(harness.get().hasMoreFiles(null), true);
  });
});
