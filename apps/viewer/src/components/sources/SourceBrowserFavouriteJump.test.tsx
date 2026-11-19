/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Jumping to a favourite, mounted under `<StrictMode>` because that is where
 * it broke.
 *
 * The browser is a three-step wizard, so a favourite has to rebuild the state
 * the user would have reached by hand and then wait a render for the id-only
 * listing it requested. The first version of that fired once, guarded by a ref
 * — and StrictMode's mount runs effect -> cleanup -> effect, while both
 * `useSourceCatalogSync` and `usePagedList` abort their in-flight request and
 * bump their request generation in their own unmount cleanups. So the listing
 * the first pass started was aborted by the teardown in between, the second
 * pass skipped (ref already set), and because the generation was now stale the
 * `finally` that clears `loadingFolders`/`loadingFiles` no longer applied: two
 * spinners, forever, with no request outstanding. Every test here therefore
 * renders inside `<StrictMode>` — under a plain mount they pass either way.
 *
 * The provider fixture mirrors Dalux (`flat-subtree` + recursive files), which
 * is the shipped capability pair this ran into. A second fixture mirrors
 * Dropbox/msgraph (`direct-children` + per-folder files), whose two-step
 * `openContainer` is the only way to reach the folders-before-files window one
 * of the tests pins down. A third splits the FOLDER listing over two pages,
 * which is what the folder branch's paging guard exists for.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  FileSourceProvider,
  Page,
  PluginContext,
  PluginManifest,
  SourceContainer,
  SourceFile,
  SourceProject,
} from '@ifc-lite/plugin-api';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { toast } from '@/components/ui/toast';
import type { SourceFavourite } from '@/lib/sources/favourites';
import { SourceBrowser } from './SourceBrowser.js';

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

const manifest: PluginManifest = {
  name: 'fixture-provider',
  title: 'Fixture Provider',
  api: '^2.0.0',
  permissions: { network: [] },
  auth: 'preferences',
  preferences: [],
  capabilities: {
    containerListing: 'flat-subtree',
    listFilesIsRecursive: true,
    revisionHistory: false,
    downloadHistoricalRevisions: false,
    changeDetection: false,
    search: false,
  },
  contributes: { fileSources: [] },
};

const FOLDER: SourceContainer = { id: 'folder-1', name: 'Models', parentId: 'area-1' };
const OTHER_FOLDER: SourceContainer = { id: 'folder-2', name: 'Drawings', parentId: 'area-1' };
/** Nested one level down, so a fabricated `parentId` of the area root is a
 *  visibly different trail rather than an accidentally correct guess. */
const NESTED_FOLDER: SourceContainer = { id: 'folder-3', name: 'Archive', parentId: 'folder-1' };
const IN_FOLDER: SourceFile = {
  id: 'file-1', name: 'Tower.ifc', containerId: 'folder-1', currentRevisionId: 'rev-1',
};
const ELSEWHERE: SourceFile = {
  id: 'file-2', name: 'Podium.ifc', containerId: 'folder-2', currentRevisionId: 'rev-1',
};
const IN_NESTED: SourceFile = {
  id: 'file-3', name: 'Superseded.ifc', containerId: 'folder-3', currentRevisionId: 'rev-1',
};

class FakeProvider implements FileSourceProvider {
  readonly manifest = manifest;
  folderListings = 0;
  fileListings = 0;

  listProjects(): Promise<Page<SourceProject>> {
    return Promise.resolve({ items: [{ id: 'project-1', name: 'Tower Project' }] });
  }

  listContainers(_ctx: PluginContext, _projectId: string, parentId?: string): Promise<Page<SourceContainer>> {
    if (!parentId) return Promise.resolve({ items: [{ id: 'area-1', name: 'Documents' }] });
    this.folderListings += 1;
    return Promise.resolve({ items: [FOLDER, OTHER_FOLDER] });
  }

  listFiles(): Promise<Page<SourceFile>> {
    this.fileListings += 1;
    return Promise.resolve({ items: [IN_FOLDER, ELSEWHERE] });
  }

  download(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('not exercised'));
  }
}

