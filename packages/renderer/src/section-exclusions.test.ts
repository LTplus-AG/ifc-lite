/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { bindSectionExclusions, emptyBindGroup, emptyBindGroupLayout, sectionExclusionImage, sectionExclusions, withSectionExclusions } from './section-exclusions.js';
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

/**
 * Pre-gpuweb#4946 validation (#9060): an EMPTY bind group layout is still a
 * slot that needs a bound group, which is what the failing browsers enforce.
 */
function strictDevice() {
  const device = { limits: {}, createBuffer: () => ({ destroy() {} }),
    createBindGroupLayout: (d: { entries: unknown[] }) => ({ entries: d.entries }),
    createBindGroup: (d: { layout: unknown }) => ({ layout: d.layout }),
  } as unknown as GPUDevice;
  const bound: unknown[] = [];
  const pass = { setBindGroup: (slot: number, group: unknown) => { bound[slot] = group; } } as unknown as GPURenderPassEncoder;
  const unbound = (layouts: GPUBindGroupLayout[]) => layouts.flatMap((_, slot) => bound[slot] ? [] : [slot]);
  return { device, pass, bound, unbound };
}

it('binds every padded slot so the layout validates where empty layouts are not holes (#9060)', () => {
  const strict = strictDevice();
  const own = strict.device.createBindGroupLayout({ entries: [{ binding: 0 }] } as GPUBindGroupLayoutDescriptor);
  const layouts = withSectionExclusions(strict.device, [own]);
  assert.equal(layouts.length, 4);
  strict.pass.setBindGroup(0, {} as GPUBindGroup);
  assert.deepEqual(strict.unbound(layouts), [1, 2, 3], 'the defect: groups 1 and 2 are padding nobody bound');
  bindSectionExclusions(strict.pass, strict.device, 1);
  assert.deepEqual(strict.unbound(layouts), []);
  assert.equal(strict.bound[1], emptyBindGroup(strict.device));
  assert.equal(strict.bound[2], emptyBindGroup(strict.device));
  assert.equal(layouts[1], emptyBindGroupLayout(strict.device), 'padding shares the empty bound layout');
  assert.equal(strict.bound[3], sectionExclusions(strict.device).bindGroup);
});

it('leaves caller-owned groups below the first padded slot alone (#9060)', () => {
  const strict = strictDevice();
  const environment = {} as GPUBindGroup;
  strict.pass.setBindGroup(1, environment);
  bindSectionExclusions(strict.pass, strict.device, 2);
  assert.equal(strict.bound[1], environment, 'the main pass environment at group 1 survives');
  assert.equal(strict.bound[2], emptyBindGroup(strict.device));
});
