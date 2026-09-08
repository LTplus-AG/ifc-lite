/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  SECTION_2D_CAP_FILL_WGSL,
  SECTION_2D_OVERLAY_LINE_WGSL,
  SECTION_2D_UNIFORM_BYTES,
  SECTION_2D_UNIFORM_FLOATS,
  SECTION_2D_UNIFORM_SLOTS,
} from './shaders/section-2d-overlay.wgsl.js';

/**
 * The fill and line pipelines deliberately alias ONE 160-byte uniform buffer,
 * and the TypeScript writers address it by float index. Nothing in the compiler
 * connects the WGSL struct to those indices — moving a `vec4` in the shader
 * would silently repaint the cap in the line colour. These tests derive the
 * offsets from the shader text itself and compare them to the slot table both
 * sides import.
 */

/** WGSL scalar/vector/matrix sizes we use, in floats. */
const FLOAT_SIZE: Record<string, number> = {
  'mat4x4<f32>': 16,
  'vec4<f32>': 4,
};

/**
 * Extract `struct Uniforms { … }` from a shader source and compute each field's
 * float offset. Every type in use is 16-byte aligned, so the offsets are a
 * running sum with no padding.
 */
function uniformFieldOffsets(source: string): Record<string, number> {
  const match = source.match(/struct\s+Uniforms\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'shader must declare a struct named Uniforms');
  const body = match[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l.length > 0)
    .join(' ');

  const offsets: Record<string, number> = {};
  let cursor = 0;
  for (const field of body.split(',')) {
    const decl = field.trim();
    if (decl.length === 0) continue;
    const parts = decl.split(':').map((s) => s.trim());
    assert.strictEqual(parts.length, 2, `unparsable uniform field: "${decl}"`);
    const [name, type] = parts;
    const size = FLOAT_SIZE[type];
    assert.ok(size, `unknown WGSL type "${type}" in struct Uniforms — extend FLOAT_SIZE`);
    offsets[name] = cursor;
    cursor += size;
  }
  return offsets;
}

describe('section 2D uniform layout: WGSL vs SECTION_2D_UNIFORM_SLOTS', () => {
  it('the line shader struct matches the slot table field for field', () => {
    assert.deepStrictEqual(
      uniformFieldOffsets(SECTION_2D_OVERLAY_LINE_WGSL),
      { ...SECTION_2D_UNIFORM_SLOTS },
    );
  });

  it('the fill shader struct is a prefix of the same layout', () => {
    const fill = uniformFieldOffsets(SECTION_2D_CAP_FILL_WGSL);
    // The fill shader stops at params2 — it never reads lineColor.
    assert.ok(!('lineColor' in fill), 'fill shader must not declare lineColor');
    for (const [name, offset] of Object.entries(fill)) {
      assert.strictEqual(
        offset,
        (SECTION_2D_UNIFORM_SLOTS as Record<string, number>)[name],
        `fill shader field "${name}" is at float ${offset}, slot table says ` +
          `${(SECTION_2D_UNIFORM_SLOTS as Record<string, number>)[name]}`,
      );
    }
  });

  it('the two shaders agree on every field they share (they alias one buffer)', () => {
    const fill = uniformFieldOffsets(SECTION_2D_CAP_FILL_WGSL);
    const line = uniformFieldOffsets(SECTION_2D_OVERLAY_LINE_WGSL);
    for (const name of Object.keys(fill)) {
      assert.strictEqual(line[name], fill[name], `field "${name}" is at a different offset`);
    }
  });

  it('the buffer is exactly big enough for the last field', () => {
    const line = uniformFieldOffsets(SECTION_2D_OVERLAY_LINE_WGSL);
    const end = Math.max(...Object.values(line)) + FLOAT_SIZE['vec4<f32>'];
    assert.strictEqual(end, SECTION_2D_UNIFORM_FLOATS);
    assert.strictEqual(SECTION_2D_UNIFORM_BYTES, SECTION_2D_UNIFORM_FLOATS * 4);
  });

  it('lineColor sits at byte offset 144, as both shader comments claim', () => {
    assert.strictEqual(SECTION_2D_UNIFORM_SLOTS.lineColor * 4, 144);
  });

  it('the parser itself catches a moved field (control for this file)', () => {
    const shuffled = SECTION_2D_OVERLAY_LINE_WGSL.replace(
      'planeOffset: vec4<f32>,\n          capFillColor: vec4<f32>,',
      'capFillColor: vec4<f32>,\n          planeOffset: vec4<f32>,',
    );
    assert.notStrictEqual(shuffled, SECTION_2D_OVERLAY_LINE_WGSL, 'the swap must actually apply');
    assert.notDeepStrictEqual(
      uniformFieldOffsets(shuffled),
      { ...SECTION_2D_UNIFORM_SLOTS },
      'swapping two fields must change the derived offsets',
    );
  });
});

describe('section 2D shader sources', () => {
  it('both shaders declare the entry points the pipelines ask for', () => {
    for (const src of [SECTION_2D_CAP_FILL_WGSL, SECTION_2D_OVERLAY_LINE_WGSL]) {
      assert.ok(/@vertex\s+fn vs_main/.test(src), 'vs_main');
      assert.ok(/@fragment\s+fn fs_main/.test(src), 'fs_main');
    }
  });

  it('both shaders write the objectId attachment the two-target pass requires', () => {
    for (const src of [SECTION_2D_CAP_FILL_WGSL, SECTION_2D_OVERLAY_LINE_WGSL]) {
      assert.ok(/@location\(1\) objectId/.test(src), 'objectId output declared');
    }
  });

  it('the fill shader keeps the sentinel-alpha fallback to the uniform cap colour', () => {
    // A polygon with no material colour carries alpha −1; dropping this branch
    // would paint every uniform-styled cap black.
    assert.ok(/input\.color\.a >= 0\.0/.test(SECTION_2D_CAP_FILL_WGSL));
    assert.ok(/select\(uniforms\.capFillColor, input\.color, useVertex\)/.test(SECTION_2D_CAP_FILL_WGSL));
  });

  it('the line shader keeps the #812 reverse-Z decal nudge', () => {
    assert.ok(/clip\.z \+ 5e-5 \* clip\.w/.test(SECTION_2D_OVERLAY_LINE_WGSL));
  });
});
