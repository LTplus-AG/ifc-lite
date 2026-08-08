/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type conversion functions for the native Tauri bridge.
 *
 * `convertPackedNativeBatch` shares its offset/length pool-table shape with
 * the binary packed-cache-shard decoder (`packed-geometry-decoder.ts`), which
 * validates each mesh's declared range against its shared pool before
 * slicing. This file had no coverage at all before, and the pool-bounds
 * check was missing here too: a malformed offset/length pair would silently
 * clip (`subarray` saturates) into truncated-or-borrowed geometry instead of
 * throwing.
 */

import { describe, it, expect } from 'vitest';

import {
  convertNativeMesh,
  convertPackedNativeBatch,
  convertNativeBatchTelemetry,
  convertNativeCoordinateInfo,
  type NativePackedGeometryBatch,
} from './native-bridge-conversion.js';

describe('convertNativeMesh', () => {
  it('converts plain number arrays into typed arrays', () => {
    const out = convertNativeMesh({
      expressId: 7,
      ifcType: 'IfcWall',
      positions: [1, 2, 3],
      normals: [0, 1, 0],
      indices: [0, 1, 2],
      color: [1, 0, 0, 1],
    });
    expect(out.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(out.positions)).toEqual([1, 2, 3]);
    expect(out.normals).toBeInstanceOf(Float32Array);
    expect(out.indices).toBeInstanceOf(Uint32Array);
    expect(out.expressId).toBe(7);
    expect(out.ifcType).toBe('IfcWall');
  });
});

