/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  decodeInstancedShard,
  isInstancedShard,
  INSTANCED_SHARD_MAGIC,
} from './packed-instanced-decoder.js';

// Cross-language conformance fixture: bytes produced by the Rust encoder
// (`encode_instanced`) via the `dump_instanced_fixture` test in instancing.rs.
// Regenerate with:
//   cargo test -p ifc-lite-geometry --lib dump_instanced_fixture -- --ignored --nocapture
//
// Case: CANON tetra at three pure translations — m0=(1,0,0) rep50, m1=(0,2,0)
// rep50, m2=(5,5,5) rep60. collate(min_group=2) → 1 shared template (m0 geometry,
// occurrences m0+m1) + 1 singleton template (m2). entityId = 1000+meshIndex;
// colour = [meshIndex*0.1, 0.2, 0.3, 1].
const FIXTURE_HEX =
  '534e464901000000020000000300000018000000180000000800000000000000000000000c000000000000000c00000000000000040000000000000000000000000000000000000000000000000000000c0000000c0000000c0000000c000000040000000400000000000000000000000000000000000000000000000000000000000000e803000000000000cdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f00000000e9030000cdcccc3dcdcc4c3e9a99993e0000803f0000803f0000000000000000000080bf000000000000803f000000000000004000000000000000000000803f000000000000000000000000000000000000803f01000000ea030000cdcc4c3ecdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f0000803f00000000000000000000004000000000000000000000803f0000803f000000000000803f000000000000803f0000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000020000000300000000000000010000000200000003000000';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Apply a row-major mat4 to a point (w assumed 1, affine).
function applyRowMajor(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

const CANON = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('decodeInstancedShard (Rust↔TS conformance)', () => {
  const bytes = hexToBytes(FIXTURE_HEX);

  it('recognises the instanced magic', () => {
    expect(INSTANCED_SHARD_MAGIC).toBe(0x4946_4e53);
    expect(isInstancedShard(bytes)).toBe(true);
    expect(isInstancedShard(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it('decodes the template + instance tables produced by the Rust encoder', () => {
    const shard = decodeInstancedShard(bytes);
    // rep50 → 1 shared template (2 occ); rep60 singleton → 1 template (1 occ).
    expect(shard.templates).toHaveLength(2);
    expect(shard.instances).toHaveLength(3);

    // Template 0 is mesh 0's geometry: CANON translated by (1,0,0).
    const expected0 = CANON.map((v, i) => (i % 3 === 0 ? v + 1 : v));
    expect(Array.from(shard.templates[0].positions)).toEqual(expected0);
    // The fixture's mesh helper uses sequential indices over its 4 verts.
    expect(Array.from(shard.templates[0].indices)).toEqual([0, 1, 2, 3]);
    expect(shard.templates[0].origin).toEqual([0, 0, 0]);

    // Instances: m0 (id 1000, template 0), m1 (id 1001, template 0), m2 (id 1002, template 1).
    expect(shard.instances.map((i) => i.entityId)).toEqual([1000, 1001, 1002]);
    expect(shard.instances.map((i) => i.templateIndex)).toEqual([0, 0, 1]);
    // colour = [meshIndex*0.1, 0.2, 0.3, 1]
    expect(shard.instances[1].color[0]).toBeCloseTo(0.1, 5);
    expect(shard.instances[1].color[1]).toBeCloseTo(0.2, 5);
    expect(shard.instances[2].color[0]).toBeCloseTo(0.2, 5);
  });

  it('expand-to-flat: applying an instance transform to its template reproduces the occurrence', () => {
    const shard = decodeInstancedShard(bytes);
    // Instance 1 is mesh 1 (translation (0,2,0)); its rel transform applied to
    // template 0 (mesh 0's geometry) must reproduce CANON translated by (0,2,0).
    const inst = shard.instances[1];
    const tmpl = shard.templates[inst.templateIndex];
    const expectedM1 = CANON.map((v, i) => (i % 3 === 1 ? v + 2 : v));
    const n = tmpl.positions.length / 3;
    for (let v = 0; v < n; v += 1) {
      const [wx, wy, wz] = applyRowMajor(
        inst.transform,
        tmpl.origin[0] + tmpl.positions[v * 3],
        tmpl.origin[1] + tmpl.positions[v * 3 + 1],
        tmpl.origin[2] + tmpl.positions[v * 3 + 2]
      );
      expect(wx).toBeCloseTo(expectedM1[v * 3], 4);
      expect(wy).toBeCloseTo(expectedM1[v * 3 + 1], 4);
      expect(wz).toBeCloseTo(expectedM1[v * 3 + 2], 4);
    }
  });

  it('rejects a truncated buffer', () => {
    expect(() => decodeInstancedShard(bytes.slice(0, 40))).toThrow(/truncated/);
  });
});
