/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { skyShaderSource } from './shaders/sky.wgsl.js';
import { texturedShaderSource } from './shaders/textured.wgsl.js';

/**
 * The colour pipeline lights authored sRGB colours in linear and grades
 * nothing in display space (#5381).
 *
 * Before this contract the fragment stage multiplied sRGB values by light as
 * if they were linear, then darkened near-greys, stretched contrast about 0.5,
 * boosted saturation 1.4x, ran ACES and a 2.2 power. Measured on real models:
 * an authored grass green rgb(53,142,41) rendered neon rgb(0,175,39), a brown
 * brick rgb(114,51,14) rendered crimson, every grey at or below 40/255 rendered
 * pure black on every face, and pure white never exceeded 202/255.
 *
 * WGSL cannot run under `tsx --test`, so these assert the shader sources at the
 * only level that can see the stages, in the idiom of
 * `sun-softness-wiring.test.ts`: each negative assertion is paired with a
 * positive one so a rename cannot make it pass vacuously. Everything is read
 * from the three shader sources, so the file also loads against a tree that
 * predates the contract and fails there on assertions.
 */

const TRANSFER_FNS = ['srgbToLinear', 'linearToSrgb', 'neutralCompress'] as const;

/** Every definition of WGSL function `name` in `src`, braces matched. */
function wgslFnDefinitions(src: string, name: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(`fn ${name}(`, from);
    if (start < 0) return found;
    const open = src.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    found.push(src.slice(start, end + 1));
    from = end + 1;
  }
}

describe('linear colour pipeline (#5381)', () => {
  it('decodes the authored colour to linear before it is multiplied by light', () => {
    const read = mainShaderSource.indexOf('var baseColor = input.color.rgb;');
    const decode = mainShaderSource.indexOf('baseColor = srgbToLinear(baseColor);');
    const lit = mainShaderSource.indexOf('var color = baseColor * irradiance;');
    assert.ok(read >= 0 && decode >= 0 && lit >= 0, 'expected read, decode and light stages in fs_main');
    assert.ok(read < decode && decode < lit, 'the albedo must be decoded after it is read and before it is lit');
  });

  it('multiplies the selection uniform directly, with no shader-side sRGB decode (#5484)', () => {
    // Selection was a hardcoded WGSL sRGB literal, decoded in-shader
    // (`srgbToLinear(vec3<f32>(0.3, 0.6, 1.0))`). #5484 made it a themeable
    // uniform (`Renderer.setOverlayTheme`), and moved the decode to the CPU
    // side (the viewer pushes `tokenToLinearRgba`, already linear) — so the
    // shader must consume `selectionColor.rgb` AS-IS, not re-decode it (that
    // would double-decode and darken every themed selection colour).
    assert.match(mainShaderSource, /color = selectionColor\.rgb \* shade;/);
    assert.doesNotMatch(
      mainShaderSource,
      /color = srgbToLinear\(selectionColor\.rgb\)/,
      'selectionColor must not be decoded again in-shader — it already arrives linear',
    );
  });

  it('keeps no display-space grading in the geometry or sky shaders', () => {
    for (const [name, src] of [['main', mainShaderSource], ['sky', skyShaderSource]] as const) {
      assert.ok(src.includes('neutralCompress('), `${name}: expected the shared highlight roll-off`);
      assert.ok(src.includes('linearToSrgb('), `${name}: expected the exact sRGB encode`);
      assert.doesNotMatch(src, /satBoost|isWhiteish/, `${name}: saturation boost / near-grey darkening is back`);
      assert.doesNotMatch(src, /\(color - 0\.5\) \* /, `${name}: contrast stretch about 0.5 is back`);
      assert.doesNotMatch(src, /1\.0 \/ 2\.2/, `${name}: a 2.2 power encode is back`);
      assert.doesNotMatch(src, /\b2\.51\b|acesTonemap/, `${name}: ACES is back`);
    }
  });

  it('gives geometry, textured geometry and sky one identical transfer, defined once each', () => {
    const sources = { main: mainShaderSource, textured: texturedShaderSource, sky: skyShaderSource };
    for (const fn of TRANSFER_FNS) {
      const bodies = Object.entries(sources).map(([name, src]) => {
        const defs = wgslFnDefinitions(src, fn);
        assert.equal(defs.length, 1, `${name}: expected exactly one \`fn ${fn}\`, found ${defs.length}`);
        return defs[0];
      });
      assert.ok(bodies.every((b) => b === bodies[0]), `\`fn ${fn}\` differs between shaders; they must share color-transfer.wgsl.ts`);
    }
  });
});