describe('convertPackedNativeBatch', () => {
  const baseNative: NativePackedGeometryBatch = {
    meshes: [
      { expressId: 101, positionsOffset: 0, positionsLen: 6, normalsOffset: 0, normalsLen: 6, indicesOffset: 0, indicesLen: 3, color: [1, 1, 1, 1] },
      { expressId: 202, positionsOffset: 6, positionsLen: 3, normalsOffset: 6, normalsLen: 3, indicesOffset: 3, indicesLen: 3, color: [0, 1, 0, 1] },
    ],
    positions: [1, 2, 3, 4, 5, 6, 100, 200, 300],
    normals: [0, 0, 1, 0, 1, 0, 1, 0, 0],
    indices: [0, 1, 0, 0, 1, 2],
    progress: { processed: 1, total: 2, currentType: 'mesh' },
  };

  it('splits the shared pools at each mesh offset/length', () => {
    const out = convertPackedNativeBatch(baseNative);
    expect(out).toHaveLength(2);
    expect(Array.from(out[0].positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(out[1].positions)).toEqual([100, 200, 300]);
  });

  // Mesh 0 declares a positions length far beyond the 9-float shared pool.
  // `subarray` saturates instead of throwing, so without a guard mesh 0
  // silently absorbs mesh 1's vertices with no error anywhere.
  it('rejects a mesh whose positions range runs past the positions pool', () => {
    const bad: NativePackedGeometryBatch = {
      ...baseNative,
      meshes: [
        { ...baseNative.meshes[0], positionsLen: 999 },
        baseNative.meshes[1],
      ],
    };
    expect(() => convertPackedNativeBatch(bad)).toThrow(/mesh 0 pool offset out of bounds/);
  });

  it('rejects a mesh whose normals range runs past the normals pool', () => {
    const bad: NativePackedGeometryBatch = {
      ...baseNative,
      meshes: [
        { ...baseNative.meshes[0], normalsLen: 999 },
        baseNative.meshes[1],
      ],
    };
    expect(() => convertPackedNativeBatch(bad)).toThrow(/mesh 0 pool offset out of bounds/);
  });

  it('rejects a mesh whose indices range runs past the indices pool', () => {
    const bad: NativePackedGeometryBatch = {
      ...baseNative,
      meshes: [
        { ...baseNative.meshes[0], indicesLen: 999 },
        baseNative.meshes[1],
      ],
    };
    expect(() => convertPackedNativeBatch(bad)).toThrow(/mesh 0 pool offset out of bounds/);
  });

  // Control: an out-of-range SECOND mesh must not be masked by the first
  // mesh's valid range — proves the guard runs per-mesh.
  it('rejects an out-of-bounds second mesh even when the first mesh is valid', () => {
    const bad: NativePackedGeometryBatch = {
      ...baseNative,
      meshes: [
        baseNative.meshes[0],
        { ...baseNative.meshes[1], positionsLen: 999 },
      ],
    };
    expect(() => convertPackedNativeBatch(bad)).toThrow(/mesh 1 pool offset out of bounds/);
  });

  // Unlike the binary decoder, whose offsets come from `getUint32` and are
  // therefore non-negative integers by construction, these arrive as plain
  // JS numbers on an IPC payload. An upper-bound check alone does not cover
  // that: `NaN + len > length` is FALSE, so NaN slips through and
  // `subarray(NaN, NaN)` yields an EMPTY view — a mesh reported as
  // successfully converted while carrying no geometry at all. A negative
  // offset likewise passes the upper bound and makes `subarray` count from
  // the END of the pool, silently borrowing another mesh's vertices.
  it('rejects a NaN offset instead of silently producing an empty mesh', () => {
    const bad: NativePackedGeometryBatch = {
      ...baseNative,
      meshes: [{ ...baseNative.meshes[0], positionsOffset: Number.NaN }],
    };
    expect(() => convertPackedNativeBatch(bad)).toThrow(/mesh 0 pool offset out of bounds/);
  });

  it('rejects a negative offset instead of slicing from the end of the pool', () => {
    const bad: NativePackedGeometryBatch = {
      ...baseNative,
      meshes: [{ ...baseNative.meshes[0], positionsOffset: -3, positionsLen: 3 }],
    };
    expect(() => convertPackedNativeBatch(bad)).toThrow(/mesh 0 pool offset out of bounds/);
  });

  // Control: a mesh range that exactly reaches the end of its pool must
  // still decode — proves the guard doesn't over-reject valid data.
  it('accepts a mesh range that exactly reaches the end of its pool', () => {
    const ok: NativePackedGeometryBatch = {
      ...baseNative,
      meshes: [baseNative.meshes[0]],
      positions: [1, 2, 3, 4, 5, 6],
      normals: [0, 0, 1, 0, 1, 0],
      indices: [0, 1, 0],
    };
    const out = convertPackedNativeBatch(ok);
    expect(Array.from(out[0].positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('convertNativeBatchTelemetry', () => {
  it('returns undefined when telemetry is absent', () => {
    expect(convertNativeBatchTelemetry(undefined, 123)).toBeUndefined();
  });

  it('attaches jsReceivedTimeMs to the converted telemetry', () => {
    const out = convertNativeBatchTelemetry(
      {
        batchSequence: 3,
        payloadKind: 'mesh-array',
        meshCount: 5,
        positionsLen: 10,
        normalsLen: 10,
        indicesLen: 6,
        chunkReadyTimeMs: 1,
        packTimeMs: 2,
        emitTimeMs: 3,
        emittedTimeMs: 4,
      },
      42
    );
    expect(out).toEqual({
      batchSequence: 3,
      payloadKind: 'mesh-array',
      meshCount: 5,
      positionsLen: 10,
      normalsLen: 10,
      indicesLen: 6,
      chunkReadyTimeMs: 1,
      packTimeMs: 2,
      emitTimeMs: 3,
      emittedTimeMs: 4,
      jsReceivedTimeMs: 42,
    });
  });
});

describe('convertNativeCoordinateInfo', () => {
  it('copies bounds and shift fields through unchanged', () => {
    const native = {
      originShift: { x: 1, y: 2, z: 3 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
      shiftedBounds: { min: { x: -1, y: -2, z: -3 }, max: { x: 9, y: 8, z: 7 } },
      hasLargeCoordinates: true,
    };
    expect(convertNativeCoordinateInfo(native)).toEqual(native);
  });
});
