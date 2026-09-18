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
import { emptyPlacementState, importPlacements, beginPlacement, previewPlacement } from './state';
import { makePlacementManifest, resolvePlacementManifest } from './manifest';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function state(id: string, fingerprint = 'source-a') {
  return { ...useViewerStore.getState(), ...fixtureModels({ ...fixtureModel(id), sourceContentHash: fingerprint }), modelPlacement: emptyPlacementState() };
}

describe('workspace placement persistence (#4226)', () => {
  it('restores by source contents after runtime ids change, preserving fine corrections', () => {
    const disk = storage(), original = state('old');
    original.modelPlacement = importPlacements(original.modelPlacement, new Map([['old', { translation: [10_000_000.001, 2, 3], locked: false }]]));
    saveWorkspacePlacements(disk, original);
    assert.deepEqual(restoreWorkspacePlacements(disk, state('new')).get('new')?.translation, [10_000_000.001, 2, 3]);
    assert.equal(restoreWorkspacePlacements(disk, state('new', 'different-contents')).size, 0);
  });

  it('saves committed positions during a preview and persists reset instead of resurrecting a prior move', () => {
    const disk = storage(), original = state('a');
    original.modelPlacement = importPlacements(original.modelPlacement, new Map([['a', { translation: [2, 0, 0], locked: false }]]));
    original.modelPlacement = previewPlacement(beginPlacement(original.modelPlacement, ['a'], new Set(['a'])), [100, 0, 0]);
    saveWorkspacePlacements(disk, original);
    assert.deepEqual(restoreWorkspacePlacements(disk, state('b')).get('b')?.translation, [2, 0, 0]);
    saveWorkspacePlacements(disk, state('a'));
    assert.deepEqual(restoreWorkspacePlacements(disk, state('b')).get('b')?.translation, [0, 0, 0]);
  });

  it('retains the current model when the saved frame already contains 1000 sources', () => {
    const disk = storage(), old = state('old');
    old.models = new Map(Array.from({ length: 1000 }, (_, index) => {
      const id = `old-${index}`;
      return [id, { ...fixtureModel(id), sourceContentHash: id }];
    }));
    saveWorkspacePlacements(disk, old);
    const current = state('current', 'new-source');
    current.modelPlacement = importPlacements(current.modelPlacement, new Map([['current', { translation: [42.001, 0, 0], locked: false }]]));
    saveWorkspacePlacements(disk, current);
    assert.deepEqual(restoreWorkspacePlacements(disk, state('reloaded', 'new-source')).get('reloaded')?.translation, [42.001, 0, 0]);
    assert.equal(restoreWorkspacePlacements(disk, state('old-again', 'old-0')).size, 1);
  });

  it('does not auto-bind duplicate sources or overwrite an explicit move made during loading', () => {
    const disk = storage(), original = state('a');
    original.modelPlacement = importPlacements(original.modelPlacement, new Map([['a', { translation: [3, 0, 0], locked: false }]]));
    saveWorkspacePlacements(disk, original);
    const duplicate = state('b');
    duplicate.models.set('c', { ...fixtureModel('c'), sourceContentHash: 'source-a' });
    assert.equal(restoreWorkspacePlacements(disk, duplicate).size, 0);
    const edited = state('b');
    edited.modelPlacement = importPlacements(edited.modelPlacement, new Map([['b', { translation: [4, 0, 0], locked: false }]]));
    assert.equal(restoreWorkspacePlacements(disk, edited).size, 0);
  });
});

describe('placementFrameKey distinguishes an RTC convergence (#4936)', () => {
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

it('repairs corrupt storage on the next committed save (#4226)', () => {
  const disk = storage(), original = state('a');
  disk.setItem('ifc-lite:placements:v1:' + placementFrameKey(original), '{broken');
  original.modelPlacement = importPlacements(original.modelPlacement, new Map([['a', { translation: [12, 3, 4], locked: false }]]));
  saveWorkspacePlacements(disk, original);
  assert.deepEqual(restoreWorkspacePlacements(disk, state('b')).get('b'),
    { translation: [12, 3, 4], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false });
});
