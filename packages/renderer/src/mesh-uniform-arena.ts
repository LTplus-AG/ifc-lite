/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pooled per-draw mesh uniforms: one `queue.writeBuffer` per arena page per
 * frame instead of one per drawn batch.
 *
 * Every colour batch owns a 512-byte mesh uniform block whose RTE lanes
 * (`drawableDelta = origin - eye`, camera high/low, view-projection) change
 * with the camera, so a moving camera rewrites every drawn batch. Writing
 * each block to its own GPUBuffer cost one GPU-process queue operation per
 * drawn batch (~1,370 per frame on a large Archicad model), the same
 * write-count bottleneck #6393 measured for instanced deltas. Here each
 * block is a 256-aligned slice of a shared page: draws stage their bytes
 * into the page's CPU mirror, and `flush` uploads each changed page span in
 * a single write before the frame is submitted. The WGSL `Uniforms` struct,
 * the bind group layout and the packed bytes are unchanged; only the buffer
 * a batch's bind group points at differs.
 *
 * A block whose bytes did not change since the last flush is not uploaded,
 * so an idle re-render (hover, selection) with a still camera writes
 * nothing.
 *
 * Slot reuse waits for a flush: a released slot may still be referenced by
 * draws encoded earlier in the current frame, and those must read the bytes
 * staged for them, not a new owner's.
 */

/** WebGPU guarantees `minUniformBufferOffsetAlignment <= 256`. */
const UNIFORM_OFFSET_ALIGNMENT = 256;
/** Slots per page: 512 x 512 B = 256 KiB pages. */
export const MESH_UNIFORM_SLOTS_PER_PAGE = 512;

/** One draw's uniform block: an aligned slice of a shared arena page. */
export interface MeshUniformSlot {
  /** The page buffer; bind it with `offset` and `size`, never whole. */
  readonly buffer: GPUBuffer;
  /** Byte offset of this block inside `buffer` (256-aligned). */
  readonly offset: number;
  /** Bytes of the block (the mesh uniform size). */
  readonly size: number;
  /** Return the slot to its arena. Idempotent; never destroys the page. */
  release(): void;
}

interface Page {
  readonly buffer: GPUBuffer;
  readonly mirror: Uint32Array;
  live: number;
  dirtyLo: number;
  dirtyHi: number;
}

class Slot implements MeshUniformSlot {
  released = false;
  constructor(
    readonly arena: MeshUniformArena,
    readonly page: Page,
    readonly index: number,
    readonly offset: number,
    readonly size: number,
  ) {}
  get buffer(): GPUBuffer { return this.page.buffer; }
  release(): void {
    if (this.released) return;
    this.released = true;
    this.arena.retire(this);
  }
}

export class MeshUniformArena {
  private readonly stride: number;
  private readonly strideWords: number;
  private readonly sizeWords: number;
  private readonly pages: Page[] = [];
  private readonly free: Slot[] = [];
  private retired: Slot[] = [];
  private lastSource: Float32Array | null = null;
  private lastSourceWords: Uint32Array | null = null;

  constructor(
    private readonly device: GPUDevice,
    readonly slotSize: number,
    private readonly slotsPerPage = MESH_UNIFORM_SLOTS_PER_PAGE,
  ) {
    if (!(slotSize > 0) || slotSize % 4 !== 0) throw new RangeError(`Mesh uniform slot size ${slotSize} is not a positive multiple of 4.`);
    this.stride = Math.ceil(slotSize / UNIFORM_OFFSET_ALIGNMENT) * UNIFORM_OFFSET_ALIGNMENT;
    this.strideWords = this.stride / 4;
    this.sizeWords = slotSize / 4;
  }

  allocate(): MeshUniformSlot {
    let slot = this.free.pop();
    if (!slot) {
      this.addPage();
      slot = this.free.pop()!;
    }
    slot.released = false;
    slot.page.live++;
    return slot;
  }

  /**
   * Copy `data` (the first `slotSize` bytes) into the slot's mirror, marking
   * it for the next `flush` only when a word differs. Compared as u32 so the
   * u32 lanes (flags, override anchors such as 0xFFFFFFFF, a NaN bit
   * pattern as f32) compare exactly.
   */
  stage(slot: MeshUniformSlot, data: Float32Array): void {
    if (!(slot instanceof Slot) || slot.released) throw new Error('Staging into a released or foreign mesh uniform slot.');
    if (data.length < this.sizeWords) throw new RangeError(`Mesh uniform data needs ${this.sizeWords} floats.`);
    if (data !== this.lastSource) {
      this.lastSource = data;
      this.lastSourceWords = new Uint32Array(data.buffer, data.byteOffset, data.length);
    }
    const source = this.lastSourceWords!;
    const mirror = slot.page.mirror;
    const base = slot.index * this.strideWords;
    let changed = false;
    for (let i = 0; i < this.sizeWords; i++) {
      const word = source[i]!;
      if (mirror[base + i] !== word) {
        mirror[base + i] = word;
        changed = true;
      }
    }
    if (!changed) return;
    const page = slot.page;
    if (slot.index < page.dirtyLo) page.dirtyLo = slot.index;
    if (slot.index > page.dirtyHi) page.dirtyHi = slot.index;
  }

