/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dropPartialCacheForBatch, type PartialBatchCaches } from './partial-batch-cache.js';
import type { BatchedMesh } from './types.js';

function clone(): BatchedMesh & { destroyed: number } {
  const c = { destroyed: 0 } as unknown as BatchedMesh & { destroyed: number };
  const buffer = { destroy: () => { c.destroyed++; } };
  Object.assign(c, { vertexBuffer: buffer, indexBuffer: { destroy() {} }, uniformBuffer: { destroy() {} } });
  return c;
}

describe('dropPartialCacheForBatch (#9050 review)', () => {
  it('drops only the slots of that batch id, not of an id it prefixes', () => {
    const caches: PartialBatchCaches = { batches: new Map(), keys: new Map(), versions: new Map() };
    const slots = { 'c:12': clone(), 'c:12:promoted': clone(), 'c:12:x0': clone(), 'c:125': clone(), 'c:125:x0': clone() };
    for (const [slot, c] of Object.entries(slots)) {
      caches.keys.set(slot, `${slot}:hash`);
      caches.batches.set(`${slot}:hash`, c);
      caches.versions.set(slot, 1);
    }
    dropPartialCacheForBatch(caches, { colorKey: 'c', id: 12 } as BatchedMesh);
    assert.deepEqual([...caches.keys.keys()].sort(), ['c:125', 'c:125:x0']);
    assert.deepEqual([...caches.versions.keys()].sort(), ['c:125', 'c:125:x0']);
    assert.deepEqual(Object.entries(slots).map(([k, c]) => [k, c.destroyed]),
      [['c:12', 1], ['c:12:promoted', 1], ['c:12:x0', 1], ['c:125', 0], ['c:125:x0', 0]]);
  });
});