function favourite(overrides: Partial<SourceFavourite> = {}): SourceFavourite {
  return {
    providerId: 'fixture-provider',
    kind: 'folder',
    projectId: 'project-1',
    projectName: 'Tower Project',
    fileAreaId: 'area-1',
    fileAreaName: 'Documents',
    containerId: 'folder-1',
    containerName: 'Models',
    identityId: null,
    addedAt: 1,
    ...overrides,
  };
}

/**
 * A provider that holds a listing back until released, so the second phase is
 * forced to run while the data it needs is still in flight. `FakeProvider`
 * resolves in a microtask, which happens to hand the effect a complete listing
 * on its first useful run — the "is it still loading?" guards are then inert,
 * and a build that dropped them passes. Deferring is what makes them
 * load-bearing.
 */
class DeferringProvider extends FakeProvider {
  private releaseFolders: (() => void) | null = null;
  private releaseFiles: (() => void) | null = null;

  constructor(private readonly defer: 'folders' | 'files') {
    super();
  }

  override listContainers(
    c: PluginContext,
    projectId: string,
    parentId?: string,
  ): Promise<Page<SourceContainer>> {
    const page = super.listContainers(c, projectId, parentId);
    if (this.defer !== 'folders' || !parentId) return page;
    return new Promise((resolve) => {
      this.releaseFolders = () => resolve(page);
    });
  }

  override listFiles(): Promise<Page<SourceFile>> {
    const page = super.listFiles();
    if (this.defer !== 'files') return page;
    return new Promise((resolve) => {
      this.releaseFiles = () => resolve(page);
    });
  }

  release(): void {
    this.releaseFolders?.();
    this.releaseFiles?.();
  }
}

const directChildrenManifest: PluginManifest = {
  ...manifest,
  capabilities: {
    ...manifest.capabilities,
    containerListing: 'direct-children',
    listFilesIsRecursive: false,
  },
};

/**
 * Dropbox/msgraph-shaped: one children listing per browsed folder, one file
 * listing per folder. On this capability pair `openContainer` fetches the
 * child folders FIRST and flips `loadingFiles` only after they resolve, so
 * there is a window where `loadingFolders` is true, `loadingFiles` is false
 * and the favourited file is simply not listed yet. `DeferringProvider` cannot
 * park the jump there — it holds back every folder listing including the area
 * root's, which the jump needs to get going — so this one holds back exactly
 * the favourited folder's children listing.
 */
class DirectChildrenProvider extends FakeProvider {
  override readonly manifest = directChildrenManifest;
  private releaseChildren: (() => void) | null = null;

  /**
   * Splits the file listing over two pages, the favourited file on the second.
   * `eagerFileSweep` is off by default, so this is the SHIPPED shape for every
   * provider but Dalux: `useSourceCatalogSync` fetches page one and stops.
   */
  constructor(private readonly pageFiles = false) {
    super();
  }

  override listContainers(
    _ctx: PluginContext,
    _projectId: string,
    parentId?: string,
  ): Promise<Page<SourceContainer>> {
    if (!parentId) return Promise.resolve({ items: [{ id: 'area-1', name: 'Documents' }] });
    this.folderListings += 1;
    const page = Promise.resolve({
      items: [FOLDER, OTHER_FOLDER].filter((folder) => folder.parentId === parentId),
    });
    if (parentId !== FOLDER.id) return page;
    return new Promise((resolve) => {
      this.releaseChildren = () => resolve(page);
    });
  }

  override listFiles(
    _ctx?: PluginContext,
    _projectId?: string,
    containerId?: string,
    _filter?: unknown,
    options?: { cursor?: string },
  ): Promise<Page<SourceFile>> {
    this.fileListings += 1;
    const items = [IN_FOLDER, ELSEWHERE].filter((file) => file.containerId === containerId);
    if (!this.pageFiles) return Promise.resolve({ items });
    return options?.cursor === undefined
      ? Promise.resolve({ items: [], cursor: 'page-2' })
      : Promise.resolve({ items });
  }

  release(): void {
    this.releaseChildren?.();
    this.releaseChildren = null;
  }
}

