/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';

/**
 * The single line that makes the terminator-softness slider do anything.
 *
 * `main.wgsl.ts` used to hard-code `let wrap = 0.3;`. #2688 replaced that with
 * a read of the environment uniform so the preset base and the user's trim
 * actually reach the shading. Reverting just that one line to a numeric
 * literal leaves the whole feature inert: the uniform is still packed, the
 * slider still moves, the store still updates, the presets still differ — and
 * nothing renders differently.
 *
 * That mutation was measured surviving with BYTE-IDENTICAL pass/fail counts
 * across the renderer suite (843 pass / 3 fail) and the viewer suite
 * (2722 / 206). Every other guard on this feature sits either upstream of the
 * shader (uniform packing, clamp contract, preset composition) or downstream
 * of it (the slider's store wiring), so none of them can observe the shader
 * ceasing to read the value. This test is at the only level that can.
 *
 * Modelled on `sky-shader.test.ts`, including its guard-the-guard clause: a
 * regex that finds nothing passes vacuously, so the construct's continued
 * existence is asserted too.
 */
describe('sun softness reaches the shader (#2688)', () => {
  it('reads the terminator wrap from the environment uniform, not a literal', () => {
    const assignments = [...mainShaderSource.matchAll(/let\s+wrap\s*=\s*([^;]+);/g)];

    // Guard the guard: if `wrap` is renamed or the diffuse-wrap term is
    // removed, the regex below would find nothing and pass for no reason.
    assert.ok(
      assignments.length >= 1,
      'expected the main shader to keep a `let wrap = ...` diffuse-wrap term',
    );

    for (const m of assignments) {
      const rhs = m[1].trim();
      assert.ok(
        rhs.includes('env.sunSoftness'),
        `\`let wrap = ${rhs}\` does not read env.sunSoftness — the softness slider is inert`,
      );
      assert.ok(
        !/^-?\d+(\.\d+)?$/.test(rhs),
        `\`let wrap = ${rhs}\` is a numeric literal — the softness slider is inert`,
      );
    }
  });
});
