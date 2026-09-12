/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which models an IFCX export un-homes from their room slot (#4444): the
 * recipient's reconstructed `room:<roomId>:<slotId>` models and nothing else.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_ROOM_SLOT, roomModelIdFor, roomSlotRef } from './model-slot-ref.js';
import { roomExportPathPrefix } from './room-export-paths.js';

describe('roomExportPathPrefix (#4444)', () => {
  it('names the slot prefix for a recipient room model, in every slot', () => {
    const roomId = 'ab12cd34ef56';
    const models = new Map([
      [roomModelIdFor(roomId, 'm0'), roomSlotRef(0)],
      [roomModelIdFor(roomId, 'm1'), roomSlotRef(1)],
      [roomModelIdFor(roomId, 'm10'), roomSlotRef(10)],
    ]);
    const state = { collabRoomId: roomId, collabRoomModels: models };
    assert.equal(roomExportPathPrefix(state, 'room:ab12cd34ef56:m0'), '/m0');
    assert.equal(roomExportPathPrefix(state, 'room:ab12cd34ef56:m1'), '/m1');
    assert.equal(roomExportPathPrefix(state, 'room:ab12cd34ef56:m10'), '/m10');
  });

  it("leaves an owner's own models alone even though they are in a room slot", () => {
    // The owner shared two files: the loader's ids, seeded into m0 and m1.
    const state = {
      collabRoomId: 'r1',
      collabRoomModels: new Map([
        ['model-1712345678-1', roomSlotRef(0)],
        ['model-1712345678-2', roomSlotRef(1)],
      ]),
    };
    assert.equal(roomExportPathPrefix(state, 'model-1712345678-1'), undefined);
    assert.equal(roomExportPathPrefix(state, 'model-1712345678-2'), undefined);
  });

  it('has nothing to strip for the legacy slot of a room shared before slots existed', () => {
    const state = { collabRoomId: 'old', collabRoomModels: new Map([[roomModelIdFor('old', 'm0'), LEGACY_ROOM_SLOT]]) };
    assert.equal(roomExportPathPrefix(state, 'room:old:m0'), undefined);
  });

  it('is undefined off a session and for a model the room does not hold', () => {
    const live = { collabRoomId: 'r1', collabRoomModels: new Map([[roomModelIdFor('r1', 'm0'), roomSlotRef(0)]]) };
    assert.equal(roomExportPathPrefix(live, 'model-private'), undefined);
    assert.equal(roomExportPathPrefix(live, roomModelIdFor('other-room', 'm0')), undefined);
    const off = { collabRoomId: null, collabRoomModels: new Map([[roomModelIdFor('r1', 'm0'), roomSlotRef(0)]]) };
    assert.equal(roomExportPathPrefix(off, 'room:r1:m0'), undefined);
  });
});
