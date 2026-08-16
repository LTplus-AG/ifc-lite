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
 * `openContainer` is the only way to reach the folders-before-files window the
 * last test pins down.
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
const IN_FOLDER: SourceFile = {
  id: 'file-1', name: 'Tower.ifc', containerId: 'folder-1', currentRevisionId: 'rev-1',
};
const ELSEWHERE: SourceFile = {
  id: 'file-2', name: 'Podium.ifc', containerId: 'folder-2', currentRevisionId: 'rev-1',
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
  ): Promise<Page<SourceFile>> {
    this.fileListings += 1;
    return Promise.resolve({
      items: [IN_FOLDER, ELSEWHERE].filter((file) => file.containerId === containerId),
    });
  }

  release(): void {
    this.releaseChildren?.();
    this.releaseChildren = null;
  }
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
});
