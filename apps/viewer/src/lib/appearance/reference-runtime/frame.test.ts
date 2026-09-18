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
// `placementFrameKey` (`lib/model-placement/persistence.ts`) folds the live
// RTC anchor into the base as ONE JSON object's trailing `rtc` field (#4936);
// `baseFrameKey` is what `realignedFrameKey` pins, `liveKey` is what
// `placementFrameKey` actually computes once the fixture's own live
// `wasmRtcOffset` (below) is folded on.
const baseFrameKey = (eastings = 0, name = 'EPSG:2056') => JSON.stringify({ crs: { name }, conversion: { eastings }, lengthUnitScale: 1, originShift: { x: 2, y: 3, z: 4 } });
const liveKey = (rtc: number, eastings = 0, name?: string) =>
  JSON.stringify({ ...JSON.parse(baseFrameKey(eastings, name)) as Record<string, unknown>, rtc: { x: rtc, y: 100, z: 10 } });
const bounds = { min: { x:0,y:0,z:0 }, max: { x:2,y:3,z:1 } };
function state(rtc: number, eastings = 0, name?: string) {
  const base = useViewerStore.getState();
  return { ...base, models: new Map(), modelPlacement: { ...emptyPlacementState(), realignedFrameKey: baseFrameKey(eastings, name) },
    geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0,
      coordinateInfo: { originShift: { x:2,y:3,z:4 }, wasmRtcOffset: { x:rtc,y:100,z:10 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: true } } };
}

test('reference engineering corners and metre scale survive RTC-only workspace rebase (#4308)', () => {
  const record = { cornersIfcWorld: corners, frameKey: liveKey(5000000) };
  const before = referenceRenderCorners(record, state(5000000));
  const after = referenceRenderCorners(record, state(4999990));
  assert.deepEqual(before, [[-2,-1,-4],[0,-1,-4],[0,-4,-4],[-2,-4,-4]]);
  assert.deepEqual(after, [[8,-1,-4],[10,-1,-4],[10,-4,-4],[8,-4,-4]]);
  assert.equal(Math.hypot(after![1][0]-after![0][0], after![1][1]-after![0][1]), 2);
  assert.deepEqual(record.cornersIfcWorld, corners);
});

test('reference refuses a changed map conversion instead of silently moving to the new engineering frame (#4308)', () => {
  const record = { cornersIfcWorld: corners, frameKey: liveKey(5000000) };
  assert.equal(referenceFrameStatus(record, state(5000000, 900)), 'frame-mismatch');
  assert.equal(referenceRenderCorners(record, state(5000000, 900)), null);
});

test('switching active federated model does not move a registered workspace reference (#4308)', () => {
  const first = state(5000000), second = state(4999900);
  const models = new Map([
    ['first', { ...fixtureModel('first'), loadedAt: 1, geometryResult: first.geometryResult }],
    ['second', { ...fixtureModel('second'), loadedAt: 2, geometryResult: second.geometryResult }],
  ]);
  const record = { cornersIfcWorld: corners, frameKey: liveKey(5000000) };
  const a = referenceRenderCorners(record, { ...first, models, activeModelId:'first' });
  const b = referenceRenderCorners(record, { ...second, models, activeModelId:'second' });
  assert.deepEqual(b, a);
});

test('a CRS name containing ":rtc:" cannot collapse two different frames into one (#4936 round 5 review)', () => {
  // The previous `engineeringFrame` stripped the live anchor with `/:rtc:.*$/`,
  // which cut BOTH of these keys at the first `:rtc:` inside the CRS name
  // (`{"crs":{"name":"site`), so a reference registered in frame A reported
  // `ready` in frame B and was drawn at absolute coordinates from the wrong CRS.
  const inA = { cornersIfcWorld: corners, frameKey: liveKey(5000000, 0, 'site:rtc:A') };
  const inB = { cornersIfcWorld: corners, frameKey: liveKey(5000000, 0, 'site:rtc:B') };
  const liveB = state(4999990, 0, 'site:rtc:B');
  assert.equal(referenceFrameStatus(inB, liveB), 'ready', 'sanity: same CRS, RTC-only change, still ready');
  assert.equal(referenceFrameStatus(inA, liveB), 'frame-mismatch');
  assert.equal(referenceRenderCorners(inA, liveB), null);
  // And the exact record key survives a round trip when nothing changed at all.
  assert.equal(referenceFrameStatus(inA, state(5000000, 0, 'site:rtc:A')), 'ready');
});
