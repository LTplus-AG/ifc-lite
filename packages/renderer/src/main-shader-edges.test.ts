/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { texturedShaderSource } from './shaders/textured.wgsl.js';

/**
 * The mesh shaders draw no edges of their own (#5746).
 *
 * `main.wgsl.ts` used to darken edges from screen-space derivatives of view
 * depth and the shaded normal, gated by `uniforms.flags.z` with the strength
 * in `flags.w`. A 2x2 pixel quad cannot tell a crease from an entity seam, so
 * it broke into dashes along seams (#5385), and with the edge pass on it
 * darkened every crease a second time. The edge pass (`edge-pass.ts`) is now
 * the single edge source.
 *
 * WGSL does not run under `tsx --test`, so this reads the two exported shader
 * sources, the strings handed to `createShaderModule`. Each absence is paired
 * with a presence check so a rename cannot pass it vacuously. Both imports
 * exist on trees that predate the removal, where the absences fail.
 */

const SHADERS = { main: mainShaderSource, textured: texturedShaderSource } as const;

/** Body of WGSL function `name` in `src`, braces matched. */
function wgslFnBody(src: string, name: string): string {
  const start = src.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let end = open; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) return src.slice(open, end + 1);
  }
  throw new Error(`fn ${name} is unbalanced`);
}

describe('mesh shaders carry no derivative edge darkening (#5746)', () => {
  for (const [label, src] of Object.entries(SHADERS)) {
    it(`${label}: fs_main reads no flags.z / flags.w lane`, () => {
      const fs = wgslFnBody(src, 'fs_main');
      // Positive control: fs_main still reads the lanes that remain live.
      assert.match(fs, /uniforms\.flags\.x/);
      assert.match(fs, /uniforms\.flags\.y/);
      assert.doesNotMatch(src, /uniforms\.flags\.z/, 'flags.z (edgeEnabled) is no longer read');
      assert.doesNotMatch(src, /uniforms\.flags\.w/, 'flags.w (edgeIntensityMilli) is no longer read');
    });

    it(`${label}: the only screen-space derivative in fs_main is the face normal`, () => {
      const fs = wgslFnBody(src, 'fs_main');
      // The face normal is the one sanctioned derivative use.
      const faceNormal = 'cross(dpdx(fragmentPos), dpdy(fragmentPos))';
      assert.ok(fs.includes(faceNormal), 'face normal from dpdx/dpdy of fragmentPos');
      const rest = fs.replace(faceNormal, '');
      assert.doesNotMatch(rest, /\b(dpdx|dpdy|fwidth)(Fine|Coarse)?\s*\(/, 'no other derivative in fs_main');
      assert.doesNotMatch(fs, /edgeFactor|edgeDarken|depthGradient|normalGradient/);
    });

    it(`${label}: the view-position varying that only fed the edge term is gone`, () => {
      assert.match(src, /@location\(6\) eyePos: vec3<f32>/, 'positive control: varyings still declared');
      assert.doesNotMatch(src, /\bviewPos\b/);
    });
  }
});
