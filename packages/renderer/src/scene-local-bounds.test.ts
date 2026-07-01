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

  it('returns the shared template box for a GPU-instanced entity, as a copy', () => {
    const scene = new Scene();
    // Seed the private instancing state directly (GPU-buffer-agnostic data
    // side), mirroring scene-remove.test.ts's approach for boundingBoxes.
    scene['instancedTemplateCpu'] = [
      {
        positions: new Float32Array(),
        normals: new Float32Array(),
        indices: new Uint32Array(),
        instanceData: new ArrayBuffer(0),
        localMin: [0, 0, 0],
        localMax: [2, 2, 2],
      },
    ];
    scene['instancedEntityMap'] = new Map([
      [7, [{ templateIndex: 0, byteOffset: 0, originalColor: [0, 0, 0, 1] }]],
    ]);

    const bounds = scene.getEntityLocalBounds(7);
    assert.deepStrictEqual(bounds, { min: [0, 0, 0], max: [2, 2, 2] });

    // Regression: must be a copy, not the live template arrays — mutating the
    // result must not corrupt internal renderer state (Greptile P1).
    bounds!.min[0] = 999;
    const tmpl = scene['instancedTemplateCpu'][0];
    assert.strictEqual(tmpl.localMin[0], 0, 'mutating the returned box must not affect the template');
    assert.deepStrictEqual(scene.getEntityLocalBounds(7), { min: [0, 0, 0], max: [2, 2, 2] });
  });

  it('unions across occurrences backed by DIFFERENT templates (mapped-item sub-assembly)', () => {
    // One expressId, two occurrence records pointing at two distinct
    // templates — e.g. a mapped-item assembly split across materials.
    // Regression: the instanced path must union, not just read occurrences[0].
    const scene = new Scene();
    scene['instancedTemplateCpu'] = [
      {
        positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
        instanceData: new ArrayBuffer(0), localMin: [0, 0, 0], localMax: [1, 1, 1],
      },
      {
        positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
        instanceData: new ArrayBuffer(0), localMin: [-1, 0.5, 0], localMax: [0.5, 2, 1],
      },
    ];
    scene['instancedEntityMap'] = new Map([
      [9, [
        { templateIndex: 0, byteOffset: 0, originalColor: [0, 0, 0, 1] },
        { templateIndex: 1, byteOffset: 0, originalColor: [0, 0, 0, 1] },
      ]],
    ]);
    assert.deepStrictEqual(scene.getEntityLocalBounds(9), {
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

  it('returns the captured transform as a row-major Float64Array(16)', () => {
    const scene = new Scene();
    scene.addMeshData(makeMesh(4, { localToWorld: IDENTITY_ROW_MAJOR }));
    const transform = scene.getEntityTransform(4);
    assert.ok(transform instanceof Float64Array);
    assert.strictEqual(transform!.length, 16);
    assert.deepStrictEqual(Array.from(transform!), IDENTITY_ROW_MAJOR);
  });

  it('does not lose precision for a large-magnitude (georeferenced) translation', () => {
    // A translation far from the origin — the exact case f32 would corrupt
    // (sub-mm precision lost past a few hundred metres).
    const farTransform = [...IDENTITY_ROW_MAJOR];
    farTransform[3] = 123_456_789.123456; // translation X
    const scene = new Scene();
    scene.addMeshData(makeMesh(5, { localToWorld: farTransform }));
    const transform = scene.getEntityTransform(5);
    assert.strictEqual(transform![3], 123_456_789.123456);
  });

  it('reads a GPU-instanced occurrence transform, column-major -> row-major', () => {
    const scene = new Scene();
    // Column-major identity + translation (10, 20, 30), packed as the GPU
    // instance buffer stores it (mat4 at byte offset 0).
    const instanceData = new ArrayBuffer(64);
    const dv = new DataView(instanceData);
    // prettier-ignore
    const colMajor = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      10, 20, 30, 1,
    ];
    colMajor.forEach((v, i) => dv.setFloat32(i * 4, v, true));

    scene['instancedTemplateCpu'] = [
      {
        positions: new Float32Array(),
        normals: new Float32Array(),
        indices: new Uint32Array(),
        instanceData,
        localMin: [0, 0, 0],
        localMax: [1, 1, 1],
      },
    ];
    scene['instancedEntityMap'] = new Map([
      [8, [{ templateIndex: 0, byteOffset: 0, originalColor: [0, 0, 0, 1] }]],
    ]);

    const transform = scene.getEntityTransform(8);
    assert.deepStrictEqual(Array.from(transform!), [
      1, 0, 0, 10,
      0, 1, 0, 20,
      0, 0, 1, 30,
      0, 0, 0, 1,
    ]);
  });
});

describe('Scene splitMeshForStreaming', () => {
  it('preserves localBounds/localToWorld on every fragment of an oversized mesh', () => {
    // Regression: fragments used to carry origin forward but silently drop
    // localBounds/localToWorld, so getEntityLocalBounds/getEntityTransform
    // returned null for any element large enough to stream-split.
    const scene = new Scene();
    const TRIANGLE_COUNT = 70_000; // > STREAMING_FRAGMENT_MAX_INDICES/3 (60,000)
    const indices = new Uint32Array(TRIANGLE_COUNT * 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 3; // 3 shared vertices
    const big = makeMesh(6, {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices,
      origin: [5, 5, 5],
      localBounds: { min: [0, 0, 0], max: [1, 1, 0] },
      localToWorld: IDENTITY_ROW_MAJOR,
    });

    const fragments = scene['splitMeshForStreaming'](big) as MeshData[];
    assert.ok(fragments.length > 1, 'the mesh should actually split');
    for (const frag of fragments) {
      assert.deepStrictEqual(frag.localBounds, { min: [0, 0, 0], max: [1, 1, 0] });
      assert.deepStrictEqual(Array.from(frag.localToWorld!), IDENTITY_ROW_MAJOR);
    }
  });
});
