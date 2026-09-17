/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState, placementFor } from '@/lib/model-placement/state';
import { degreesToRadians, rotateWorkspacePoint } from '@/lib/model-placement/rotation';
import { addTranslation, type Translation } from '@/lib/model-placement/translation';
import { testPlacement } from '@/lib/model-placement/test-fixtures';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';
import { realignFederationModels } from '@/hooks/ingest/federationRealign';
import type { ModelGeoref } from '@/hooks/ingest/federationAlign';
import { applyRoomModelData } from '@/lib/collab/room-model-apply';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { convergeFederationRtcFrame } from '@/hooks/ingest/federationRtcRebase';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { reconcileModelRotations, subscribeModelRotationSync, withModelRotationsUnbaked } from './useModelRotationSync';

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

/** A SECOND model's geometry, deliberately unlike `geometryResult()` on every
 * component: a cross-model test can only see a baker that restored one
 * model's baseline onto another when the two fixtures differ. */
function secondGeometryResult(): GeometryResult {
  return {
    meshes: [{ expressId: 2, positions: new Float32Array([0, 0, 0, 0, 0, 5, 2, 0, 5]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1], origin: [-60, 11, 250] } as MeshData],
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 5 } },
      shiftedBounds: { min: { x: -60, y: 11, z: 250 }, max: { x: -58, y: 11, z: 255 } },
      hasLargeCoordinates: false },
  } as unknown as GeometryResult;
}

const vertices = (model: FederatedModel) => [...model.geometryResult!.meshes[0].positions,
  ...(model.geometryResult!.meshes[0].origin ?? [])];
