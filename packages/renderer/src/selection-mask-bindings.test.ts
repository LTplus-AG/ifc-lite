/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { SELECTION_MASK_DEPTH_GROUP, selectionMaskFragmentSource } from './shaders/selection-mask.wgsl.js';

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
