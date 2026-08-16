/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The quick-access list. What matters is not that rows render but that the
 * right rows render and that a click hands the panel an address it can
 * actually re-open, so every test here clicks or asserts on absence:
 *
 * - another account's favourites are not on screen, and are still in storage;
 * - a provider this build no longer registers renders DISABLED rather than
 *   vanishing, because dropping bookmarks on a plugin change is worse than
 *   showing a dead one;
 * - a preference-auth provider missing its required settings is disabled with
 *   the same wording the provider row uses, so the two cannot disagree;
 * - clicking a row emits the stored favourite verbatim;
 * - the X removes exactly that row from storage.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
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
import { SourceHost } from '@/services/sources/source-host';
import { saveFavourites, loadFavourites, type SourceFavourite } from '@/lib/sources/favourites';
import { syncSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import { saveSourcePrefs } from '@/lib/sources/preferences';
import { SourceFavouritesList } from './SourceFavouritesList.js';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'fixture-provider',
    title: 'Fixture Provider',
    api: '^2.0.0',
    permissions: { network: [] },
    auth: 'preferences',
    preferences: [],
    capabilities: {
      containerListing: 'direct-children',
      listFilesIsRecursive: false,
      revisionHistory: false,
      downloadHistoricalRevisions: false,
      changeDetection: false,
      search: false,
    },
    contributes: { fileSources: [] },
    ...overrides,
  };
}

class FakeProvider implements FileSourceProvider {
  constructor(readonly manifest: PluginManifest) {}
  listProjects(): Promise<Page<SourceProject>> {
    return Promise.resolve({ items: [] });
  }
  listContainers(): Promise<Page<SourceContainer>> {
    return Promise.resolve({ items: [] });
  }
  listFiles(): Promise<Page<SourceFile>> {
    return Promise.resolve({ items: [] });
  }
  download(_ctx: PluginContext): Promise<ArrayBuffer> {
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
    addedAt: 1_000,
    ...overrides,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderList(host: SourceHost): { opened: SourceFavourite[]; rerender: () => void } {
  const opened: SourceFavourite[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let version = 0;

  const paint = () => {
    act(() => {
      root.render(
        <SourceFavouritesList
          sourceHost={host}
          favouritesVersion={version}
          identityVersion={0}
          onOpen={(item) => opened.push(item)}
          onChanged={() => {
            version += 1;
            paint();
          }}
        />,
      );
    });
  };
  paint();
  mounted.push({ root, container });

  return {
    opened,
    rerender: () => {
      version += 1;
      paint();
    },
  };
}

function rowButton(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

function removeButton(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  );
  assert.ok(found, `a button labelled "${label}" must render`);
  return found as HTMLButtonElement;
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

describe('SourceFavouritesList — what is shown', () => {
  it('renders nothing at all when there are no favourites', () => {
    const host = new SourceHost();
    host.register(new FakeProvider(manifest()));
    renderList(host);
    assert.equal(document.body.textContent?.includes('Favourites'), false);
  });

  it('opens a favourite by handing back the stored address', () => {
    const host = new SourceHost();
    host.register(new FakeProvider(manifest()));
    saveFavourites('fixture-provider', [favourite()]);

    const { opened } = renderList(host);
    const row = rowButton('Models');
    assert.ok(row, 'the favourite must render a clickable row');
    act(() => {
      row.click();
    });

    assert.equal(opened.length, 1);
    assert.deepStrictEqual(opened[0], favourite());
  });

  it('labels a row with its provider, project and file area so two sources can be told apart', () => {
    const host = new SourceHost();
    host.register(new FakeProvider(manifest()));
    saveFavourites('fixture-provider', [favourite()]);
    renderList(host);
    assert.ok(
      document.body.textContent?.includes('Fixture Provider / Tower Project / Documents'),
      'the sub-line must carry the full source path',
    );
  });

  it('removes exactly the clicked row from storage', () => {
    const host = new SourceHost();
    host.register(new FakeProvider(manifest()));
    saveFavourites('fixture-provider', [
      favourite({ containerId: 'folder-1', containerName: 'Models', addedAt: 2 }),
      favourite({ containerId: 'folder-2', containerName: 'Drawings', addedAt: 1 }),
    ]);
    renderList(host);

    act(() => {
      removeButton('Remove favourite: Models').click();
    });

    assert.deepStrictEqual(
      loadFavourites('fixture-provider').map((item) => item.containerName),
      ['Drawings'],
    );
    assert.equal(rowButton('Models'), undefined, 'the removed row must leave the screen');
  });
});

describe('SourceFavouritesList — identity scoping', () => {
  it("hides another identity's favourites while leaving them in storage", () => {
    const host = new SourceHost();
    host.register(new FakeProvider(manifest({ auth: 'interactive' })));
    // The provider is signed in as user-a.
    syncSourceCatalogCacheOwner('fixture-provider', 'user-a');
    saveFavourites('fixture-provider', [
      favourite({ identityId: 'user-a', containerName: 'Mine' }),
      favourite({ identityId: 'user-b', containerId: 'folder-2', containerName: 'Theirs' }),
    ]);

    renderList(host);

    assert.ok(rowButton('Mine'), "the signed-in identity's favourite must render");
    assert.equal(rowButton('Theirs'), undefined, "another identity's favourite must not render");
    assert.equal(loadFavourites('fixture-provider').length, 2, 'nothing is deleted by the filter');
  });
});

describe('SourceFavouritesList — providers that cannot be browsed', () => {
  it('renders a favourite for an unregistered provider disabled rather than dropping it', () => {
    // Nothing registered: the plugin was removed, or failed to register.
    const host = new SourceHost();
    saveFavourites('retired-provider', [favourite({ providerId: 'retired-provider' })]);

    const { opened } = renderList(host);
    const row = rowButton('Models');
    assert.ok(row, 'a bookmark must never vanish because a build dropped its provider');
    assert.equal(row.disabled, true);
    assert.ok(document.body.textContent?.includes('Provider unavailable'));

    act(() => {
      row.click();
    });
    assert.equal(opened.length, 0, 'a disabled row must not navigate anywhere');
  });

  it('disables a preference-auth provider that is missing a required setting', () => {
    const host = new SourceHost();
    host.register(
      new FakeProvider(
        manifest({
          preferences: [{ name: 'apiKey', title: 'API key', type: 'password', required: true }],
        }),
      ),
    );
    saveFavourites('fixture-provider', [favourite()]);

    renderList(host);
    const row = rowButton('Models');
    assert.ok(row);
    assert.equal(row.disabled, true);
    assert.ok(document.body.textContent?.includes('Add the required settings to browse'));
  });

  it('enables the row once the required setting is saved', () => {
    const host = new SourceHost();
    host.register(
      new FakeProvider(
        manifest({
          preferences: [{ name: 'apiKey', title: 'API key', type: 'password', required: true }],
        }),
      ),
    );
    saveFavourites('fixture-provider', [favourite()]);
    const handle = renderList(host);

    saveSourcePrefs('fixture-provider', { apiKey: 'secret' });
    handle.rerender();

    const row = rowButton('Models');
    assert.ok(row);
    assert.equal(row.disabled, false);
  });
});
