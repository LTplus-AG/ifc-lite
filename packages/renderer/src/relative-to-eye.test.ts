/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5049 — RTE is an arithmetic contract, not just a pair of extra uniforms.
 * These cases use a multi-million-metre source frame where direct f32 world
 * upload loses millimetre-scale geometry, and pin the CPU/WGSL packing order
 * that every renderer path will share while it is migrated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MathUtils } from './math.js';
import {
  RelativeToEyeFrame,
  RTE_FRAME_FLOATS,
  RTE_ORIGIN_FLOATS,
  packRteOrigin,
  rteRelativePositionF32,
  translationFreeViewProjection,
  unpackRteOrigin,
} from './relative-to-eye.js';

function close(actual: number, expected: number, tolerance = 1e-7): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} ± ${tolerance}`);
}

describe('relative-to-eye packing (#5049)', () => {
  it('retains a centimetre-sized local vertex at a multi-million-metre offset', () => {
    const camera = new Float32Array(RTE_ORIGIN_FLOATS);
    const drawable = new Float32Array(RTE_ORIGIN_FLOATS);
    packRteOrigin([5_000_000, -3_000_000, 2_000_000], camera);
    packRteOrigin([5_000_000, -3_000_000, 2_000_000], drawable);

    const local: [number, number, number] = [0.025, -0.0125, 0.03125];
    const relative = rteRelativePositionF32(local, drawable, camera);

    // This is the exact failure RTE prevents: the f32 upload of the absolute
    // coordinate has no room left for 2.5 cm at a five-million-metre offset.
    assert.equal(Math.fround(5_000_000 + local[0]) - Math.fround(5_000_000), 0);
    close(relative[0], local[0]);
    close(relative[1], local[1]);
    close(relative[2], local[2]);
  });

  it('cancels neighbouring high lanes before adding the low residual', () => {
    const camera = new Float32Array(RTE_ORIGIN_FLOATS);
    const drawable = new Float32Array(RTE_ORIGIN_FLOATS);
    const cameraWorld: [number, number, number] = [5_000_000.25, 4_000_000.125, -6_000_000.5];
    const drawableWorld: [number, number, number] = [5_000_000.75, 3_999_999.875, -5_999_999.75];
    packRteOrigin(cameraWorld, camera);
    packRteOrigin(drawableWorld, drawable);

    const got = rteRelativePositionF32([0.125, -0.25, 0.0625], drawable, camera);
    close(got[0], 0.625);
    close(got[1], -0.5);
    close(got[2], 0.8125);
  });

  it('writes stable vec4-aligned high/low lanes and reconstructs source coordinates', () => {
    const origin: [number, number, number] = [5_000_000.125, -3_000_000.0625, 42.5];
    const packed = new Float32Array(RTE_ORIGIN_FLOATS);
    packRteOrigin(origin, packed);

    assert.equal(packed[3], 0, 'high vec4 padding is cleared');
    assert.equal(packed[7], 0, 'low vec4 padding is cleared');
    const unpacked = unpackRteOrigin(packed);
    for (let axis = 0; axis < 3; axis++) close(unpacked[axis], origin[axis]);
  });

  it('keeps CPU ray/snap/measure coordinates in f64 while GPU uniforms are split', () => {
    const frame = new RelativeToEyeFrame();
    const eye = { x: 5_000_000.25, y: -3_000_000.5, z: 2_000_000.125 };
    frame.update(eye, MathUtils.identity(), MathUtils.lookAt(eye, { x: eye.x, y: eye.y, z: eye.z - 1 }, { x: 0, y: 1, z: 0 }));

    assert.deepStrictEqual(frame.worldToRelative([5_000_000.275, -3_000_000.5125, 2_000_000.15625]), [0.02500000037252903, -0.012500000186264515, 0.03125]);
    const packed = new Float32Array(RTE_FRAME_FLOATS);
    frame.packUniforms(packed);
    assert.deepStrictEqual(Array.from(packed.subarray(16, 24)), [5_000_000, -3_000_000.5, 2_000_000.125, 0, 0.25, 0, 0, 0]);
  });

  it('removes eye translation from view-projection but leaves projection depth semantics intact', () => {
    const projection = MathUtils.perspectiveReverseZ(Math.PI / 3, 1.5, 0.1, 10_000);
    const view = MathUtils.lookAt(
      { x: 5_000_000.25, y: -3_000_000.5, z: 2_000_000.125 },
      { x: 5_000_000.25, y: -3_000_000.5, z: 1_999_999.125 },
      { x: 0, y: 1, z: 0 },
    );
    const translated = MathUtils.multiply(projection, view);
    const relative = translationFreeViewProjection(projection, view);

    // The normal perspective matrix owns a depth offset (m14), so it survives;
    // the large eye-derived X/Y translation does not.
    assert.notEqual(translated.m[12], relative.m[12]);
    assert.notEqual(translated.m[13], relative.m[13]);
    close(relative.m[14], projection.m[14]);
  });
});
