/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { referenceFrameStatus, referenceRenderCorners } from './frame.js';
import type { RegisteredAppearanceReference } from '../references/types.js';

const corners: RegisteredAppearanceReference['cornersIfcWorld'] = [[5000000,100,12],[5000002,100,12],[5000002,100,9],[5000000,100,9]];
const frameKey = (rtc: number, eastings = 0) => JSON.stringify({ crs: { name: 'EPSG:2056' }, conversion: { eastings }, lengthUnitScale: 1, rtc: { x: rtc, y: 100, z: 10 }, originShift: { x: 2, y: 3, z: 4 } });
const bounds = { min: { x:0,y:0,z:0 }, max: { x:2,y:3,z:1 } };
function state(rtc: number, eastings = 0) {
  const base = useViewerStore.getState();
  return { ...base, models: new Map(), modelPlacement: { ...emptyPlacementState(), frameKey: frameKey(rtc, eastings) },
    geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0,
      coordinateInfo: { originShift: { x:2,y:3,z:4 }, wasmRtcOffset: { x:rtc,y:100,z:10 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: true } } };
}

test('reference engineering corners and metre scale survive RTC-only workspace rebase (#4308)', () => {
  const record = { cornersIfcWorld: corners, frameKey: frameKey(5000000) };
  const before = referenceRenderCorners(record, state(5000000));
  const after = referenceRenderCorners(record, state(4999990));
  assert.deepEqual(before, [[-2,-1,-4],[0,-1,-4],[0,-4,-4],[-2,-4,-4]]);
  assert.deepEqual(after, [[8,-1,-4],[10,-1,-4],[10,-4,-4],[8,-4,-4]]);
  assert.equal(Math.hypot(after![1][0]-after![0][0], after![1][1]-after![0][1]), 2);
  assert.deepEqual(record.cornersIfcWorld, corners);
});

test('reference refuses a changed map conversion instead of silently moving to the new engineering frame (#4308)', () => {
  const record = { cornersIfcWorld: corners, frameKey: frameKey(5000000) };
  assert.equal(referenceFrameStatus(record, state(5000000, 900)), 'frame-mismatch');
  assert.equal(referenceRenderCorners(record, state(5000000, 900)), null);
});

test('switching active federated model does not move a registered workspace reference (#4308)', () => {
  const first = state(5000000), second = state(4999900);
  const models = new Map([
    ['first', { ...fixtureModel('first'), loadedAt: 1, geometryResult: first.geometryResult }],
    ['second', { ...fixtureModel('second'), loadedAt: 2, geometryResult: second.geometryResult }],
  ]);
  const record = { cornersIfcWorld: corners, frameKey: frameKey(5000000) };
  const a = referenceRenderCorners(record, { ...first, models, activeModelId:'first' });
  const b = referenceRenderCorners(record, { ...second, models, activeModelId:'second' });
  assert.deepEqual(b, a);
});
