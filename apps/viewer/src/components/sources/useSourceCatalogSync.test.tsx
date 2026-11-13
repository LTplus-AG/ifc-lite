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
import { afterEach, beforeEach, describe, it } from 'node:test';
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
import { loadSourceCatalogCache, saveSourceCatalogCache } from '@/lib/sources/persistence';
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

beforeEach(() => localStorageMock.clear());
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

interface Harness {
  readonly hook: ReturnType<typeof useSourceCatalogSync>;
}

function renderCatalogSync(provider: FileSourceProvider): { get: () => Harness['hook']; rerender: (next: FileSourceProvider) => void } {
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
    rerender: next => { provider = next; act(() => root.render(<Probe />)); },
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

// C-5: paging X must merge into the live catalog after Y has opened.
for (const kind of ['folders', 'files'] as const) {
  it(`C-5 load more ${kind} preserves a folder opened while the page was pending`, async () => {
    const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: false });
    let finish!: () => void;
    provider.listContainers = async (_ctx, _project, parent, options) => {
      if (options?.cursor) await new Promise<void>(resolve => { finish = resolve; });
      return { items: [{ id: `${parent}-child${options?.cursor ? '-2' : ''}`, name: 'child', parentId: parent }],
        cursor: parent === 'area-1' && !options?.cursor ? 'next' : undefined };
    };
    provider.listFiles = async (_ctx, _project, parent, _filter, options) => {
      if (options?.cursor) await new Promise<void>(resolve => { finish = resolve; });
      return { items: [{ ...fileOf(`${parent}-file${options?.cursor ? '-2' : ''}`), containerId: parent }],
        cursor: parent === 'area-1' && !options?.cursor ? 'next' : undefined };
    };
    const harness = renderCatalogSync(provider);
    await act(async () => { harness.get().openFileArea('project-1', 'area-1'); });
    act(() => { if (kind === 'folders') harness.get().loadMoreFolders(null); else harness.get().loadMoreFiles(null); });
    await act(async () => { harness.get().openContainer({ id: 'Y', name: 'Y', parentId: 'area-1' }); });
    await act(async () => finish());
    const ids = kind === 'folders' ? harness.get().folders.map(f => f.id) : harness.get().allFiles.map(f => f.id);
    assert.equal(ids.includes(kind === 'folders' ? 'Y-child' : 'Y-file'), true, 'Y survives the late page');
  });
}

it('C-5 concurrent folder opens retain each pending container', async () => {
  const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: true });
  const replies = new Map<string, () => void>();
  provider.listContainers = async (_ctx, _project, parent) => {
    if (parent !== 'area-1') await new Promise<void>(resolve => replies.set(parent, resolve));
    return { items: [] };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  act(() => {
    harness.get().openContainer({ id: 'X', name: 'X' });
    harness.get().openContainer({ id: 'Y', name: 'Y' });
  });
  await act(async () => replies.get('X')!());
  assert.equal(harness.get().loadingContainers.has('Y'), true, 'Y still owns a pending folder request');
  await act(async () => replies.get('Y')!());
  assert.equal(harness.get().loadingContainers.size, 0);
});

for (const kind of ['folders', 'files'] as const) it(`C-5 same-tick ${kind} load-more presses request one page`, async () => {
  const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: false });
  const replies: Array<() => void> = [];
  let pages = 0;
  provider.listContainers = async (_ctx, _project, _parent, options) => {
    if (options?.cursor) { pages++; await new Promise<void>(resolve => replies.push(resolve)); }
    return { items: [], cursor: kind === 'folders' && !options?.cursor ? 'next' : undefined };
  };
  provider.listFiles = async (_ctx, _project, _parent, _filter, options) => {
    if (options?.cursor) { pages++; await new Promise<void>(resolve => replies.push(resolve)); }
    return { items: [], cursor: kind === 'files' && !options?.cursor ? 'next' : undefined };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  const loadMore = () => kind === 'folders' ? harness.get().loadMoreFolders(null) : harness.get().loadMoreFiles(null);
  act(() => { loadMore(); loadMore(); });
  const count = pages;
  await act(async () => { for (const finish of replies) finish(); });
  assert.equal(count, 1);
});

it('C-5 an old folder completion cannot release a replacement generation folder', async () => {
  const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: true });
  const replies: Array<() => void> = [];
  let opens = 0;
  provider.listContainers = async (_ctx, _project, parent) => {
    if (parent === 'X') { opens++; await new Promise<void>(resolve => replies.push(resolve)); }
    return { items: [] };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  act(() => harness.get().openContainer({ id: 'X', name: 'X' }));
  await act(async () => harness.get().openFileArea('p', 'area-2'));
  act(() => harness.get().openContainer({ id: 'X', name: 'X' }));
  await act(async () => replies[0]());
  act(() => harness.get().openContainer({ id: 'X', name: 'X' }));
  const count = opens;
  await act(async () => { for (const finish of replies.slice(1)) finish(); });
  assert.equal(count, 2, 'the old finally must not remove the replacement folder lock');
});

