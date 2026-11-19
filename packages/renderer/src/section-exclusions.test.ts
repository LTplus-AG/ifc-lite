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

/** A device whose error scopes settle when the test decides (#10636). */
function scopedDevice(limit = 1 << 20) {
  const buffers: Array<{ size: number; destroyed: number; destroy(): void }> = [];
  const writes: Array<{ buffer: unknown; image: number[] }> = [];
  const scopes: GPUErrorFilter[] = [];
  const pending: Array<{ filter: GPUErrorFilter; settle(error: GPUError | null): void; fail(reason: unknown): void }> = [];
  let throwOnCreate = false;
  const device = { limits: { maxStorageBufferBindingSize: limit, maxBufferSize: limit },
    createBindGroupLayout: () => ({}),
    createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor,
    createBuffer: ({ size }: { size: number }) => {
      if (throwOnCreate) throw new RangeError('createBuffer failed');
      const buffer = { size, destroyed: 0, destroy() { this.destroyed++; } }; buffers.push(buffer); return buffer;
    },
    pushErrorScope: (filter: GPUErrorFilter) => { scopes.push(filter); },
    popErrorScope: () => new Promise<GPUError | null>((settle, fail) => pending.push({ filter: scopes.pop()!, settle, fail })),
    queue: { writeBuffer: (buffer: unknown, _offset: number, image: Uint32Array) => writes.push({ buffer, image: [...image] }) },
  } as unknown as GPUDevice;
  const settleAll = async (oom: GPUError | null) => {
    for (const scope of pending.splice(0)) scope.settle(scope.filter === 'out-of-memory' ? oom : null);
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  return { device, buffers, writes, scopes, pending, settleAll, setThrow(value: boolean) { throwOnCreate = value; } };
}
const idsImage = (count: number) => { const image = new Uint32Array(4 + count); image[0] = count; return image; };
const groupBuffers = (group: GPUBindGroup) => (group as unknown as GPUBindGroupDescriptor).entries.map(e => (e.resource as GPUBufferBinding).buffer);

it('keeps the validated visibility table bound until a growth settles, and never uploads into an unconfirmed one (#10636)', async () => {
  const h = scopedDevice();
  const table = sectionExclusions(h.device); table.retain();
  const initial = table.visibility, group = table.bindGroup;
  const big = idsImage(20_000);
  assert.equal(table.writeVisibility(big), false, 'unconfirmed: dependent draws stay out');
  assert.equal(table.writeVisibility(big), false);
  assert.equal(h.buffers.filter(b => b.size > (initial as unknown as { size: number }).size).length, 1, 'one attempt while pending');
  assert.equal(h.scopes.length, 0, 'both scopes popped before awaiting');
  assert.equal(table.bindGroup, group); assert.equal(table.visibility, initial);
  assert.ok(h.writes.every(w => w.buffer === initial || w.buffer === h.buffers[0]), 'nothing written into the candidate');
  const pending = table.visibilityPending!;
  await h.settleAll(null);
  assert.equal(await pending, true); assert.equal(table.visibilityPending, null);
  assert.notEqual(table.bindGroup, group);
  assert.equal(groupBuffers(table.bindGroup)[1], table.visibility);
  assert.equal((initial as unknown as { destroyed: number }).destroyed, 1);
  assert.equal(table.writeVisibility(big), true);
  assert.equal(h.writes.at(-1)!.buffer, table.visibility, 'the current image lands in the confirmed table');
  table.release();
});

it('treats a rejected scope or a throwing createBuffer as a failed growth, and frees a candidate settling after release (#10636)', async () => {
  const lost = scopedDevice();
  const table = sectionExclusions(lost.device); table.retain();
  const big = idsImage(20_000);
  table.writeVisibility(big);
  for (const scope of lost.pending.splice(0)) scope.fail(new Error('Instance dropped in popErrorScope'));
  assert.equal(await table.visibilityPending, false);
  assert.equal(lost.buffers.at(-1)!.destroyed, 1, 'device-lost candidate released');
  assert.equal(table.writeVisibility(big), false); assert.equal(table.visibilityPending, null, 'not retried');
  assert.equal(table.writeVisibility(idsImage(3)), true, 'a fitting image still works');
  table.release();

  const throwing = scopedDevice();
  const second = sectionExclusions(throwing.device); second.retain();
  throwing.setThrow(true);
  assert.equal(second.writeVisibility(big), false);
  assert.equal(throwing.scopes.length, 0, 'scopes stay balanced when createBuffer throws');
  await throwing.settleAll(null);
  assert.equal(second.visibilityPending, null);
  assert.equal(second.writeVisibility(big), false, 'not retried for the same image');
  throwing.setThrow(false);
  const beforeRetry = throwing.buffers.length;
  assert.equal(second.writeVisibility(idsImage(20_000)), false, 'equal contents are still rejected');
  assert.equal(second.visibilityPending, null);
  assert.equal(throwing.buffers.length, beforeRetry, 'a fresh array does not retry the same rejected state');
  assert.equal(second.writeVisibility(idsImage(20_001)), false, 'changed contents may try again');
  second.release(); // the last owner leaves while the growth is pending
  await throwing.settleAll(null);
  assert.equal(throwing.buffers.at(-1)!.destroyed, 1, 'a candidate confirmed after release is destroyed, not bound');
});

it('binds the highlight table at binding 2 and grows it like the visibility table (#10264 S3)', async () => {
  const h = scopedDevice();
  const table = sectionExclusions(h.device); table.retain();
  const initial = table.highlight;
  assert.equal(groupBuffers(table.bindGroup)[2], initial);
  assert.equal(table.writeHighlight(new Uint32Array([2, 3, 4])), true);
  assert.equal(h.writes.at(-1)!.buffer, initial);
  const big = new Uint32Array(20_001); big[0] = 20_000;
  assert.equal(table.writeHighlight(big), false, 'unconfirmed: batch highlights stay out');
  assert.equal(table.highlight, initial);
  const visibility = table.visibility;
  const pending = table.highlightPending!;
  await h.settleAll(null);
  assert.equal(await pending, true);
  assert.notEqual(table.highlight, initial);
  assert.equal(table.visibility, visibility, 'the visibility table is untouched');
  assert.deepEqual(groupBuffers(table.bindGroup), [table.buffer, table.visibility, table.highlight]);
  assert.equal(table.writeHighlight(big), true);
  table.release();
});
