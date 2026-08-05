/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streaming batch sizing + WASM MeshCollection → MeshData conversion.
 *
 * `convertMeshCollectionToBatch` is the single-threaded mesh-extraction path
 * (`index.ts`); everything it drops on the floor — a per-element origin, a
 * local box, a placement matrix, a texture — is lost silently, showing up only
 * as geometry in the wrong place or shaded wrong.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  getStreamingBatchSize,
  convertMeshCollectionToBatch,
  withBuildingRotation,
} from './geometry-coordinate.js';
import type { CoordinateInfo } from './types.js';

describe('getStreamingBatchSize', () => {
  const buffer = new Uint8Array(0);

  // No buffer length can produce 7 — every measured bracket returns one of
  // 100/200/300/500/1500/3000 — so the assertion, not the buffer's size,
  // carries the "ignores the buffer" claim. Allocating a large buffer here
  // would only add memory pressure in parallel workers.
  it('returns a numeric config verbatim, ignoring the buffer', () => {
    expect(getStreamingBatchSize(buffer, 7)).toBe(7);
  });

  // Every bracket asserted with a value on each side of its boundary — a
  // single sample per bracket lets one lucky case carry the whole ladder.
  it.each([
    [0, 100],
    [9.9, 100],
    [10, 200],
    [49.9, 200],
    [50, 300],
    [99.9, 300],
    [100, 500],
    [299.9, 500],
    [300, 1500],
    [499.9, 1500],
    [500, 3000],
    [5000, 3000],
  ])('maps %s MB to a batch of %s', (fileSizeMB, expected) => {
    expect(getStreamingBatchSize(buffer, { fileSizeMB })).toBe(expected);
  });

  it('derives the file size from the buffer when the config omits it', () => {
    // 60 MB → the 50–100 MB bracket.
    expect(getStreamingBatchSize(new Uint8Array(60 * 1024 * 1024), {})).toBe(300);
  });

  it('treats a zero fileSizeMB as absent and measures the buffer', () => {
    // `fileSizeMB: 0` is falsy, so the buffer length decides: 200 MB → 500.
    expect(
      getStreamingBatchSize(new Uint8Array(200 * 1024 * 1024), { fileSizeMB: 0 })
    ).toBe(500);
  });
});

describe('withBuildingRotation', () => {
  const base: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
  };

  it('attaches the rotation without mutating the input', () => {
    const out = withBuildingRotation(base, 1.25);

    expect(out.buildingRotation).toBe(1.25);
    expect(out).not.toBe(base);
    expect(base).not.toHaveProperty('buildingRotation');
  });

  // Zero is a meaningful rotation (explicitly north-aligned) and is falsy;
  // only `undefined` means "not resolved".
  it('attaches a zero rotation', () => {
    expect(withBuildingRotation(base, 0).buildingRotation).toBe(0);
  });

  it('returns the input untouched when the rotation is undefined', () => {
    expect(withBuildingRotation(base, undefined)).toBe(base);
  });
});

// ── convertMeshCollectionToBatch ──

interface FakeMesh {
  expressId: number;
  ifcType: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: Float32Array;
  free: () => void;
  [k: string]: unknown;
}

function fakeMesh(overrides: Partial<FakeMesh> & { expressId: number }): FakeMesh {
  return {
    ifcType: 'IfcWall',
    positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
    indices: new Uint32Array([0]),
    color: new Float32Array([1, 1, 1, 1]),
    free: vi.fn(),
    ...overrides,
  } as FakeMesh;
}

function fakeCollection(meshes: (FakeMesh | null)[], extra: Record<string, unknown> = {}) {
  return {
    length: meshes.length,
    get: (i: number) => meshes[i],
    free: vi.fn(),
    ...extra,
  };
}

// The fakes are structural stand-ins for the WASM `MeshCollection`; cast to
// the parameter's own type (not `any`) so the call site stays type-checked.
const asCollection = (c: unknown) => c as Parameters<typeof convertMeshCollectionToBatch>[0];

