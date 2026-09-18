/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { ModelRotationBaker, type RotationTarget } from './rotation-bake.js';
import type { MeshPrune } from './rotation-baseline.js';
import { degreesToRadians, ZERO_ROTATION, type ModelRotation } from './rotation.js';
import type { Translation } from './translation.js';

const ROTATION: ModelRotation = { angle: degreesToRadians(30), pivot: [10, 4, 0] as Translation };
const OTHER: ModelRotation = { angle: degreesToRadians(-55), pivot: [10, 4, 0] as Translation };
/** Non-round angle, off-origin pivot: no term can cancel by symmetry. */
const SKEW: ModelRotation = { angle: degreesToRadians(37.4), pivot: [13.7, -4.9, 0] as Translation };

type Geometry = Pick<GeometryResult, 'meshes' | 'coordinateInfo' | 'instancedGeometryAabbs'>;

function geometry(): Geometry {
  return {
    meshes: [{ expressId: 1, positions: new Float32Array([0, 0, 0, 3, 0, 0, 3, 0, 1]),
      normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1], origin: [100, 5, -40] } as MeshData],
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 100, y: 5, z: -40 }, max: { x: 103, y: 5, z: -39 } },
      hasLargeCoordinates: false },
  } as unknown as Geometry;
}

const snapshot = (value: Geometry) => [...value.meshes[0].positions, ...(value.meshes[0].origin ?? [])];
const targets = (value: Geometry, rotation: ModelRotation): ReadonlyMap<string, RotationTarget> =>
  new Map([['m', { geometry: value, rotation }]]);

