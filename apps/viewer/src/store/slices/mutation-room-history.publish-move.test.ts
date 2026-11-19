/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An atomic edit (a wall move that regenerates rooms) hands back its draft's mutation while history holds a committed
 * copy, so the room's record of the move must land on that copy, or its undo never reaches peers (#10810).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { WALL_ID, model, parseHelloWall, seed } from '@/test/agent-tools-fixture';
import { publishMove } from './mutation-room-history.js';

const initial = useViewerStore.getState();
let mirrored: unknown[][];
beforeEach(async () => {
  seed([model('hello', await parseHelloWall())]);
  mirrored = [];
  useViewerStore.setState({
    collabRoomId: 'room-a', collabSession: { roomId: 'room-a', transact: (run: () => void) => run() } as never,
    collabRoomModels: new Map([['hello', { slotId: 'm0', pathPrefix: '/m0' }]]),
    mirrorPlacementEdit: (...args) => { mirrored.push(args); },
  });
});
afterEach(() => useViewerStore.setState(initial));

it('a move recorded against a copy of the committed mutation still mirrors its undo (#10810)', () => {
  const committed = useViewerStore.getState().setPositionalAttribute('hello', WALL_ID, 0, 'Moved')!;
  // As the slice does: the state read after the commit, whose history holds `committed`.
  publishMove(useViewerStore.getState(), 'hello', { ...committed }, WALL_ID, [2, 0, 0]);
  mirrored.length = 0;
  useViewerStore.getState().undo('hello');
  assert.deepEqual(mirrored, [['hello', WALL_ID, [-2, -0, -0]]]);
});
