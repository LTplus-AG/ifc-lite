/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NullGraphicsDevice } from 'playcanvas';
import { pointResources } from '../point-resources.mjs';

test('scan replacement releases prior PlayCanvas buffers and materials (#8140)', () => {
  const device = new NullGraphicsDevice();
  const resources = pointResources(device);
  // NullGraphicsDevice does not initialize GPU allocations; inspect the real
  // resource registry rather than its upload-dependent VRAM counter.
  const baseline = device.buffers.size;
  let priorMesh = null;
  const destroyed = [];
  try {
    for (let index = 0; index < 3; index++) {
      const { mesh, material } = resources.replace({ positions: new Float32Array([index, 0, 0]) });
      if (priorMesh) assert.equal(priorMesh.vertexBuffer, null);
      assert.equal(device.buffers.size, baseline + 1, 'only the active scan buffer remains');
      assert.equal(destroyed.length, index, 'the previous material is destroyed on replacement');
      const destroy = material.destroy.bind(material);
      material.destroy = () => { destroyed.push(index); destroy(); };
      priorMesh = mesh;
    }
    resources.clear();
    resources.clear();
    assert.equal(device.buffers.size, baseline);
    assert.deepEqual(destroyed, [0, 1, 2], 'each scan material is released exactly once');
  } finally { resources.clear(); device.destroy(); }
});
