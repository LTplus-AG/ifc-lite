/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skyShaderSource } from './shaders/sky.wgsl.js';

/**
 * Regression: a `smoothstep(low, high, x)` with `low >= high` is a WGSL
 * compile error ("low not less than high"). Tint (Chromium/Edge on real
 * hardware) rejects the whole shader module, so the sky pipeline becomes
 * invalid and encoding the frame fails — the model blanks the moment a
 * non-Default lighting preset enables the sky. Permissive drivers
 * (SwiftShader) accepted the reversed edges, which is why it slipped through.
 *
 * `smoothstep(0.0, -0.1, elevation)` was the offender; it is now written as
 * `1.0 - smoothstep(-0.1, 0.0, elevation)`. This pins the invariant for every
 * numeric-literal `smoothstep` in the shipped sky shader, so a future
 * reversed-edge call cannot silently invalidate the pipeline again.
 */
describe('sky shader smoothstep edges (WGSL low < high)', () => {
  it('has no numeric-literal smoothstep with low >= high', () => {
    // Match smoothstep(<number>, <number>, …) — only the literal-edge calls,
    // which are the ones a human can statically verify (and the ones that
    // trip Tint's constant-folding validation).
    const re = /smoothstep\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g;
    const seen: Array<{ low: number; high: number }> = [];
    for (const m of skyShaderSource.matchAll(re)) {
      const low = Number(m[1]);
      const high = Number(m[2]);
      seen.push({ low, high });
      assert.ok(
        low < high,
        `smoothstep(${m[1]}, ${m[2]}, …) has low >= high — WGSL rejects this`,
      );
    }
    // Guard the guard: if the shader stops using literal-edge smoothstep the
    // regex silently passes, so require at least the two known calls.
    assert.ok(seen.length >= 2, 'expected the sky shader to keep its literal-edge smoothstep calls');
  });
});
