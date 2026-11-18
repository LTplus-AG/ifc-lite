/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEntityVisible } from './entity-visibility.js';
import { EntityVisibilityCache, FrameEntityVisibility, entityVisibilityImage, entityVisibleInImage } from './entity-visibility-table.js';

// #10264 S1/S2: the batch pick pass and partly visible colour/shadow draws
// draw whole batches and decide hide/isolate per fragment from this table, so it
// must answer exactly as isEntityVisible.
describe('entity visibility table (#10264)', () => {
  const ids = [0, 1, 7, 42, 99, 1000, 0x00FFFFFF, 0x01000000, 0x3FFFFFFF, 0xFFFFFFFE];
  const cases: Array<[string, Set<number> | undefined, Set<number> | null | undefined]> = [
    ['no filters', undefined, undefined],
    ['hidden only', new Set([7, 1000, 0x01000000]), null],
    ['isolation only', undefined, new Set([42, 99, 0x3FFFFFFF])],
    ['hiding wins over isolation', new Set([42]), new Set([42, 99])],
    ['empty isolation hides everything', new Set(), new Set()],
    ['empty hidden set hides nothing', new Set(), undefined],
  ];
  for (const [name, hidden, isolated] of cases) {
    it(`matches isEntityVisible: ${name}`, () => {
      const image = entityVisibilityImage(hidden, isolated);
      for (const id of ids) {
        assert.equal(entityVisibleInImage(image, id), isEntityVisible(id, hidden, isolated), `id ${id}`);
      }
    });
  }

  it('sorts ids numerically, not as strings, so the binary search finds them', () => {
    const hidden = new Set([100, 9, 20, 3]);
    const image = entityVisibilityImage(hidden, null);
    assert.deepEqual([...image.subarray(4)], [3, 9, 20, 100]);
    for (const id of hidden) assert.equal(entityVisibleInImage(image, id), false);
  });

  it('reuses the image for unchanged sets and rebuilds it after an in-place edit', () => {
    const cache = new EntityVisibilityCache();
    const hidden = new Set([5, 6]);
    const first = cache.resolve(hidden, null);
    assert.equal(cache.resolve(hidden, null), first, 'hover picks reuse the sorted table');
    hidden.delete(6);
    hidden.add(8);
    const edited = cache.resolve(hidden, null);
    assert.notEqual(edited, first, 'same size, different ids: must not reuse');
    assert.equal(entityVisibleInImage(edited, 6), true);
    assert.equal(entityVisibleInImage(edited, 8), false);
    assert.notEqual(cache.resolve(hidden, new Set([5])), edited, 'isolation switching on is a change');
    assert.notEqual(cache.resolve(hidden, null), edited, 'and switching it off again too');
  });
});

describe('FrameEntityVisibility redraws once when a pending table is confirmed (#10636)', () => {
  const table = (pending: Promise<boolean> | null) => ({ visibilityPending: pending, writeVisibility: () => false });
  const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

  it('requests one render per confirmed growth, however many frames waited on it', async () => {
    const frame = new FrameEntityVisibility();
    let renders = 0;
    let confirm!: (ready: boolean) => void;
    const pending = new Promise<boolean>(resolve => { confirm = resolve; });
    for (let i = 0; i < 3; i++) assert.equal(frame.write(table(pending), 1, new Set([1]), null, () => renders++), false);
    confirm(true); await flush();
    assert.equal(renders, 1);
  });

  it('requests nothing for a rejected growth or a table that cannot grow', async () => {
    const frame = new FrameEntityVisibility();
    let renders = 0;
    frame.write(table(Promise.resolve(false)), 1, new Set([1]), null, () => renders++);
    frame.write(table(null), 1, new Set([1]), null, () => renders++);
    await flush();
    assert.equal(renders, 0);
  });
});
