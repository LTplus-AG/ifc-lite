/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ghost fragment stage is fs_main up to the diffuse light rig: it returns
 * before every term a faint ghost cannot show, and keeps the discards and the
 * vertex stage untouched.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ghostShaderSource } from './shaders/ghost.wgsl.js';
import { mainShaderSource } from './shaders/main.wgsl.js';

function fsMain(src: string): string {
  return src.slice(src.indexOf('fn fs_main'));
}

describe('ghost.wgsl', () => {
  it('returns before specular, shadows, the selection tint and the colour override', () => {
    const fs = fsMain(ghostShaderSource);
    const ret = fs.indexOf('return ghost;');
    assert.ok(ret > 0, 'the ghost return is in fs_main');
    for (const call of ['surfaceSpecular(', 'sunShadowFactor(', 'let isSelected', 'entityOverrideColor(']) {
      const at = fs.indexOf(call);
      assert.ok(at === -1 || at > ret, `${call} runs after the ghost return`);
    }
  });

  it('keeps the discards and the light rig, at the translucent alpha', () => {
    const fs = fsMain(ghostShaderSource);
    const ret = fs.indexOf('return ghost;');
    for (const kept of ['if (sectionClipped(fragmentPos)) { discard; }', 'let faceN', 'let irradiance', 'input.color.a * TRANSLUCENT_OPACITY_SCALE']) {
      const at = fs.indexOf(kept);
      assert.ok(at > 0 && at < ret, `${kept} runs before the ghost return`);
    }
  });

  it('leaves everything before fs_main as the main shader has it', () => {
    const head = (src: string) => src.slice(0, src.indexOf('fn fs_main'));
    assert.strictEqual(head(ghostShaderSource), head(mainShaderSource));
  });
});