/**
 * Splits the FOLDER listing over two pages, the favourited folder on the
 * second: the folder-side twin of `DirectChildrenProvider(true)` above.
 * Folder listings are cursor-paged for every provider (`useSourceCatalogSync`
 * fetches page one and stops; there is no folder equivalent of
 * `eagerFileSweep`), so this is the shipped shape, not a corner case.
 *
 * Capabilities stay Dalux-shaped (`flat-subtree` + recursive files) so the
 * whole area is one folder listing keyed by the area id, which is exactly the
 * key `hasMoreFolders` consults while the jump is still parked at the root.
 */
class PagedFoldersProvider extends FakeProvider {
  /** Page two's contents; empty models a folder genuinely gone from the source. */
  constructor(private readonly secondPage: readonly SourceContainer[] = [NESTED_FOLDER]) {
    super();
  }

  override listContainers(
    _ctx?: PluginContext,
    _projectId?: string,
    parentId?: string,
    options?: { cursor?: string },
  ): Promise<Page<SourceContainer>> {
    if (!parentId) return Promise.resolve({ items: [{ id: 'area-1', name: 'Documents' }] });
    this.folderListings += 1;
    return options?.cursor === undefined
      ? Promise.resolve({ items: [FOLDER, OTHER_FOLDER], cursor: 'folder-page-2' })
      : Promise.resolve({ items: [...this.secondPage] });
  }

