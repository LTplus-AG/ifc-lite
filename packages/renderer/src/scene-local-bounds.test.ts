/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * `getEntityLocalBounds` / `getEntityTransform` (issue #1474) are GPU-buffer-
 * agnostic — they read straight off `meshDataMap`, so exercised here without a
 * GPUDevice, mirroring `scene-remove.test.ts`'s approach.
 */

const IDENTITY_ROW_MAJOR = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function makeMesh(expressId: number, overrides: Partial<MeshData> = {}): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 1, 1]),
    normals: new Float32Array([0, 0, 0, 1, 1, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0, 0, 0, 1],
    ...overrides,
  } as unknown as MeshData;
}

describe('Scene.getEntityLocalBounds', () => {
  it('returns null when no mesh exists for the entity', () => {
    const scene = new Scene();
    assert.strictEqual(scene.getEntityLocalBounds(123), null);
  });

  it('returns null when the mesh has no captured localBounds', () => {
    const scene = new Scene();
    scene.addMeshData(makeMesh(1));
    assert.strictEqual(scene.getEntityLocalBounds(1), null);
  });

  it('returns the captured box for a single-piece entity', () => {
    const scene = new Scene();
    scene.addMeshData(
      makeMesh(2, { localBounds: { min: [0, 0, 0], max: [2, 3, 4] } }),
    );
    assert.deepStrictEqual(scene.getEntityLocalBounds(2), {
      min: [0, 0, 0],
      max: [2, 3, 4],
    });
  });

  it('unions localBounds across a multi-piece entity', () => {
    const scene = new Scene();
    // Same expressId, two pieces (e.g. material-layer split) — every piece of
    // one element shares the local frame, so a plain union is correct.
    scene.addMeshData(
      makeMesh(3, { geometryItemId: 1, localBounds: { min: [0, 0, 0], max: [1, 1, 1] } } as Partial<MeshData>),
    );
    scene.addMeshData(
      makeMesh(3, { geometryItemId: 2, localBounds: { min: [-1, 0.5, 0], max: [0.5, 2, 1] } } as Partial<MeshData>),
    );
    assert.deepStrictEqual(scene.getEntityLocalBounds(3), {
      min: [-1, 0, 0],
      max: [1, 2, 1],
    });
  });
});

describe('Scene.getEntityTransform', () => {
  it('returns null when no mesh exists for the entity', () => {
    const scene = new Scene();
    assert.strictEqual(scene.getEntityTransform(123), null);
  });

  it('returns null when the mesh has no captured localToWorld', () => {
    const scene = new Scene();
    scene.addMeshData(makeMesh(1));
    assert.strictEqual(scene.getEntityTransform(1), null);
  });

  it('returns the captured transform as a row-major Float32Array(16)', () => {
    const scene = new Scene();
    scene.addMeshData(makeMesh(4, { localToWorld: IDENTITY_ROW_MAJOR }));
    const transform = scene.getEntityTransform(4);
    assert.ok(transform instanceof Float32Array);
    assert.strictEqual(transform!.length, 16);
    assert.deepStrictEqual(Array.from(transform!), IDENTITY_ROW_MAJOR);
  });
});
