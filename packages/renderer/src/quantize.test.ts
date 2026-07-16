/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  quantizeInterleaved,
  octEncode,
  octDecode,
  QUANT_STEP,
  MAX_QUANT_EXTENT,
  QUANT_BYTES_PER_VERTEX,
} from './quantize.ts';

const STRIDE = 7;

function interleave(
  verts: Array<{ p: [number, number, number]; n?: [number, number, number]; id?: number }>,
): Float32Array {
  const out = new Float32Array(verts.length * STRIDE);
  const ids = new Uint32Array(out.buffer);
  verts.forEach((v, i) => {
    out[i * STRIDE] = v.p[0];
    out[i * STRIDE + 1] = v.p[1];
    out[i * STRIDE + 2] = v.p[2];
    const n = v.n ?? [0, 0, 1];
    out[i * STRIDE + 3] = n[0];
    out[i * STRIDE + 4] = n[1];
    out[i * STRIDE + 5] = n[2];
    ids[i * STRIDE + 6] = v.id ?? 0;
  });
  return out;
}

/** CPU dequantization mirroring the WGSL: quantMin + q * step (f32 ops). */
function dequant(q: QuantizedView, i: number): [number, number, number] {
  return [
    Math.fround(q.quantMin[0] + Math.fround(q.u16[i * 6] * q.step)),
    Math.fround(q.quantMin[1] + Math.fround(q.u16[i * 6 + 1] * q.step)),
    Math.fround(q.quantMin[2] + Math.fround(q.u16[i * 6 + 2] * q.step)),
  ];
}
interface QuantizedView { u16: Uint16Array; u32: Uint32Array; quantMin: [number, number, number]; step: number }
function view(r: NonNullable<ReturnType<typeof quantizeInterleaved>>): QuantizedView {
  return { u16: new Uint16Array(r.vertexData), u32: new Uint32Array(r.vertexData), quantMin: r.quantMin, step: r.step };
}

describe('octEncode/octDecode', () => {
  it('round-trips axis and diagonal normals within ~1.5 degrees', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
      [0.577, 0.577, 0.577], [-0.577, 0.577, -0.577], [0.267, -0.535, 0.802],
    ];
    for (const [x, y, z] of cases) {
      const l = Math.hypot(x, y, z);
      const [bx, by] = octEncode(x / l, y / l, z / l);
      const [dx, dy, dz] = octDecode(bx, by);
      const dot = (x / l) * dx + (y / l) * dy + (z / l) * dz;
      const deg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
      assert.ok(deg < 1.5, `normal (${x},${y},${z}) error ${deg.toFixed(2)} deg`);
    }
  });
});

describe('quantizeInterleaved (#1682 phase 6)', () => {
  it('produces 12-byte records with positions within half a lattice step', () => {
    const src = interleave([
      { p: [0.1234, 5.6789, -3.21], id: 42 },
      { p: [10.5, 0.001, 7.777], id: 0xABCDEF01 },
    ]);
    const r = quantizeInterleaved(src, STRIDE)!;
    assert.strictEqual(r.vertexData.byteLength, 2 * QUANT_BYTES_PER_VERTEX);
    const q = view(r);
    for (let i = 0; i < 2; i++) {
      const [x, y, z] = dequant(q, i);
      assert.ok(Math.abs(x - src[i * STRIDE]) <= QUANT_STEP / 2 + 1e-7);
      assert.ok(Math.abs(y - src[i * STRIDE + 1]) <= QUANT_STEP / 2 + 1e-7);
      assert.ok(Math.abs(z - src[i * STRIDE + 2]) <= QUANT_STEP / 2 + 1e-7);
    }
    // entityId lane verbatim.
    assert.strictEqual(q.u32[2], 42);
    assert.strictEqual(q.u32[5], 0xABCDEF01);
  });

  it('BIT-EXACT coincidence: a shared point dequantizes identically from two batches', () => {
    // The load-bearing property (shared-origin guarantee): one world point
    // present in two batches with different (lattice-aligned) quantMins must
    // dequantize to the SAME f32 values in both.
    const P: [number, number, number] = [12.3456789, -7.654321, 3.14159];
    const batchA = interleave([{ p: P }, { p: [11, -8, 3] }]);
    const batchB = interleave([{ p: P }, { p: [40.5, -3.25, 17.5] }]);
    const qa = view(quantizeInterleaved(batchA, STRIDE)!);
    const qb = view(quantizeInterleaved(batchB, STRIDE)!);
    assert.notDeepStrictEqual(qa.quantMin, qb.quantMin, 'test needs distinct quantMins');
    assert.deepStrictEqual(dequant(qa, 0), dequant(qb, 0));
  });

  it('returns null when the extent exceeds the u16 lattice range', () => {
    const src = interleave([{ p: [0, 0, 0] }, { p: [MAX_QUANT_EXTENT + 1, 0, 0] }]);
    assert.strictEqual(quantizeInterleaved(src, STRIDE), null);
  });

  it('handles the empty buffer', () => {
    const r = quantizeInterleaved(new Float32Array(0), STRIDE)!;
    assert.strictEqual(r.vertexData.byteLength, 0);
  });

  it('rejects non-finite positions (NaN poisoned mesh)', () => {
    const src = interleave([{ p: [NaN, 0, 0] }]);
    assert.strictEqual(quantizeInterleaved(src, STRIDE), null);
  });

  it('rejects a PARTIALLY poisoned mesh (finite bounds from other vertices)', () => {
    // The subtle case: healthy vertices give finite bounds, and the NaN
    // vertex would silently quantize to the batch corner without the
    // per-vertex check.
    const src = interleave([{ p: [1, 2, 3] }, { p: [NaN, 0, 0] }, { p: [4, 5, 6] }]);
    assert.strictEqual(quantizeInterleaved(src, STRIDE), null);
  });
});