const modelOf = (id: string) => useViewerStore.getState().models.get(id) as FederatedModel;
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

  it('withdraws the pre-rotation spatial index at once instead of serving it until the rebuild lands', () => {
    const stale = { stale: true } as unknown as NonNullable<FederatedModel['ifcDataStore']>['spatialIndex'];
    live().ifcDataStore!.spatialIndex = stale;
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    assert.deepEqual(reconcileModelRotations(useViewerStore.getState()), ['ifc']);
    // The rebuild is asynchronous; synchronously after the bake a raycast must
    // not be answered from boxes describing the previous heading.
    assert.notEqual(live().ifcDataStore!.spatialIndex, stale, 'raycasts still read the pre-rotation index');
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

  // GPU-instanced occurrences are drawn from renderer instance data the bake
  // never touches, so rotating such a model would turn its flat meshes and
  // leave the instanced ones behind. Refused until that is supported.
  const withInstanced = (id: string, how: 'instanced-only' | 'pending-shards' | 'streaming') => {
    const model = { ...fixtureModel(id), geometryResult: geometryResult() } as FederatedModel;
    if (how === 'instanced-only') model.geometryResult!.instancedGeometryHashes = new Map([[77, 1n]]);
    if (how === 'streaming') model.loadState = 'streaming-geometry';
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, [id, model]]),
      ...(how === 'pending-shards' ? { pendingInstancedShards: [{ modelId: id, bytes: new ArrayBuffer(8) }] } : {}) });
  };

  for (const how of ['instanced-only', 'pending-shards'] as const) {
    it(`refuses to rotate a model with GPU-instanced geometry (${how}), atomically for a mixed selection`, () => {
      withInstanced('inst', how);
      assert.throws(() => useViewerStore.getState().setModelRotation(['ifc', 'inst'], { angle: ANGLE, pivot: [...PIVOT] }),
        /GPU-instanced geometry cannot be rotated/);
      assert.equal(placementFor(useViewerStore.getState().modelPlacement, 'ifc').rotation.angle, 0);
      assert.equal(placementFor(useViewerStore.getState().modelPlacement, 'inst').rotation.angle, 0);
      useViewerStore.setState({ pendingInstancedShards: null });
    });
  }

  it('refuses to rotate a model whose geometry is still streaming, before its instancing is known', () => {
    withInstanced('loading', 'streaming');
    assert.throws(() => useViewerStore.getState().setModelRotation(['loading'], { angle: ANGLE, pivot: [...PIVOT] }),
      /finish loading/);
    assert.equal(placementFor(useViewerStore.getState().modelPlacement, 'loading').rotation.angle, 0);
  });

  it('refuses a placement manifest that would give an instanced model a heading, and still imports its translation', () => {
    withInstanced('inst', 'instanced-only');
    const state = useViewerStore.getState();
    const manifest = (rotation?: { angle: number; pivot: [number, number, number] }) => ({ version: 1 as const, units: 'm' as const,
      axes: 'engineering-z-up' as const, frameKey: placementFrameKey(state),
      models: [{ instanceId: 'inst', sourceContentHash: null, translation: [2.5, -1.25, 0] as Translation, rotation, locked: false }] });
    assert.throws(() => state.importModelPlacements(manifest({ angle: ANGLE, pivot: [...PIVOT] }), new Map([['inst', 'inst']])),
      /GPU-instanced geometry cannot be rotated/);
    assert.deepEqual(placementFor(useViewerStore.getState().modelPlacement, 'inst').translation, [0, 0, 0], 'a refused import must apply nothing');
    useViewerStore.getState().importModelPlacements(manifest(), new Map([['inst', 'inst']]));
    assert.deepEqual(placementFor(useViewerStore.getState().modelPlacement, 'inst').translation, [2.5, -1.25, 0]);
  });

  it('refuses a manifest heading for every model the rotate command refuses, not only instanced ones', () => {
    const cloud = { ...fixtureModel('scan'), pointCloudHandleId: 7 } as unknown as FederatedModel;
    withInstanced('loading', 'streaming');
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['scan', cloud]]) });
    const state = useViewerStore.getState();
    for (const [id, message] of [['scan', /Pointclouds cannot be rotated/], ['loading', /finish loading/]] as const) {
      const manifest = { version: 1 as const, units: 'm' as const, axes: 'engineering-z-up' as const, frameKey: placementFrameKey(state),
        models: [{ instanceId: id, sourceContentHash: null, translation: [0, 0, 0] as Translation,
          rotation: { angle: ANGLE, pivot: [...PIVOT] as Translation }, locked: false }] };
      assert.throws(() => useViewerStore.getState().importModelPlacements(manifest, new Map([[id, id]])), message, id);
      assert.equal(placementFor(useViewerStore.getState().modelPlacement, id).rotation.angle, 0, id);
    }
  });

  it('a re-align never snapshots a rotated model, and re-applies each heading exactly once', async () => {
    // Two models so the anchor's `updateModel` fires the live subscription
    // BEFORE the second model is snapshotted — the window a mid-pass reconcile
    // would re-rotate it in.
    const pristine = vertices({ geometryResult: secondGeometryResult() } as FederatedModel);
    const second = { ...fixtureModel('second'), geometryResult: secondGeometryResult() } as FederatedModel;
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['second', second]]) });
    const unsubscribe = subscribeModelRotationSync();
    try {
      useViewerStore.getState().setModelRotation(['ifc', 'second'], { angle: ANGLE, pivot: [...PIVOT] });
      const rotated = vertices(modelOf('second'));
      assert.notDeepEqual(rotated, pristine, 'the fixture must turn under this heading');
      assert.notDeepEqual(rotated, vertices(live()), 'the two fixtures must stay distinguishable');

      const state = useViewerStore.getState();
      await withModelRotationsUnbaked(() => realignFederationModels({
        models: [...state.models] as Array<[string, FederatedModel]>, anchorModelId: 'ifc',
        anchorGeoref: {} as ModelGeoref, resolveGeoref: () => null, updateModel: state.updateModel,
      }));

      const after = useViewerStore.getState().models.get('second') as FederatedModel;
      const snapshot = after.preAlignment!;
      assert.deepEqual([...snapshot.positions[0], ...(snapshot.origins[0] ?? [])], pristine,
        'the pre-alignment snapshot captured a rotated model');
      assert.deepEqual(vertices(after), rotated, 'the heading was not re-applied exactly once after the re-align');
    } finally {
      unsubscribe();
    }
  });

  it('a geometry update to one model leaves every other rotated model where it is', () => {
    // The two models carry DIFFERENT geometry and each expectation is captured
    // from its own model: with one shared fixture a baker that restored
    // `ifc`'s baseline onto `second` would land on the right numbers by
    // coincidence, and this test would not see the mix-up.
    const second = { ...fixtureModel('second'), geometryResult: secondGeometryResult() } as FederatedModel;
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['second', second]]) });
    const unsubscribe = subscribeModelRotationSync();
    try {
      useViewerStore.getState().setModelRotation(['ifc', 'second'], { angle: ANGLE, pivot: [...PIVOT] });
      const rotated = vertices(live());
      const rotatedSecond = vertices(modelOf('second'));
      assert.notDeepEqual(rotatedSecond, rotated, 'the two fixtures must stay distinguishable');
      // A collab peer edit on the other, inactive model: a new geometry for it
      // and a bump of the store-wide content version (room-model-apply.ts).
      applyRoomModelData(useViewerStore.getState(), 'second', { geometryResult: secondGeometryResult() });
      assert.deepEqual(vertices(live()), rotated, 'an untouched model re-applied its heading on another model\'s update');
      assert.deepEqual(vertices(modelOf('second')), rotatedSecond,
        'the replaced model did not take its heading exactly once');
    } finally {
      unsubscribe();
    }
  });

  it('turns every selected model about the ONE workspace pivot, whatever their translations', () => {
    const second = { ...fixtureModel('second'), geometryResult: secondGeometryResult() } as FederatedModel;
    const offsets = new Map<string, Translation>([['ifc', [3.5, -1.25, 0.5]], ['second', [100.75, -20.5, 2]]]);
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['second', second]]),
      modelPlacement: { ...emptyPlacementState(), placements: new Map([...offsets].map(([id, t]) => [id, testPlacement(t)])) } });
    const workspace = { angle: ANGLE, pivot: [42.5, 7.25, 0] as Translation };
    useViewerStore.getState().setModelRotation(['ifc', 'second'], workspace);
    const local: Translation = [11.5, -6.75, 1.5];
    for (const [id, offset] of offsets) {
      const placement = placementFor(useViewerStore.getState().modelPlacement, id);
      // Rendered: rotate the model-frame point, then translate it.
      const rendered = addTranslation(rotateWorkspacePoint(local, placement.rotation), placement.translation);
      // Asked for: the placed point turned about the entered workspace pivot.
      const intended = rotateWorkspacePoint(addTranslation(local, offset), workspace);
      for (let axis = 0; axis < 3; axis += 1) {
        assert.ok(Math.abs(rendered[axis] - intended[axis]) < 1e-9, `${id} axis ${axis}: ${rendered[axis]} vs ${intended[axis]}`);
      }
    }
  });

  it('rejects a non-finite angle or pivot rather than storing one', () => {
    for (const rotation of [{ angle: Number.NaN, pivot: [0, 0, 0] as const },
      { angle: ANGLE, pivot: [Number.POSITIVE_INFINITY, 0, 0] as const }]) {
      assert.throws(() => useViewerStore.getState().setModelRotation(['ifc'], { angle: rotation.angle, pivot: [...rotation.pivot] }));
    }
    assert.equal(placementFor(useViewerStore.getState().modelPlacement, 'ifc').rotation.angle, 0);
  });
});

