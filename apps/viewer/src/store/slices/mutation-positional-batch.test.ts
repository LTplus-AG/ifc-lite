/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A positional batch is ONE store update and ONE undo step (#6232 perf):
 * a wall resize writes four slots, and each used to be its own notification.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { WALL, WALL_UNITS, seedRectangleWall } from '@/test/rectangle-wall-fixture';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';

const store = () => useViewerStore.getState();

describe('setPositionalAttributesBatch (#6232)', () => {
  beforeEach(async () => {
    // The re-mesh this resize asks for never answers: only the commit is measured.
    setRemeshClientFactory(() => new Promise(() => {}));
    await seedRectangleWall(WALL_UNITS[0].unit, WALL_UNITS[0].scale);
  });
  afterEach(() => setRemeshClientFactory(null));

  it('notifies subscribers once and undoes as one step', () => {
    let notifications = 0;
    const unsubscribe = useViewerStore.subscribe(() => { notifications++; });
    const before = store().readWallEndpoints('ifc', WALL);
    assert.ok(store().resizeWall('ifc', WALL, [2, 1, 0], [9, 1, 0]).ok);
    unsubscribe();
    assert.equal(notifications, 1, 'one store notification for the four slot writes');
    assert.equal(store().undoStacks.get('ifc')!.length, 4);
    assert.equal(new Set(store().undoStacks.get('ifc')!.map((m) => store().mutationBatchTags.get(m.id))).size, 1);
    store().undo('ifc');
    assert.equal(store().undoStacks.get('ifc')!.length, 0);
    assert.deepEqual(store().readWallEndpoints('ifc', WALL)?.end, before?.end);
  });
});
