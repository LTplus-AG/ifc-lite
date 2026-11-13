/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { adoptedSceneOutlivesEmptyGeometry, sceneSnapshotKey, setPendingSceneSnapshot, takeSceneSnapshotGeometry, takeSnapshotModelArrival, withdrawPendingSceneSnapshot } from './sceneSnapshotOwnership.js';

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
const point = { x: 1, y: 2, z: 3 };
let hydrates = true;
let hydrations: unknown[][] = [];
let removedShards: number[] = [];
let fits: unknown[] = [];
const renderer = {
  getScene: () => ({ removeInstancedTemplatesForModel: (index: number) => { removedShards.push(index); return 0; }, hydrateSceneSnapshot: (adoption: object, meshes: MeshData[]) => { hydrations.push([adoption, meshes]); return hydrates; } }),
  getCanvas: () => null,
  getCamera: () => ({ fitBoundsAdaptive: (box: unknown) => { fits.push(box); }, setSceneBounds() {}, setOrbitAnchorBounds() {}, getOrbitAnchorBounds: () => null, getSceneBounds: () => bounds, getPosition: () => point, getTarget: () => point }),
  requestRender() {},
} as unknown as Renderer;
const mesh = () => ({ positions: new Float32Array(3) }) as MeshData;
const refs = () => ({
  lastGeometryLengthRef: { current: 0 }, lastGeometryRef: { current: null as MeshData[] | null },
  cameraFittedRef: { current: false }, finalBoundsRefittedRef: { current: false },
  geometryBoundsRef: { current: { min: point, max: point } }, cameraSnapshotRef: { current: null as never },
});

describe('sceneSnapshotKey', () => {
  const visibility = { spaces: false, openings: false };

  it('changes with the policy, the view mode and any type filter, and is stable otherwise', () => {
    const key = sceneSnapshotKey('p', 'model', visibility);
    assert.equal(sceneSnapshotKey('p', 'model', { ...visibility }), key);
    assert.notEqual(sceneSnapshotKey('other', 'model', visibility), key);
    assert.notEqual(sceneSnapshotKey('p', 'types', visibility), key);
    assert.notEqual(sceneSnapshotKey('p', 'model', { ...visibility, spaces: true }), key);
  });
});

describe('takeSceneSnapshotGeometry', () => {
  const adoption = {};
  beforeEach(() => { hydrates = true; hydrations = []; removedShards = []; fits = []; withdrawPendingSceneSnapshot(adoption); takeSnapshotModelArrival(); });
  const take = (geometry: MeshData[], modelCount = 0, target = refs()) => takeSceneSnapshotGeometry(geometry, modelCount, renderer, target, true);

  it('hydrates with the synced geometry once, and records it as streamed and fitted', () => {
    const geometry = [mesh(), mesh()];
    setPendingSceneSnapshot(adoption);
    const claimed = refs();
    assert.equal(take(geometry, 0, claimed), true);
    assert.deepEqual(hydrations, [[adoption, geometry]]);
    assert.equal(claimed.lastGeometryLengthRef.current, 2);
    assert.equal(claimed.lastGeometryRef.current, geometry);
    assert.equal(claimed.cameraFittedRef.current, true);
    assert.equal(claimed.finalBoundsRefittedRef.current, true);
    assert.equal(claimed.geometryBoundsRef.current, bounds);

    const again = refs();
    assert.equal(take(geometry, 0, again), false, 'a rebuild uploads as usual');
    assert.equal(again.cameraFittedRef.current, false);
  });

  it('falls through to the ordinary path when the scene refuses the geometry', () => {
    hydrates = false;
    let requeued = 0;
    setPendingSceneSnapshot(adoption, () => { requeued++; });
    const refused = refs();
    assert.equal(take([mesh()], 0, refused), false);
    assert.deepEqual(removedShards, [0], 'the fallback reshape must not decide their fate');
    assert.equal(requeued, 1, 'the ordinary drain uploads them after the reshape');
    assert.equal(refused.lastGeometryLengthRef.current, 0);
    assert.equal(refused.cameraFittedRef.current, false);
  });

  it('a refused snapshot restores its framing after the fallback sync, and its model arrival keeps it', async () => {
    hydrates = false;
    const fit = { fitBounds: bounds, sceneBounds: bounds, orbitAnchorBounds: null };
    setPendingSceneSnapshot(adoption, () => {}, fit);
    const refused = refs();
    assert.equal(take([mesh()], 0, refused), false);
    assert.deepEqual(fits, [], 'after the sync, whose reset would undo it');
    await Promise.resolve();
    assert.deepEqual(fits, [bounds]);
    assert.equal(refused.geometryBoundsRef.current, bounds);
    assert.equal(takeSnapshotModelArrival(), true);
  });

  it('swallows only its own model\'s arrival, once; a federated add still refits', () => {
    setPendingSceneSnapshot(adoption);
    take([mesh()], 0);
    assert.equal(takeSnapshotModelArrival(), true);
    assert.equal(takeSnapshotModelArrival(), false);

    setPendingSceneSnapshot(adoption);
    take([mesh()], 1);
    assert.equal(takeSnapshotModelArrival(), false, 'its model already registered');
  });

  it('a superseded load\'s arrival marker dies with the next new geometry', () => {
    setPendingSceneSnapshot(adoption);
    take([mesh()], 0); // hydrated, and its model never registers
    assert.equal(take([mesh()]), false);
    assert.equal(takeSnapshotModelArrival(), false, 'the next model refits');
  });

  it('leaves geometry alone with nothing pending, or once withdrawn', () => {
    assert.equal(take([mesh()]), false);
    setPendingSceneSnapshot(adoption);
    withdrawPendingSceneSnapshot(adoption);
    assert.equal(take([mesh()]), false);
    assert.deepEqual(hydrations, []);
  });

  it('an older load\'s cleanup leaves a newer load\'s pending adoption', () => {
    const newer = {};
    setPendingSceneSnapshot(newer);
    withdrawPendingSceneSnapshot(adoption);
    assert.equal(take([mesh()]), true);
    assert.equal(hydrations[0][0], newer);
  });

  describe('empty geometry', () => {
    const scene = (hydrating: boolean) => {
      const refused: object[] = [];
      return { refused, isSceneSnapshotHydrating: () => hydrating, removeInstancedTemplatesForModel: () => 0, hydrateSceneSnapshot: (a: object) => { refused.push(a); return false; } };
    };

    it('keeps the adopted batches while their meshes decode', () => {
      const hydrating = scene(true);
      assert.equal(adoptedSceneOutlivesEmptyGeometry(hydrating), true);
      assert.deepEqual(hydrating.refused, []);
    });

    it('ends the adoption once its meshes were published and all filtered out', () => {
      let requeued = 0;
      setPendingSceneSnapshot(adoption, () => { requeued++; });
      const hydrating = scene(true);
      assert.equal(adoptedSceneOutlivesEmptyGeometry(hydrating), false);
      assert.equal(requeued, 1);
      assert.deepEqual(hydrating.refused, [adoption]);
      assert.equal(take([mesh()]), false, 'no longer pending');
    });

    it('does nothing without an adoption', () => {
      assert.equal(adoptedSceneOutlivesEmptyGeometry(scene(false)), false);
    });
  });
});
