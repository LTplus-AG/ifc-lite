/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, readGeometryV13 } from './geometry-chunks.js';
import { FORMAT_VERSION } from '../types.js';

/**
 * Regression: a NaN/Infinity-bombed position or normal float, tampered
 * directly into an otherwise structurally valid v13 geometry section, used
 * to flow straight through `readMeshRecord` unfiltered — every existing
 * guard in this package validates SHAPE (offsets, lengths, indices), none
 * validated the numeric DOMAIN of a vertex float. That NaN then reaches
 * `packages/spatial`'s BVH bounds and the renderer with nothing downstream
 * re-checking cache input (see #3547, which made the BVH tolerate a NaN'd
 * subtree without poisoning siblings, but did not stop one from existing).
 */

const coordInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

function mesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 12345.5, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    ifcType: 'IFCWALL',
    geometryClass: 0,
  };
}

/** Patch the LAST occurrence of `needle` (a float32) in `buffer` to `bits`
 *  (a raw uint32 bit pattern, little-endian). The chunk directory's AABB
 *  min/max also stores a mesh's extreme vertex values, and it sits BEFORE
 *  the mesh record in the buffer — scanning from the end targets the mesh
 *  record's own copy, not the directory's. */
function patchLastFloat(buffer: ArrayBuffer, needle: number, bits: number): boolean {
  const view = new DataView(buffer);
  for (let i = buffer.byteLength - 4; i >= 0; i -= 1) {
    if (view.getFloat32(i, true) === needle) {
      view.setUint32(i, bits, true);
      return true;
    }
  }
  return false;
}

const NAN_BITS = 0x7fc00000;
const POS_INFINITY_BITS = 0x7f800000;

describe('geometry cache reader rejects non-finite vertex data', () => {
  it('throws on a NaN-bombed position (RED on unmodified main: silently returns NaN)', async () => {
    const section = await buildGeometrySectionV13([mesh(1)], coordInfo, { compress: false });
    expect(patchLastFloat(section, 12345.5, NAN_BITS)).toBe(true);
    await expect(readGeometryV13(section, 0, FORMAT_VERSION)).rejects.toThrow(
      /Invalid cache: mesh 0 \(expressId=1\) has a non-finite value \(NaN\) in positions/,
    );
  });

  it('throws on an Infinity-bombed normal', async () => {
    const section = await buildGeometrySectionV13([mesh(1)], coordInfo, { compress: false });
    expect(patchLastFloat(section, 1, POS_INFINITY_BITS)).toBe(true);
    await expect(readGeometryV13(section, 0, FORMAT_VERSION)).rejects.toThrow(
      /Invalid cache: mesh 0 \(expressId=1\) has a non-finite value \(Infinity\) in normals/,
    );
  });

  it('control: a well-formed section still round-trips finite values', async () => {
    const section = await buildGeometrySectionV13([mesh(1)], coordInfo, { compress: false });
    const result = await readGeometryV13(section, 0, FORMAT_VERSION);
    expect(Array.from(result.meshes[0].positions)).toEqual([0, 0, 0, 12345.5, 0, 0, 0, 1, 0]);
  });

  it('control: an already-guarded tamper (chunk directory contiguity) still fails', async () => {
    const section = await buildGeometrySectionV13([mesh(1), mesh(2)], coordInfo, { compress: false });
    // Corrupt the byte at the start of the directory's chunkCount region is
    // fragile to hand-locate here; instead reuse the existing guard by
    // truncating the buffer mid-section, which `BufferReader.ensureAvailable`
    // must still catch independently of the new finiteness check.
    const truncated = section.slice(0, section.byteLength - 8);
    await expect(readGeometryV13(truncated, 0, FORMAT_VERSION)).rejects.toThrow();
  });
});
