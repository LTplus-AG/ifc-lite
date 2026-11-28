// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Hands out a decoded batch's per-mesh arrays as views into a few large
 * buffers, instead of one ArrayBuffer per mesh array. Opt-in
 * (`ParseRequestOptions.sharedBuffers`); by default every mesh owns its buffers.
 *
 * Why: a 275k-mesh model decoded with an own buffer per positions, normals
 * and indices array is ~825k ArrayBuffers. The browser runs a full garbage
 * collection whenever new ArrayBuffer memory crosses its external-memory
 * limit, and every such collection marks and sweeps everything already
 * loaded. A federation slot decoded beside resident models then spent most
 * of its time in those collections (a public 275k-mesh model: 28 s as the
 * first slot, ~170 s as the second). Slabs cut the buffers to a handful per
 * batch. The local WASM path already hands out views the same way
 * (`unpackFlatBatch` in `@ifc-lite/geometry`), so the viewer handles meshes
 * that share a buffer; other callers must not transfer one mesh's buffer.
 */

/** At most 64 MiB of f32/u32 per shared slab: few buffers per batch. An array larger than that gets a buffer of its own size. */
export const DEFAULT_SLAB_ELEMENTS = 16 * 1024 * 1024;

type SlabArray = Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;

/**
 * Views for a batch whose total element count is known up front. Each slab is
 * sized to what the batch still needs (capped at `slabElements`), so a small
 * batch allocates exactly its own size and nothing is left over at the end.
 */
export class TypedArraySlab<T extends SlabArray> {
  private slab: T | null = null;
  private used = 0;
  private remaining: number;

  constructor(
    private readonly create: (length: number) => T,
    totalElements: number,
    private readonly slabElements = DEFAULT_SLAB_ELEMENTS,
  ) {
    this.remaining = Math.max(0, totalElements);
  }

  /** A zero-filled array of `length` elements, viewing the current slab (a new one when it is full; its own buffer when larger than a slab). */
  take(length: number): T {
    if (this.slabElements <= 0) return this.create(length); // owned buffers: nothing is shared
    if (!this.slab || this.used + length > this.slab.length) {
      this.slab = this.create(Math.max(length, Math.min(this.slabElements, this.remaining)));
      this.used = 0;
    }
    const view = this.slab.subarray(this.used, this.used + length) as T;
    this.used += length;
    this.remaining -= length;
    return view;
  }
}

/** `sharedBuffers` of `ParseRequestOptions`: whether a batch's meshes view shared buffers or own theirs. */
export interface MeshBufferOptions { sharedBuffers?: boolean }

/**
 * The three slabs of one flat batch, after checking the per-mesh columns they are sized from: every
 * column must have a row per mesh and every count must be a non-negative integer. A malformed payload
 * fails loudly here instead of decoding into empty or overlapping meshes.
 */
export function meshSlabs(
  meshCount: number,
  vertexStarts: ArrayLike<number>, vertexCounts: ArrayLike<number>,
  indexStarts: ArrayLike<number>, indexCounts: ArrayLike<number>,
  { sharedBuffers = false }: MeshBufferOptions = {},
) {
  if ([vertexStarts, vertexCounts, indexStarts, indexCounts].some((column) => column.length !== meshCount)) {
    throw new Error('Malformed Parquet geometry: inconsistent mesh column lengths');
  }
  let vertices = 0, indices = 0;
  for (let i = 0; i < meshCount; i++) {
    const v = vertexCounts[i], n = indexCounts[i];
    if (!Number.isInteger(v) || v < 0 || !Number.isInteger(n) || n < 0) {
      throw new Error(`Malformed Parquet geometry: mesh ${i} has an invalid vertex or index count (${v}, ${n})`);
    }
    vertices += v; indices += n;
  }
  // A zero-capacity slab gives every array its own buffer of exactly its size: the default, owned buffers.
  const capacity = sharedBuffers ? DEFAULT_SLAB_ELEMENTS : 0;
  return {
    positionSlab: new TypedArraySlab((length) => new Float32Array(length), vertices * 3, capacity),
    normalSlab: new TypedArraySlab((length) => new Float32Array(length), vertices * 3, capacity),
    indexSlab: new TypedArraySlab((length) => new Uint32Array(length), indices, capacity),
  };
}
