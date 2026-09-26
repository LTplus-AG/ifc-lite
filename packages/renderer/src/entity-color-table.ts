/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-entity colour table (#6076): colour overrides (lens, charts, IDS,
 * compare, 4D) are applied in the BASE pass by looking the entity up in one
 * GPU storage buffer, instead of copying the overridden geometry into overlay
 * batches drawn in a second equal-depth pass.
 *
 * WHAT THE SHADER CAN KNOW. Every flat vertex carries a u32 entity lane whose
 * low 24 bits are the scene id (`MeshData.expressId`, the federated global id)
 * masked to 24 bits, and whose high 8 bits are a colour salt for the depth
 * nudge (`packEntityLane` in scene-geometry.ts). It does NOT carry a model
 * index: federated global ids exceed 2^24 as soon as a few models load (each
 * model's range is its max express id plus a 1,000,000 headroom), so the lane
 * alone is ambiguous across models. Each draw therefore also passes an
 * ANCHOR, the smallest full id it draws (`uniforms.overrideParams.x`), and the
 * shader rebuilds the full id as `anchor + ((lane - anchor) mod 2^24)`. That is
 * exact whenever the draw's ids span less than 2^24, which holds for every
 * bucket batch (a bucket belongs to one model) and fails only for a model with
 * more than 16.7M express ids, whose lanes already collide for picking
 * (`mergeGeometry` warns). {@link entityIdAnchor} returns null for such a draw
 * and the renderer leaves it unpainted rather than paint the wrong entity.
 *
 * TABLE LAYOUT: an open-addressing hash table keyed by the full id, one
 * `array<u32>` storage buffer:
 *
 *   [0] capacity (power of two, 0 when empty)   [1] max probe distance
 *   [2] entry count                              [3] colourBase = 4 + capacity
 *   [4 .. 4 + capacity)                         keys, EMPTY = 0xFFFFFFFF
 *   [colourBase + 4 * slot .. + 4)              rgba as f32 bit patterns
 *
 * Linear probing from `fmix32(id) & (capacity - 1)`, load factor at most 1/2,
 * and the longest displacement recorded in the header so the shader's probe
 * loop has a bound. A dense per-model table (slot = express id) was the other
 * candidate; it is sized by the model's STEP line count rather than by what
 * is overridden, which on a large federation is tens of millions of slots and
 * exceeds the 128 MiB default `maxStorageBufferBindingSize`. This table is
 * sized by the number of overridden entities only.
 *
 * MEMORY BOUND: 20 bytes per slot plus a 16-byte header, capacity =
 * nextPow2(2n) (minimum 16), so under 80 bytes per overridden entity and at
 * least 40. 100,000 overridden entities take 262,144 slots = 5.0 MiB. The
 * capacity is capped by `maxStorageBufferBindingSize` and `maxBufferSize`
 * (2,097,152 entries at the 128 MiB default); past that the extra entries are
 * dropped with one console warning.
 *
 * `EntityColorTable.write` rebuilds the image on the CPU (O(n)) and uploads it
 * with one `queue.writeBuffer`; the GPU buffer is reallocated only when the
 * image outgrows it (or the device changed, after a device-loss recovery), and
 * the renderer rebinds it at frame start (`RenderPipeline.setEntityColorTableBuffer`).
 */

type Rgba = readonly [number, number, number, number];

/** Key value of an unused slot. Federated ids stop far below it (`FederationRegistry`'s 2e9 limit). */
export const ENTITY_COLOR_EMPTY_KEY = 0xFFFFFFFF;
/** Header words before the key section. */
export const ENTITY_COLOR_HEADER_WORDS = 4;
const MIN_CAPACITY = 16;
const BYTES_PER_SLOT = 20; // one u32 key + four f32 colour lanes
/** Distinct full ids one draw can resolve from the 24-bit lane (see the module doc). */
export const ENTITY_LANE_ID_SPAN = 0x1000000;
/** Used when a device reports no limit (the WebGPU default for `maxStorageBufferBindingSize`). */
const DEFAULT_MAX_TABLE_BYTES = 128 * 1024 * 1024;

/** `overrideParams.y` bit: this draw applies the table. */
export const OVERRIDE_PARAM_PAINT = 1;
/** `overrideParams.y` bit: paint the override unlit and opaque (`RenderOptions.emphasizeOverrides`). */
export const OVERRIDE_PARAM_EMPHASIZE = 2;

/** murmur3's 32-bit finalizer; `entityColorSlotHash` in the WGSL is the same function. */
export function entityColorSlotHash(key: number): number {
  let h = key >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The table as uploaded: `words` is the whole buffer image. */
export interface EntityColorTableImage {
  readonly words: Uint32Array;
  readonly capacity: number;
  readonly count: number;
  readonly maxProbe: number;
  /** Overrides that did not fit under the device's buffer limits. */
  readonly dropped: number;
}

const EMPTY_IMAGE: EntityColorTableImage = {
  words: new Uint32Array(ENTITY_COLOR_HEADER_WORDS), capacity: 0, count: 0, maxProbe: 0, dropped: 0,
};

function isTableKey(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < ENTITY_COLOR_EMPTY_KEY;
}

function capacityFor(entries: number, maxBytes: number): number {
  let capacity = MIN_CAPACITY;
  while (capacity < entries * 2) capacity *= 2;
  while (capacity > MIN_CAPACITY && ENTITY_COLOR_HEADER_WORDS * 4 + capacity * BYTES_PER_SLOT > maxBytes) capacity /= 2;
  return capacity;
}

/** Build the buffer image for `overrides` (keys are scene ids, colours linear 0..1 RGBA). */
export function buildEntityColorTableImage(
  overrides: ReadonlyMap<number, Rgba>,
  maxBytes: number = DEFAULT_MAX_TABLE_BYTES,
): EntityColorTableImage {
  let entries = 0;
  for (const id of overrides.keys()) if (isTableKey(id)) entries++;
  if (entries === 0) return EMPTY_IMAGE;
  const capacity = capacityFor(entries, maxBytes);
  const limit = Math.min(entries, capacity / 2);
  const colorBase = ENTITY_COLOR_HEADER_WORDS + capacity;
  const words = new Uint32Array(colorBase + capacity * 4);
  const colors = new Float32Array(words.buffer);
  words.fill(ENTITY_COLOR_EMPTY_KEY, ENTITY_COLOR_HEADER_WORDS, colorBase);
  const mask = capacity - 1;
  let count = 0;
  let maxProbe = 0;
  for (const [id, rgba] of overrides) {
    if (count === limit) break;
    if (!isTableKey(id)) continue;
    let slot = entityColorSlotHash(id) & mask;
    let probe = 0;
    while (words[ENTITY_COLOR_HEADER_WORDS + slot] !== ENTITY_COLOR_EMPTY_KEY) {
      slot = (slot + 1) & mask;
      probe++;
    }
    words[ENTITY_COLOR_HEADER_WORDS + slot] = id;
    colors.set([rgba[0], rgba[1], rgba[2], rgba[3]], colorBase + slot * 4);
    if (probe > maxProbe) maxProbe = probe;
    count++;
  }
  words[0] = capacity;
  words[1] = maxProbe;
  words[2] = count;
  words[3] = colorBase;
  return { words, capacity, count, maxProbe, dropped: entries - count };
}

/** CPU mirror of the shader lookup: the colour stored for `id`, or null (sentinel). */
export function lookupEntityColor(image: EntityColorTableImage, id: number): [number, number, number, number] | null {
  if (image.count === 0 || !isTableKey(id)) return null;
  const { words, capacity } = image;
  const colorBase = words[3];
  const mask = capacity - 1;
  let slot = entityColorSlotHash(id) & mask;
  for (let i = 0; i <= image.maxProbe && i < capacity; i++) {
    const key = words[ENTITY_COLOR_HEADER_WORDS + slot];
    if (key === id) {
      const c = new Float32Array(words.buffer, (colorBase + slot * 4) * 4, 4);
      return [c[0], c[1], c[2], c[3]];
    }
    if (key === ENTITY_COLOR_EMPTY_KEY) return null;
    slot = (slot + 1) & mask;
  }
  return null;
}

/**
 * The anchor a draw passes so the shader can rebuild full ids from 24-bit
 * lanes: the smallest id, or null when the ids span 2^24 or more (or are not
 * table keys) and the draw must stay unpainted.
 */
export function entityIdAnchor(ids: ArrayLike<number>): number | null {
  if (ids.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!isTableKey(id)) return null;
    if (id < min) min = id;
    if (id > max) max = id;
  }
  return max - min < ENTITY_LANE_ID_SPAN ? min : null;
}

/** CPU mirror of the shader's `resolveLaneEntityId`: the full id behind a lane under `anchor`. */
export function resolveLaneEntityId(anchor: number, lane: number): number {
  return (anchor + (((lane >>> 0) - anchor) & 0x00FFFFFF)) >>> 0;
}

const anchorCache = new WeakMap<object, number | null>();

/** {@link entityIdAnchor} of a batch, cached per batch object (a batch's `expressIds` never change). */
export function batchEntityIdAnchor(batch: { readonly expressIds: readonly number[] }): number | null {
  let anchor = anchorCache.get(batch);
  if (anchor === undefined) {
    anchor = entityIdAnchor(batch.expressIds);
    anchorCache.set(batch, anchor);
  }
  return anchor;
}

const hasOverrideCache = new WeakMap<object, { generation: number; has: boolean }>();

/**
 * Whether any entity of `batch` is overridden, cached per batch for one
 * override `generation` (`Scene.getColorOverrideGeneration`). A batch with none
 * is drawn with the table off, so its fragments skip the lookup entirely.
 */
export function batchHasColorOverride(
  batch: { readonly expressIds: readonly number[] },
  overrides: ReadonlyMap<number, unknown> | null,
  generation: number,
): boolean {
  if (!overrides || overrides.size === 0) return false;
  const cached = hasOverrideCache.get(batch);
  if (cached && cached.generation === generation) return cached.has;
  const has = batch.expressIds.some((id) => overrides.has(id));
  hasOverrideCache.set(batch, { generation, has });
  return has;
}

/**
 * Write a draw's `overrideParams` lanes (x = anchor, y = mode bits). A null
 * anchor, or `paint = false`, writes zeros: the draw keeps its own colour.
 */
export function packOverrideParams(out: Uint32Array, anchor: number | null, paint: boolean, emphasize: boolean): void {
  if (paint && anchor !== null) {
    out[0] = anchor;
    out[1] = OVERRIDE_PARAM_PAINT | (emphasize ? OVERRIDE_PARAM_EMPHASIZE : 0);
  } else {
    out[0] = 0;
    out[1] = 0;
  }
  out[2] = 0;
  out[3] = 0;
}

interface TableDevice {
  readonly limits?: { readonly maxStorageBufferBindingSize?: number; readonly maxBufferSize?: number };
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
  readonly queue: { writeBuffer(buffer: GPUBuffer, offset: number, data: Uint32Array): void };
}

let warnedDropped = false;

/** Owns the table's CPU image and its GPU buffer. One per `Scene`. */
export class EntityColorTable {
  private image: EntityColorTableImage = EMPTY_IMAGE;
  private buffer: GPUBuffer | null = null;
  private bufferDevice: TableDevice | null = null;
  private bufferBytes = 0;
  private uploadedBytes = 0;

  /** Replace the table with `overrides` and upload it. */
  write(device: TableDevice, overrides: ReadonlyMap<number, Rgba>): void {
    const limits = device.limits;
    const maxBytes = Math.min(
      limits?.maxStorageBufferBindingSize ?? DEFAULT_MAX_TABLE_BYTES,
      limits?.maxBufferSize ?? DEFAULT_MAX_TABLE_BYTES,
    );
    this.image = buildEntityColorTableImage(overrides, maxBytes);
    if (this.image.dropped > 0 && !warnedDropped) {
      warnedDropped = true;
      console.warn(`[EntityColorTable] ${this.image.dropped} colour overrides exceed the device's storage-buffer limit and are not painted.`);
    }
    const bytes = this.image.words.byteLength;
    if (!this.buffer || this.bufferDevice !== device || this.bufferBytes < bytes) {
      this.buffer?.destroy();
      this.bufferBytes = Math.max(bytes, ENTITY_COLOR_HEADER_WORDS * 4);
      this.buffer = device.createBuffer({
        label: 'entity-color-table',
        size: this.bufferBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bufferDevice = device;
    }
    device.queue.writeBuffer(this.buffer, 0, this.image.words);
    this.uploadedBytes = bytes;
  }

  /** Empty the table: only the 16-byte header is rewritten (count 0 disables every lookup). */
  clear(): void {
    this.image = EMPTY_IMAGE;
    this.uploadedBytes = 0;
    if (this.buffer && this.bufferDevice) {
      this.bufferDevice.queue.writeBuffer(this.buffer, 0, EMPTY_IMAGE.words);
      this.uploadedBytes = EMPTY_IMAGE.words.byteLength;
    }
  }

  /** Drop the GPU buffer (device loss, scene teardown); the CPU image survives for re-upload. */
  releaseGpu(): void {
    this.buffer?.destroy();
    this.buffer = null;
    this.bufferDevice = null;
    this.bufferBytes = 0;
  }

  /** The buffer the renderer binds, or null while nothing was ever written. */
  getBuffer(): GPUBuffer | null {
    return this.buffer;
  }

  /** The current CPU image (what the GPU buffer holds after the last write). */
  getImage(): EntityColorTableImage {
    return this.image;
  }

  /** Bytes the last `write` / `clear` uploaded. */
  getLastUploadBytes(): number {
    return this.uploadedBytes;
  }
}
