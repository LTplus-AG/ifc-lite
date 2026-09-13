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
import { LEGACY_ROOM_SLOT, pathInRoomSlot, roomModelIdFor, roomModelNameFor, roomSlotPath, roomSlotRef } from './model-slot-ref.js';

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

  it('builds the same GlobalId path for every slot', () => {
    const guid = '0aBcDeFgHiJkLmNoPqRsT1';
    for (const [ref, runtime] of [
      [roomSlotRef(0), modelSlotRef('m0')],
      [roomSlotRef(7), modelSlotRef('m7')],
      [LEGACY_ROOM_SLOT, legacyModelSlot()],
    ] as const) {
      assert.equal(roomSlotPath(ref, guid), slotPath(runtime, guid));
      assert.ok(pathInRoomSlot(ref, roomSlotPath(ref, guid)));
    }
    assert.equal(roomSlotPath(roomSlotRef(1), guid), '/m1/0aBcDeFgHiJkLmNoPqRsT1');
    assert.equal(roomSlotPath(LEGACY_ROOM_SLOT, guid), '/0aBcDeFgHiJkLmNoPqRsT1');
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

  it('suffixes a recipient model name only when another slot carries the same one', () => {
    const twoCopies = [
      { slotId: 'm0', name: 'AC20-FZK-Haus.ifc' },
      { slotId: 'm1', name: 'site.ifc' },
      { slotId: 'm2', name: 'AC20-FZK-Haus.ifc' },
      { slotId: 'm3', name: 'AC20-FZK-Haus.ifc' },
    ];
    assert.equal(roomModelNameFor(twoCopies, 'm0'), 'AC20-FZK-Haus.ifc', 'the first keeps the owner name');
    assert.equal(roomModelNameFor(twoCopies, 'm1'), 'site.ifc', 'a unique name is untouched');
    assert.equal(roomModelNameFor(twoCopies, 'm2'), 'AC20-FZK-Haus.ifc (2)');
    assert.equal(roomModelNameFor(twoCopies, 'm3'), 'AC20-FZK-Haus.ifc (3)');
    assert.equal(roomModelNameFor(twoCopies, 'm9'), 'm9', 'an unknown slot falls back to its id');
  });
});
