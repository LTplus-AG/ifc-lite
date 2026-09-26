/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MathUtils } from './math.js';
import { writeFlatPickUniform } from './picker-rte-uniforms.js';
import { MAX_RTE_EYE_RELATIVE_METRES, RelativeToEyeSnapshot } from './relative-to-eye.js';
import type { Mesh } from './types.js';

function recordingDevice(): { device: GPUDevice; writes: number[] } {
  const writes: number[] = [];
  const device = {
    queue: { writeBuffer: (_buffer: GPUBuffer, offset: number) => { writes.push(offset); } },
  } as unknown as GPUDevice;
  return { device, writes };
}

function write(device: GPUDevice, rteOrigin: [number, number, number]): boolean {
  const scratch = new Float32Array(64);
  const flags = new Uint32Array(scratch.buffer, 44 * 4, 4);
  const mesh = { transform: MathUtils.identity(), rteOrigin } as unknown as Mesh;
  const snapshot = new RelativeToEyeSnapshot(1, [0, 0, 0], MathUtils.identity());
  return writeFlatPickUniform(device, {} as GPUBuffer, scratch, flags, mesh, snapshot, null, 3);
}

describe('flat pick uniforms and the RTE eye envelope (#6128)', () => {
  it('writes a mesh inside the camera-relative envelope', () => {
    const { device, writes } = recordingDevice();
    assert.equal(write(device, [MAX_RTE_EYE_RELATIVE_METRES, 0, 0]), true);
    assert.deepEqual(writes, [3 * 256]);
  });

  it('skips, rather than throws on, a mesh beyond the envelope', () => {
    const { device, writes } = recordingDevice();
    assert.equal(write(device, [MAX_RTE_EYE_RELATIVE_METRES + 1, 0, 0]), false);
    assert.deepEqual(writes, []);
  });
});
