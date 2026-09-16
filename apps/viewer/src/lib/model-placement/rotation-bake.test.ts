/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { ModelRotationBaker, type RotationTarget } from './rotation-bake.js';
import { degreesToRadians, ZERO_ROTATION, type ModelRotation } from './rotation.js';
import type { Translation } from './translation.js';

const ROTATION: ModelRotation = { angle: degreesToRadians(30), pivot: [10, 4, 0] as Translation };
const OTHER: ModelRotation = { angle: degreesToRadians(-55), pivot: [10, 4, 0] as Translation };

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
    assert.deepEqual(baker.reconcile(targets(value, ROTATION), 1), ['m']);
    const after = snapshot(value);
    assert.notDeepEqual(after, before);
    // Same declared value again: nothing moved, nothing re-baked.
    assert.deepEqual(baker.reconcile(targets(value, ROTATION), 1), []);
    assert.deepEqual(snapshot(value), after);
  });

  it('spends nothing on an unrotated model', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const before = snapshot(value);
    assert.deepEqual(baker.reconcile(targets(value, ZERO_ROTATION), 1), []);
    assert.deepEqual(snapshot(value), before);
  });

  it('re-bakes from the pristine baseline when the angle changes, never from the last bake', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION), 1);
    baker.reconcile(targets(value, OTHER), 1);
    const direct = new ModelRotationBaker(), fresh = geometry();
    direct.reconcile(targets(fresh, OTHER), 1);
    for (let i = 0; i < snapshot(value).length; i += 1) {
      assert.ok(Math.abs(snapshot(value)[i] - snapshot(fresh)[i]) < 1e-3,
        `component ${i}: ${snapshot(value)[i]} vs ${snapshot(fresh)[i]} — the second angle compounded`);
    }
  });

  it('restores the pristine geometry when the rotation returns to zero', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const before = snapshot(value);
    baker.reconcile(targets(value, ROTATION), 1);
    assert.deepEqual(baker.reconcile(targets(value, ZERO_ROTATION), 1), ['m']);
    assert.deepEqual(snapshot(value), before);
  });

  it('treats a content-version bump it did not settle as somebody else rewriting the vertices', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION), 1);
    baker.settle(2);
    // Settled: the baker caused that bump, so the baked state still stands.
    assert.deepEqual(baker.reconcile(targets(value, ROTATION), 2), []);
    // Unsettled: an external rewrite. The contract is that such a rewrite
    // leaves the geometry un-rotated, so the declared angle is applied again.
    const external = snapshot(value);
    assert.deepEqual(baker.reconcile(targets(value, ROTATION), 3), ['m']);
    assert.notDeepEqual(snapshot(value), external);
  });

  it('drops a baseline when the model hands over a different geometry object', () => {
    const baker = new ModelRotationBaker(), first = geometry();
    baker.reconcile(targets(first, ROTATION), 1);
    const replacement = geometry();
    const pristine = snapshot(replacement);
    assert.deepEqual(baker.reconcile(targets(replacement, ROTATION), 1), ['m']);
    assert.notDeepEqual(snapshot(replacement), pristine);
    // The replacement was rotated from its OWN pristine bytes, not from the
    // first model's baseline.
    const control = new ModelRotationBaker(), fresh = geometry();
    control.reconcile(targets(fresh, ROTATION), 1);
    assert.deepEqual(snapshot(replacement), snapshot(fresh));
  });

  it('unbake restores every rotated model and forgets its baselines', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    const pristine = snapshot(value);
    baker.reconcile(targets(value, ROTATION), 1);
    assert.deepEqual(baker.unbake(() => value), ['m']);
    assert.deepEqual(snapshot(value), pristine);
    // Forgotten, so the next reconcile captures a fresh baseline from whatever
    // the re-align left behind rather than trusting a stale one.
    assert.deepEqual(baker.reconcile(targets(value, ROTATION), 1), ['m']);
  });

  it('unbake leaves a model alone once its geometry has been swapped out', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION), 1);
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

  it('does not re-rotate the meshes it already baked when a batch is appended in place', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION), 1);
    const bakedFirst = meshSnapshot(value, 0);
    // Exactly what `appendGeometryBatch` does: push onto the live array, wrap
    // it in a new object, leave the content version alone.
    value.meshes.push(streamedMesh());
    const appended = { ...value, meshes: value.meshes } as Geometry;
    assert.deepEqual(baker.reconcile(targets(appended, ROTATION), 1), ['m']);
    assert.deepEqual(meshSnapshot(appended, 0), bakedFirst,
      'the already-baked mesh was rotated a second time');
    // …and the mesh that arrived un-rotated is rotated exactly once.
    const control = new ModelRotationBaker();
    const fresh = geometry();
    fresh.meshes.push(streamedMesh());
    control.reconcile(targets(fresh, ROTATION), 1);
    assert.deepEqual(meshSnapshot(appended, 1), meshSnapshot(fresh, 1));
  });

  it('does not put back vertices a bounded-mode release has freed', () => {
    const baker = new ModelRotationBaker(), value = geometry();
    baker.reconcile(targets(value, ROTATION), 1);
    // `releaseGeometryMemory` swaps every mesh's buffers for empty ones and
    // republishes the geometry, in place and without a version bump.
    value.meshes[0].positions = new Float32Array(0);
    value.meshes[0].normals = new Float32Array(0);
    const released = { ...value, meshes: value.meshes } as Geometry;
    baker.reconcile(targets(released, OTHER), 1);
    assert.equal(released.meshes[0].positions.length, 0,
      'the bake resurrected buffers the release had freed');
  });
});
