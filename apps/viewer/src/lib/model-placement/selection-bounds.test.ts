/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState, importPlacements } from './state';
import { createPlacedEntityBoundsLookup, placedBoundsExcludingTypes } from './selection-bounds';

it('frames a flat element beyond the source-coordinate corruption threshold (#4226)', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m', { idOffset: 0 })),
    modelPlacement: importPlacements(emptyPlacementState(), new Map([['m', { translation: [10_000_000, 20, 30], locked: false }]])) });
  const bounds = createPlacedEntityBoundsLookup([{ expressId: 1, origin: [1, 2, 3],
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }])(1);
  assert.ok(bounds);
  assert.deepEqual(bounds, { min: { x: 10_000_001, y: 32, z: -17 }, max: { x: 10_000_003, y: 34, z: -17 } });
});

it('frames the placed building shell while excluding the site extent (#4226)', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m', { idOffset: 0 })),
    modelPlacement: importPlacements(emptyPlacementState(), new Map([['m', { translation: [100_000, 0, 100], locked: false }]])) });
  const wall = { expressId: 1, ifcType: 'IfcWall', positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] as [number, number, number, number] };
  const site = { ...wall, expressId: 2, ifcType: 'IfcSite', origin: [500, 0, 0] as [number, number, number] };
  assert.deepEqual(placedBoundsExcludingTypes([wall, site], new Set(['IfcSite'])),
    { min: { x: 100_000, y: 100, z: 0 }, max: { x: 100_002, y: 102, z: 0 } });
});
