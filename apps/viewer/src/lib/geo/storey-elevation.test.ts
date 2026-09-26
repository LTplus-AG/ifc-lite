/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { IfcDataStore } from '@ifc-lite/parser';
import { displayStoreyElevationMeters } from './storey-elevation.js';

interface FakeEntity {
  type: string;
  attributes: unknown[];
}

/**
 * A storey placed at local `storeyLocation` inside a parent placement whose
 * Axis is `parentAxis` and whose RefDirection is `$`.
 */
function storeWithParentAxis(
  parentAxis: [number, number, number],
  storeyLocation: [number, number, number],
): { store: IfcDataStore; storeyId: number } {
  const entities = new Map<number, FakeEntity>([
    [1, { type: 'IFCCARTESIANPOINT', attributes: [[0, 0, 0]] }],
    [2, { type: 'IFCDIRECTION', attributes: [parentAxis] }],
    [3, { type: 'IFCAXIS2PLACEMENT3D', attributes: [1, 2, null] }],
    [4, { type: 'IFCLOCALPLACEMENT', attributes: [null, 3] }],
    [5, { type: 'IFCCARTESIANPOINT', attributes: [storeyLocation] }],
    [6, { type: 'IFCAXIS2PLACEMENT3D', attributes: [5, null, null] }],
    [7, { type: 'IFCLOCALPLACEMENT', attributes: [4, 6] }],
    [8, { type: 'IFCBUILDINGSTOREY', attributes: [null, null, null, null, null, 7] }],
  ]);
  const store = { getEntity: (id: number) => entities.get(id) ?? null } as unknown as IfcDataStore;
  return { store, storeyId: 8 };
}

describe('displayStoreyElevationMeters - absent RefDirection (#5922)', () => {
  it('reads a -X Axis with `$` RefDirection in the frame the renderer draws', () => {
    // The renderer fills `$` on an Axis of -X with (0,-1,0), so the parent's
    // local Y is Z x X = (-1,0,0) x (0,-1,0) = (0,0,1): a storey 5 along local
    // Y sits 5 up, and one 5 along local X sits at height 0.
    const alongY = storeWithParentAxis([-1, 0, 0], [0, 5, 0]);
    assert.strictEqual(displayStoreyElevationMeters(0, null, alongY.store, alongY.storeyId), 5);
    const alongX = storeWithParentAxis([-1, 0, 0], [5, 0, 0]);
    assert.strictEqual(displayStoreyElevationMeters(0, null, alongX.store, alongX.storeyId) + 0, 0);
  });

  it('reads a +X Axis with `$` RefDirection as world Y, per IfcFirstProjAxis', () => {
    // Local X = (0,1,0), local Y = (1,0,0) x (0,1,0) = (0,0,1).
    const alongY = storeWithParentAxis([1, 0, 0], [0, 5, 0]);
    assert.strictEqual(displayStoreyElevationMeters(0, null, alongY.store, alongY.storeyId), 5);
  });
});
