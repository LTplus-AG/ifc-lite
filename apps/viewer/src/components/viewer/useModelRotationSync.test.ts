/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState, placementFor } from '@/lib/model-placement/state';
import { degreesToRadians } from '@/lib/model-placement/rotation';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';
import { reconcileModelRotations } from './useModelRotationSync';

/** 30°, an off-origin pivot, and an asymmetric shape: at 0°, at the origin, or
 * on a symmetric shape this fixture would pass whether or not it turned. */
const ANGLE = degreesToRadians(30);
const PIVOT = [10, 4, 0] as const;

function geometryResult(): GeometryResult {
  return {
    meshes: [{ expressId: 1, positions: new Float32Array([0, 0, 0, 3, 0, 0, 3, 0, 1]),
      normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1], origin: [100, 5, -40] } as MeshData],
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 100, y: 5, z: -40 }, max: { x: 103, y: 5, z: -39 } },
      hasLargeCoordinates: false },
  } as unknown as GeometryResult;
}

const vertices = (model: FederatedModel) => [...model.geometryResult!.meshes[0].positions,
  ...(model.geometryResult!.meshes[0].origin ?? [])];
const live = () => useViewerStore.getState().models.get('ifc') as FederatedModel;

describe('model rotation reaches the geometry every render path reads (#4869)', () => {
  beforeEach(() => {
    modelRotationBaker.clear();
    const model = { ...fixtureModel('ifc'), geometryResult: geometryResult() } as FederatedModel;
    useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState(), geometryContentVersion: 0 });
  });

  it('bakes a committed heading into the vertices and bumps the content version', () => {
    const before = vertices(live());
    const version = useViewerStore.getState().geometryContentVersion;
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    assert.deepEqual(reconcileModelRotations(useViewerStore.getState()), ['ifc']);
    assert.notDeepEqual(vertices(live()), before);
    // Without the bump the GPU keeps serving the old vertex buffers and the
    // model does not visibly turn — the whole point of baking.
    assert.ok(useViewerStore.getState().geometryContentVersion > version, 'content version did not bump');
  });

  it('does not re-bake a heading that has not changed', () => {
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    const settled = vertices(live()), version = useViewerStore.getState().geometryContentVersion;
    assert.deepEqual(reconcileModelRotations(useViewerStore.getState()), []);
    assert.deepEqual(vertices(live()), settled);
    assert.equal(useViewerStore.getState().geometryContentVersion, version);
  });

  it('undo and redo move the geometry, not just the number', () => {
    const pristine = vertices(live());
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    const rotated = vertices(live());

    useViewerStore.getState().undoModelTranslation();
    assert.equal(placementFor(useViewerStore.getState().modelPlacement, 'ifc').rotation.angle, 0);
    assert.deepEqual(reconcileModelRotations(useViewerStore.getState()), ['ifc']);
    assert.deepEqual(vertices(live()), pristine);

    useViewerStore.getState().redoModelTranslation();
    assert.deepEqual(reconcileModelRotations(useViewerStore.getState()), ['ifc']);
    assert.deepEqual(vertices(live()), rotated);
  });

  it('re-editing the angle re-bakes from pristine instead of compounding', () => {
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    useViewerStore.getState().setModelRotation(['ifc'], { angle: degreesToRadians(-55), pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    const twoEdits = vertices(live());

    modelRotationBaker.clear();
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('ifc'), geometryResult: geometryResult() } as FederatedModel),
      modelPlacement: emptyPlacementState(), geometryContentVersion: 0 });
    useViewerStore.getState().setModelRotation(['ifc'], { angle: degreesToRadians(-55), pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    const once = vertices(live());
    for (let i = 0; i < once.length; i += 1) {
      assert.ok(Math.abs(twoEdits[i] - once[i]) < 1e-3, `component ${i}: ${twoEdits[i]} vs ${once[i]}`);
    }
  });

  it('resetting the placement restores the pristine geometry', () => {
    const pristine = vertices(live());
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    useViewerStore.getState().resetModelTranslations(['ifc']);
    reconcileModelRotations(useViewerStore.getState());
    assert.deepEqual(vertices(live()), pristine);
  });

  it('refuses to rotate a locked model, and an unloaded one', () => {
    useViewerStore.getState().setModelPositionLocked('ifc', true);
    assert.throws(() => useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] }), /Unlock/);
    assert.throws(() => useViewerStore.getState().setModelRotation(['gone'], { angle: ANGLE, pivot: [...PIVOT] }), /no longer loaded/);
  });

  it('refuses to rotate a pointcloud rather than turning the model and leaving the cloud', () => {
    const cloud = { ...fixtureModel('scan'), pointCloudHandleId: 7 } as unknown as FederatedModel;
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['scan', cloud]]) });
    assert.throws(() => useViewerStore.getState().setModelRotation(['ifc', 'scan'], { angle: ANGLE, pivot: [...PIVOT] }),
      /Pointclouds cannot be rotated/);
    // And the refusal is atomic: the IFC model in the same selection is untouched.
    assert.equal(placementFor(useViewerStore.getState().modelPlacement, 'ifc').rotation.angle, 0);
  });

  it('rejects a non-finite angle or pivot rather than storing one', () => {
    for (const rotation of [{ angle: Number.NaN, pivot: [0, 0, 0] as const },
      { angle: ANGLE, pivot: [Number.POSITIVE_INFINITY, 0, 0] as const }]) {
      assert.throws(() => useViewerStore.getState().setModelRotation(['ifc'], { angle: rotation.angle, pivot: [...rotation.pivot] }));
    }
    assert.equal(placementFor(useViewerStore.getState().modelPlacement, 'ifc').rotation.angle, 0);
  });
});
