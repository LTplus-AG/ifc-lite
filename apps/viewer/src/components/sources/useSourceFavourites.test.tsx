/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The star affordance, driven the way a user drives it: mount the real folder
 * step with the real favourites hook behind it and CLICK.
 *
 * Presence of a star proves nothing — the defect this guards against is a
 * button that renders and stores nothing, or stores something that cannot be
 * re-opened. So every assertion here is on what landed in `localStorage` after
 * the click, and on the button reporting its new state back to the user.
 *
 * Three affordances exist and all three are exercised, because they are three
 * separate call sites: the file area itself (a sibling of its own button — a
 * star cannot nest inside a button), a folder in the tree, and a file row.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SourceContainer, SourceFile, SourceProject } from '@ifc-lite/plugin-api';
import { loadFavourites, favouriteKey, saveFavourites } from '@/lib/sources/favourites';
import { syncSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import { SourceFolderStep } from './SourceFolderStep.js';
import { useSourceFavourites } from './useSourceFavourites.js';

const PROVIDER = 'fixture-provider';
const project: SourceProject = { id: 'project-1', name: 'Tower Project' };
const fileArea: SourceContainer = { id: 'area-1', name: 'Documents' };
const folder: SourceContainer = { id: 'folder-1', name: 'Models', parentId: 'area-1' };
const file: SourceFile = {
  id: 'file-1',
  name: 'tower.ifc',
  containerId: 'folder-1',
  currentRevisionId: 'rev-1',
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** Wires the real hook to the real step, exactly as `SourceBrowser` does. */
function Harness() {
  const favourites = useSourceFavourites({
    providerId: PROVIDER,
    selectedProject: project,
    selectedFileArea: fileArea,
    folders: [folder],
  });

  return (
    <SourceFolderStep
      providerName={PROVIDER}
      selectedProject={project}
      selectedFileArea={fileArea}
      selectedContainer={folder}
      onSelectContainer={() => {}}
      sortedFolders={[folder]}
      allFiles={[file]}
      gateEmptyFolders={false}
      loadingFolders={false}
      loadingFiles={false}
      sortedFiles={[file]}
      selectedFiles={new Map()}
      onToggleFile={() => {}}
      downloadedRecords={new Map()}
      loadedModelNamesByFileId={new Map()}
      syncingFileIds={new Set()}
      onSyncLoadedFile={() => {}}
      busy={false}
      onLoad={() => {}}
      foldersHaveMore={false}
      onLoadMoreFolders={() => {}}
      filesHaveMore={false}
      onLoadMoreFiles={() => {}}
      loadingMore={false}
      searchEnabled={false}
      searchQuery=""
      searchActive={false}
      onSearchQueryChange={() => {}}
      onSearchSubmit={() => {}}
      onSearchClear={() => {}}
      isFolderFavourite={favourites.isFolderFavourite}
      onToggleFolderFavourite={favourites.toggleFolderFavourite}
      isFileFavourite={favourites.isFileFavourite}
      onToggleFileFavourite={favourites.toggleFileFavourite}
    />
  );
}

function renderStep(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
  mounted.push({ root, container });
}

/** Finds a star by the label it advertises, which is also what a screen reader reads. */
function star(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  );
  assert.ok(found, `a button labelled "${label}" must render`);
  return found as HTMLButtonElement;
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.click();
  });
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

describe('favouriting a folder from the browser', () => {
  it('stores the whole re-entry tuple when the file area itself is starred', () => {
    renderStep();
    click(star('Add favourite: Documents'));

    const [stored] = loadFavourites(PROVIDER);
    assert.ok(stored, 'the click must persist a favourite');
    assert.equal(stored.kind, 'folder');
    assert.equal(stored.projectId, 'project-1');
    assert.equal(stored.projectName, 'Tower Project');
    assert.equal(stored.fileAreaId, 'area-1');
    assert.equal(stored.containerId, 'area-1', 'the area root favourites itself');
    assert.equal(stored.containerName, 'Documents');
  });

  it('stores a subfolder starred in the tree, addressed by its own id', () => {
    renderStep();
    click(star('Add favourite: Models'));

    const [stored] = loadFavourites(PROVIDER);
    assert.ok(stored);
    assert.equal(stored.containerId, 'folder-1');
    assert.equal(stored.fileAreaId, 'area-1', 'the area is needed to re-enter the wizard');
  });

  it('reports the new state on the button, and un-favourites on a second press', () => {
    renderStep();
    const add = star('Add favourite: Models');
    assert.equal(add.getAttribute('aria-pressed'), 'false');
    click(add);

    const remove = star('Remove favourite: Models');
    assert.equal(remove.getAttribute('aria-pressed'), 'true');
    click(remove);

    assert.deepStrictEqual(loadFavourites(PROVIDER), []);
    assert.equal(star('Add favourite: Models').getAttribute('aria-pressed'), 'false');
  });
});

describe('favouriting a file from the browser', () => {
  it("stores the file's own folder, not the folder currently selected", () => {
    renderStep();
    click(star('Add favourite: tower.ifc'));

    const [stored] = loadFavourites(PROVIDER);
    assert.ok(stored);
    assert.equal(stored.kind, 'file');
    assert.equal(stored.fileId, 'file-1');
    assert.equal(stored.fileName, 'tower.ifc');
    assert.equal(stored.containerId, 'folder-1');
    assert.equal(stored.containerName, 'Models', 'the folder name is resolved, not left as an id');
  });

  it('addresses a file favourite by fileId, so a folder favourite of the same id is separate', () => {
    renderStep();
    click(star('Add favourite: tower.ifc'));
    click(star('Add favourite: Models'));

    const stored = loadFavourites(PROVIDER);
    assert.equal(stored.length, 2);
    assert.equal(new Set(stored.map((item) => favouriteKey(item))).size, 2);
  });

  it('does not stamp a revision — a favourite is a location, not a version', () => {
    renderStep();
    click(star('Add favourite: tower.ifc'));
    const [stored] = loadFavourites(PROVIDER);
    assert.equal(
      Object.values(stored ?? {}).includes('rev-1'),
      false,
      'pinning a revision would poison the loaded/update-available status',
    );
  });
});

describe('two accounts sharing one browser profile', () => {
  it("shows account A's favourite as unstarred to account B, and B's press adds rather than deletes", () => {
    // A and B are the same provider in the same browser profile, so they share
    // one favourites blob and receive the same provider-side folder id. Only
    // the identity stamp tells their records apart.
    saveFavourites(PROVIDER, [
      {
        providerId: PROVIDER,
        kind: 'folder',
        projectId: project.id,
        projectName: project.name,
        fileAreaId: fileArea.id,
        fileAreaName: fileArea.name,
        containerId: folder.id,
        containerName: folder.name,
        identityId: 'user-a',
        addedAt: 1_000,
      },
    ]);
    syncSourceCatalogCacheOwner(PROVIDER, 'user-b');

    renderStep();

    const add = star('Add favourite: Models');
    assert.equal(
      add.getAttribute('aria-pressed'),
      'false',
      "B never starred this folder, so it cannot render starred to B",
    );

    click(add);

    assert.deepStrictEqual(
      loadFavourites(PROVIDER).map((item) => item.identityId).sort(),
      ['user-a', 'user-b'],
      "B's press must add B's own record and leave A's alone",
    );
    assert.equal(star('Remove favourite: Models').getAttribute('aria-pressed'), 'true');
  });
});
