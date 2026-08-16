/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Favourites storage. Four properties are pinned because each one is a way the
 * feature can look fine and be wrong:
 *
 * 1. A favourite survives a round trip through `localStorage` with the whole
 *    addressing tuple intact — an id dropped in the blob is a bookmark that
 *    opens the wrong folder, or nothing.
 * 2. One malformed record drops out on its own, rather than taking every other
 *    bookmark with it. `localStorage` outlives app versions.
 * 3. A refused write (quota, private mode) is REPORTED. Unlike the caches in
 *    `persistence.ts` this is a user gesture, so failing silently would leave a
 *    star that looks set and is not.
 * 4. The owner stamp hides another account's bookmarks without deleting them,
 *    which is the whole point of stamping rather than clearing on sign-out.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAVOURITES_KEY_PREFIX,
  favouriteKey,
  isFavourited,
  listFavouriteProviderIds,
  loadFavourites,
  MAX_FAVOURITES_PER_PROVIDER,
  removeFavourite,
  renameFavourite,
  saveFavourites,
  toggleFavourite,
  visibleFavourites,
  type SourceFavourite,
} from './favourites.js';
import { clearAllSourceData } from './persistence.js';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  /** When true, every write throws like a QuotaExceededError would. */
  failWrites = false;

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    }
    this.map.set(key, value);
  }
}

const localStorageMock = new MemoryStorage();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

function folderFavourite(overrides: Partial<SourceFavourite> = {}): SourceFavourite {
  return {
    providerId: 'dropbox',
    kind: 'folder',
    projectId: 'me',
    projectName: 'My Dropbox',
    fileAreaId: 'id:area',
    fileAreaName: 'Documents',
    containerId: 'id:folder',
    containerName: 'Models',
    identityId: 'user-a',
    addedAt: 1_000,
    ...overrides,
  };
}

function fileFavourite(overrides: Partial<SourceFavourite> = {}): SourceFavourite {
  return folderFavourite({
    kind: 'file',
    containerId: 'id:folder',
    containerName: 'Models',
    fileId: 'id:file',
    fileName: 'tower.ifc',
    addedAt: 2_000,
    ...overrides,
  });
}

beforeEach(() => {
  localStorageMock.clear();
  localStorageMock.failWrites = false;
});

describe('favourites round trip', () => {
  it('restores every addressing field a re-entry needs', () => {
    const favourite = fileFavourite();
    assert.equal(saveFavourites('dropbox', [favourite]), true);

    const [restored] = loadFavourites('dropbox');
    assert.deepStrictEqual(restored, favourite);
  });

  it('returns favourites newest first, whatever order they were written in', () => {
    saveFavourites('dropbox', [
      folderFavourite({ containerId: 'a', addedAt: 1 }),
      folderFavourite({ containerId: 'b', addedAt: 3 }),
      folderFavourite({ containerId: 'c', addedAt: 2 }),
    ]);
    assert.deepStrictEqual(
      loadFavourites('dropbox').map((item) => item.containerId),
      ['b', 'c', 'a'],
    );
  });

  it('toggles a favourite off and on again, and reports which happened', () => {
    const favourite = folderFavourite();
    const added = toggleFavourite(favourite);
    assert.equal(added.added, true);
    assert.equal(added.ok, true);
    assert.equal(isFavourited(loadFavourites('dropbox'), favouriteKey(favourite)), true);

    const removed = toggleFavourite(favourite);
    assert.equal(removed.added, false);
    assert.equal(removed.ok, true);
    assert.deepStrictEqual(loadFavourites('dropbox'), []);
  });

  it('scopes the key by provider, so the same file in two sources is two favourites', () => {
    const dropbox = fileFavourite();
    const msgraph = fileFavourite({ providerId: 'msgraph-onedrive' });
    assert.notEqual(favouriteKey(dropbox), favouriteKey(msgraph));

    toggleFavourite(dropbox);
    toggleFavourite(msgraph);
    assert.equal(loadFavourites('dropbox').length, 1);
    assert.equal(loadFavourites('msgraph-onedrive').length, 1);
  });

  it('removes by key and leaves the rest', () => {
    const keep = folderFavourite({ containerId: 'keep' });
    const drop = folderFavourite({ containerId: 'drop' });
    saveFavourites('dropbox', [keep, drop]);

    const remaining = removeFavourite('dropbox', favouriteKey(drop));
    assert.deepStrictEqual(remaining.map((item) => item.containerId), ['keep']);
    assert.deepStrictEqual(loadFavourites('dropbox').map((item) => item.containerId), ['keep']);
  });

  it('renames a stale label without changing the key that addresses it', () => {
    const favourite = folderFavourite();
    saveFavourites('dropbox', [favourite]);
    const key = favouriteKey(favourite);

    const next = renameFavourite('dropbox', key, 'Models (2026)');
    assert.equal(next[0]?.containerName, 'Models (2026)');
    assert.equal(favouriteKey(next[0]!), key, 'a rename must not re-address the favourite');
    assert.equal(loadFavourites('dropbox')[0]?.containerName, 'Models (2026)');
  });

  it('renames a favourited file by its file name, not its folder name', () => {
    const favourite = fileFavourite();
    saveFavourites('dropbox', [favourite]);
    const next = renameFavourite('dropbox', favouriteKey(favourite), 'tower-rev-b.ifc');
    assert.equal(next[0]?.fileName, 'tower-rev-b.ifc');
    assert.equal(next[0]?.containerName, 'Models');
  });

  it('lists provider ids from storage, including providers this build does not register', () => {
    saveFavourites('dropbox', [folderFavourite()]);
    saveFavourites('retired-provider', [folderFavourite({ providerId: 'retired-provider' })]);
    assert.deepStrictEqual(listFavouriteProviderIds(), ['dropbox', 'retired-provider']);
  });
});

