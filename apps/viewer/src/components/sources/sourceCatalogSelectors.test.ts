/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PagedItems } from './sourceCatalogPaging';
import {
  collectUniqueById,
  isCatalogComplete,
  pageHasMore,
  resolveCatalogKey,
} from './sourceCatalogSelectors';

const area = { projectId: 'p1', fileAreaId: 'fa1' };

function page<T>(items: readonly T[], cursor?: string): PagedItems<T> {
  return { items, cursor };
}

describe('sourceCatalogSelectors', () => {
  it('keys area-wide listings by the file area and per-container ones by the selection', () => {
    // Area-keyed (flat-subtree folders, recursive files): the selected folder
    // must not become the key, or "Load more" would page a listing that was
    // never fetched under that key.
    assert.equal(resolveCatalogKey(area, 'folder-a', true), 'fa1');
    assert.equal(resolveCatalogKey(area, null, true), 'fa1');

    // Per-container: the selection is the key, falling back to the area root.
    assert.equal(resolveCatalogKey(area, 'folder-a', false), 'folder-a');
    assert.equal(resolveCatalogKey(area, null, false), 'fa1');

    // No area open yet — nothing is keyed.
    assert.equal(resolveCatalogKey(null, 'folder-a', false), null);
  });

  it('treats an empty catalog as incomplete and any outstanding cursor as incomplete', () => {
    const empty = new Map<string, PagedItems<unknown>>();

    // Nothing fetched yet must NOT read as complete: the folder-is-empty UI
    // gate would otherwise fire before the first listing lands.
    assert.equal(isCatalogComplete(empty, empty), false);

    assert.equal(isCatalogComplete(new Map([['fa1', page([{ id: 'a' }])]]), empty), true);
    assert.equal(isCatalogComplete(empty, new Map([['fa1', page([{ id: 'f' }])]])), true);

    // A cursor on either side means more is outstanding.
    assert.equal(isCatalogComplete(new Map([['fa1', page([], 'next')]]), empty), false);
    assert.equal(
      isCatalogComplete(new Map([['fa1', page([])]]), new Map([['fa1', page([], 'next')]])),
      false,
    );
  });

  it('dedupes entities reached through more than one page, last write winning', () => {
    const pages = [
      page([{ id: 'a', name: 'stale' }, { id: 'b', name: 'b' }]),
      page([{ id: 'a', name: 'fresh' }]),
    ];

    assert.deepEqual(collectUniqueById(pages), [{ id: 'a', name: 'fresh' }, { id: 'b', name: 'b' }]);
  });

  it('reports more pages only for a fetched key with an outstanding cursor', () => {
    const pages = new Map<string, PagedItems<unknown>>([
      ['fa1', page([], 'next')],
      ['folder-a', page([])],
    ]);

    assert.equal(pageHasMore(pages, 'fa1'), true);
    assert.equal(pageHasMore(pages, 'folder-a'), false);
    assert.equal(pageHasMore(pages, 'never-fetched'), false);
    assert.equal(pageHasMore(pages, null), false);
  });
});
