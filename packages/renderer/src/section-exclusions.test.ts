/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { sectionExclusionImage, sectionExclusions } from './section-exclusions.js';
import { entityIdPageKey, entityIdAnchor, resolveLaneEntityId } from './entity-color-table.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 128, COPY_DST: 8 };
(globalThis as Record<string, unknown>).GPUShaderStage = { FRAGMENT: 2 };

it('keeps IDs with identical low 24 bits distinct under the enforced scene page invariant (#8015)', () => {
  const low = 101, high = low + 0x1000000;
  assert.notEqual(entityIdPageKey(low, 'same-color'), entityIdPageKey(high, 'same-color'));
  assert.equal(entityIdAnchor([low, high]), null, 'a hand-built ambiguous draw is rejected');
  assert.equal(resolveLaneEntityId(entityIdAnchor([high])!, low), high);
  assert.deepEqual([...sectionExclusionImage(new Set([high, low]))], [2, low, high]);
});

it('uploads only changed exclusions, grows safely and frees shared resources after the last owner (#8015)', () => {
  const buffers: Array<{ size: number; destroyed: number; destroy(): void }> = [];
  const uploads: number[][] = [];
  const device = { limits: { maxStorageBufferBindingSize: 1024, maxBufferSize: 1024 },
    createBindGroupLayout: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: { size: number }) => {
      const buffer = { size, destroyed: 0, destroy() { this.destroyed++; } }; buffers.push(buffer); return buffer;
    },
    queue: { writeBuffer: (_buffer: unknown, _offset: number, image: Uint32Array) => uploads.push([...image]) },
  } as unknown as GPUDevice;
  const table = sectionExclusions(device);
  table.retain(); table.retain();
  const ids = new Set([101]);
  table.update(ids); table.update(new Set(ids));
  assert.deepEqual(uploads, [[1, 101]], 'equal contents do not re-upload');
  ids.add(101 + 0x1000000); table.update(ids);
  assert.deepEqual(uploads.at(-1), [2, 101, 101 + 0x1000000]);
  assert.equal(buffers[0]!.destroyed, 1, 'old allocation released after growth');
  ids.clear(); table.update(ids);
  assert.deepEqual(uploads.at(-1), [0]);
  table.release(); assert.equal(buffers.at(-1)!.destroyed, 0, 'other GPU pass still owns it');
  table.release(); assert.equal(buffers.at(-1)!.destroyed, 1);
});
