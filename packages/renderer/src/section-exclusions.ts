/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PickClipState } from './pick-types.js';
import { entityVisibilityWgsl } from './entity-visibility-table.js';

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

// One group per device submission, shared by colour, masks, shadow and picking:
// binding 0 the section exclusions, binding 1 the hide/isolate table
// (entity-visibility-table.ts, #10264 S2). Owners retain/release it; mask
// passes borrow it while the renderer is alive.
const tables = new WeakMap<GPUDevice, SectionExclusions>();
export function sectionExclusions(device: GPUDevice): SectionExclusions {
  let table = tables.get(device);
  if (!table) { table = new SectionExclusions(device); tables.set(device, table); }
  return table;
}
export const SECTION_EXCLUSIONS_GROUP = 3;
const INITIAL_VISIBILITY_BYTES = 64 * 1024;

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
  visibility: GPUBuffer;
  bindGroup: GPUBindGroup;
  private snapshot = new Set<number>();
  private owners = 0;
  private bytes = 4;
  private visibilityBytes: number;
  private visibilityImage: Uint32Array | null = null;
  /** A larger visibility buffer awaiting its error scopes; never bound before it settles. */
  private visibilityGrowth: Promise<boolean> | null = null;
  /** The image whose growth WebGPU rejected: not retried, so sustained OOM cannot loop. */
  private visibilityFailed: Uint32Array | null = null;
  private released = false;
  private readonly limit: number;
  constructor(private device: GPUDevice) {
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } });
    this.layout = device.createBindGroupLayout({ entries: [storage(0), storage(1)] });
    this.limit = Math.min(device.limits?.maxStorageBufferBindingSize ?? 134217728, device.limits?.maxBufferSize ?? 268435456);
    this.buffer = this.allocate('section-excluded-ids', 4);
    // Room for ~16k hidden/isolated ids up front: a larger table only becomes
    // usable a frame later (growVisibility), so ordinary hide sets never wait.
    this.visibilityBytes = this.storageBytes(INITIAL_VISIBILITY_BYTES);
    this.visibility = this.allocate('entity-visibility', this.visibilityBytes); // zeroed = nothing hidden
    this.bindGroup = this.bind();
  }
  retain(): void { this.owners++; }
  release(): void {
    if (--this.owners === 0) { this.released = true; this.buffer.destroy(); this.visibility.destroy(); tables.delete(this.device); }
  }
  private allocate(label: string, size: number): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  /** `bytes`, capped at the device limit and kept a multiple of 4 bytes. */
  private storageBytes(bytes: number): number {
    const cap = this.limit - this.limit % 4;
    return Math.min(bytes, cap);
  }
  private bind(): GPUBindGroup {
    return this.device.createBindGroup({ layout: this.layout, entries: [
      { binding: 0, resource: { buffer: this.buffer } }, { binding: 1, resource: { buffer: this.visibility } },
    ] });
  }
  update(ids?: ReadonlySet<number> | null): void {
    if (this.snapshot.size === (ids?.size ?? 0) && [...this.snapshot].every(id => ids?.has(id))) return;
    const image = sectionExclusionImage(ids);
    if (image.byteLength > this.limit) throw new RangeError('Section exclusions exceed the GPU storage buffer limit');
    if (image.byteLength > this.bytes) {
      this.buffer.destroy(); this.bytes = image.byteLength;
      this.buffer = this.allocate('section-excluded-ids', this.bytes); this.bindGroup = this.bind();
    }
    this.device.queue.writeBuffer(this.buffer, 0, image);
    this.snapshot = new Set(ids);
  }
  /**
   * Make `image` (`entityVisibilityImage`) the hide/isolate table the next
   * submission reads. An image already written is not uploaded again. Returns
   * false, leaving the bound table unchanged, when the image cannot be held:
   * over the device's storage binding limit, or larger than the current
   * buffer while its replacement is unconfirmed or was rejected. The caller
   * must then not draw anything that relies on the table, rather than draw
   * hidden geometry.
   */
  writeVisibility(image: Uint32Array): boolean {
    if (image.byteLength > this.limit) return false;
    if (image.byteLength > this.visibilityBytes) { this.growVisibility(image); return false; }
    if (image !== this.visibilityImage) {
      this.device.queue.writeBuffer(this.visibility, 0, image);
      this.visibilityImage = image;
    }
    return true;
  }
  /** Settles true once a larger table is bound, false when WebGPU rejected it; null when none is pending. */
  get visibilityPending(): Promise<boolean> | null { return this.visibilityGrowth; }
  /**
   * `createBuffer` does not throw on out-of-memory: it returns an invalid
   * buffer and reports through an error scope, later. Binding that buffer
   * would invalidate group 3 for every draw and pick, so the validated buffer
   * stays bound until the replacement's scopes settle clean. One attempt per
   * pending growth, none for an image already rejected; a different image (a
   * new hide/isolate state) may try again, and a smaller one that fits the
   * bound buffer is written at once.
   */
  private growVisibility(image: Uint32Array): void {
    if (this.visibilityGrowth || image === this.visibilityFailed) return;
    const device = this.device;
    let size = Math.max(16, this.visibilityBytes);
    while (size < image.byteLength) size *= 2; // geometric, so a growing set reallocates rarely
    size = this.storageBytes(size);
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    let candidate: GPUBuffer | null = null;
    try { candidate = this.allocate('entity-visibility', size); } catch { candidate = null; }
    // Pop both before awaiting so no other caller's scope is consumed.
    const scopes = Promise.all([device.popErrorScope(), device.popErrorScope()]);
    this.visibilityGrowth = scopes.then(([validation, memory]) => {
      const error = validation ?? memory;
      if (error) console.warn('[SectionExclusions] entity visibility table growth rejected; partly hidden batches stay out:', error.message);
      return candidate !== null && !error;
    }, () => false).then(valid => {
      this.visibilityGrowth = null;
      if (!valid || this.released) {
        candidate?.destroy();
        if (!valid) this.visibilityFailed = image;
        return false;
      }
      this.visibility.destroy();
      this.visibility = candidate!; this.visibilityBytes = size;
      this.visibilityImage = null; // the new buffer is zeroed: write the current image on next use
      this.visibilityFailed = null;
      this.bindGroup = this.bind();
      return true;
    });
  }
}

/** Binary search is bounded by log2(count); the empty default reads just the count. */
export const sectionExclusionsWgsl = `
@group(3) @binding(0) var<storage, read> sectionExcludedIds: array<u32>;
@group(3) @binding(1) var<storage, read> entityVisibility: array<u32>;
${entityVisibilityWgsl}
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
