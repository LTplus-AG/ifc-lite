/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import {
  INSTANCE_FINISH_FLAGS_MASK,
  INSTANCE_FLAG_SELECTED,
  INSTANCE_FLAGS_OFFSET,
  INSTANCE_STRIDE_BYTES,
  packInstanceFinish,
} from './instanced-render.js';

/**
 * #5984: an instanced occurrence's IFC-authored finish rides the flags lane of
 * its GPU record, which `Scene.writeInstanceFlags` rewrites wholesale on every
 * selection / hide / isolate change. The rewrite must carry the finish bits
 * through, or selecting and deselecting a glossy occurrence turns it matte.
 */

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeDevice(): { device: GPUDevice; buffers: WeakMap<GPUBuffer, ArrayBuffer> } {
  const buffers = new WeakMap<GPUBuffer, ArrayBuffer>();
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(desc.size);
      const buffer = { size: desc.size, getMappedRange: () => data, unmap() {}, destroy() {} } as unknown as GPUBuffer;
      buffers.set(buffer, data);
      return buffer;
    },
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
        new Uint8Array(buffers.get(buffer)!, offset, data.byteLength)
          .set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
    },
  } as unknown as GPUDevice;
  return { device, buffers };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function kieferShard(): DecodedInstancedShard {
  return {
    carriesItemIds: false,
    carriesFinishes: true,
    templates: [{
      positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]),
      normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      origin: [0, 0, 0],
    }],
    instances: [
      // FZK-Haus's instanced IfcMember 'Kiefer' pieces author roughness 0.9.
      { templateIndex: 0, entityId: 9, color: [0.6, 0.5, 0.4, 1], transform: IDENTITY, roughness: 0.9 },
      { templateIndex: 0, entityId: 10, color: [0.6, 0.5, 0.4, 1], transform: IDENTITY },
    ],
  };
}

describe('instanced finish survives selection and visibility writes (#5984)', () => {
  it('keeps the finish bits through select, deselect, hide and show', () => {
    const { device, buffers } = fakeDevice();
    const scene = new Scene();
    scene.addInstancedShard(device, kieferShard(), 0);
    const gpu = scene.getInstancedTemplates()[0];
    const flags = (i: number) =>
      new DataView(buffers.get(gpu.instanceBuffer)!).getUint32(i * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true);
    const kiefer = packInstanceFinish(undefined, 0.9);
    assert.notEqual(kiefer, 0);

    scene.setInstancedSelection(new Set([9]));
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED);
    assert.equal((flags(0) & INSTANCE_FINISH_FLAGS_MASK) >>> 0, kiefer, 'selected, still glossy-rough');

    scene.setInstancedSelection(new Set());
    assert.equal(flags(0), kiefer, 'deselected: exactly the finish, nothing else');

    scene.setInstancedVisibility(new Set([9]), undefined);
    assert.equal((flags(0) & INSTANCE_FINISH_FLAGS_MASK) >>> 0, kiefer, 'hidden keeps it');
    scene.setInstancedVisibility(new Set(), undefined);
    assert.equal(flags(0), kiefer);
    assert.equal((flags(1) & INSTANCE_FINISH_FLAGS_MASK) >>> 0, 0, 'an unauthored occurrence carries no finish bits');
  });
});
