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
});
