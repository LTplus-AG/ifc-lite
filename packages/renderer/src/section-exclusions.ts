/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PickClipState } from './pick-types.js';

/** All section planes are exempted together; the crop box remains independent (#8015). */
export function entityClip(clip: PickClipState | null | undefined, id: number): PickClipState | null | undefined {
  return clip?.sectionExcludedIds?.has(id) ? { clipBox: clip.clipBox } : clip;
}

/** Sorted full scene ids: count followed by keys. No 24-bit aliasing across models. */
export function sectionExclusionImage(ids?: ReadonlySet<number> | null): Uint32Array {
  const keys = [...(ids ?? [])].filter(id => Number.isInteger(id) && id >= 0 && id < 0xFFFFFFFF).sort((a, b) => a - b);
  const image = new Uint32Array(keys.length + 1);
  image[0] = keys.length; image.set(keys, 1);
  return image;
}

// One table per device submission, shared by colour, masks, shadow and picking.
// Owners retain/release it; mask passes borrow it while the renderer is alive.
const tables = new WeakMap<GPUDevice, SectionExclusions>();
export function sectionExclusions(device: GPUDevice): SectionExclusions {
  let table = tables.get(device);
  if (!table) { table = new SectionExclusions(device); tables.set(device, table); }
  return table;
}
export const SECTION_EXCLUSIONS_GROUP = 3;

// WebGPU before gpuweb#4946 (Nov 2024) still requires a bind group at every
// slot of a pipeline layout, even an empty one; current Dawn treats empty
// layouts as holes. Padded slots are therefore always bound explicitly (#9060).
const empties = new WeakMap<GPUDevice, { layout: GPUBindGroupLayout; group: GPUBindGroup }>();
function empty(device: GPUDevice): { layout: GPUBindGroupLayout; group: GPUBindGroup } {
  let entry = empties.get(device);
  if (!entry) {
    const layout = device.createBindGroupLayout({ label: 'empty-padding-bgl', entries: [] });
    entry = { layout, group: device.createBindGroup({ label: 'empty-padding', layout, entries: [] }) };
    empties.set(device, entry);
  }
  return entry;
}
export const emptyBindGroupLayout = (device: GPUDevice): GPUBindGroupLayout => empty(device).layout;
export const emptyBindGroup = (device: GPUDevice): GPUBindGroup => empty(device).group;

export function withSectionExclusions(device: GPUDevice, layouts: GPUBindGroupLayout[]): GPUBindGroupLayout[] {
  for (let slot = 0; slot < SECTION_EXCLUSIONS_GROUP; slot++) layouts[slot] ??= emptyBindGroupLayout(device);
  return [...layouts, sectionExclusions(device).layout];
}

/**
 * Bind the exclusion table at group 3 and an empty group at every slot from
 * `firstPadded` up to it: the slots `withSectionExclusions` padded for this
 * pipeline. Slots below `firstPadded` are the caller's own groups.
 */
export function bindSectionExclusions(pass: GPUBindingCommandsMixin, device: GPUDevice, firstPadded = SECTION_EXCLUSIONS_GROUP): void {
  for (let slot = firstPadded; slot < SECTION_EXCLUSIONS_GROUP; slot++) pass.setBindGroup(slot, emptyBindGroup(device));
  pass.setBindGroup(SECTION_EXCLUSIONS_GROUP, sectionExclusions(device).bindGroup);
}
class SectionExclusions {
  readonly layout: GPUBindGroupLayout;
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  private snapshot = new Set<number>();
  private owners = 0;
  private bytes = 4;
  constructor(private device: GPUDevice) {
    this.layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }] });
    this.buffer = this.allocate(4);
    this.bindGroup = this.bind();
  }
  retain(): void { this.owners++; }
  release(): void {
    if (--this.owners === 0) { this.buffer.destroy(); tables.delete(this.device); }
  }
  private allocate(size: number): GPUBuffer {
    return this.device.createBuffer({ label: 'section-excluded-ids', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  private bind(): GPUBindGroup {
    return this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
  }
  update(ids?: ReadonlySet<number> | null): void {
    if (this.snapshot.size === (ids?.size ?? 0) && [...this.snapshot].every(id => ids?.has(id))) return;
    const image = sectionExclusionImage(ids);
    const limit = Math.min(this.device.limits.maxStorageBufferBindingSize ?? 134217728, this.device.limits.maxBufferSize ?? 268435456);
    if (image.byteLength > limit) throw new RangeError('Section exclusions exceed the GPU storage buffer limit');
    if (image.byteLength > this.bytes) {
      this.buffer.destroy(); this.bytes = image.byteLength;
      this.buffer = this.allocate(this.bytes); this.bindGroup = this.bind();
    }
    this.device.queue.writeBuffer(this.buffer, 0, image);
    this.snapshot = new Set(ids);
  }
}

/** Binary search is bounded by log2(count); the empty default reads just the count. */
export const sectionExclusionsWgsl = `
@group(3) @binding(0) var<storage, read> sectionExcludedIds: array<u32>;
// Scene colour buckets are partitioned by 2^24 ID page. Reject an invalid anchor.
fn sectionEntityFromLane(anchor: u32, lane: u32) -> u32 {
  return select(anchor + ((lane - anchor) & 0x00FFFFFFu), 0xFFFFFFFFu, anchor == 0xFFFFFFFFu);
}
fn sectionExcluded(id: u32) -> bool {
  var lo = 0u;
  var hi = sectionExcludedIds[0];
  while (lo < hi) {
    let mid = lo + (hi - lo) / 2u;
    let key = sectionExcludedIds[mid + 1u];
    if (key == id) { return true; }
    if (key < id) { lo = mid + 1u; } else { hi = mid; }
  }
  return false;
}
`;
