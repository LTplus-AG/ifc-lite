/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FRAGMENT_DISCARDS_BEGIN, FRAGMENT_DISCARDS_END, mainShaderSource } from './shaders/main.wgsl.js';
import { opaqueFastShaderSource, withoutFragmentDiscards } from './shaders/main-opaque-fast.wgsl.js';

const fragmentOf = (src: string): string => src.slice(src.indexOf('fn fs_main('));

/**
 * The discard-free opaque variant: a fragment stage that can discard disables
 * early depth rejection, so overdraw was fully shaded on every frame. The
 * variant must differ from the main shader ONLY by the bracketed discards.
 */
describe('discard-free opaque shader derivation', () => {
  it('every fs_main discard sits inside the brackets of the main shader', () => {
    const fragment = fragmentOf(mainShaderSource);
    const begin = fragment.indexOf(FRAGMENT_DISCARDS_BEGIN);
    const end = fragment.indexOf(FRAGMENT_DISCARDS_END);
    assert.ok(begin > 0 && end > begin, 'fs_main carries one bracketed span');
    const outside = fragment.slice(0, begin) + fragment.slice(end);
    assert.doesNotMatch(outside, /\bdiscard\b/);
    // The three discards the renderer reasons about when it picks the variant.
    const inside = fragment.slice(begin, end);
    assert.match(inside, /input\.instSelected & 2u/);
    assert.match(inside, /uniforms\.flags\.x & 4u/);
    assert.match(inside, /sectionClipped\(fragmentPos, input\.sectionEntityId\)/);
  });

  it('removes exactly the bracketed span and nothing else', () => {
    const begin = mainShaderSource.indexOf(FRAGMENT_DISCARDS_BEGIN);
    const end = mainShaderSource.indexOf(FRAGMENT_DISCARDS_END) + FRAGMENT_DISCARDS_END.length;
    assert.equal(opaqueFastShaderSource, mainShaderSource.slice(0, begin) + mainShaderSource.slice(end));
    assert.doesNotMatch(fragmentOf(opaqueFastShaderSource), /\bdiscard\b/);
    // Shading, the colour override and both outputs survive.
    for (const kept of ['let fragmentPos = clipSpacePos', 'let faceN = cross(dpdx(fragmentPos), dpdy(fragmentPos));',
      'entityOverrideColor(input.entityId)', 'out.objectIdEncoded = encodeId24(input.entityId);']) {
      assert.ok(fragmentOf(opaqueFastShaderSource).includes(kept), kept);
    }
    // The vertex entries the base pipelines use are untouched.
    for (const entry of ['fn vs_main(', 'fn vs_main_quantized(', 'fn vs_instanced(']) {
      assert.ok(opaqueFastShaderSource.includes(entry), entry);
    }
  });

  it('refuses a shader whose brackets are missing, duplicated, or that discards outside them', () => {
    assert.throws(() => withoutFragmentDiscards('fn fs_main() { discard; }'), /brackets not found/);
    const twice = `${FRAGMENT_DISCARDS_BEGIN} ${FRAGMENT_DISCARDS_END} ${FRAGMENT_DISCARDS_BEGIN} ${FRAGMENT_DISCARDS_END}`;
    assert.throws(() => withoutFragmentDiscards(`fn fs_main() { ${twice} }`), /not unique/);
    assert.throws(
      () => withoutFragmentDiscards(`fn fs_main() { ${FRAGMENT_DISCARDS_BEGIN} discard; ${FRAGMENT_DISCARDS_END} if (x) { discard; } }`),
      /outside the brackets/,
    );
  });
});