for (const action of ['reset', 'replace'] as const) it(`C-5 ${action} releases the old pagination owner immediately`, async () => {
  const provider = new FakeProvider();
  const replies: Array<() => void> = [];
  let pages = 0;
  provider.listContainers = async (_ctx, _project, _parent, options) => {
    if (options?.cursor) { pages++; await new Promise<void>(resolve => replies.push(resolve)); }
    return { items: [], cursor: options?.cursor ? undefined : 'next' };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'old'));
  act(() => harness.get().loadMoreFolders(null));
  assert.equal(harness.get().loadingMore, true);
  if (action === 'reset') {
    act(() => harness.get().resetCatalog());
    assert.equal(harness.get().loadingMore, false, 'reset abandons the pagination lease');
  }
  await act(async () => harness.get().openFileArea('p', 'new'));
  act(() => harness.get().loadMoreFolders(null));
  const count = pages;
  await act(async () => { for (const finish of replies) finish(); });
  assert.equal(count, 2, 'replacement area can page while the retired provider promise is pending');
  assert.equal(harness.get().loadingMore, false);
});

it('#9567 manual sync retires folder locks without letting old finally release the new request', async () => {
  const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: true });
  const replies: Array<() => void> = [];
  let opens = 0;
  provider.listContainers = async (_ctx, _project, parent) => {
    if (parent === 'X') { opens++; await new Promise<void>(resolve => replies.push(resolve)); }
    return { items: [] };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  act(() => harness.get().openContainer({ id: 'X', name: 'X' }));
  await act(async () => harness.get().syncFileArea('p', 'area-1'));
  const retiredLoading = harness.get().loadingContainers.has('X');
  act(() => harness.get().openContainer({ id: 'X', name: 'X' }));
  await act(async () => replies[0]());
  const stillLoading = harness.get().loadingContainers.has('X');
  act(() => harness.get().openContainer({ id: 'X', name: 'X' }));
  const count = opens;
  await act(async () => { for (const finish of replies.slice(1)) finish(); });
  assert.equal(retiredLoading, false, 'manual sync retires the old container loading state');
  assert.equal(count, 2, 'manual sync permits a new request and the old finally cannot unlock it');
  assert.equal(stillLoading, true);
  assert.equal(harness.get().loadingFolders, false);
});

it('#9567 manual sync retires the pagination flight before the old page resolves', async () => {
  const provider = new FakeProvider();
  const replies: Array<() => void> = [];
  let pages = 0;
  provider.listContainers = async (_ctx, _project, _parent, options) => {
    if (options?.cursor) { pages++; await new Promise<void>(resolve => replies.push(resolve)); }
    return { items: [], cursor: options?.cursor ? undefined : 'next' };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  act(() => harness.get().loadMoreFolders(null));
  await act(async () => harness.get().syncFileArea('p', 'area-1'));
  const released = !harness.get().loadingMore;
  act(() => harness.get().loadMoreFolders(null));
  await act(async () => replies[0]());
  const stillLoading = harness.get().loadingMore;
  const count = pages;
  await act(async () => { for (const finish of replies.slice(1)) finish(); });
  assert.equal(released, true, 'manual sync releases the old flight immediately');
  assert.equal(count, 2);
  assert.equal(stillLoading, true, 'the old page cannot finish the replacement flight');
  assert.equal(harness.get().loadingMore, false);
});

it('#9567 opening a cached area releases an old pagination flight without starting another sync', async () => {
  const provider = new FakeProvider();
  saveSourceCatalogCache(provider.manifest.name, 'p', 'cached', [],
    [{ ...fileOf('cached-file'), containerId: 'cached' }]);
  let finish!: () => void, cachedFetches = 0;
  provider.listContainers = async (_ctx, _project, parent, options) => {
    if (parent === 'cached') cachedFetches++;
    if (options?.cursor) await new Promise<void>(resolve => { finish = resolve; });
    return { items: [], cursor: options?.cursor ? undefined : 'next' };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'old'));
  act(() => harness.get().loadMoreFolders(null));
  const wasLoading = harness.get().loadingMore;
  act(() => harness.get().openFileArea('p', 'cached'));
  const released = !harness.get().loadingMore;
  const cachedIds = harness.get().allFiles.map(file => file.id);
  await act(async () => finish());
  assert.equal(wasLoading, true);
  assert.equal(released, true, 'the cache path returns before beginGeneration can release the old owner');
  assert.equal(cachedFetches, 0, 'the cached transition must not fall back to a fresh sync');
  assert.deepEqual(cachedIds, ['cached-file']);
  assert.deepEqual(harness.get().allFiles.map(file => file.id), ['cached-file']);
});

