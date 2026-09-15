/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore, IfcSourceBytes } from '@ifc-lite/parser';
import { registerRoomSymbolicSource, type RoomSymbolicSource } from './room-symbolic-source.js';
import { roomDrawingContextKey } from './room-drawing-symbolic.js';

function binding(dataStore: IfcDataStore, source: IfcSourceBytes, x: number): RoomSymbolicSource {
  return {
    dataStore,
    source,
    seededIds: new Set([1]),
    ownerIds: new Map([[1, 101]]),
    placements: new Map([[1, { location: [x, 0, 0] }]]),
    baselines: new Map([[1, { location: [0, 0, 0] }]]),
    structuredPsets: new Map(),
    structuredQuantities: new Map(),
    structuredAttributes: new Map(),
  } as RoomSymbolicSource;
}

describe('portable room drawing cache identity (#4799)', () => {
  it('changes when bindings change even if the portable bytes are reused', () => {
    const reconstructed = (
      { source: { contentKey: 'reconstructed', byteLength: 1 } } as unknown as IfcDataStore
    );
    const portableStore = (
      { source: { contentKey: 'portable', byteLength: 1 } } as unknown as IfcDataStore
    );
    const portableSource = portableStore.source;

    registerRoomSymbolicSource(reconstructed, binding(portableStore, portableSource, 0));
    const before = roomDrawingContextKey(reconstructed);
    registerRoomSymbolicSource(reconstructed, binding(portableStore, portableSource, 12));
    const after = roomDrawingContextKey(reconstructed);

    assert.ok(before && after);
    assert.notEqual(after, before, 'placement-dependent drawing output must not reuse the old binding cache');
  });
});
