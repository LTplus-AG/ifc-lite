/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState, placementFor } from '@/lib/model-placement/state';
import { degreesToRadians, rotateWorkspacePoint } from '@/lib/model-placement/rotation';
import { addTranslation, toRenderTranslation, type Translation } from '@/lib/model-placement/translation';
import { testPlacement } from '@/lib/model-placement/test-fixtures';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';
import { realignFederationModels } from '@/hooks/ingest/federationRealign';
import type { ModelGeoref } from '@/hooks/ingest/federationAlign';
import { applyRoomModelData } from '@/lib/collab/room-model-apply';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { convergeFederationRtcFrame } from '@/hooks/ingest/federationRtcRebase';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { setGlobalRendererRef } from '@/hooks/useBCF';
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

  const withInstanced = (id: string) => {
    const model = { ...fixtureModel(id), geometryResult: geometryResult() } as FederatedModel;
    model.geometryResult!.instancedGeometryHashes = new Map([[77, 1n]]);
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, [id, model]]) });
  };

  it('rotates a model with GPU-instanced geometry, atomically for a mixed selection (#4890)', () => {
    withInstanced('inst');
    useViewerStore.getState().setModelRotation(['ifc', 'inst'], { angle: ANGLE, pivot: [...PIVOT] });
    assert.ok(Math.abs(placementFor(useViewerStore.getState().modelPlacement, 'ifc').rotation.angle - ANGLE) < 1e-9);
    assert.ok(Math.abs(placementFor(useViewerStore.getState().modelPlacement, 'inst').rotation.angle - ANGLE) < 1e-9);
  });

  it('imports a placement manifest giving an instanced model a heading (#4890)', () => {
    withInstanced('inst');
    const state = useViewerStore.getState();
    const manifest = { version: 1 as const, units: 'm' as const, axes: 'engineering-z-up' as const, frameKey: placementFrameKey(state),
      models: [{ instanceId: 'inst', sourceContentHash: null, translation: [2.5, -1.25, 0] as Translation,
        rotation: { angle: ANGLE, pivot: [...PIVOT] as Translation }, locked: false }] };
    state.importModelPlacements(manifest, new Map([['inst', 'inst']]));
    const placed = placementFor(useViewerStore.getState().modelPlacement, 'inst');
    assert.deepEqual(placed.translation, [2.5, -1.25, 0]);
    assert.ok(Math.abs(placed.rotation.angle - ANGLE) < 1e-9);
  });

  describe('the bake pushes the renderer half of a heading and rebuilds the placed index (#4890)', () => {
    /** The corners of a unit box at `[dx, dx+1] x [0,1] x [0,1]`, in the
     *  renderer's own (already Y-up) frame — what `Scene.getAllInstancedMeshData`
     *  returns for one materialized occurrence. */
    function occurrenceBox(expressId: number, dx: number): MeshData {
      return {
        expressId, ifcType: 'IfcDoor',
        positions: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0,
          dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1]),
        normals: new Float32Array(24),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
          1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]),
        color: [1, 1, 1, 1],
      } as unknown as MeshData;
    }

    /** Render-frame yaw about the vertical axis through `(px, *, pz)` — the SAME
     *  sign `ModelTranslations.placeInstances`/`Scene.rotateMeshesForEntity`
     *  settle on (PR #4961). Written out independently, so this test's expected
     *  position is not derived from the code path it exercises. */
    function rotateRenderPoint(p: readonly [number, number, number], angle: number, px: number, pz: number): [number, number, number] {
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const dx = p[0] - px, dz = p[2] - pz;
      return [px + dx * cos + dz * sin, p[1], pz - dx * sin + dz * cos];
    }

    afterEach(() => setGlobalRendererRef({ current: null } as RefObject<Renderer | null>));

    it('pushes the render-frame pivot to the renderer before the index rebuild, and the rebuilt index answers at the turned occurrence (#4890)', async () => {
      const doorId = 5;
      // Far from `ifc`'s own [100..103]x[5]x[-40..-39] flat extent, so a stray
      // un-rotated hit or a wrong-model index cannot pass by coincidence.
      const originalDoor = occurrenceBox(doorId, 20);
      const calls: Array<{ index: number; angle: number; pivot: readonly [number, number, number] }> = [];
      let currentDoor: MeshData = originalDoor;
      const scene = { getAllInstancedMeshData: () => [currentDoor] };
      const fakeRenderer = {
        getScene: () => scene,
        // A real `Renderer.setModelRotation` rewrites the instance buffer
        // `getAllInstancedMeshData` reads SYNCHRONOUSLY, before returning —
        // this stub does the same, so `currentDoor` is at its turned
        // position for anything that reads the scene after this call, and at
        // its ORIGINAL position for anything that reads it before. That is
        // what lets the assertions below tell "before" from "after" apart.
        setModelRotation: (index: number, angle: number, pivot: readonly [number, number, number]) => {
          calls.push({ index, angle, pivot: [...pivot] as [number, number, number] });
          const rotatedCorners = [0, 1].flatMap((cx) => [0, 1].flatMap((cy) => [0, 1].map((cz) =>
            rotateRenderPoint([20 + cx, cy, cz], angle, pivot[0], pivot[2]))));
          currentDoor = { ...originalDoor, positions: new Float32Array(rotatedCorners.flat()) };
        },
      } as unknown as Renderer;
      setGlobalRendererRef({ current: fakeRenderer } as RefObject<Renderer | null>);

      const model = { ...fixtureModel('ifc'), geometryResult: geometryResult(), idOffset: 0, maxExpressId: 999 } as FederatedModel;
      useViewerStore.setState({ ...fixtureModels(model), modelPlacement: emptyPlacementState(), geometryContentVersion: 0 });

      useViewerStore.getState().setModelRotation(['ifc'], { angle: ANGLE, pivot: [...PIVOT] });
      assert.deepEqual(reconcileModelRotations(useViewerStore.getState()), ['ifc']);

      // The push happened synchronously, inside the same bake that then
      // rebuilds the index — `currentDoor` is proof either way: if the index
      // rebuild had read the scene BEFORE the push, the query below (posed at
      // the rotated position) would find nothing.
      assert.equal(calls.length, 1, 'setModelRotation must be pushed exactly once per bake');
      assert.equal(calls[0].index, 0);
      assert.ok(Math.abs(calls[0].angle - ANGLE) < 1e-9);
      assert.deepEqual(calls[0].pivot, toRenderTranslation(PIVOT), 'the pushed pivot must be the render-frame conversion, not the workspace point');

      // Independent oracle for the expected rotated position — the door's 8
      // corners, rotated about the SAME pivot/angle the renderer was told to
      // use, written out here rather than reused from the stub above.
      const rotatedCorners = [0, 1].flatMap((cx) => [0, 1].flatMap((cy) => [0, 1].map((cz) =>
        rotateRenderPoint([20 + cx, cy, cz], calls[0].angle, calls[0].pivot[0], calls[0].pivot[2]))));
      const min = [0, 1, 2].map((axis) => Math.min(...rotatedCorners.map((c) => c[axis])));
      const max = [0, 1, 2].map((axis) => Math.max(...rotatedCorners.map((c) => c[axis])));

      let index = useViewerStore.getState().models.get('ifc')!.ifcDataStore!.spatialIndex;
      for (let i = 0; i < 50 && !index; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        index = useViewerStore.getState().models.get('ifc')!.ifcDataStore!.spatialIndex;
      }
      assert.ok(index, 'the placed spatial index must have rebuilt after the bake');
      const hitRotated = index!.queryAABB({ min: min as [number, number, number], max: max as [number, number, number] });
      assert.ok(hitRotated.includes(doorId), `the rebuilt index must answer a query at the rotated occurrence; got ${hitRotated}`);
      const hitOriginal = index!.queryAABB({ min: [20, 0, 0], max: [21, 1, 1] });
      assert.ok(!hitOriginal.includes(doorId), 'a query at the pre-rotation position must not still hit — the fixture would not test rotation otherwise');
    });
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
