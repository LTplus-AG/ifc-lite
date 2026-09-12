/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's eager copy of the slot rules (`model-slot-ref.ts`) must agree
 * with the collab runtime's own (`@ifc-lite/collab` `model-slot.ts`), which
 * the viewer only ever lazy-loads. Pinned here against the real runtime so
 * the copy cannot drift (#4444).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { legacyModelSlot, modelSlotId, modelSlotRef, pathInSlot, slotPath } from '@ifc-lite/collab';
import { LEGACY_ROOM_SLOT, pathInRoomSlot, roomModelIdFor, roomSlotRef } from './model-slot-ref.js';

describe('model-slot-ref mirrors the collab runtime', () => {
  it('mints the same slot for the same seed index', () => {
    for (const i of [0, 1, 9, 10, 42]) {
      assert.deepEqual(roomSlotRef(i), modelSlotRef(modelSlotId(i)));
    }
  });

  it('the legacy slot has the same path prefix', () => {
    const runtime = legacyModelSlot();
    assert.equal(LEGACY_ROOM_SLOT.slotId, runtime.slotId);
    assert.equal(LEGACY_ROOM_SLOT.pathPrefix, runtime.pathPrefix);
  });

  it('agrees on slot membership for every path shape', () => {
    const guid = '0aBcDeFgHiJkLmNoPqRsT1';
    const paths = [
      slotPath(modelSlotRef('m0'), guid),
      slotPath(modelSlotRef('m1'), guid),
      slotPath(modelSlotRef('m10'), guid),
      slotPath(legacyModelSlot(), guid),
      '/m1/nested/ifcx/path',
      'bare-ifcx-path',
      '/m1',
    ];
    for (const slot of [roomSlotRef(0), roomSlotRef(1), roomSlotRef(10), LEGACY_ROOM_SLOT]) {
      for (const path of paths) {
        assert.equal(pathInRoomSlot(slot, path), pathInSlot(slot, path), `${slot.slotId} vs ${path}`);
      }
    }
  });

  it('names a recipient model by room and slot', () => {
    assert.equal(roomModelIdFor('r1', 'm1'), 'room:r1:m1');
  });
});