describe('favourites validation', () => {
  it('drops one malformed record and keeps the rest', () => {
    localStorage.setItem(
      `${FAVOURITES_KEY_PREFIX}dropbox`,
      JSON.stringify({
        version: 1,
        providerId: 'dropbox',
        items: [
          folderFavourite({ containerId: 'good' }),
          // A file favourite with no fileId cannot be re-opened.
          { ...fileFavourite(), fileId: undefined },
          // Written by a build that had no fileAreaId; re-entry is impossible.
          { ...folderFavourite({ containerId: 'legacy' }), fileAreaId: undefined },
        ],
      }),
    );
    assert.deepStrictEqual(
      loadFavourites('dropbox').map((item) => item.containerId),
      ['good'],
    );
  });

  it('ignores a blob written under a different version', () => {
    localStorage.setItem(
      `${FAVOURITES_KEY_PREFIX}dropbox`,
      JSON.stringify({ version: 99, providerId: 'dropbox', items: [folderFavourite()] }),
    );
    assert.deepStrictEqual(loadFavourites('dropbox'), []);
  });

  it('ignores records stamped with a different provider than the key they sit under', () => {
    localStorage.setItem(
      `${FAVOURITES_KEY_PREFIX}dropbox`,
      JSON.stringify({
        version: 1,
        providerId: 'dropbox',
        items: [folderFavourite({ providerId: 'msgraph-onedrive' })],
      }),
    );
    assert.deepStrictEqual(loadFavourites('dropbox'), []);
  });

  it('survives unparseable JSON', () => {
    localStorage.setItem(`${FAVOURITES_KEY_PREFIX}dropbox`, '{not json');
    assert.deepStrictEqual(loadFavourites('dropbox'), []);
  });
});

describe('favourites refusals are reported, never silent', () => {
  it('reports a failed write and does not pretend the favourite was added', () => {
    localStorageMock.failWrites = true;
    const result = toggleFavourite(folderFavourite());
    assert.equal(result.ok, false);
    assert.equal(result.added, false);
    assert.equal(result.reason, 'storage');
    assert.deepStrictEqual(result.items, [], 'the caller must not be handed an optimistic list');
  });

  it('refuses past the per-provider cap instead of growing the blob', () => {
    const items = Array.from({ length: MAX_FAVOURITES_PER_PROVIDER }, (_unused, index) =>
      folderFavourite({ containerId: `folder-${index}`, addedAt: index }),
    );
    saveFavourites('dropbox', items);

    const result = toggleFavourite(folderFavourite({ containerId: 'one-too-many' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'cap');
    assert.equal(loadFavourites('dropbox').length, MAX_FAVOURITES_PER_PROVIDER);
  });

  it('still allows removing when the list sits exactly on the cap', () => {
    const items = Array.from({ length: MAX_FAVOURITES_PER_PROVIDER }, (_unused, index) =>
      folderFavourite({ containerId: `folder-${index}`, addedAt: index }),
    );
    saveFavourites('dropbox', items);

    const result = toggleFavourite(folderFavourite({ containerId: 'folder-0', addedAt: 0 }));
    assert.equal(result.ok, true);
    assert.equal(result.added, false);
    assert.equal(loadFavourites('dropbox').length, MAX_FAVOURITES_PER_PROVIDER - 1);
  });
});

describe('favourites identity stamping', () => {
  it('hides another identity\'s favourites without deleting them', () => {
    const mine = folderFavourite({ identityId: 'user-a', containerId: 'mine' });
    const theirs = folderFavourite({ identityId: 'user-b', containerId: 'theirs' });
    saveFavourites('dropbox', [mine, theirs]);

    assert.deepStrictEqual(
      visibleFavourites(loadFavourites('dropbox'), 'user-a').map((item) => item.containerId),
      ['mine'],
    );
    // Signed out: an interactive provider shows nothing, and nothing is lost.
    assert.deepStrictEqual(visibleFavourites(loadFavourites('dropbox'), null), []);
    assert.equal(loadFavourites('dropbox').length, 2, 'storage must survive the filter');
  });

  it('shows a preference-auth provider\'s null-stamped favourites', () => {
    const dalux = folderFavourite({ providerId: 'dalux-build', identityId: null });
    saveFavourites('dalux-build', [dalux]);
    assert.equal(visibleFavourites(loadFavourites('dalux-build'), null).length, 1);
  });
});

describe('forget saved values sweeps favourites', () => {
  it('removes the favourites key for that provider only', () => {
    saveFavourites('dalux-build', [folderFavourite({ providerId: 'dalux-build' })]);
    saveFavourites('dropbox', [folderFavourite()]);

    clearAllSourceData('dalux-build');

    assert.deepStrictEqual(loadFavourites('dalux-build'), []);
    assert.equal(loadFavourites('dropbox').length, 1, "another provider's favourites must survive");
  });
});