describe('ModelRotationBaker', () => {
  it('bakes a declared rotation once and reports the model as moved', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const before = snapshot(value);
    assert.deepEqual(baker.reconcile(targets(value, ROTATION)), ['m']);
    const after = snapshot(value);
    assert.notDeepEqual(after, before);
    // Same declared value again: nothing moved, nothing re-baked.
    assert.deepEqual(baker.reconcile(targets(value, ROTATION)), []);
    assert.deepEqual(snapshot(value), after);
  });

  it('spends nothing on an unrotated model', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const before = snapshot(value);
    assert.deepEqual(baker.reconcile(targets(value, ZERO_ROTATION)), []);
    assert.deepEqual(snapshot(value), before);
  });

  it('re-bakes from the pristine baseline when the angle changes, never from the last bake', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION));
    baker.reconcile(targets(value, OTHER));
    const direct = new ModelRotationBaker(), fresh = geometry();
    direct.reconcile(targets(fresh, OTHER));
    for (let i = 0; i < snapshot(value).length; i += 1) {
      assert.ok(Math.abs(snapshot(value)[i] - snapshot(fresh)[i]) < 1e-3,
        `component ${i}: ${snapshot(value)[i]} vs ${snapshot(fresh)[i]} — the second angle compounded`);
    }
  });

  it('restores the pristine geometry when the rotation returns to zero', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const before = snapshot(value);
    baker.reconcile(targets(value, ROTATION));
    assert.deepEqual(baker.reconcile(targets(value, ZERO_ROTATION)), ['m']);
    assert.deepEqual(snapshot(value), before);
  });

  it('keeps an untouched model\'s baseline when another model\'s geometry is replaced', () => {
    const baker = new ModelRotationBaker(), kept = geometry(), other = geometry();
    const both = (second: Geometry) => new Map([['m', { geometry: kept, rotation: ROTATION }],
      ['n', { geometry: second, rotation: ROTATION }]]);
    baker.reconcile(both(other));
    const rotated = snapshot(kept);
    assert.deepEqual(baker.reconcile(both(geometry())), ['n']);
    assert.deepEqual(snapshot(kept), rotated, 'the untouched model was turned a second time');
  });

  it('drops a baseline when the model hands over a different geometry object', () => {
    const baker = new ModelRotationBaker(), first = geometry();
    baker.reconcile(targets(first, ROTATION));
    const replacement = geometry();
    const pristine = snapshot(replacement);
    assert.deepEqual(baker.reconcile(targets(replacement, ROTATION)), ['m']);
    assert.notDeepEqual(snapshot(replacement), pristine);
    // The replacement was rotated from its OWN pristine bytes, not from the
    // first model's baseline.
    const control = new ModelRotationBaker(), fresh = geometry();
    control.reconcile(targets(fresh, ROTATION));
    assert.deepEqual(snapshot(replacement), snapshot(fresh));
  });

  it('unbake restores every rotated model and forgets its baselines', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const pristine = snapshot(value);
    baker.reconcile(targets(value, ROTATION));
    assert.deepEqual(baker.unbake(() => value), ['m']);
    assert.deepEqual(snapshot(value), pristine);
    // Forgotten, so the next reconcile captures a fresh baseline from whatever
    // the re-align left behind rather than trusting a stale one.
    assert.deepEqual(baker.reconcile(targets(value, ROTATION)), ['m']);
  });

  it('unbake leaves a model alone once its geometry has been swapped out', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION));
    const rotated = snapshot(value);
    assert.deepEqual(baker.unbake(() => geometry()), []);
    assert.deepEqual(snapshot(value), rotated);
  });

  // Streaming appends to the SAME mesh array and wraps it in a new
  // `geometryResult` object without bumping the content version — see
  // `appendGeometryBatch`. Rotate while a large model is still streaming and
  // every later batch arrives this way.
  const streamedMesh = (): MeshData => ({ expressId: 2,
    positions: new Float32Array([1.37, 0.42, -2.09, 4.73, 0.42, -2.09, 4.73, 3.11, 0.66]),
    normals: new Float32Array([0, 0.6, 0.8, 0, 0.6, 0.8, 0, 0.6, 0.8]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
    origin: [117.31, 5.25, -38.47] } as unknown as MeshData);
  const meshSnapshot = (value: Geometry, index: number) =>
    [...value.meshes[index].positions, ...(value.meshes[index].normals ?? []),
      ...(value.meshes[index].origin ?? [])];

  it('hands an authoring path a baked mesh in its unrotated frame, so a copy is turned once (#4873)', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const pristine = meshSnapshot(value, 0);
    baker.reconcile(targets(value, ROTATION));
    const source = value.meshes[0], baked = meshSnapshot(value, 0);
    const view = baker.inModelFrame(source);
    assert.deepEqual([...view.positions, ...(view.normals ?? []), ...(view.origin ?? [])], pristine);
    // Copies: the bake rewrites buffers in place, and must not reach the baseline through a clone.
    assert.notEqual(view.positions, source.positions);
    assert.notEqual(view.normals, source.normals);
    // Appended the way duplicate appends it, the copy lands exactly on its source.
    value.meshes.push({ ...view, expressId: 7 });
    assert.deepEqual(baker.reconcile(targets({ ...value, meshes: value.meshes } as Geometry, ROTATION)), ['m']);
    assert.deepEqual(meshSnapshot(value, 1), baked, 'the copy was turned twice');
    // Never baked: the live bytes already are the model frame.
    const unrotated = geometry();
    assert.deepEqual(meshSnapshot({ meshes: [new ModelRotationBaker().inModelFrame(unrotated.meshes[0])] } as Geometry, 0),
      meshSnapshot(unrotated, 0));
  });

  it('does not re-rotate the meshes it already baked when a batch is appended in place', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION));
    const bakedFirst = meshSnapshot(value, 0);
    // Exactly what `appendGeometryBatch` does: push onto the live array, wrap
    // it in a new object, leave the content version alone.
    value.meshes.push(streamedMesh());
    const appended = { ...value, meshes: value.meshes } as Geometry;
    assert.deepEqual(baker.reconcile(targets(appended, ROTATION)), ['m']);
    assert.deepEqual(meshSnapshot(appended, 0), bakedFirst,
      'the already-baked mesh was rotated a second time');
    // …and the mesh that arrived un-rotated is rotated exactly once.
    const control = new ModelRotationBaker();
    const fresh = geometry();
    fresh.meshes.push(streamedMesh());
    control.reconcile(targets(fresh, ROTATION));
    assert.deepEqual(meshSnapshot(appended, 1), meshSnapshot(fresh, 1));
  });

  it('keeps a baseline that still describes some of the republished meshes', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const kept = value.meshes[0];
    baker.reconcile(targets(value, ROTATION));
    const bakedKept = meshSnapshot(value, 0);
    // Partial overlap: the baselined mesh object survives into a NEW array
    // beside a mesh this baseline has never seen.
    const partial = { ...value, meshes: [kept, streamedMesh()] } as Geometry;
    assert.deepEqual(baker.reconcile(targets(partial, ROTATION)), ['m']);
    assert.deepEqual(meshSnapshot(partial, 0), bakedKept,
      'the surviving mesh was re-rotated instead of restored and re-baked');
    const control = new ModelRotationBaker(), fresh = geometry();
    fresh.meshes.push(streamedMesh());
    control.reconcile(targets(fresh, ROTATION));
    assert.deepEqual(meshSnapshot(partial, 1), meshSnapshot(fresh, 1),
      'the newly arrived mesh was not rotated exactly once');
  });

  const instanced = (min: number[], max: number[]) =>
    new Map([[99, { min, max }]]) as unknown as GeometryResult['instancedGeometryAabbs'];

  it('does not hand a replaced model the vanished model\'s instanced boxes', () => {
    const baker = new ModelRotationBaker(), first = geometry();
    first.instancedGeometryAabbs = instanced([1.37, 0.24, 2.71], [5.19, 3.46, 9.63]);
    baker.reconcile(targets(first, ROTATION));
    // A collab replacement: a whole new geometry with no mesh in common, and
    // instanced boxes of its own that the stale baseline must not overwrite.
    const replacement = geometry();
    replacement.instancedGeometryAabbs = instanced([-7.21, 1.13, -3.48], [-2.64, 4.82, 0.97]);
    const control = new ModelRotationBaker(), fresh = geometry();
    fresh.instancedGeometryAabbs = instanced([-7.21, 1.13, -3.48], [-2.64, 4.82, 0.97]);
    control.reconcile(targets(fresh, ROTATION));
    assert.deepEqual(baker.reconcile(targets(replacement, ROTATION)), ['m']);
    assert.deepEqual(replacement.instancedGeometryAabbs, fresh.instancedGeometryAabbs,
      'the replacement inherited the vanished model\'s instanced boxes');
  });

  it('adopts instanced boxes installed after the bake and turns them exactly once', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION));
    // Streaming completion: the loader republishes the SAME meshes with the
    // accumulated instanced-only boxes, which have never been rotated.
    const completed = { ...value, instancedGeometryAabbs: instanced([1.37, 0.24, 2.71], [5.19, 3.46, 9.63]) } as Geometry;
    assert.deepEqual(baker.reconcile(targets(completed, ROTATION)), ['m']);
    const control = (rotation: ModelRotation) => {
      const fresh = geometry();
      fresh.instancedGeometryAabbs = instanced([1.37, 0.24, 2.71], [5.19, 3.46, 9.63]);
      new ModelRotationBaker().reconcile(targets(fresh, rotation));
      return fresh.instancedGeometryAabbs;
    };
    assert.deepEqual(completed.instancedGeometryAabbs, control(ROTATION), 'the installed boxes were not rotated once');
    // The next bake restores from the baseline: it must not drop them.
    baker.reconcile(targets(completed, OTHER));
    assert.deepEqual(completed.instancedGeometryAabbs, control(OTHER), 'a later bake dropped or compounded the installed boxes');
  });

  it('does not put back vertices a bounded-mode release has freed', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION));
    // `releaseGeometryMemory` swaps every mesh's buffers for empty ones and
    // republishes the geometry, in place and without a version bump.
    value.meshes[0].positions = new Float32Array(0);
    value.meshes[0].normals = new Float32Array(0);
    const released = { ...value, meshes: value.meshes } as Geometry;
    baker.reconcile(targets(released, OTHER));
    assert.equal(released.meshes[0].positions.length, 0,
      'the bake resurrected buffers the release had freed');
    assert.equal(released.meshes[0].normals.length, 0,
      'the bake resurrected the normal buffer the release had freed');
  });

  /** Every field a bake can restore, all off-axis and non-round: a partial or
   * dropped restore cannot land on the right number by luck. */
  const releasableMesh = (): MeshData => ({ expressId: 7,
    positions: new Float32Array([0.37, 0.19, -0.84, 2.61, 0.19, -0.84, 2.61, 1.73, 0.46]),
    normals: new Float32Array([0.6, 0, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
    origin: [418.63, 7.41, -253.19],
    geometryAabb: { min: [419, 7.6, -254.03], max: [421.24, 9.14, -252.73] },
    localToWorld: [1, 0, 0, 418.63, 0, 1, 0, 7.41, 0, 0, 1, -253.19, 0, 0, 0, 1],
  } as unknown as MeshData);

  const releasable = (): Geometry => ({ ...geometry(), meshes: [releasableMesh()] } as Geometry);
  const placement = (value: Geometry) => ({ origin: value.meshes[0].origin,
    localToWorld: value.meshes[0].localToWorld, geometryAabb: value.meshes[0].geometryAabb });
  /** In place and without a version bump, exactly as `releaseGeometryMemory`
   * does it: the buffers go, the placement fields are left alone. */
  const release = (value: Geometry): Geometry => {
    value.meshes[0].positions = new Float32Array(0);
    value.meshes[0].normals = new Float32Array(0);
    return { ...value, meshes: value.meshes } as Geometry;
  };

  it('restores a released mesh\'s placement, which the release never freed', () => {
    const baker = new ModelRotationBaker(), value = releasable();
    const pristine = structuredClone(placement(value));
    baker.reconcile(targets(value, SKEW));
    assert.notDeepEqual(placement(value), pristine, 'the fixture must move under this rotation');
    assert.deepEqual(baker.reconcile(targets(release(value), ZERO_ROTATION)), ['m']);
    assert.equal(value.meshes[0].positions.length, 0, 'the bake resurrected freed buffers');
    // The baseline is dropped at zero, so a placement left rotated here is
    // unrecoverable — a silent, permanent error while the UI reports 0°.
    assert.deepEqual(placement(value), pristine, 'the released mesh kept its rotated placement');
  });

  it('re-bakes a released mesh from its pristine placement rather than compounding', () => {
    const baker = new ModelRotationBaker(), value = releasable();
    baker.reconcile(targets(value, SKEW));
    baker.reconcile(targets(release(value), OTHER));
    // Straight to OTHER from pristine is where the released mesh must land.
    const control = new ModelRotationBaker(), fresh = releasable();
    control.reconcile(targets(fresh, OTHER));
    assert.deepEqual(placement(value), placement(fresh));
  });

  /**
   * #4935: a split or a delete drops a mesh out of `geometryResult.meshes`
   * (`pruneGeometryMeshes` / `store/slices/data-mesh-prune.ts`). The baseline is
   * then the only thing still holding that mesh's pristine copy and its share
   * of the model's pristine extent.
   */
  describe('pruneMeshes', () => {
    const placedMesh = (expressId: number, x: number, length: number): MeshData => ({
      expressId, positions: new Float32Array([0, 0, 0, length, 0, 0, length, 0, 1]),
      normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1], origin: [x, 5, -40],
    } as unknown as MeshData);

    /** Two meshes far apart, under the loader's OWN declared extent spanning
     * both — the bounds a capture clones, not something re-measured. */
    const spread = (): Geometry => ({
      meshes: [placedMesh(1, 100, 3), placedMesh(2, 400, 2)],
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
        shiftedBounds: { min: { x: 100, y: 5, z: -40 }, max: { x: 402, y: 5, z: -39 } },
        hasLargeCoordinates: false },
    } as unknown as Geometry);

    /** What `pruneMeshesFromGeometry` hands the baker: the ids, its own
     * removal rule, and the pruned geometry object it published. */
    const drain = (ids: number[], replacements: Array<[Geometry, Geometry]> = []): MeshPrune => ({
      ids: new Set(ids), removes: (mesh) => ids.includes(mesh.expressId),
      replacements: new Map(replacements),
    });
    /** The prune republishes the geometry as a NEW object holding the same
     * surviving mesh objects. */
    const withoutIds = (value: Geometry, ids: number[]): Geometry => ({ ...value,
      meshes: value.meshes.filter((mesh) => !ids.includes(mesh.expressId)) } as Geometry);

    it('releases the pruned mesh\'s pristine copy', () => {
      const baker = new ModelRotationBaker(), value = spread();
      baker.reconcile(targets(value, SKEW));
      const gone = value.meshes[1];
      const pristine = [...baker.inModelFrame(gone).positions];
      assert.notDeepEqual(pristine, [...gone.positions], 'the fixture must actually be baked');

      baker.pruneMeshes(drain([2], [[value, withoutIds(value, [2])]]));

      // Nothing on offer for a mesh that no longer exists: the copy is gone,
      // and `inModelFrame` falls back to the live bytes.
      assert.deepEqual([...baker.inModelFrame(gone).positions], [...gone.positions],
        'the baseline still holds the pruned mesh\'s pristine buffers');
    });

    it('re-measures the pristine extent, so a 0° bake cannot restore the pruned mesh\'s bounds', () => {
      const baker = new ModelRotationBaker(), value = spread();
      baker.reconcile(targets(value, SKEW));
      const next = withoutIds(value, [2]);
      baker.pruneMeshes(drain([2], [[value, next]]));

      assert.deepEqual(baker.reconcile(targets(next, ZERO_ROTATION)), ['m']);
      assert.deepEqual(next.coordinateInfo.shiftedBounds,
        { min: { x: 100, y: 5, z: -40 }, max: { x: 103, y: 5, z: -39 } },
        'the restored extent still covers the deleted mesh');
    });

    it('keeps a colour-merged mesh the prune itself keeps', () => {
      const baker = new ModelRotationBaker(), value = spread();
      baker.reconcile(targets(value, SKEW));
      const kept = value.meshes[1];
      const pristine = [...baker.inModelFrame(kept).positions];
      // The renderer keeps a mesh that hosts OTHER entities, so `removes` says
      // no for it even though its id is in the drain.
      baker.pruneMeshes({ ...drain([2]), removes: () => false });
      assert.deepEqual([...baker.inModelFrame(kept).positions], pristine,
        'a mesh the prune kept lost its baseline');
      // Nothing was removed, so the pristine extent is left exactly as declared
      // rather than re-measured off the vertices.
      baker.reconcile(targets(value, ZERO_ROTATION));
      assert.deepEqual(value.coordinateInfo.shiftedBounds,
        { min: { x: 100, y: 5, z: -40 }, max: { x: 402, y: 5, z: -39 } });
    });

    it('drops the whole baseline when every mesh it described is pruned', () => {
      const baker = new ModelRotationBaker(), value = spread();
      baker.reconcile(targets(value, SKEW));
      const emptied = withoutIds(value, [1, 2]);
      baker.pruneMeshes(drain([1, 2], [[value, emptied]]));
      // No baseline left, so a model that streams in again is baked from its
      // own pristine bytes rather than from an extent-less stale copy.
      const restreamed = spread();
      assert.deepEqual(baker.reconcile(targets(restreamed, SKEW)), ['m']);
      const control = new ModelRotationBaker(), fresh = spread();
      control.reconcile(targets(fresh, SKEW));
      assert.deepEqual(restreamed.coordinateInfo.shiftedBounds, fresh.coordinateInfo.shiftedBounds);
    });

    it('follows the model onto the pruned geometry object so unbake still restores it', () => {
      const baker = new ModelRotationBaker(), value = spread();
      const pristine = meshSnapshot(value, 0);
      baker.reconcile(targets(value, SKEW));
      const next = withoutIds(value, [2]);
      baker.pruneMeshes(drain([2], [[value, next]]));
      // The store now holds `next`; an identity check against the pre-prune
      // object would silently skip the un-bake a re-align depends on.
      assert.deepEqual(baker.unbake(() => next), ['m']);
      assert.deepEqual(meshSnapshot(next, 0), pristine);
    });

    it('does not turn the instanced boxes twice across a prune', () => {
      const baker = new ModelRotationBaker(), value = spread();
      value.instancedGeometryAabbs = instanced([1.37, 0.24, 2.71], [5.19, 3.46, 9.63]);
      baker.reconcile(targets(value, SKEW));
      // The prune copies the instanced maps to drop pruned ids; the copy holds
      // boxes this baker already turned.
      const next = { ...withoutIds(value, [2]),
        instancedGeometryAabbs: new Map(value.instancedGeometryAabbs) } as Geometry;
      baker.pruneMeshes(drain([2], [[value, next]]));
      baker.reconcile(targets(next, SKEW));
      const control = new ModelRotationBaker(), fresh = spread();
      fresh.instancedGeometryAabbs = instanced([1.37, 0.24, 2.71], [5.19, 3.46, 9.63]);
      control.reconcile(targets(fresh, SKEW));
      assert.deepEqual(next.instancedGeometryAabbs, fresh.instancedGeometryAabbs,
        'the instanced boxes were rotated a second time after the prune');
    });
  });
});
