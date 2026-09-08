/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { SourceFile, SourceTag } from '@ifc-lite/plugin-api';
import {
  clearAllSourceData,
  getDownloadedSourceFileRecord,
  getDownloadedSourceFileStatus,
  loadDownloadedSourceFileRecords,
  loadRevisionWatchCursor,
  loadSourceCatalogCache,
  makeDownloadedSourceFileKey,
  recordDownloadedSourceFile,
  saveRevisionWatchCursor,
  saveSourceCatalogCache,
  syncSourceCatalogCacheOwner,
} from './persistence.js';
import { saveSourcePrefs, loadSavedSourcePrefs } from './preferences.js';
import { loadFavourites, saveFavourites } from './favourites.js';

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

const sourceFile: SourceFile = {
  id: 'file-1',
  name: 'Model.ifc',
  containerId: 'folder-1',
  currentRevisionId: 'rev-3',
  sizeBytes: 512,
};
const tag: SourceTag = {
  provider: 'dalux-build',
  projectId: 'project-1',
  containerId: 'folder-1',
  fileId: 'file-1',
  revisionId: 'rev-3',
  loadedAt: 123,
};

describe('source persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorageMock.failWrites = false;
  });

  it('round-trips a cached file-area catalog', () => {
    const saved = saveSourceCatalogCache(
      'dalux-build',
      'project-1',
      'file-area-1',
      [{ id: 'folder-1', name: 'Folder A', parentId: 'file-area-1' }],
      [sourceFile],
    );

    const loaded = loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1');
    assert.deepStrictEqual(loaded, saved);
  });

  it('stores downloaded source-file metadata keyed by provider, project, and file', () => {
    const record = recordDownloadedSourceFile(tag, sourceFile);
    const records = loadDownloadedSourceFileRecords();

    assert.deepStrictEqual(
      records.get(makeDownloadedSourceFileKey('dalux-build', 'project-1', 'file-1')),
      record,
    );
    assert.deepStrictEqual(
      getDownloadedSourceFileRecord(records, 'dalux-build', 'project-1', 'file-1'),
      record,
    );
  });

  it('flags downloaded files orange when the source exposes a newer revision', () => {
    const newer: SourceFile = { ...sourceFile, currentRevisionId: 'rev-4' };

    assert.strictEqual(getDownloadedSourceFileStatus(newer), 'never-loaded');
    assert.strictEqual(
      getDownloadedSourceFileStatus(newer, {
        providerId: 'dalux-build',
        projectId: 'project-1',
        containerId: 'folder-1',
        fileId: 'file-1',
        name: 'Model.ifc',
        loadedRevisionId: 'rev-4',
        loadedAt: 123,
      }),
      'loaded-current',
    );
    assert.strictEqual(
      getDownloadedSourceFileStatus(newer, {
        providerId: 'dalux-build',
        projectId: 'project-1',
        containerId: 'folder-1',
        fileId: 'file-1',
        name: 'Model.ifc',
        loadedRevisionId: 'rev-3',
        loadedAt: 123,
      }),
      'update-available',
    );
  });

  it('degrades to best-effort when localStorage writes fail (quota)', () => {
    localStorageMock.failWrites = true;

    // Neither call may throw — persistence is an optimisation, not load-bearing.
    const record = recordDownloadedSourceFile(tag, sourceFile);
    assert.strictEqual(record.fileId, 'file-1');

    const entry = saveSourceCatalogCache('dalux-build', 'project-1', 'file-area-1', [], []);
    assert.strictEqual(entry.providerId, 'dalux-build');

    saveRevisionWatchCursor('dalux-build', 'project-1', 'cursor-1');
    assert.strictEqual(loadRevisionWatchCursor('dalux-build', 'project-1'), undefined);
  });

  it('round-trips and clears the revision-watch cursor', () => {
    saveRevisionWatchCursor('dalux-build', 'project-1', 'cursor-1');
    assert.strictEqual(loadRevisionWatchCursor('dalux-build', 'project-1'), 'cursor-1');

    saveRevisionWatchCursor('dalux-build', 'project-1', undefined);
    assert.strictEqual(loadRevisionWatchCursor('dalux-build', 'project-1'), undefined);
  });

  it('clearAllSourceData sweeps every prefix the feature owns for one provider', () => {
    saveSourcePrefs('dalux-build', { apiKey: 'secret' });
    saveSourceCatalogCache('dalux-build', 'project-1', 'file-area-1', [], [sourceFile]);
    recordDownloadedSourceFile(tag, sourceFile);
    saveRevisionWatchCursor('dalux-build', 'project-1', 'cursor-1');
    // Provider ctx.storage namespace (mirrors host-storage's prefix).
    localStorage.setItem('ifc-lite-source:dalux-build:rev:p:a:f', 'rev-3');
    // Favourites carry folder and file NAMES, so the sweep has to take them.
    saveFavourites('dalux-build', [
      {
        providerId: 'dalux-build',
        kind: 'folder',
        projectId: 'project-1',
        projectName: 'Project 1',
        fileAreaId: 'file-area-1',
        fileAreaName: 'Documents',
        containerId: 'folder-1',
        containerName: 'Models',
        identityId: null,
        addedAt: 1,
      },
    ]);
    // Another provider's data must survive the sweep.
    saveSourcePrefs('other-provider', { apiKey: 'keep' });
    recordDownloadedSourceFile(
      { ...tag, provider: 'other-provider' },
      sourceFile,
    );

    clearAllSourceData('dalux-build');

    assert.deepStrictEqual(loadSavedSourcePrefs('dalux-build'), {});
    assert.strictEqual(loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1'), null);
    assert.strictEqual(loadRevisionWatchCursor('dalux-build', 'project-1'), undefined);
    assert.strictEqual(localStorage.getItem('ifc-lite-source:dalux-build:rev:p:a:f'), null);
    assert.deepStrictEqual(loadFavourites('dalux-build'), []);
    const records = loadDownloadedSourceFileRecords();
    assert.strictEqual(
      getDownloadedSourceFileRecord(records, 'dalux-build', 'project-1', 'file-1'),
      undefined,
    );
    assert.deepStrictEqual(loadSavedSourcePrefs('other-provider'), { apiKey: 'keep' });
    assert.notStrictEqual(
      getDownloadedSourceFileRecord(records, 'other-provider', 'project-1', 'file-1'),
      undefined,
    );
  });
});