describe('convertMeshCollectionToBatch', () => {
  it('frees every mesh and the collection itself', () => {
    const meshes = [fakeMesh({ expressId: 1 }), fakeMesh({ expressId: 2 })];
    const collection = fakeCollection(meshes);

    convertMeshCollectionToBatch(asCollection(collection));

    expect(meshes[0].free).toHaveBeenCalledTimes(1);
    expect(meshes[1].free).toHaveBeenCalledTimes(1);
    expect(collection.free).toHaveBeenCalledTimes(1);
  });

  // `collection.get` throws before any mesh exists, so only the outer
  // `finally { collection.free() }` can run here — the per-mesh cleanup is
  // covered by the next test.
  it('frees the collection when the collection getter itself throws', () => {
    const collection = fakeCollection([], {
      length: 1,
      get: () => {
        throw new Error('boom');
      },
    });

    expect(() => convertMeshCollectionToBatch(asCollection(collection))).toThrow('boom');
    expect(collection.free).toHaveBeenCalledTimes(1);
  });

  // The mesh IS handed out and then throws mid-conversion: without the inner
  // `finally { mesh.free() }` the WASM mesh leaks on every partial failure,
  // and the collection-level free below would not catch it.
  it('frees the mesh AND the collection when a mesh getter throws mid-conversion', () => {
    const free = vi.fn();
    const mesh = {
      ...fakeMesh({ expressId: 1 }),
      free,
      // `color` is read after the mesh is in hand but before it is pushed.
      get color(): Float32Array {
        throw new Error('mesh boom');
      },
    };
    const collection = fakeCollection([], { length: 1, get: () => mesh });

    expect(() => convertMeshCollectionToBatch(asCollection(collection))).toThrow('mesh boom');
    expect(free).toHaveBeenCalledTimes(1);
    expect(collection.free).toHaveBeenCalledTimes(1);
  });

  it('skips null mesh slots', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(fakeCollection([null, fakeMesh({ expressId: 9 })]))
    );

    expect(batch.map((m) => m.expressId)).toEqual([9]);
  });

  it('copies the colour out of the WASM view into a plain tuple', () => {
    const color = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const batch = convertMeshCollectionToBatch(
      asCollection(fakeCollection([fakeMesh({ expressId: 1, color })]))
    );

    expect(batch[0].color).toEqual([
      color[0], color[1], color[2], color[3],
    ]);
    expect(Array.isArray(batch[0].color)).toBe(true);
  });

  // The origin guard is `originArr[0] || originArr[1] || originArr[2]` — ANY
  // non-zero component means the element has a local frame. Requiring all
  // three (a plausible slip) drops every axis-aligned origin, and the geometry
  // then renders at the world origin instead of its placement.
  it.each([
    [[0, 0, 5000], [0, 0, 5000]],
    [[5000, 0, 0], [5000, 0, 0]],
    [[0, 5000, 0], [0, 5000, 0]],
    [[1, 2, 3], [1, 2, 3]],
  ])('keeps a local origin with only some axes set: %j', (origin, expected) => {
    const batch = convertMeshCollectionToBatch(
      asCollection(fakeCollection([fakeMesh({ expressId: 1, origin })]))
    );

    expect(batch[0].origin).toEqual(expected);
  });

  it('omits an all-zero origin (absolute positions)', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(fakeCollection([fakeMesh({ expressId: 1, origin: [0, 0, 0] })]))
    );

    expect(batch[0].origin).toBeUndefined();
  });

  it('omits the origin when the getter is absent or the wrong arity', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({ expressId: 1 }),
          fakeMesh({ expressId: 2, origin: [1, 2] }),
        ])
      )
    );

    expect(batch[0].origin).toBeUndefined();
    expect(batch[1].origin).toBeUndefined();
  });

  it('carries the local bounds split at min/max, and only at full arity', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({ expressId: 1, localBounds: [-1, -2, -3, 4, 5, 6] }),
          fakeMesh({ expressId: 2, localBounds: [-1, -2, -3, 4, 5] }),
        ])
      )
    );

    expect(batch[0].localBounds).toEqual({ min: [-1, -2, -3], max: [4, 5, 6] });
    expect(batch[1].localBounds).toBeUndefined();
  });

  it('carries a 16-element placement matrix as a plain array, in order', () => {
    const m = Array.from({ length: 16 }, (_, i) => i + 1);
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({ expressId: 1, localToWorld: new Float32Array(m) }),
          fakeMesh({ expressId: 2, localToWorld: new Float32Array(15) }),
        ])
      )
    );

    expect(batch[0].localToWorld).toEqual(m);
    expect(batch[1].localToWorld).toBeUndefined();
  });

  it('defaults the geometry class to 0 (Model) when the getter is absent', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({ expressId: 1 }),
          fakeMesh({ expressId: 2, geometryClass: 1 }),
        ])
      )
    );

    expect(batch[0].geometryClass).toBe(0);
    expect(batch[1].geometryClass).toBe(1);
  });

  it('carries a four-component shading colour, and drops a mis-sized one', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({ expressId: 1, shadingColor: [0.1, 0.2, 0.3, 0.4] }),
          fakeMesh({ expressId: 2, shadingColor: [0.1, 0.2, 0.3] }),
          fakeMesh({ expressId: 3 }),
        ])
      )
    );

    expect(batch[0].shadingColor).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(batch[1].shadingColor).toBeUndefined();
    expect(batch[2].shadingColor).toBeUndefined();
  });

  it('copies an embedded texture with its uvs and repeat factors', () => {
    const uvs = new Float32Array([0, 0, 1, 1]);
    const rgba = new Uint8Array([255, 0, 0, 255]);
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({
            expressId: 1,
            hasTexture: true,
            uvs,
            textureRgba: rgba,
            textureWidth: 1,
            textureHeight: 1,
            textureRepeatS: 2,
            textureRepeatT: 3,
          }),
        ])
      )
    );

    expect(batch[0].uvs).toBe(uvs);
    expect(batch[0].texture).toEqual({
      rgba,
      width: 1,
      height: 1,
      repeatS: 2,
      repeatT: 3,
    });
    expect(batch[0].textureRef).toBeUndefined();
  });

  it('prefers the embedded texture over an external reference', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({
            expressId: 1,
            hasTexture: true,
            uvs: new Float32Array([0, 0]),
            textureRgba: new Uint8Array([1, 2, 3, 4]),
            textureWidth: 1,
            textureHeight: 1,
            textureRepeatS: 1,
            textureRepeatT: 1,
            textureId: 5,
            textureUrl: 'images/wall.png',
          }),
        ])
      )
    );

    expect(batch[0].texture).toBeDefined();
    expect(batch[0].textureRef).toBeUndefined();
  });

  it('carries an external texture reference when no pixels were decoded', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(
        fakeCollection([
          fakeMesh({
            expressId: 1,
            uvs: new Float32Array([0, 0]),
            textureId: 5,
            textureUrl: 'images/wall.png',
            textureRepeatS: 4,
            textureRepeatT: 5,
          }),
        ])
      )
    );

    expect(batch[0].texture).toBeUndefined();
    expect(batch[0].textureRef).toEqual({
      textureId: 5,
      url: 'images/wall.png',
      repeatS: 4,
      repeatT: 5,
    });
  });

  it('attaches the per-entity fingerprint, box and volume by express id', () => {
    const collection = fakeCollection(
      [fakeMesh({ expressId: 11 }), fakeMesh({ expressId: 22 })],
      {
        geometryHashCount: 2,
        // Deliberately NOT in mesh order, so a positional lookup would mis-attribute.
        geometryHashIds: new Uint32Array([22, 11]),
        geometryHashValues: new BigUint64Array([7n, 9n]),
        geometryAabbValues: new Float64Array([
          0, 0, 0, 1, 1, 1, // id 22
          -5, -5, -5, 5, 5, 5, // id 11
        ]),
        geometryVolumeValues: new Float64Array([1, 1000]),
      }
    );

    const batch = convertMeshCollectionToBatch(asCollection(collection));

    expect(batch[0].expressId).toBe(11);
    expect(batch[0].geometryHash).toBe(9n);
    expect(batch[0].geometryAabb).toEqual({ min: [-5, -5, -5], max: [5, 5, 5] });
    expect(batch[0].geometryVolume).toBe(1000);

    expect(batch[1].geometryHash).toBe(7n);
    expect(batch[1].geometryVolume).toBe(1);
  });

  it('leaves fingerprint fields absent when hashing was not enabled', () => {
    const batch = convertMeshCollectionToBatch(
      asCollection(fakeCollection([fakeMesh({ expressId: 1 })]))
    );

    expect(batch[0].geometryHash).toBeUndefined();
    expect(batch[0].geometryAabb).toBeUndefined();
    expect(batch[0].geometryVolume).toBeUndefined();
  });
});
