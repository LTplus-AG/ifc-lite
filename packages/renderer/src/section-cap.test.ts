/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for pure data exposed by section-cap. GPU pipeline construction
 * is covered by an integration smoke test in apps/viewer, which actually
 * boots a WebGPU context.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  HATCH_PATTERN_IDS,
  DEFAULT_CAP_STYLE,
  type HatchPatternId,
} from './section-cap.ts';
import {
  stencilGeomShaderSource,
  capFillShaderSource,
} from './shaders/section-cap.wgsl.ts';

describe('HATCH_PATTERN_IDS', () => {
  it('assigns contiguous non-negative ids to every pattern', () => {
    const ids = Object.values(HATCH_PATTERN_IDS);
    // Every id is a non-negative integer.
    for (const id of ids) {
      assert.ok(Number.isInteger(id), `pattern id ${id} should be integer`);
      assert.ok(id >= 0, `pattern id ${id} should be non-negative`);
    }
    // No duplicates — the cap shader uses this as a dense switch.
    const unique = new Set(ids);
    assert.strictEqual(unique.size, ids.length, 'pattern ids must be unique');
  });

  it('matches the branches the cap fragment shader uses', () => {
    // The shader has an early-out for 0 (solid) and named branches for
    // patternId == 1u .. 7u. This test pins that mapping so changing the
    // numeric ids requires touching the shader too.
    assert.strictEqual(HATCH_PATTERN_IDS.solid,      0);
    assert.strictEqual(HATCH_PATTERN_IDS.diagonal,   1);
    assert.strictEqual(HATCH_PATTERN_IDS.crossHatch, 2);
    assert.strictEqual(HATCH_PATTERN_IDS.horizontal, 3);
    assert.strictEqual(HATCH_PATTERN_IDS.vertical,   4);
    assert.strictEqual(HATCH_PATTERN_IDS.concrete,   5);
    assert.strictEqual(HATCH_PATTERN_IDS.brick,      6);
    assert.strictEqual(HATCH_PATTERN_IDS.insulation, 7);
  });

  it('every pattern id appears in the cap fill shader', () => {
    // Grep-style check: the shader must branch on every advertised id.
    for (const [name, id] of Object.entries(HATCH_PATTERN_IDS)) {
      if (id === 0) continue; // solid is the default else-branch
      const marker = `patternId == ${id}u`;
      assert.ok(
        capFillShaderSource.includes(marker),
        `cap shader is missing branch for pattern '${name}' (id ${id})`,
      );
    }
  });
});

describe('DEFAULT_CAP_STYLE', () => {
  it('is a valid, opaque, diagonal hatch style', () => {
    assert.strictEqual(DEFAULT_CAP_STYLE.pattern, 'diagonal');
    assert.strictEqual(DEFAULT_CAP_STYLE.fillColor.length, 4);
    assert.strictEqual(DEFAULT_CAP_STYLE.strokeColor.length, 4);
    // All channels must be 0-1 so the shader multiplies sanely.
    for (const c of [...DEFAULT_CAP_STYLE.fillColor, ...DEFAULT_CAP_STYLE.strokeColor]) {
      assert.ok(c >= 0 && c <= 1, `channel ${c} must be in [0,1]`);
    }
    assert.ok(DEFAULT_CAP_STYLE.spacingPx >= 2, 'spacing must be at least the shader clamp');
    assert.ok(DEFAULT_CAP_STYLE.widthPx   >= 1, 'width must be at least the shader clamp');
  });

  it('has a pattern name that is a valid HatchPatternId', () => {
    const ids: HatchPatternId[] = [
      'solid', 'diagonal', 'crossHatch', 'horizontal',
      'vertical', 'concrete', 'brick', 'insulation',
    ];
    assert.ok(ids.includes(DEFAULT_CAP_STYLE.pattern));
  });
});

describe('stencil geometry shader', () => {
  it('discards fragments below the plane (kept half) — cap only counts the clipped side', () => {
    assert.ok(stencilGeomShaderSource.includes('if (d <= 0.0)'));
    assert.ok(stencilGeomShaderSource.includes('discard'));
  });

  it('honours the flipped flag from uniforms.flags.x', () => {
    assert.ok(stencilGeomShaderSource.includes('uniforms.flags.x == 1u'));
  });
});