describe('catalog cache identity scoping', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorageMock.failWrites = false;
  });

  const folders = [{ id: 'folder-1', name: 'Confidential Project A', parentId: 'file-area-1' }];

  /** Populate a catalog cache as `identityId` and return the localStorage key it lives under. */
  function seedCacheAs(identityId: string): void {
    syncSourceCatalogCacheOwner('dalux-build', identityId);
    saveSourceCatalogCache('dalux-build', 'project-1', 'file-area-1', folders, []);
  }

  it('drops a catalog populated by a DIFFERENT identity', () => {
    seedCacheAs('alice@example.com');
    assert.ok(loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1'));

    const dropped = syncSourceCatalogCacheOwner('dalux-build', 'bob@example.com');

    assert.strictEqual(dropped, true);
    assert.strictEqual(loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1'), null);
  });

  it('keeps the catalog for the SAME identity, so a re-sign-in is not a forced refetch', () => {
    seedCacheAs('alice@example.com');

    const dropped = syncSourceCatalogCacheOwner('dalux-build', 'alice@example.com');

    assert.strictEqual(dropped, false);
    assert.ok(loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1'));
  });

  it('drops the catalog when the identity goes away (failed restore / signed out)', () => {
    seedCacheAs('alice@example.com');

    assert.strictEqual(syncSourceCatalogCacheOwner('dalux-build', null), true);
    assert.strictEqual(loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1'), null);
  });

  it('remembers the owner across a reload, which is the whole point', () => {
    // The cache lives in localStorage and outlives the tab; the owning identity
    // used to live only in React state, so a new session could not tell whose
    // catalog it was holding. Simulate the reload by discarding every in-memory
    // reference and going back to storage cold.
    seedCacheAs('alice@example.com');

    // No React state, no module state — exactly what a fresh page load has.
    const dropped = syncSourceCatalogCacheOwner('dalux-build', 'bob@example.com');

    assert.strictEqual(dropped, true, 'a new session must still know the cache was not bob\'s');
    assert.strictEqual(loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1'), null);
  });

  it('scopes the drop to one provider', () => {
    syncSourceCatalogCacheOwner('dalux-build', 'alice@example.com');
    saveSourceCatalogCache('dalux-build', 'project-1', 'file-area-1', folders, []);
    syncSourceCatalogCacheOwner('sharepoint', 'alice@example.com');
    saveSourceCatalogCache('sharepoint', 'project-1', 'file-area-1', folders, []);

    syncSourceCatalogCacheOwner('dalux-build', 'bob@example.com');

    assert.strictEqual(loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1'), null);
    assert.ok(
      loadSourceCatalogCache('sharepoint', 'project-1', 'file-area-1'),
      'the other provider\'s cache belongs to alice still and must survive',
    );
  });

  it('clearAllSourceData forgets the owner too, so the next identity is not compared to a ghost', () => {
    seedCacheAs('alice@example.com');

    clearAllSourceData('dalux-build');

    // With the owner gone, alice signing back in is treated as a new owner and
    // gets a clean fetch — never a hit on a catalog that was swept.
    assert.strictEqual(syncSourceCatalogCacheOwner('dalux-build', 'alice@example.com'), true);
  });
});