  /**
   * Upload every changed span (one write per page that changed) and recycle
   * slots released before this call. Call once per frame, before submit.
   * Returns the number of writes issued.
   */
  flush(queue: GPUQueue): number {
    let writes = 0;
    for (const page of this.pages) {
      if (page.dirtyHi < page.dirtyLo) continue;
      const start = page.dirtyLo * this.strideWords;
      const end = page.dirtyHi * this.strideWords + this.sizeWords;
      queue.writeBuffer(page.buffer, start * 4, page.mirror.subarray(start, end));
      page.dirtyLo = Number.POSITIVE_INFINITY;
      page.dirtyHi = -1;
      writes++;
    }
    this.recycle();
    return writes;
  }

  /** Slot bookkeeping, called by `Slot.release`. */
  retire(slot: Slot): void {
    this.retired.push(slot);
  }

  /** Pages currently allocated (diagnostics and tests). */
  get pageCount(): number { return this.pages.length; }

  private addPage(): void {
    const buffer = this.device.createBuffer({
      label: 'mesh-uniform-arena',
      size: this.stride * this.slotsPerPage,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const page: Page = {
      buffer,
      mirror: new Uint32Array((this.stride * this.slotsPerPage) / 4),
      live: 0,
      dirtyLo: Number.POSITIVE_INFINITY,
      dirtyHi: -1,
    };
    this.pages.push(page);
    // Pushed in reverse so `pop()` hands out ascending slots: consecutive
    // allocations stay contiguous and their flush spans stay short.
    for (let i = this.slotsPerPage - 1; i >= 0; i--) {
      const slot = new Slot(this, page, i, i * this.stride, this.slotSize);
      slot.released = true;
      this.free.push(slot);
    }
  }

  private recycle(): void {
    if (this.retired.length === 0) return;
    const emptied = new Set<Page>();
    for (const slot of this.retired) {
      slot.page.live--;
      if (slot.page.live === 0) emptied.add(slot.page);
      this.free.push(slot);
    }
    this.retired = [];
    // Return wholly unused pages to the driver (a cleared model must not pin
    // its peak uniform footprint), keeping one so the next load starts warm.
    for (const page of emptied) {
      if (page.live !== 0 || this.pages.length <= 1) continue;
      this.pages.splice(this.pages.indexOf(page), 1);
      page.buffer.destroy();
      for (let i = this.free.length - 1; i >= 0; i--) if (this.free[i]!.page === page) this.free.splice(i, 1);
    }
  }
}

// One arena per device and slot size, like `sectionExclusions(device)`: the
// batch builder and the frame flush share it without threading an owner
// through every Scene path, and a recovered device gets a fresh arena. The
// pages die with their device (`Renderer.teardown` destroys it).
const arenas = new WeakMap<GPUDevice, Map<number, MeshUniformArena>>();

export function meshUniformArena(device: GPUDevice, slotSize: number): MeshUniformArena {
  let bySize = arenas.get(device);
  if (!bySize) { bySize = new Map(); arenas.set(device, bySize); }
  let arena = bySize.get(slotSize);
  if (!arena) { arena = new MeshUniformArena(device, slotSize); bySize.set(slotSize, arena); }
  return arena;
}

/** Flush every arena of `device`; the renderer calls this right before submit. */
export function flushMeshUniforms(device: GPUDevice): number {
  const bySize = arenas.get(device);
  if (!bySize) return 0;
  let writes = 0;
  for (const arena of bySize.values()) writes += arena.flush(device.queue);
  return writes;
}

/** Stage `data` into `slot` through the arena that owns it. */
export function stageMeshUniforms(slot: MeshUniformSlot, data: Float32Array): void {
  if (!(slot instanceof Slot)) throw new Error('Not a mesh uniform arena slot.');
  slot.arena.stage(slot, data);
}

/** A copy of the bytes `slot` holds once the frame's flush has run (diagnostics and tests). */
export function readMeshUniforms(slot: MeshUniformSlot): Float32Array {
  if (!(slot instanceof Slot)) throw new Error('Not a mesh uniform arena slot.');
  return new Float32Array(slot.page.mirror.buffer.slice(slot.offset, slot.offset + slot.size));
}