/**
 * The federation RTC convergence (#4897, reworked by #4906) is the SECOND
 * operation that rewrites a settled model's render frame in place, after a
 * re-align. It shifts each mesh's f64 `origin` and the `CoordinateInfo` frame
 * — exactly the state a rotation baseline and a stored pivot are recorded in —
 * so a heading and a convergence have to compose without either being applied
 * twice or dropped. These read the ABSOLUTE world position, the one quantity
 * neither operation is allowed to change behind the other's back.
 */
describe('a federation RTC convergence composes with a model heading (#4869 + #4897)', () => {
  /** Non-round and asymmetric in sign: a round anchor hides axis mix-ups. */
  const ANCHOR = { x: 1234567.891, y: -987654.321, z: 42.75 };

  function anchoredModel(id: string, loadedAt: number): FederatedModel {
    const geometry = secondGeometryResult();
    geometry.coordinateInfo = { ...geometry.coordinateInfo,
      wasmRtcOffset: { ...ANCHOR }, wasmRtcFrame: { ...ANCHOR, needsShift: true } };
    return { ...fixtureModel(id), geometryResult: geometry, loadedAt } as FederatedModel;
  }

  /** Every vertex in absolute world coordinates: render position + the mesh's
   * f64 origin + the frame offset. A convergence changes the last two and must
   * leave the sum untouched; a bake changes the first two and must move the sum
   * by exactly one heading. */
  function worldVertices(model: FederatedModel): number[] {
    const geometry = model.geometryResult!;
    const offset = totalYupOffset(geometry.coordinateInfo);
    const out: number[] = [];
    for (const mesh of geometry.meshes) {
      const origin = mesh.origin ?? [0, 0, 0];
      for (let i = 0; i < mesh.positions.length; i += 3) {
        out.push(mesh.positions[i] + origin[0] + offset.x,
          mesh.positions[i + 1] + origin[1] + offset.y,
          mesh.positions[i + 2] + origin[2] + offset.z);
      }
    }
    return out;
  }

  /** The pivot `RotationControls.defaultPivot` offers for a model that already
   * has a heading: the one it was given, back in workspace coordinates. */
  function shownPivot(modelId: string): Translation {
    const placement = placementFor(useViewerStore.getState().modelPlacement, modelId);
    return addTranslation(placement.rotation.pivot, placement.translation);
  }

  /** A single raw-framed model, as `beforeEach` leaves it but with a
   * `loadedAt` so the anchor choice is deterministic. */
  function seed(): void {
    modelRotationBaker.clear();
    const model = { ...fixtureModel('ifc'), geometryResult: geometryResult(), loadedAt: 1 } as FederatedModel;
    useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState(), geometryContentVersion: 0 });
  }

  /** The ordinary way a convergence happens: a georeferenced model joins a
   * federation whose existing model was meshed in the raw frame. */
  function joinGeoreferencedModel(): void {
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, ['geo', anchoredModel('geo', 2)]]) });
    convergeFederationRtcFrame();
  }

  it('leaves an already-baked heading exactly where it is in the world', () => {
    seed();
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    const before = worldVertices(live());
    const renderOrigin = [...live().geometryResult!.meshes[0].origin!];

    joinGeoreferencedModel();

    // Not vacuous: the rotated model really was moved onto the shared anchor.
    assert.notDeepEqual([...live().geometryResult!.meshes[0].origin!], renderOrigin,
      'the rotated model was never converged, so this test proves nothing');
    const after = worldVertices(live());
    for (let i = 0; i < before.length; i += 1) {
      assert.ok(Math.abs(after[i] - before[i]) < 1e-6,
        `component ${i}: the convergence moved a rotated model in the world, ${after[i]} vs ${before[i]}`);
    }
  });

  it('does not re-bake a model the convergence only re-framed', () => {
    seed();
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    joinGeoreferencedModel();
    // The convergence re-expressed the declared pivot in the new frame. The
    // heading standing in the vertices has to be re-expressed with it, or this
    // reads as a changed rotation and pays for a vertex pass and a GPU
    // re-upload to put the model back exactly where it already is.
    assert.deepEqual(reconcileModelRotations(useViewerStore.getState()), [],
      'the convergence provoked a re-bake of a model that did not turn');
  });

  it('re-editing the heading after a convergence lands the model where it would have without one', () => {
    const edit = () => {
      useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
      reconcileModelRotations(useViewerStore.getState());
    };
    const reEdit = () => {
      useViewerStore.getState().setModelRotation(['ifc'], { angle: degreesToRadians(-55), pivot: shownPivot('ifc') });
      reconcileModelRotations(useViewerStore.getState());
    };

    seed(); edit(); reEdit();
    const withoutConverge = worldVertices(live());

    seed(); edit(); joinGeoreferencedModel(); reEdit();
    const withConverge = worldVertices(live());

    for (let i = 0; i < withoutConverge.length; i += 1) {
      assert.ok(Math.abs(withConverge[i] - withoutConverge[i]) < 1e-3,
        `component ${i}: ${withConverge[i]} with a convergence in between vs ${withoutConverge[i]} without`);
    }
  });

  it('clearing the heading after a convergence restores the model into the SHARED frame', () => {
    seed();
    const pristine = worldVertices(live());
    useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
    reconcileModelRotations(useViewerStore.getState());
    assert.notDeepEqual(worldVertices(live()).map((v) => Math.round(v)), pristine.map((v) => Math.round(v)),
      'the fixture must actually turn under this heading');
    joinGeoreferencedModel();

    useViewerStore.getState().setModelRotation(['ifc'], { angle: 0, pivot: shownPivot('ifc') });
    reconcileModelRotations(useViewerStore.getState());

    // Clearing a heading restores the pristine shape — at the pristine WORLD
    // position, not back in the raw frame the model was loaded in.
    const cleared = worldVertices(live());
    for (let i = 0; i < pristine.length; i += 1) {
      assert.ok(Math.abs(cleared[i] - pristine[i]) < 1e-6,
        `component ${i}: clearing the heading left the model at ${cleared[i]} instead of ${pristine[i]}`);
    }
  });
});