it('#9567 on-demand completion leaves initial area file loading owned by the area', async () => {
  const provider = new FakeProvider({ containerListing: 'flat-subtree', listFilesIsRecursive: false, eagerFileSweep: true });
  let finish!: () => void;
  provider.listFiles = async (_ctx, _project, parent) => {
    if (parent === 'area-1') await new Promise<void>(resolve => { finish = resolve; });
    return { items: [] };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  await act(async () => harness.get().openContainer({ id: 'X', name: 'X' }));
  const areaStillLoading = harness.get().loadingFiles;
  await act(async () => finish());
  assert.equal(areaStillLoading, true, 'only the initial area fetch may clear its loading flag');
  assert.equal(harness.get().loadingFiles, false);
});

// #9567 / #9590: the helper migration preserves physical cancellation of page requests.
for (const kind of ['folders', 'files'] as const) for (const retire of ['reset', 'replace', 'sync', 'unmount'] as const) {
  it(`#9567 ${retire} aborts an in-flight ${kind} page and rejects its late result`, async () => {
    const provider = new FakeProvider();
    let pageSignal: AbortSignal | undefined;
    let finish!: () => void;
    const hold = async (options?: ListOptions) => {
      if (options?.cursor) {
        pageSignal = options.signal;
        await new Promise<void>(resolve => { finish = resolve; });
      }
    };
    provider.listContainers = async (_ctx, _project, _parent, options) => {
      await hold(options);
      return { items: options?.cursor ? [{ id: 'retired-page', name: 'retired page' }] : [],
        cursor: kind === 'folders' && !options?.cursor ? 'next' : undefined };
    };
    provider.listFiles = async (_ctx, _project, _parent, _filter, options) => {
      await hold(options);
      return { items: options?.cursor ? [fileOf('retired-page')] : [],
        cursor: kind === 'files' && !options?.cursor ? 'next' : undefined };
    };
    const harness = renderCatalogSync(provider);
    await act(async () => harness.get().openFileArea('p', 'area-1'));
    act(() => { if (kind === 'folders') harness.get().loadMoreFolders(null); else harness.get().loadMoreFiles(null); });
    await act(async () => {});
    assert.equal(Boolean(pageSignal), true, 'paging reaches the provider with an abort signal');
    if (retire === 'reset') act(() => harness.get().resetCatalog());
    else if (retire === 'replace') await act(async () => harness.get().openFileArea('p', 'area-2'));
    else if (retire === 'sync') await act(async () => harness.get().syncFileArea('p', 'area-1'));
    else { const entry = mounted.pop()!; act(() => entry.root.unmount()); entry.container.remove(); }
    const aborted = pageSignal?.aborted;
    await act(async () => finish());
    assert.equal(aborted, true, 'retiring the page aborts its transport');
    if (retire !== 'unmount') {
      assert.equal(harness.get().loadingMore, false);
      const ids = kind === 'folders' ? harness.get().folders.map(folder => folder.id) : harness.get().allFiles.map(file => file.id);
      assert.equal(ids.includes('retired-page'), false, 'an abort-ignoring provider cannot publish a retired page');
    }
  });
}

for (const action of ['reset', 'cached-open'] as const) it(`#9567 ${action} clears the rendered container loading set`, async () => {
  const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: true });
  let release!: () => void;
  provider.listContainers = async (_ctx, _project, parent) => {
    if (parent === 'X') await new Promise<void>(resolve => { release = resolve; });
    return { items: [] };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  act(() => harness.get().openContainer({ id: 'X', name: 'X' }));
  assert.equal(harness.get().loadingContainers.size, 1);
  if (action === 'reset') act(() => harness.get().resetCatalog());
  else {
    // Provider replacement can restore a complete cached catalog while the
    // previous provider's folder request is still outstanding.
    const cachedProvider = new FakeProvider();
    harness.rerender(cachedProvider);
    saveSourceCatalogCache(cachedProvider.manifest.name, 'p', 'cached', [], []);
    act(() => harness.get().openFileArea('p', 'cached'));
  }
  const size = harness.get().loadingContainers.size;
  await act(async () => release());
  assert.equal(size, 0, 'retirement clears rendered loading without waiting for the old provider');
});

