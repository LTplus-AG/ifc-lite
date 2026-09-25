/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { MASK_DEPTH_REL_TOLERANCE, SELECTION_MASK_DEPTH_GROUP, selectionMaskFragmentSource } from './shaders/selection-mask.wgsl.js';

/**
 * The selection-mask pipeline pairs `mainShaderSource`'s `vs_main` (which
 * reads the mesh uniform at `@group(0) @binding(0)`) with the mask fragment
 * stage (which reads the scene depth texture). Both live in ONE pipeline
 * layout, so the depth texture must not also sit at group 0: that made the
 * shader's texture collide with the layout's uniform buffer, every mask
 * pipeline failed validation, and any frame with a selection was dropped
 * (#5390, caught by a real WebGPU run, not by the unit suite).
 */
describe('selection-mask bind groups (#5390)', () => {
  it('keeps the depth texture out of the mesh uniform group', () => {
    assert.match(mainShaderSource, /@binding\(0\) @group\(0\) var<uniform> uniforms: Uniforms;/, 'vs_main reads the mesh uniform at group 0');
    assert.notEqual(SELECTION_MASK_DEPTH_GROUP, 0, 'depth must not share group 0 with the mesh uniform');
  });

  for (const multisampled of [false, true]) {
    it(`declares depthTex at the documented group (${multisampled ? 'MSAA' : 'single-sample'})`, () => {
      const src = selectionMaskFragmentSource(multisampled);
      const decl = /@group\((\d+)\) @binding\((\d+)\) var depthTex: (texture_depth(?:_multisampled)?_2d);/.exec(src);
      assert.ok(decl, 'expected a depthTex declaration');
      assert.equal(Number(decl[1]), SELECTION_MASK_DEPTH_GROUP, 'group');
      assert.equal(Number(decl[2]), 0, 'binding');
      assert.equal(decl[3], multisampled ? 'texture_depth_multisampled_2d' : 'texture_depth_2d');
    });
  }
});

/**
 * #5390 review: the mask fragments must drop what the section plane / clip
 * box cut away, through the SAME test `fs_main` uses, reading varyings at
 * the locations `vs_main` really emits them.
 */
describe('selection mask honours the section plane and clip box (#5390)', () => {
  const vertexOutput = /struct VertexOutput \{([\s\S]*?)\n\s*\}/.exec(mainShaderSource)?.[1] ?? '';
  const locationOf = (name: string, src: string) => new RegExp(`@location\\((\\d+)\\) ${name}: vec3<f32>`).exec(src)?.[1];

  it('fs_main clips through the shared sectionClipped()', () => {
    const fsMain = mainShaderSource.slice(mainShaderSource.indexOf('fn fs_main('));
    assert.match(fsMain, /if \(sectionClipped\(fragmentPos\)\) \{ discard; \}/);
  });

  for (const multisampled of [false, true]) {
    const src = selectionMaskFragmentSource(multisampled);
    it(`every mask entry point discards cut fragments (${multisampled ? 'MSAA' : 'single-sample'})`, () => {
      for (const entry of ['fs_mask_selected_visible', 'fs_mask_hover_visible', 'fs_mask_selected_all']) {
        const body = new RegExp(`fn ${entry}\\(input: MaskInput\\)[^{]*\\{([^}]*)\\}`).exec(src)?.[1] ?? '';
        assert.match(body, /isCut\(input\)/, `${entry} must test the section/clip cut`);
      }
      assert.match(src, /fn isCut\(input: MaskInput\) -> bool \{\s*return sectionClipped\(clipSpacePos\(input\.worldPos, input\.eyePos\)\);/);
    });

    it(`reads worldPos / eyePos at vs_main's output locations (${multisampled ? 'MSAA' : 'single-sample'})`, () => {
      for (const name of ['worldPos', 'eyePos']) {
        const emitted = locationOf(name, vertexOutput);
        assert.ok(emitted, `vs_main emits ${name}`);
        assert.equal(locationOf(name, src), emitted, `${name} location must match VertexOutput`);
      }
    });
  }
});

/**
 * #5390: the first cut compared against the scene depth with a fixed 1e-7
 * epsilon. The stored depth is MSAA sample 0 from the (possibly quantized)
 * batch draw, so on a real WebGPU frame every selected pixel failed and the
 * visible outline never drew. The slack must scale with the surface.
 */
describe('visible mask depth test tolerates the same surface (#5390)', () => {
  const src = selectionMaskFragmentSource(true);
  it('allows the fragment depth slope plus a relative slack, not a fixed epsilon', () => {
    assert.match(src, /let slack = depthSlope \+ fragPos\.z \* MASK_DEPTH_REL_TOLERANCE;/);
    assert.doesNotMatch(src, /loadDepth\(ip\) - 1e-7/);
    assert.ok(MASK_DEPTH_REL_TOLERANCE > 0 && MASK_DEPTH_REL_TOLERANCE <= 0.01, 'a sliver of the distance, not a see-through');
  });

  it('takes fwidth before branching, so the derivative stays in uniform control flow', () => {
    for (const entry of ['fs_mask_selected_visible', 'fs_mask_hover_visible']) {
      const body = new RegExp(`fn ${entry}\\(input: MaskInput\\)[^{]*\\{([^}]*)\\}`).exec(src)?.[1] ?? '';
      const lines = body.trim().split('\n').map((l) => l.trim());
      assert.equal(lines[0], 'let depthSlope = fwidth(input.fragPos.z);', `${entry}: fwidth must come first`);
    }
  });
});

