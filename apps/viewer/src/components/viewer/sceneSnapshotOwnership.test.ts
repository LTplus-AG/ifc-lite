/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { setPendingSceneSnapshot, takeSceneSnapshotGeometry, takeSnapshotModelArrival } from './sceneSnapshotOwnership.js';

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
const point = { x: 1, y: 2, z: 3 };
let hydrates = true;
let hydrations: unknown[][] = [];
const renderer = {
  getScene: () => ({ hydrateSceneSnapshot: (adoption: object, meshes: MeshData[]) => { hydrations.push([adoption, meshes]); return hydrates; } }),
  getCamera: () => ({ getOrbitAnchorBounds: () => null, getSceneBounds: () => bounds, getPosition: () => point, getTarget: () => point }),
  requestRender() {},
} as unknown as Renderer;
const mesh = () => ({ positions: new Float32Array(3) }) as MeshData;
const refs = () => ({
  lastGeometryLengthRef: { current: 0 }, lastGeometryRef: { current: null as MeshData[] | null },
  cameraFittedRef: { current: false }, finalBoundsRefittedRef: { current: false },
  geometryBoundsRef: { current: { min: point, max: point } }, cameraSnapshotRef: { current: null as never },
});

describe('takeSceneSnapshotGeometry', () => {
  const adoption = {};
  beforeEach(() => { hydrates = true; hydrations = []; setPendingSceneSnapshot(null); });
  const take = (geometry: MeshData[], modelCount = 0, target = refs()) => takeSceneSnapshotGeometry(geometry, modelCount, renderer, target);

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
    setPendingSceneSnapshot(adoption);
    const refused = refs();
    assert.equal(take([mesh()], 0, refused), false);
    assert.equal(refused.lastGeometryLengthRef.current, 0);
    assert.equal(refused.cameraFittedRef.current, false);
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

  it('leaves geometry alone with nothing pending, or once withdrawn', () => {
    assert.equal(take([mesh()]), false);
    setPendingSceneSnapshot(adoption);
    setPendingSceneSnapshot(null);
    assert.equal(take([mesh()]), false);
    assert.deepEqual(hydrations, []);
  });
});
