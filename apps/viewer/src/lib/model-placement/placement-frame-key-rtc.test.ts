/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { saveWorkspacePlacements, restoreWorkspacePlacements, placementFrameKey } from './persistence';
import { emptyPlacementState, importPlacements } from './state';
import { makePlacementManifest, resolvePlacementManifest } from './manifest';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
function coordInfo(wasmRtcOffset?: CoordinateInfo['wasmRtcOffset']): CoordinateInfo {
  return { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box,
    hasLargeCoordinates: false, ...(wasmRtcOffset ? { wasmRtcOffset } : {}) } as CoordinateInfo;
}

/** A non-georeferenced (local-engineering) workspace: `selectAnchorGeoref`
 * finds no usable map georef, so `placementFrameKey` falls to the
 * `local-engineering:*` branch under test. */
function localState(rtcOffset?: CoordinateInfo['wasmRtcOffset']) {
  const model = { ...fixtureModel('a'), sourceContentHash: 'source-a', loadedAt: 1,
    geometryResult: { coordinateInfo: coordInfo(rtcOffset) } as unknown as GeometryResult };
  return { ...useViewerStore.getState(), ...fixtureModels(model), modelPlacement: emptyPlacementState() };
}

describe('placementFrameKey distinguishes an RTC convergence (#4936)', () => {
  it('changes when federation convergence re-anchors the scene, and a saved pivot is not reused unshifted', () => {
    const disk = storage(), before = localState(undefined);
    const keyBefore = placementFrameKey(before);
    assert.equal(keyBefore, 'local-engineering:m:z-up');

    // A rotation pivot saved before the convergence: a workspace POINT, only
    // meaningful in the frame it was captured in.
    before.modelPlacement = importPlacements(before.modelPlacement,
      new Map([['a', { translation: [0, 0, 0], rotation: { angle: 0.5, pivot: [10, 0, 5] }, locked: false }]]));
    saveWorkspacePlacements(disk, before);

    // `convergeFederationRtcFrame` (#4897/#4906) stamps every converged
    // model's `coordinateInfo.wasmRtcOffset` with the shared anchor.
    const after = localState({ x: 1234567.891, y: -987654.321, z: 42.75 });
    const keyAfter = placementFrameKey(after);
    assert.notEqual(keyAfter, keyBefore, 'the frame key must change when the RTC anchor moves under the models');

    // The pivot saved under the old frame is not silently handed back under
    // the new one: nothing is found for the converged frame's key.
    assert.equal(restoreWorkspacePlacements(disk, after).size, 0);
  });

  it('refuses loudly when a manifest saved before a convergence is imported after it', () => {
    const before = localState(undefined);
    before.modelPlacement = importPlacements(before.modelPlacement,
      new Map([['a', { translation: [0, 0, 0], rotation: { angle: 0.25, pivot: [3, 0, -2] }, locked: false }]]));
    const manifest = makePlacementManifest(before.models, before.modelPlacement.placements, placementFrameKey(before));

    const after = localState({ x: 100, y: 200, z: 300 });
    assert.throws(() => resolvePlacementManifest(manifest, after.models, placementFrameKey(after)),
      /coordinate frame differs/);
  });

  it('stays the same across an unrelated re-read of an already-converged frame', () => {
    const offset = { x: 5, y: 6, z: 7 };
    assert.equal(placementFrameKey(localState(offset)), placementFrameKey(localState(offset)));
  });
});
