/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coldAbBrowserArgs, DEFAULT_COLD_AB_GPU_ARGS } from './browser-cold-launch.mjs';

describe('coldAbBrowserArgs', () => {
  it('keeps the default real-GPU flags when the host exports none', () => {
    assert.deepEqual(coldAbBrowserArgs({}), [...DEFAULT_COLD_AB_GPU_ARGS]);
    assert.deepEqual(coldAbBrowserArgs({ IFC_GPU_CHROME_ARGS: '  ' }), [...DEFAULT_COLD_AB_GPU_ARGS]);
  });

  it("uses the host's GPU launch and pins the high-performance adapter", () => {
    assert.deepEqual(coldAbBrowserArgs({ IFC_GPU_CHROME_ARGS: '--enable-unsafe-webgpu  --enable-features=Vulkan --use-angle=vulkan' }),
      ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--use-webgpu-power-preference=default-high-performance']);
  });
});