  override listFiles(): Promise<Page<SourceFile>> {
    this.fileListings += 1;
    return Promise.resolve({ items: [IN_FOLDER, ELSEWHERE, IN_NESTED] });
  }
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

// Several microtask turns: the area sync fetches folders and files in
// sequence, and the second phase runs on the render after each arrives.
async function pump(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function jumpTo(target: SourceFavourite, provider: FakeProvider): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  await act(async () => {
    root.render(
      <StrictMode>
        <SourceHostProvider>
          <SourceBrowser
            provider={provider}
            ctx={ctx}
            onDownload={() => {}}
            onBack={() => {}}
            openTarget={target}
          />
        </SourceHostProvider>
      </StrictMode>,
    );
  });
  await pump();
}

function text(): string {
  return document.body.textContent ?? '';
}

/**
 * The breadcrumb above the file list, as "Area / Folder / Subfolder".
 * `SourceFolderStep` builds it by walking `selectedContainer.parentId` up to
 * the file area, so it is where a fabricated parent becomes visible: a
 * synthesised stand-in claiming the area root renders one level shallower than
 * the folder really is.
 */
function trail(): string {
  const crumbs = document.body.querySelector('nav[aria-label="Current folder"]');
  // Loud rather than empty: an unmatched selector would otherwise read as
  // "the jump went nowhere" when the markup was merely restyled.
  assert.ok(crumbs, 'no breadcrumb row in the DOM - has SourceFolderStep been restyled?');
  return [...crumbs.querySelectorAll('button')].map((crumb) => crumb.textContent ?? '').join(' / ');
}

beforeEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('jumping to a favourite folder', () => {
  it('fetches the area listing and lands inside the favourited folder', async () => {
    const provider = new FakeProvider();
    await jumpTo(favourite(), provider);

    assert.ok(
      provider.folderListings > 0,
      'the jump must actually request the area catalog, not sit on a spinner',
    );
    assert.ok(provider.fileListings > 0, 'the file listing must be requested too');
    assert.ok(text().includes('Tower.ifc'), "the favourited folder's file must be listed");
    assert.equal(
      text().includes('Podium.ifc'),
      false,
      'a file from a sibling folder must not leak into the favourited one',
    );
  });

  it('refreshes a label the source renamed underneath the favourite', async () => {
    const provider = new FakeProvider();
    const { loadFavourites, saveFavourites } = await import('@/lib/sources/favourites');
    const stale = favourite({ containerName: 'Old Name' });
    saveFavourites('fixture-provider', [stale]);

    await jumpTo(stale, provider);

    assert.equal(
      loadFavourites('fixture-provider')[0]?.containerName,
      'Models',
      'an id-addressed favourite still opens after a rename; the stored label must catch up',
    );
  });
});

describe('jumping to a favourite file', () => {
  it('preselects the file so one click loads it', async () => {
    const provider = new FakeProvider();
    await jumpTo(
      favourite({ kind: 'file', fileId: 'file-1', fileName: 'Tower.ifc' }),
      provider,
    );

    assert.ok(
      text().includes('Load 1 file as federated model'),
      'the favourited file must arrive already selected',
    );
  });

  it('says so instead of hanging when the file is gone from its folder', async () => {
    const provider = new FakeProvider();
    await jumpTo(
      favourite({ kind: 'file', fileId: 'file-deleted', fileName: 'Gone.ifc' }),
      provider,
    );

    assert.ok(text().includes('Tower.ifc'), 'the folder still opens');
    assert.equal(
      text().includes('Load 1 file as federated model'),
      false,
      'nothing may end up selected',
    );
  });

  it('waits for a slow file listing instead of giving up on the first empty one', async () => {
    const provider = new DeferringProvider('files');
    await jumpTo(favourite({ kind: 'file', fileId: 'file-1', fileName: 'Tower.ifc' }), provider);

    // The listing is still in flight: an absent file here means "not yet",
    // never "deleted", so the jump must still be pending.
    assert.equal(
      text().includes('Load 1 file as federated model'),
      false,
      'nothing can be selected before the listing arrives',
    );

    provider.release();
    await pump();

    assert.ok(
      text().includes('Load 1 file as federated model'),
      'the favourited file must be selected once the slow listing lands',
    );
  });
});

describe('jumping while the listing is still in flight', () => {
  it('waits for a slow folder listing before resolving the favourited folder', async () => {
    const provider = new DeferringProvider('folders');
    const { loadFavourites, saveFavourites } = await import('@/lib/sources/favourites');
    const stale = favourite({ containerName: 'Old Name' });
    saveFavourites('fixture-provider', [stale]);

    await jumpTo(stale, provider);
    provider.release();
    await pump();

    // Resolving against an empty in-flight listing would fall back to the
    // stored name and settle for it, leaving the label wrong forever.
    assert.equal(
      loadFavourites('fixture-provider')[0]?.containerName,
      'Models',
      'the real folder must be the one that resolves the favourite, not a synthesised stand-in',
    );
  });

  it('survives the folders-before-files window of a direct-children provider', async () => {
    // The real ordering on Dropbox/msgraph: entering the favourited folder
    // fetches its child folders first, so the effect runs with
    // `loadingFolders === true`, `loadingFiles === false` and the file absent
    // from the catalog. Guarding on `loadingFiles` alone gives up right there.
    const provider = new DirectChildrenProvider();
    const infoToasts: string[] = [];
    const originalInfo = toast.info;
    toast.info = (message: string) => {
      infoToasts.push(message);
      originalInfo(message);
    };
    try {
      await jumpTo(favourite({ kind: 'file', fileId: 'file-1', fileName: 'Tower.ifc' }), provider);

      assert.equal(
        infoToasts.some((message) => message.includes('no longer in this folder')),
        false,
        'a file whose folder listing is still in flight must not be reported as gone',
      );
      assert.equal(
        text().includes('Load 1 file as federated model'),
        false,
        'nothing can be selected before the listing arrives',
      );

      provider.release();
      await pump();

      assert.equal(infoToasts.length, 0, 'no give-up toast may have fired along the way');
      assert.ok(
        text().includes('Load 1 file as federated model'),
        'the pending jump must survive the window and preselect the file once listed',
      );
    } finally {
      toast.info = originalInfo;
    }
  });

  it('does not call a favourite gone while its folder has file pages outstanding', async () => {
    // The default shape: without `eagerFileSweep` only the FIRST page of a
    // folder's files is fetched, so "not in the listing" says nothing about
    // whether the file exists. Reporting it gone here is a lie about a file
    // sitting on page two.
    const provider = new DirectChildrenProvider(true);
    const infoToasts: string[] = [];
    const originalInfo = toast.info;
    toast.info = (message: string) => {
      infoToasts.push(message);
      originalInfo(message);
    };
    try {
      await jumpTo(favourite({ kind: 'file', fileId: 'file-1', fileName: 'Tower.ifc' }), provider);
      provider.release();
      await pump();

      assert.deepStrictEqual(
        infoToasts,
        [],
        'page one being short of the file is not the file being deleted',
      );

      // And the jump is still pending, so the user's own "Load more files"
      // finishes it — the residual gap is that nothing drains those pages for
      // them, not that the jump was thrown away.
      const loadMore = button('Load more files');
      assert.ok(loadMore, 'the outstanding page must still be offered');
      await act(async () => {
        loadMore.click();
      });
      await pump();

      assert.ok(
        text().includes('Load 1 file as federated model'),
        'the favourited file must be selected once its page arrives',
      );
    } finally {
      toast.info = originalInfo;
    }
  });
});

/**
 * Regression cover for the folder branch of the same paging hole the file
 * branch above already pins down (#2671). Folder listings are cursor-paged for
 * every provider, so a favourited folder past page one is absent from
 * `sortedFolders` for a reason that has nothing to do with it being gone,
 * and falling through there does not merely mis-report it: it synthesises a
 * container whose `parentId` is a guess at the area root, wrong for any folder
 * that is not directly under it.
 */
describe('jumping to a favourite folder past the first page', () => {
  it('waits for the outstanding folder page instead of fabricating a parent', async () => {
    const provider = new PagedFoldersProvider();
    await jumpTo(
      favourite({ containerId: NESTED_FOLDER.id, containerName: NESTED_FOLDER.name }),
      provider,
    );

    // Page one has landed and both spinners are down, so the outstanding
    // cursor is the only thing that can hold the jump back at this point.
    const loadMore = button('Load more folders');
    assert.ok(loadMore, 'the outstanding folder page must still be offered');
    assert.equal(
      trail(),
      'Documents',
      'a folder missing only because its page is unfetched must not be entered yet',
    );

    await act(async () => {
      loadMore.click();
    });
    await pump();

    // A stand-in claiming the area root would read "Documents / Archive".
    assert.equal(
      trail(),
      'Documents / Models / Archive',
      'the real folder must resolve the favourite, parent and all',
    );
    assert.ok(text().includes('Superseded.ifc'), "the favourited folder's own file must be listed");
  });

  it('still opens a favourite the fully-paged listing no longer holds', async () => {
    // The guard must not turn a graceful degradation into a dead end. Once
    // every page is in, "not listed" does mean gone, and the favourite's own
    // ids still open the folder: that fallback stays reachable.
    const provider = new PagedFoldersProvider([]);
    await jumpTo(favourite({ containerId: 'folder-gone', containerName: 'Retired' }), provider);

    const loadMore = button('Load more folders');
    assert.ok(loadMore, 'the outstanding folder page must still be offered');
    await act(async () => {
      loadMore.click();
    });
    await pump();

    assert.equal(
      trail(),
      'Documents / Retired',
      'a folder absent from a complete listing must still open from the stored ids',
    );
    assert.ok(
      text().includes('No IFC files found in this folder'),
      'and it must open empty rather than showing the files of another folder',
    );
  });
});

class ConcurrentFolderProvider extends FakeProvider {
  override readonly manifest: PluginManifest = {
    ...directChildrenManifest,
    capabilities: { ...directChildrenManifest.capabilities, eagerFileSweep: true },
  };
  areaFileCalls = 0;
  private pending = new Map<string, Array<() => void>>();
  constructor(private readonly holdArea = false) { super(); }
  override listContainers(c: PluginContext, project: string, parent?: string): Promise<Page<SourceContainer>> {
    return !parent || parent === 'area-1' ? super.listContainers(c, project, parent) : Promise.resolve({ items: [] });
  }
  override async listFiles(_ctx?: PluginContext, _project?: string, container?: string): Promise<Page<SourceFile>> {
    if (container === 'area-1') this.areaFileCalls++;
    if (container === FOLDER.id || container === OTHER_FOLDER.id || (this.holdArea && container === 'area-1')) {
      await new Promise<void>(resolve => this.pending.set(container, [...(this.pending.get(container) ?? []), resolve]));
    }
    return { items: container === FOLDER.id ? [IN_FOLDER] : container === OTHER_FOLDER.id ? [ELSEWHERE] : [] };
  }
  release(id: string): void { for (const finish of this.pending.get(id) ?? []) finish(); this.pending.delete(id); }
  releaseAll(): void { for (const id of this.pending.keys()) this.release(id); }
}

const fileSpinner = () => [...document.querySelectorAll('output')].some(node => node.textContent?.includes('Loading'));

it('#9567 selected Y files render while X is still loading with eager per-folder files', async () => {
  const provider = new ConcurrentFolderProvider();
  try {
    await jumpTo(favourite({ containerId: 'area-1', containerName: 'Documents' }), provider);
    act(() => button('Models')!.click()); await pump();
    assert.equal(fileSpinner(), true, 'X owns its loading state');
    act(() => button('Drawings')!.click()); await pump();
    assert.equal(fileSpinner(), true, 'Y owns its loading state');
    provider.release(OTHER_FOLDER.id); await pump();
    assert.equal(text().includes('Podium.ifc'), true, 'ready Y files are visible before X finishes');
    assert.equal(fileSpinner(), false);
    act(() => button('Models')!.click()); await pump();
    assert.equal(fileSpinner(), true, 'the still-pending X keeps its own loading state');
    assert.equal(text().includes('Podium.ifc'), false);
    provider.release(FOLDER.id); await pump();
    assert.equal(text().includes('Tower.ifc'), true);
    assert.equal(fileSpinner(), false);
  } finally { provider.releaseAll(); await pump(); }
});

it('#9567 a folder finishing cannot clear the initial area file spinner', async () => {
  const provider = new ConcurrentFolderProvider(true);
  try {
    await jumpTo(favourite({ containerId: 'area-1', containerName: 'Documents' }), provider);
    assert.equal(fileSpinner(), true, 'initial per-folder area files are still pending');
    act(() => button('Models')!.click()); await pump();
    provider.release(FOLDER.id); await pump();
    assert.equal(text().includes('Tower.ifc'), true);
    act(() => button('Documents')!.click()); await pump();
    assert.equal(provider.areaFileCalls, 1, 'clicking the root must not start another eager sweep');
    assert.equal(fileSpinner(), true, 'the initial area request still owns the area spinner');
    provider.release('area-1'); await pump();
    assert.equal(fileSpinner(), false);
  } finally { provider.releaseAll(); await pump(); }
});

it('#9567 recursive file scans keep a selected folder loading until the area scan completes', async () => {
  const provider = new DeferringProvider('files');
  try {
    await jumpTo(favourite(), provider);
    assert.equal(trail(), 'Documents / Models', 'the favourite selects the folder before its files arrive');
    assert.equal(fileSpinner(), true, 'recursive files are owned by the area scan for every selection');
    provider.release(); await pump();
    assert.equal(text().includes('Tower.ifc'), true);
    assert.equal(fileSpinner(), false);
  } finally { provider.release(); await pump(); }
});

it('#9567 X files survive the initial area sync completing', async () => {
  const provider = new ConcurrentFolderProvider(true);
  try {
    await jumpTo(favourite({ containerId: 'area-1', containerName: 'Documents' }), provider);
    act(() => button('Models')!.click()); await pump();
    provider.release(FOLDER.id); await pump();
    assert.equal(text().includes('Tower.ifc'), true);
    provider.release('area-1'); await pump();
    assert.equal(text().includes('Tower.ifc'), true, 'X files survive the area sync completing');
    assert.equal(fileSpinner(), false);
  } finally { provider.releaseAll(); await pump(); }
});

it('#9567 an uncached selected folder shows its own folder spinner while child fetch is held', async () => {
  class HeldChildrenProvider extends FakeProvider {
    override readonly manifest: PluginManifest = { ...manifest, capabilities: { ...manifest.capabilities, containerListing: 'direct-children', listFilesIsRecursive: false } };
    release = () => {};
    releaseFiles = () => {};
    override listContainers(c: PluginContext, project: string, parent?: string): Promise<Page<SourceContainer>> {
      if (parent === FOLDER.id) return new Promise(resolve => { this.release = () => resolve({ items: [{ id: 'new-child', name: 'New child', parentId: FOLDER.id }] }); });
      return super.listContainers(c, project, parent);
    }
    override listFiles(_c?: PluginContext, _project?: string, parent?: string): Promise<Page<SourceFile>> {
      if (parent === FOLDER.id) return new Promise(resolve => { this.releaseFiles = () => resolve({ items: [] }); });
      return Promise.resolve({ items: [] });
    }
  }
  const provider = new HeldChildrenProvider();
  try {
    await jumpTo(favourite({ containerId: 'area-1', containerName: 'Documents' }), provider);
    act(() => button('Models')!.click()); await pump();
    assert.equal(trail(), 'Documents / Models');
    assert.equal(Boolean(document.querySelector('output[aria-label="Subfolders"]')), true, 'selected folder loading is visible independently of file loading');
    assert.equal(text().includes('New child'), false, 'the child list is empty while fetchContainers is pending');
    provider.release(); await pump();
    assert.equal(Boolean(document.querySelector('output[aria-label="Subfolders"]')), false);
    assert.equal(text().includes('New child'), true);
    assert.equal(fileSpinner(), true, 'files can remain pending after children arrive');
  } finally { provider.release(); provider.releaseFiles(); await pump(); }
});

it('#9567 failed manual recursive file sync leaves subfolders enabled', async () => {
  class FailedSyncProvider extends FakeProvider {
    fail = false;
    reject = () => {};
    override listFiles(): Promise<Page<SourceFile>> {
      if (this.fail) return new Promise((_resolve, reject) => { this.reject = () => reject(new Error('file listing unavailable')); });
      return super.listFiles();
    }
  }
  const provider = new FailedSyncProvider();
  try {
    await jumpTo(favourite({ containerId: 'area-1', containerName: 'Documents' }), provider);
    assert.equal(button('Models')!.disabled, false);
    provider.fail = true;
    act(() => button('Sync')!.click()); await pump();
    const disabledWhilePending = button('Models')!.disabled;
    provider.reject(); await pump();
    assert.equal(text().includes('file listing unavailable'), true);
    assert.equal(button('Models')!.disabled, false, 'a failed file listing cannot assert that the folder is empty');
    assert.equal(disabledWhilePending, false, 'folder-only data cannot disable folders while files are pending');
  } finally { provider.reject(); await pump(); }
});

it('#9567 a manual folder refresh preserves a sibling opened from the old tree', async () => {
  class FolderRefreshProvider extends FakeProvider {
    override readonly manifest: PluginManifest = { ...directChildrenManifest };
    refreshing = false;
    releaseArea = () => {};
    releaseChildren = () => {};
    override async listContainers(c: PluginContext, project: string, parent?: string): Promise<Page<SourceContainer>> {
      if (this.refreshing && parent === 'area-1') await new Promise<void>(resolve => { this.releaseArea = resolve; });
      if (this.refreshing && parent === OTHER_FOLDER.id) await new Promise<void>(resolve => { this.releaseChildren = resolve; });
      if (parent === FOLDER.id) return { items: [{ id: 'old-child', name: 'Old child', parentId: FOLDER.id }] };
      if (parent === OTHER_FOLDER.id) return { items: [{ id: 'fresh-child', name: 'Fresh child', parentId: OTHER_FOLDER.id }] };
      return super.listContainers(c, project, parent);
    }
    override listFiles(): Promise<Page<SourceFile>> { return Promise.resolve({ items: [] }); }
  }
  const provider = new FolderRefreshProvider();
  try {
    await jumpTo(favourite({ containerId: 'area-1', containerName: 'Documents' }), provider);
    act(() => button('Models')!.click()); await pump();
    assert.equal(text().includes('Old child'), true);
    provider.refreshing = true;
    act(() => button('Sync')!.click()); await pump();
    act(() => button('Drawings')!.click()); await pump();
    assert.equal(Boolean(document.querySelector('output[aria-label="Subfolders"]')), true);
    provider.releaseChildren(); await pump();
    assert.equal(text().includes('Fresh child'), true);
    assert.equal(Boolean(document.querySelector('output[aria-label="Subfolders"]')), false);
    provider.releaseArea(); await pump();
    assert.equal(text().includes('Fresh child'), true, 'Y children remain visible after the area folder refresh');
    assert.equal(Boolean(document.querySelector('output[aria-label="Subfolders"]')), false, 'Y has completed and must not spin');
    assert.equal(text().includes('Old child'), false, 'the untouched old parent page is retired');
  } finally { provider.releaseChildren(); provider.releaseArea(); await pump(); }
});