it('#9567 manual sync removes prior folder files before its replacement area page arrives', async () => {
  const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: false });
  let hold = false, release!: () => void;
  provider.listFiles = async (_ctx, _project, parent) => {
    if (hold && parent === 'area-1') await new Promise<void>(resolve => { release = resolve; });
    return { items: [{ ...fileOf('old-file'), containerId: parent }] };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  await act(async () => harness.get().openContainer({ id: 'X', name: 'X' }));
  assert.equal(harness.get().filesByContainer.has('X'), true);
  hold = true;
  let sync!: Promise<void>;
  await act(async () => { sync = harness.get().syncFileArea('p', 'area-1'); });
  const size = harness.get().filesByContainer.size;
  await act(async () => { release(); await sync; });
  assert.equal(size, 0, 'the new sync must not retain stale prior-generation files');
});

for (const order of ['files first', 'folders first'] as const) it(`#9567 overlapping sync and pagination persist the complete live catalog: ${order}`, async () => {
  const provider = new FakeProvider();
  let finishFiles = () => {}, finishFolders = () => {};
  provider.listContainers = async (_ctx, _project, _parent, options) => {
    if (options?.cursor) await new Promise<void>(resolve => { finishFolders = resolve; });
    return { items: [{ id: options?.cursor ? 'folder-2' : 'folder-1', name: 'Folder', parentId: 'area-1' }], cursor: options?.cursor ? undefined : 'next' };
  };
  provider.listFiles = async () => {
    await new Promise<void>(resolve => { finishFiles = resolve; });
    return { items: provider.files };
  };
  const harness = renderCatalogSync(provider);
  try {
    await act(async () => harness.get().openFileArea('project-1', 'area-1'));
    act(() => harness.get().loadMoreFolders(null));
    if (order === 'files first') {
      await act(async () => finishFiles());
      await act(async () => finishFolders());
    } else {
      await act(async () => finishFolders());
      await act(async () => finishFiles());
    }
    const cached = loadSourceCatalogCache(provider.manifest.name, 'project-1', 'area-1');
    assert.equal(Boolean(cached), true, 'one completion must persist the combined complete catalog');
    assert.deepEqual(cached!.folders.map(folder => folder.id), ['folder-1', 'folder-2']);
    assert.deepEqual(cached!.files.map(file => file.id), ['file-1']);
    await act(async () => harness.get().openFileArea('project-1', 'area-1'));
    assert.deepEqual(harness.get().folders.map(folder => folder.id), ['folder-1', 'folder-2'], 'reopening restores the complete cache');
  } finally { await act(async () => { finishFiles(); finishFolders(); }); }
});

for (const order of ['children first', 'area first'] as const) it(`#9567 folder refresh preserves this generation's children and retires old parents: ${order}`, async () => {
  const provider = new FakeProvider({ containerListing: 'direct-children', listFilesIsRecursive: true });
  let refreshing = false, releaseArea = () => {}, releaseChildren = () => {};
  provider.listContainers = async (_ctx, _project, parent) => {
    if (refreshing && parent === 'area-1') await new Promise<void>(resolve => { releaseArea = resolve; });
    if (refreshing && parent === 'Y') await new Promise<void>(resolve => { releaseChildren = resolve; });
    return { items: parent === 'X' ? [{ id: 'old-child', name: 'Old child', parentId: 'X' }]
      : parent === 'Y' ? [{ id: 'fresh-child', name: 'Fresh child', parentId: 'Y' }]
        : [{ id: 'X', name: 'X', parentId: 'area-1' }, { id: 'Y', name: 'Y', parentId: 'area-1' }] };
  };
  const harness = renderCatalogSync(provider);
  await act(async () => harness.get().openFileArea('p', 'area-1'));
  await act(async () => harness.get().openContainer({ id: 'X', name: 'X' }));
  assert.equal(harness.get().folders.some(folder => folder.id === 'old-child'), true);
  refreshing = true;
  let sync!: Promise<void>;
  try {
    await act(async () => { sync = harness.get().syncFileArea('p', 'area-1'); });
    act(() => harness.get().openContainer({ id: 'Y', name: 'Y' }));
    assert.equal(harness.get().loadingContainers.has('Y'), true);
    if (order === 'children first') {
      await act(async () => releaseChildren());
      assert.equal(harness.get().loadingContainers.has('Y'), false);
      assert.equal(harness.get().folders.some(folder => folder.id === 'fresh-child'), true);
      await act(async () => { releaseArea(); await sync; });
    } else {
      await act(async () => { releaseArea(); await sync; });
      await act(async () => releaseChildren());
    }
    assert.equal(harness.get().folders.some(folder => folder.id === 'fresh-child'), true, 'new-generation children survive the area folder page');
    assert.equal(harness.get().folders.some(folder => folder.id === 'old-child'), false, 'an old parent not reopened during sync is retired');
    assert.equal(harness.get().loadingContainers.has('Y'), false);
  } finally { await act(async () => { releaseChildren(); releaseArea(); await sync; }); }
});
