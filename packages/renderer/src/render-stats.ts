/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame + memory statistics for the renderer (issue #1682 observability).
 *
 * `FrameStats` is a snapshot of the last completed `Renderer.render()`;
 * `sumResidentGpuBytes` walks the scene's GPU-resident collections and sums
 * actual `GPUBuffer.size` values (allocation-accurate: it reflects what was
 * requested from the device, including any internal padding the buffers were
 * created with). Textures are estimated from their dimensions at 4 B/texel.
 */

/** Statistics for one rendered frame (the main render pass only). */
export interface FrameStats {
  /**
   * Geometry draw calls issued by the last main render pass: colour batches,
   * partial/overlay sub-batches, instanced templates, textured meshes,
   * transparent + selected meshes. Excludes the sky pass, section-plane
   * overlays and the on-demand pick pass.
   */
  drawCalls: number;
  /** Colour batches that passed all per-frame gates and were drawn. */
  batchesDrawn: number;
  /** Colour batches rejected by the frustum test this frame. */
  batchesFrustumCulled: number;
  /** Colour batches rejected by contribution (projected-size) culling. */
  batchesContributionCulled: number;
  /**
   * Visible batches skipped because their GPU buffers were evicted under the
   * residency budget; a rebuild was requested and they draw again within a
   * frame or two (issue #1682 phase 3a).
   */
  batchesNotResident: number;
  /** Batches drawn at their simplified LOD1 index range this frame. */
  batchesAtLod1: number;
  /** GPU-instanced templates drawn this frame (one draw call each). */
  instancedDrawn: number;
  /** Instanced templates rejected by the frustum test (union world AABB). */
  instancedFrustumCulled: number;
  /**
   * Instanced templates rejected by contribution culling: even the largest
   * single occurrence, projected at the union box's nearest view depth,
   * fell below the pixel threshold.
   */
  instancedContributionCulled: number;
  /** `performance.now()` timestamp taken at the end of the render call. */
  timestamp: number;
}

/** Minimal structural slice of a GPU buffer (real `GPUBuffer` satisfies it). */
interface SizedBuffer {
  size: number;
}

interface BatchLike {
  vertexBuffer: SizedBuffer;
  indexBuffer: SizedBuffer;
  uniformBuffer?: SizedBuffer;
  /** LOD1 second index range (issue #1682 phase 5), when built. */
  lod1IndexBuffer?: SizedBuffer;
}

interface TexturedLike extends BatchLike {
  texture: { width: number; height: number; depthOrArrayLayers: number };
}

interface InstancedLike {
  vertexBuffer: SizedBuffer;
  indexBuffer: SizedBuffer;
  instanceBuffer: SizedBuffer;
}

/** Byte totals per GPU-resident collection. All values in bytes. */
export interface ResidentGpuBytes {
  /** Colour batches (incl. streaming fragments) + cached partial sub-batches. */
  batches: number;
  /** Individually hydrated meshes (selection/picking/fallback paths). */
  meshes: number;
  /** Textured meshes, including an estimated 4 B/texel for the texture. */
  textured: number;
  /** Instanced templates: template geometry + per-occurrence instance buffers. */
  instanced: number;
  total: number;
}

const sumBatch = (b: BatchLike): number =>
  b.vertexBuffer.size + b.indexBuffer.size + (b.uniformBuffer?.size ?? 0) + (b.lod1IndexBuffer?.size ?? 0);

/**
 * Sum the GPU bytes held by the scene's mesh collections.
 *
 * Not covered (owned outside the scene's mesh tables): point-cloud buffers,
 * pick/post-process render targets, and the depth/MSAA attachments.
 */
export function sumResidentGpuBytes(input: {
  batches: Iterable<BatchLike>;
  partialBatches: Iterable<BatchLike>;
  meshes: Iterable<BatchLike>;
  textured: Iterable<TexturedLike>;
  instanced: Iterable<InstancedLike>;
}): ResidentGpuBytes {
  let batches = 0;
  for (const b of input.batches) batches += sumBatch(b);
  for (const b of input.partialBatches) batches += sumBatch(b);

  let meshes = 0;
  for (const m of input.meshes) meshes += sumBatch(m);

  let textured = 0;
  for (const t of input.textured) {
    textured += sumBatch(t);
    textured += t.texture.width * t.texture.height * t.texture.depthOrArrayLayers * 4;
  }

  let instanced = 0;
  for (const t of input.instanced) {
    instanced += t.vertexBuffer.size + t.indexBuffer.size + t.instanceBuffer.size;
  }

  return { batches, meshes, textured, instanced, total: batches + meshes + textured + instanced };
}
