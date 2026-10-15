/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHardwareAdapter } from './hardware-adapter.mjs';

test('#6993 a named hardware vendor is a real adapter', () => {
  assert.equal(isHardwareAdapter({ vendor: 'nvidia', architecture: 'blackwell', description: 'NVIDIA GeForce' }), true);
});

test('#6993 software rasterizers, missing and blank vendors are refused wherever the marker appears', () => {
  for (const adapter of [
    { vendor: 'google', architecture: 'swiftshader' },
    { vendor: 'mesa', description: 'llvmpipe (LLVM 17)' },
    { vendor: 'microsoft', description: 'Microsoft Basic Render Driver (Software)' },
    { vendor: '', description: 'NVIDIA' }, { vendor: '   ' }, { description: 'NVIDIA' }, null, undefined, 'nvidia',
  ]) assert.equal(isHardwareAdapter(adapter), false, JSON.stringify(adapter));
});
