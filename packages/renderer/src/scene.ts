/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene graph and mesh management
 */

import type { Mesh, BatchedMesh, Vec3, PickClipState } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import { BATCH_CONSTANTS } from './constants.js';
import {
  type BoundingBox,
  type RaycastHit,
  prepareRayDirInv,
  raycastBoundingBoxes,
  raycastTriangles,
  rayIntersectsBox,
} from './scene-raycaster.js';
import { mergeGeometry, splitMeshDataForBufferLimit, colorSaltByte, packEntityLane } from './scene-geometry.js';
import { OPAQUE_ALPHA_CUTOFF } from './overlay-routing.js';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import {
  prepareInstancedRender,
  INSTANCE_STRIDE_BYTES,
  INSTANCE_COLOR_OFFSET,
  INSTANCE_FLAGS_OFFSET,
  INSTANCE_FLAG_SELECTED,
  INSTANCE_FLAG_HIDDEN,
} from './instanced-render.js';

/** Consolidated per-bucket state — replaces six separate tracking maps. */
interface BatchBucket {
  key: string;                      // bucket key (color hash or "hash#N")
  meshData: MeshData[];             // accumulated source mesh data
  batchedMesh: BatchedMesh | null;  // built GPU batch (null during streaming)
  vertexBytes: number;              // accumulated vertex buffer bytes
}

/**
 * Release the GPU resources owned by a batch / mesh. Every
 * BatchedMesh and Mesh shares the same {vertex, index, optional
 * uniform} buffer layout, and forgetting any one of the three is a
 * GPU memory leak that won't surface until the user spends ten
 * minutes inside the viewer. Centralised here so callers don't
 * have to remember the cleanup sequence.
 *
 * Accepts the structural shape so it works for both BatchedMesh and
 * Mesh — they each carry the same buffer trio.
 */
/** A surface-textured mesh (#961): its own interleaved vertex buffer (with a UV
 *  lane), index buffer, per-mesh uniform buffer, GPU texture + sampler, and a
 *  bindGroup wiring all three. Drawn per-mesh in a dedicated sub-pass. */
export interface TexturedMesh {
  expressId: number;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  uniformBuffer: GPUBuffer;
  texture: GPUTexture;
  sampler: GPUSampler;
  bindGroup: GPUBindGroup;
  /** Authored tint (multiplies the sampled texel); white = texture passthrough. */
  color: [number, number, number, number];
}

function destroyGpuResources(
  m: { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; uniformBuffer?: GPUBuffer },
): void {
  m.vertexBuffer.destroy();
  m.indexBuffer.destroy();
  if (m.uniformBuffer) m.uniformBuffer.destroy();
}

/**
 * One GPU-uploaded instanced template: unique geometry (slot-0 vertex + index
 * buffers, 28-byte pos+norm+entityId vertex matching the flat layout) drawn once
 * per occurrence via a per-instance buffer at slot 1 and
 * `drawIndexed(indexCount, instanceCount)`. Buffers are Scene-owned, freed in clear().
 */
export interface InstancedTemplateGPU {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
}

/** Shared empty result for getInstancedTemplates() when the instanced pass is hidden. */
const EMPTY_INSTANCED_TEMPLATES: readonly InstancedTemplateGPU[] = [];

/** One occurrence's location in the instanced buffers, for per-instance selection
 *  + colour-override patching. originalColor restores after a lens/IDS overlay clears. */
interface InstancedOccurrence {
  templateIndex: number;
  byteOffset: number;
  originalColor: [number, number, number, number];
}

/** Compact CPU-side copy of one instanced template, retained so CPU consumers
 *  (bounds / raycast / measure / section / export) can reach instanced geometry
 *  WITHOUT holding a full per-occurrence MeshData each — the occurrences share this
 *  one geometry and apply their own matrix (read from `instanceData` at the
 *  occurrence's byteOffset+0, column-major). These are references into the decoded
 *  shard, so retaining them costs the (already compact) shard size, not N copies. */
interface InstancedTemplateCpu {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  instanceData: ArrayBuffer; // packed 88-byte instance records (mat4 at +0, col-major)
  localMin: [number, number, number];
  localMax: [number, number, number];
}

export class Scene {
  private meshes: Mesh[] = [];
  private batchedMeshes: BatchedMesh[] = [];                        // flat render array (rebuilt from buckets)
  private buckets: Map<string, BatchBucket> = new Map();            // bucketKey -> consolidated bucket state
  private meshDataBucket: Map<MeshData, BatchBucket> = new Map();   // reverse lookup: MeshData -> owning bucket
  private meshDataMap: Map<number, MeshData[]> = new Map();         // Map expressId -> MeshData[] (for lazy buffer creation, accumulates multiple pieces)
  private boundingBoxes: Map<number, BoundingBox> = new Map();      // Map expressId -> bounding box (computed lazily)
  private texturedMeshes: TexturedMesh[] = [];                      // #961: IFC surface-textured meshes (own buffers/texture/bindGroup)
  private texturedDevice?: GPUDevice;                               // #961: cached for textured-mesh re-upload on translate
  private instancedTemplates: InstancedTemplateGPU[] = [];          // GPU-instancing: unique templates + per-occurrence buffers (fed by addInstancedShard)
  private instancedVisible = true;                                  // GPU-instancing: hidden in Types view mode (instanced geometry is class-0 occurrences)
  private instancedEntityMap: Map<number, InstancedOccurrence[]> = new Map(); // express_id -> occurrences, for per-instance selection/overlay patching
  private instancedTemplateCpu: InstancedTemplateCpu[] = [];        // compact CPU geometry per template (index-aligned with instancedTemplates) for CPU consumers
  private instancedDevice?: GPUDevice;                              // cached for per-instance flag/colour writeBuffer updates
  private instancedSelected: Set<number> = new Set();              // currently flag-selected instanced express_ids
  private instancedHidden: Set<number> = new Set();               // currently hidden instanced express_ids (hide/isolate)
  private instancedOverridden: Set<number> = new Set();            // currently colour-overridden instanced express_ids
  private instancedHasTransparent = false;                         // an override made some instanced occurrence translucent
  private lastInstancedHiddenIds: ReadonlySet<number> | null = null;   // ref-equality guard for setInstancedVisibility
  private lastInstancedIsolatedIds: ReadonlySet<number> | null = null;
  private instancedVisibilityDirty = false;                       // set when a new shard adds occurrences → re-apply visibility

  // Buffer-size-aware bucket splitting: when a single color group's geometry
  // would exceed the GPU maxBufferSize, overflow is directed to a new
  // sub-bucket with a suffixed key (e.g. "500|500|500|1000#1"). This keeps
  // all downstream maps single-valued and the rendering code unchanged.
  private activeBucketKey: Map<string, string> = new Map(); // base colorKey -> current active bucket key
  private nextSplitId: number = 0; // Monotonic counter for sub-bucket keys
  private nextBatchId: number = 0; // Monotonic counter for unique batch identifiers
  // Shared local-frame origin for ALL batches (set from the first batch's world
  // bbox centre). Every batch stores positions relative to it and draws with
  // model = translate(sharedFrameOrigin), so coincident faces across batches
  // stay bit-coincident (no seam z-fight) while f32 vertex coords stay small.
  private sharedFrameOrigin: [number, number, number] | null = null;
  private cachedMaxBufferSize: number = 0; // device.limits.maxBufferSize * safety factor (set on first use)
  private static readonly STREAMING_FRAGMENT_MAX_INDICES = 180_000;
  private static readonly STREAMING_FRAGMENT_MAX_VERTEX_BYTES = 8 * 1024 * 1024;

  // Sub-batch cache for partially visible batches (PERFORMANCE FIX)
  // Key = colorKey + ":" + sorted visible expressIds hash
  // This allows rendering partially visible batches as single draw calls instead of 10,000+ individual draws
  private partialBatchCache: Map<string, BatchedMesh> = new Map();
  private partialBatchCacheKeys: Map<string, string> = new Map(); // sourceBatchKey -> current cache key (for invalidation)

  // Color overlay system for lens coloring — NEVER modifies original batches.
  // Overlay batches render on top using depthCompare 'equal', so they only
  // paint where original geometry already wrote depth. Clearing is instant.
  private overrideBatches: BatchedMesh[] = [];
  // Defensively-typed: the renderer is the sole writer (via setColorOverrides),
  // external readers go through getColorOverrides() and get a ReadonlyMap.
  private colorOverrides: ReadonlyMap<number, readonly [number, number, number, number]> | null = null;

  // Streaming optimization: track pending batch rebuilds
  private pendingBatchKeys: Set<string> = new Set();
  // Temporary fragment batches created during streaming for immediate rendering.
  // Destroyed and replaced by proper merged batches in finalizeStreaming().
  private streamingFragments: BatchedMesh[] = [];

  // ─── Mesh command queue ────────────────────────────────────────────
  // Decouples React state updates from GPU work.  Callers push meshes
  // via queueMeshes() (instant, no GPU), and the animation loop drains
  // the queue via flushPending() with a per-frame time budget.
  private meshQueue: MeshData[] = [];
  private meshQueueReadIndex: number = 0;

  // ─── GPU-resident mode ──────────────────────────────────────────────
  // After releaseGeometryData(), JS-side typed arrays are freed.
  // Only lightweight metadata is retained for operations that don't need
  // raw vertex data (bounding boxes, color key lookups, expressId sets).
  private geometryReleased: boolean = false;
  private ephemeralStreamingMode: boolean = false;

  /**
   * Add mesh to scene
   */
  addMesh(mesh: Mesh): void {
    this.meshes.push(mesh);
  }

  /**
   * Get all meshes
   */
  getMeshes(): Mesh[] {
    return this.meshes;
  }

  /**
   * Get all batched meshes
   */
  getBatchedMeshes(): BatchedMesh[] {
    return this.batchedMeshes;
  }

  /** The shared local-frame origin all batches relativize against (null until
   *  the first batch is built). Per-mesh highlight/picker VBOs replicate the
   *  batch's exact f32 path against this so they render bit-coincident. */
  getSharedFrameOrigin(): [number, number, number] | null {
    return this.sharedFrameOrigin;
  }

  /**
   * Store MeshData for lazy GPU buffer creation (used for selection highlighting)
   * This avoids creating 2x GPU buffers during streaming
   * Accumulates multiple mesh pieces per expressId (elements can have multiple geometry pieces)
   */
  addMeshData(meshData: MeshData): void {
    // For color-merged batches with per-vertex entityIds, register the mesh
    // under EVERY unique entity so picking/visibility/selection can find it.
    if (meshData.entityIds && meshData.entityIds.length > 0) {
      const seen = new Set<number>();
      for (let i = 0; i < meshData.entityIds.length; i++) {
        const eid = meshData.entityIds[i];
        if (seen.has(eid)) continue;
        seen.add(eid);
        const existing = this.meshDataMap.get(eid);
        if (existing) {
          existing.push(meshData);
        } else {
          this.meshDataMap.set(eid, [meshData]);
        }
      }
      return;
    }
    const existing = this.meshDataMap.get(meshData.expressId);
    if (existing) {
      existing.push(meshData);
    } else {
      this.meshDataMap.set(meshData.expressId, [meshData]);
    }
  }

  /**
   * Get MeshData by expressId (for lazy buffer creation)
   * Returns merged MeshData if element has multiple pieces with same color,
   * or first piece if colors differ (to preserve correct per-piece colors)
   * @param expressId - The expressId to look up
   * @param modelIndex - Optional modelIndex to filter by (for multi-model support)
   */
  getMeshData(expressId: number, modelIndex?: number): MeshData | undefined {
    let pieces = this.meshDataMap.get(expressId);
    if (!pieces || pieces.length === 0) return undefined;

    // Filter by modelIndex if provided (for multi-model support)
    if (modelIndex !== undefined) {
      pieces = pieces.filter(p => p.modelIndex === modelIndex);
      if (pieces.length === 0) return undefined;
    }

    if (pieces.length === 1) {
      const single = pieces[0];
      // For color-merged batches, extract only the vertices belonging to
      // this expressId so selection highlighting is per-entity, not the
      // entire merged batch.
      if (single.entityIds) {
        return this.extractEntityFromMergedMesh(single, expressId);
      }
      return single;
    }

    // For multiple pieces that are ALL merged batches referencing the same
    // entity, extract from each and concatenate.
    if (pieces.some(p => p.entityIds)) {
      const extracted: MeshData[] = [];
      for (const piece of pieces) {
        if (piece.entityIds) {
          const ex = this.extractEntityFromMergedMesh(piece, expressId);
          if (ex) extracted.push(ex);
        } else {
          extracted.push(piece);
        }
      }
      if (extracted.length === 0) return undefined;
      if (extracted.length === 1) return extracted[0];
      pieces = extracted;
      // Fall through to the normal multi-piece merge below
    }

    // Check if all pieces have the same color (within tolerance)
    // This handles multi-material elements like windows (frame vs glass)
    const firstColor = pieces[0].color;
    const colorTolerance = 0.01; // Allow small floating point differences
    const allSameColor = pieces.every(piece => {
      const c = piece.color;
      return Math.abs(c[0] - firstColor[0]) < colorTolerance &&
             Math.abs(c[1] - firstColor[1]) < colorTolerance &&
             Math.abs(c[2] - firstColor[2]) < colorTolerance &&
             Math.abs(c[3] - firstColor[3]) < colorTolerance;
    });

    // If colors differ, return first piece without merging
    // This preserves correct per-piece colors for multi-material elements
    // Callers can use getMeshDataPieces() if they need all pieces
    if (!allSameColor) {
      return pieces[0];
    }

    // All pieces have same color - safe to merge
    // Calculate total sizes
    let totalPositions = 0;
    let totalIndices = 0;
    for (const piece of pieces) {
      totalPositions += piece.positions.length;
      totalIndices += piece.indices.length;
    }

    // Create merged arrays
    const mergedPositions = new Float32Array(totalPositions);
    const mergedNormals = new Float32Array(totalPositions);
    const mergedIndices = new Uint32Array(totalIndices);

    let posOffset = 0;
    let idxOffset = 0;
    let vertexOffset = 0;

    for (const piece of pieces) {
      // Copy positions and normals
      mergedPositions.set(piece.positions, posOffset);
      mergedNormals.set(piece.normals, posOffset);

      // Copy indices with offset
      for (let i = 0; i < piece.indices.length; i++) {
        mergedIndices[idxOffset + i] = piece.indices[i] + vertexOffset;
      }

      posOffset += piece.positions.length;
      idxOffset += piece.indices.length;
      vertexOffset += piece.positions.length / 3;
    }

    // Return merged MeshData (all pieces have same color)
    return {
      expressId,
      modelIndex: pieces[0].modelIndex,  // Preserve modelIndex for multi-model support
      positions: mergedPositions,
      normals: mergedNormals,
      indices: mergedIndices,
      color: firstColor,
      ifcType: pieces[0].ifcType,
    };
  }

  /**
   * Check if MeshData exists for an expressId
   * @param expressId - The expressId to look up
   * @param modelIndex - Optional modelIndex to filter by (for multi-model support)
   */
  /**
   * Extract only the vertices/triangles belonging to `targetId` from a
   * color-merged MeshData that contains many entities.  Returns a new
   * lightweight MeshData suitable for selection highlighting.
   */
  private extractEntityFromMergedMesh(merged: MeshData, targetId: number): MeshData | undefined {
    const entityIds = merged.entityIds!;
    const positions = merged.positions;
    const normals = merged.normals;
    const indices = merged.indices;

    // Build a vertex mask and remap table
    const vertexCount = entityIds.length;
    const keep = new Uint8Array(vertexCount);
    let keptCount = 0;
    for (let i = 0; i < vertexCount; i++) {
      if (entityIds[i] === targetId) { keep[i] = 1; keptCount++; }
    }
    if (keptCount === 0) return undefined;

    // Remap old vertex index → new compacted index
    const remap = new Uint32Array(vertexCount);
    let newIdx = 0;
    for (let i = 0; i < vertexCount; i++) {
      if (keep[i]) { remap[i] = newIdx++; }
    }

    // Compact positions & normals
    const outPos = new Float32Array(keptCount * 3);
    const outNorm = new Float32Array(keptCount * 3);
    let outOff = 0;
    for (let i = 0; i < vertexCount; i++) {
      if (!keep[i]) continue;
      const src = i * 3;
      outPos[outOff] = positions[src];
      outPos[outOff + 1] = positions[src + 1];
      outPos[outOff + 2] = positions[src + 2];
      outNorm[outOff] = normals[src];
      outNorm[outOff + 1] = normals[src + 1];
      outNorm[outOff + 2] = normals[src + 2];
      outOff += 3;
    }

    // Compact indices (only triangles where ALL 3 vertices belong to target)
    const tmpIdx: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (keep[a] && keep[b] && keep[c]) {
        tmpIdx.push(remap[a], remap[b], remap[c]);
      }
    }
    if (tmpIdx.length === 0) return undefined;

    return {
      expressId: targetId,
      positions: outPos,
      normals: outNorm,
      indices: new Uint32Array(tmpIdx),
      color: merged.color,
      // Extracted vertices are copied verbatim from the merged mesh's local
      // frame, so carry its origin forward (world = origin + position) — else
      // raycast/highlight/snap would treat these local coords as world.
      origin: merged.origin,
    };
  }

  hasMeshData(expressId: number, modelIndex?: number): boolean {
    const pieces = this.meshDataMap.get(expressId);
    if (!pieces || pieces.length === 0) return false;
    if (modelIndex === undefined) return true;
    // Check if any piece matches the modelIndex
    return pieces.some(p => p.modelIndex === modelIndex);
  }

  /**
   * Get all MeshData pieces for an expressId (without merging).
   * Optionally filter by modelIndex for multi-model safety.
   */
  /**
   * Iterate every CPU-side `MeshData` the scene holds — every piece
   * for every expressId across every model. Used by the BIM ↔ scan
   * deviation BVH builder which needs world-space triangle positions
   * regardless of which IFC ingest path they came from.
   *
   * Deduplicates by `MeshData` identity: a colour-merged batch is
   * stored under every contributor's expressId, and visiting it
   * multiple times would double-count its triangles in the BVH.
   */
  forEachMeshData(visit: (md: MeshData) => void): void {
    const seen = new Set<MeshData>();
    for (const pieces of this.meshDataMap.values()) {
      for (const piece of pieces) {
        if (seen.has(piece)) continue;
        seen.add(piece);
        visit(piece);
      }
    }
    // Instanced-only occurrences live in the shard, not meshDataMap, so full-
    // geometry CPU consumers (e.g. the deviation BVH) would miss them. Materialize
    // them lazily here — these copies are transient (the caller builds its BVH and
    // discards them), so this does NOT retain the N full copies instancing avoids.
    // Skipped after geometry release (templates freed). (#1238 review)
    if (!this.geometryReleased) {
      for (const piece of this.getAllInstancedMeshData()) {
        visit(piece);
      }
    }
  }

  getMeshDataPieces(expressId: number, modelIndex?: number): MeshData[] | undefined {
    let pieces = this.meshDataMap.get(expressId);
    if (!pieces || pieces.length === 0) return undefined;
    if (modelIndex !== undefined) {
      pieces = pieces.filter((p) => p.modelIndex === modelIndex);
      if (pieces.length === 0) return undefined;
    }
    // For color-merged batches, extract only this entity's vertices so
    // selection highlighting is per-entity, not the entire merged batch.
    if (pieces.some(p => p.entityIds)) {
      const extracted: MeshData[] = [];
      for (const piece of pieces) {
        if (piece.entityIds) {
          const ex = this.extractEntityFromMergedMesh(piece, expressId);
          if (ex) extracted.push(ex);
        } else {
          extracted.push(piece);
        }
      }
      return extracted.length > 0 ? extracted : undefined;
    }
    return pieces;
  }

  /**
   * Generate color key for grouping meshes.
   * Quantizes RGBA to 10-bit per channel and packs into a compact string.
   * Avoids floating-point template literal overhead of the old approach.
   */
  private colorKey(color: [number, number, number, number]): string {
    // Quantize to 1000 levels (same precision as before, but integer math only)
    const r = Math.round(color[0] * 1000);
    const g = Math.round(color[1] * 1000);
    const b = Math.round(color[2] * 1000);
    const a = Math.round(color[3] * 1000);
    // Pack into single string with fixed-width separator for uniqueness
    return `${r}|${g}|${b}|${a}`;
  }

  /**
   * Append meshes to color batches incrementally
   * Merges new meshes into existing color groups or creates new ones
   *
   * STREAMING OPTIMIZATION: During streaming, creates lightweight "fragment"
   * batches from ONLY the new meshes instead of re-merging all accumulated
   * data. This reduces streaming from O(N²) to O(N). Call finalizeStreaming()
   * when streaming completes to do one O(N) full merge.
   */
  appendToBatches(meshDataArray: MeshData[], device: GPUDevice, pipeline: RenderPipeline, isStreaming: boolean = false): void {
    // Cache max buffer size on first call
    if (this.cachedMaxBufferSize === 0) {
      this.cachedMaxBufferSize = this.getMaxBufferSize(device);
    }

    const retainStreamingGeometry = !(isStreaming && this.ephemeralStreamingMode);

    // #961: divert meshes carrying an IFC surface texture to the dedicated
    // textured pipeline. They have no single colour, so they must be kept out
    // of BOTH the colour buckets AND the streaming-fragment path below —
    // otherwise a flat-colour copy would be drawn over the texture. Still
    // register them in meshDataMap (addMeshData) so CPU picking/bbox/frame work.
    let renderable = meshDataArray;
    if (meshDataArray.some((m) => m.texture && m.uvs)) {
      renderable = [];
      for (const meshData of meshDataArray) {
        if (meshData.texture && meshData.uvs) {
          this.createTexturedMesh(meshData, device, pipeline);
          this.addMeshData(meshData);
        } else {
          renderable.push(meshData);
        }
      }
    }

    // Route each mesh into a size-aware bucket for its color
    for (const meshData of renderable) {
      const baseKey = this.colorKey(meshData.color);
      const bucketKey = this.resolveActiveBucket(baseKey, meshData);

      if (retainStreamingGeometry || !isStreaming) {
        // Accumulate mesh data in the bucket when we need later rebatching or
        // CPU-side lookups. Huge-file mode intentionally skips this to keep JS
        // memory bounded while fragments render directly from GPU batches.
        let bucket = this.buckets.get(bucketKey);
        if (!bucket) {
          bucket = { key: bucketKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
          this.buckets.set(bucketKey, bucket);
        }
        bucket.meshData.push(meshData);

        // Track reverse mapping for O(1) bucket lookup in updateMeshColors
        this.meshDataBucket.set(meshData, bucket);

        // Also store individual mesh data for visibility filtering
        this.addMeshData(meshData);

        // Track pending keys for non-streaming rebuild only
        if (!isStreaming) {
          this.pendingBatchKeys.add(bucketKey);
        }
      }
    }

    if (isStreaming) {
      // STREAMING: Create small fragment batches from ONLY the new meshes.
      // Avoids the O(N²) cost of re-merging all accumulated data every batch.
      // finalizeStreaming() destroys fragments and does one O(N) full merge.
      // `renderable` excludes textured meshes (drawn via the textured pipeline).
      this.createStreamingFragments(renderable, device, pipeline);
      return;
    }

    // NON-STREAMING: Rebuild full batches immediately
    this.rebuildPendingBatches(device, pipeline);
  }

  /**
   * Rebuild all pending batches (call this after streaming completes)
   *
   * Each bucket key already maps to data that fits within the GPU buffer
   * limit (enforced at accumulation time by resolveActiveBucket), so no
   * splitting is needed here — just create one batch per key.
   */
  rebuildPendingBatches(device: GPUDevice, pipeline: RenderPipeline): void {
    if (this.pendingBatchKeys.size === 0) return;

    for (const key of this.pendingBatchKeys) {
      const bucket = this.buckets.get(key);

      // Destroy old GPU batch if it exists
      if (bucket?.batchedMesh) {
        destroyGpuResources(bucket.batchedMesh);
        bucket.batchedMesh = null;
      }

      if (!bucket || bucket.meshData.length === 0) {
        // Bucket is empty — clean up
        this.buckets.delete(key);
        continue;
      }

      // Create new batch with all accumulated meshes for this bucket
      const color = bucket.meshData[0].color;
      const batchedMesh = this.createBatchedMesh(bucket.meshData, color, device, pipeline, key);
      bucket.batchedMesh = batchedMesh;
    }

    // Rebuild the flat render array from all buckets (148 max batches — not perf critical)
    this.batchedMeshes = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.batchedMesh) {
        this.batchedMeshes.push(bucket.batchedMesh);
      }
    }

    this.pendingBatchKeys.clear();
  }

  /**
   * Check if there are pending batch rebuilds
   */
  hasPendingBatches(): boolean {
    return this.pendingBatchKeys.size > 0;
  }

  /**
   * Remove every mesh registered for `expressId` from the scene.
   * Affected buckets are marked for rebuild on the next call to
   * `rebuildPendingBatches`, so the GPU drops them on the next
   * frame. Returns `true` when at least one mesh was removed.
   *
   * Used by the viewer's authoring actions (split, delete) to
   * make tombstoned IFC entities disappear from the rendered
   * scene — the previous v1 workaround was to hide them via
   * `hiddenIds`, but that left the mesh in GPU memory and inside
   * raycast bounds. This is the proper removal path.
   *
   * Notes:
   *   - For color-merged meshes (the `entityIds` per-vertex case)
   *     a single MeshData often hosts many entities. We do NOT
   *     drop the whole mesh in that case — that would also remove
   *     the other entities — but we DO clear the bbox + meshDataMap
   *     for the requested expressId, so picking and selection stop
   *     finding the removed entity. Re-rendering the merged mesh
   *     unchanged is the right behaviour because color-merged
   *     batches are an optimisation: the geometry is still real;
   *     the IFC tombstone just means we ignore it for queries.
   */
  removeMeshesForEntity(expressId: number): boolean {
    const meshDataList = this.meshDataMap.get(expressId);
    if (!meshDataList || meshDataList.length === 0) {
      this.boundingBoxes.delete(expressId);
      // Instanced-only entity (lives in the shard, not meshDataMap): without this
      // the GPU occurrence keeps rendering AND picking after delete/split. Tombstone
      // it on the GPU + drop its instanced state. (#1238 review)
      return this.removeInstancedEntity(expressId);
    }

    // Track which buckets need re-batching so we don't repeatedly
    // mark the same key.
    const affectedKeys = new Set<string>();
    // Separate "did we remove anything dedicated?" from "did any
    // bucket need rebatching?" — a dedicated mesh that's mid-stream
    // and not yet bucketed still counts as a removal for the
    // caller's bulk-count contract.
    let removedDedicated = false;

    for (const meshData of meshDataList) {
      // Color-merged path: shared mesh, keep it but drop our entry.
      if (meshData.entityIds && meshData.entityIds.length > 0) {
        continue;
      }
      removedDedicated = true;

      // Dedicated mesh — drop from its bucket and decrement the
      // bucket's vertexBytes counter so subsequent
      // resolveActiveBucket calls see the updated size and don't
      // unnecessarily split it.
      const bucket = this.meshDataBucket.get(meshData);
      if (bucket) {
        const idx = bucket.meshData.indexOf(meshData);
        if (idx >= 0) {
          bucket.meshData.splice(idx, 1);
          // Match the byte-accounting `splitMeshForStreaming` uses
          // (positions + normals). Without this, the bucket's size
          // estimate stays inflated after removal and
          // `resolveActiveBucket` may force unnecessary splits on
          // subsequent inserts.
          const bytes = meshData.positions.byteLength + meshData.normals.byteLength;
          bucket.vertexBytes = Math.max(0, bucket.vertexBytes - bytes);
        }
        affectedKeys.add(bucket.key);
      }
      this.meshDataBucket.delete(meshData);
    }

    this.meshDataMap.delete(expressId);
    this.boundingBoxes.delete(expressId);

    // #961: textured meshes own GPU buffers outside the colour buckets, so the
    // bucket cleanup above never touches them. Destroy + drop them here or a
    // deleted textured entity keeps rendering (and leaks its GPU texture).
    for (let i = this.texturedMeshes.length - 1; i >= 0; i--) {
      const tm = this.texturedMeshes[i];
      if (tm.expressId !== expressId) continue;
      tm.vertexBuffer.destroy();
      tm.indexBuffer.destroy();
      tm.uniformBuffer.destroy();
      tm.texture.destroy();
      this.texturedMeshes.splice(i, 1);
      removedDedicated = true;
    }

    for (const key of affectedKeys) {
      this.pendingBatchKeys.add(key);
    }
    // Also drop the entity's standalone selection-highlight meshes — they're not
    // in the buckets and would otherwise linger after a delete/split (same ghost
    // class as a move).
    this.evictHighlightMeshes(expressId);
    // An entity can have BOTH flat meshes and instanced occurrences; clean up the
    // instanced side here too so a mixed entity doesn't keep ghost instances.
    if (this.removeInstancedEntity(expressId)) removedDedicated = true;
    // True when at least one dedicated mesh was removed — covers
    // the case where a mesh was queued but not yet bucketed.
    return removedDedicated;
  }

  /**
   * Tombstone a GPU-instanced entity on delete/split: set its HIDDEN flag on the
   * GPU (both render + pick shaders discard it) before forgetting its occurrence
   * locations, then drop all instanced state for it. The occurrence's buffer slots
   * are not reclaimed (delete/split is rare) — hiding them is sufficient and never
   * touches other entities' slots. Returns true if the id was instanced. (#1238)
   */
  private removeInstancedEntity(expressId: number): boolean {
    if (!this.instancedEntityMap.has(expressId)) return false;
    const device = this.instancedDevice;
    if (device) {
      // Must set the flag while the occurrence locations are still in the map.
      this.instancedHidden.add(expressId);
      this.writeInstanceFlags(device, expressId);
    }
    this.instancedEntityMap.delete(expressId);
    this.instancedSelected.delete(expressId);
    this.instancedHidden.delete(expressId);
    this.instancedOverridden.delete(expressId);
    this.boundingBoxes.delete(expressId);
    return true;
  }

  /**
   * Bulk variant of `removeMeshesForEntity`. Avoids re-marking the
   * same bucket key once per entity in the common "split N walls"
   * batch. Returns the number of entities that had at least one
   * dedicated mesh removed.
   */
  removeMeshesForEntities(expressIds: Iterable<number>): number {
    let count = 0;
    for (const id of expressIds) {
      if (this.removeMeshesForEntity(id)) count++;
    }
    return count;
  }

  /**
   * Translate every mesh for `expressId` by `delta` in renderer
   * world frame (Y-up). Modifies `positions` in place and marks
   * the affected bucket(s) for re-batch on the next call to
   * `rebuildPendingBatches`.
   *
   * Bounding boxes are cleared for the entity so the next bounds
   * query recomputes from the new positions; raycast bounds will
   * therefore lag by exactly one query, which is acceptable for
   * the drag-end → fresh-pick interaction the gizmo drives.
   *
   * Returns `true` when at least one mesh was modified. Used by
   * the viewer's `translateEntity` action to keep the rendered
   * mesh in sync with the IFC coords mutation.
   *
   * Color-merged meshes (shared by many entities via per-vertex
   * `entityIds`) cannot be translated for a single entity without
   * walking the entityIds array vertex by vertex; this helper
   * skips them and returns `false` so the caller can fall back
   * to a full reload if needed.
   */
  translateMeshesForEntity(expressId: number, delta: [number, number, number]): boolean {
    // An entity can have flat meshes, GPU-instanced occurrences, or both. The
    // instanced occurrences live in the per-template instance buffers, NOT in
    // meshDataMap, so the flat path below can't reach them — without this they
    // are "left behind" when a storey lifts in Exploded mode (#1289).
    //
    // Flat runs FIRST because it deletes the entity's cached world AABB; the
    // instanced pass runs last and rebuilds that AABB from the moved occurrence
    // matrices, so a mixed flat+instanced entity never ends up with stranded
    // (null) instanced bounds.
    const flatMoved = this.translateFlatMeshesForEntity(expressId, delta);
    const instancedMoved = this.translateInstancedEntity(expressId, delta);
    return flatMoved || instancedMoved;
  }

  /**
   * Translate every flat (non-instanced) mesh for `expressId` by `delta`. See
   * {@link translateMeshesForEntity} for the full contract; this is the flat half.
   */
  private translateFlatMeshesForEntity(expressId: number, delta: [number, number, number]): boolean {
    const meshDataList = this.meshDataMap.get(expressId);
    if (!meshDataList || meshDataList.length === 0) return false;
    const [dx, dy, dz] = delta;
    if (dx === 0 && dy === 0 && dz === 0) return false;

    const affectedKeys = new Set<string>();
    let anyMoved = false;
    for (const meshData of meshDataList) {
      // Skip a genuinely shared color-merged mesh — one whose vertices belong to
      // MORE than this entity — because translating it would drag the others too.
      // An authored single-entity mesh (slab/space/wall added in-session) tags
      // EVERY vertex with its own id for picking; all-same-id is safe to move, so
      // only bail when a foreign id is present (was: skip on any entityIds at all,
      // which froze authored elements under the gizmo even though their placement
      // and bbox resolved fine).
      if (meshData.entityIds && meshData.entityIds.length > 0) {
        let shared = false;
        for (let i = 0; i < meshData.entityIds.length; i++) {
          if (meshData.entityIds[i] !== expressId) { shared = true; break; }
        }
        if (shared) continue;
      }
      const pos = meshData.positions;
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] += dx;
        pos[i + 1] += dy;
        pos[i + 2] += dz;
      }
      const bucket = this.meshDataBucket.get(meshData);
      if (bucket) affectedKeys.add(bucket.key);
      anyMoved = true;
    }
    if (!anyMoved) return false;

    // #961: a textured mesh's GPU vertex buffer lives outside the colour buckets,
    // so the in-place position translation above won't reach the GPU on its own —
    // re-interleave + re-upload the moved textured parts (paired by expressId,
    // in creation order). Without this a moved textured entity renders stale.
    if (this.texturedDevice && this.texturedMeshes.length > 0) {
      const texturedData = meshDataList.filter((md) => md.texture && md.uvs);
      if (texturedData.length > 0) {
        const entries = this.texturedMeshes.filter((tm) => tm.expressId === expressId);
        for (let i = 0; i < entries.length && i < texturedData.length; i++) {
          const interleaved = this.interleaveTexturedVertices(texturedData[i]);
          if (interleaved) {
            this.texturedDevice.queue.writeBuffer(entries[i].vertexBuffer, 0, interleaved);
          }
        }
      }
    }

    this.boundingBoxes.delete(expressId);
    // The per-entity selection-highlight meshes in `this.meshes` are frozen
    // position copies made at selection time and are otherwise only cleared by
    // clear() — so a moved-while-selected entity (the gizmo holds the selection
    // through the drag) keeps drawing its highlight at the OLD position: a ghost.
    // Evict them so the highlight re-extracts from the moved geometry next frame.
    this.evictHighlightMeshes(expressId);
    for (const key of affectedKeys) {
      this.pendingBatchKeys.add(key);
    }
    return true;
  }

  /**
   * Translate every GPU-instanced occurrence of `expressId` by `delta` in the
   * renderer world frame. Instanced occurrences live in the per-template instance
   * buffers (NOT meshDataMap), so the flat translate path can't reach them — this
   * is what keeps repeated geometry (e.g. windows / mullions emitted via
   * IfcMappedItem) lifting with its storey in Exploded mode (#1289).
   *
   * Mutates BOTH halves so every consumer stays consistent:
   *   - the CPU instance record (so getInstancedMeshDataPieces / bounds / raycast
   *     / measure / section / export see the new position), and
   *   - the GPU instance buffer (so the occurrence renders at the new position).
   * The cached world AABB is shifted by the same delta — every occurrence of the
   * entity moves identically, so a recompute is unnecessary.
   *
   * Returns `true` when at least one occurrence moved. No-op (returns false) for
   * a non-instanced id or a zero delta.
   */
  translateInstancedEntity(expressId: number, delta: [number, number, number]): boolean {
    const occurrences = this.instancedEntityMap.get(expressId);
    if (!occurrences || occurrences.length === 0) return false;
    const [dx, dy, dz] = delta;
    if (dx === 0 && dy === 0 && dz === 0) return false;

    const device = this.instancedDevice;
    let moved = false;
    for (const occ of occurrences) {
      const cpu = this.instancedTemplateCpu[occ.templateIndex];
      if (!cpu) continue;
      // Column-major mat4: the translation column is floats 12,13,14, i.e. bytes
      // +48/+52/+56 of the occurrence's record (matches unionInstancedWorldAabb).
      const dv = new DataView(cpu.instanceData);
      const b = occ.byteOffset;
      const tx = dv.getFloat32(b + 48, true) + dx;
      const ty = dv.getFloat32(b + 52, true) + dy;
      const tz = dv.getFloat32(b + 56, true) + dz;
      dv.setFloat32(b + 48, tx, true);
      dv.setFloat32(b + 52, ty, true);
      dv.setFloat32(b + 56, tz, true);
      // Push only the 12 translation bytes to the GPU buffer (in place). Guarded
      // on the cached device so CPU-only tests still exercise the matrix math.
      if (device) {
        const gpu = this.instancedTemplates[occ.templateIndex]?.instanceBuffer;
        if (gpu) device.queue.writeBuffer(gpu, b + 48, new Float32Array([tx, ty, tz]));
      }
      moved = true;
    }
    if (!moved) return false;

    // Rebuild the cached world AABB from the moved occurrence matrices so pick /
    // measure / section bounds stay correct. A simple in-place shift is unsafe for
    // an entity that has BOTH flat meshes and instanced occurrences: the flat
    // translate path deletes this same cache entry, which would strand the shift
    // (a later getInstancedEntityBounds would return null). Recomputing fresh is
    // robust regardless of the flat path and the upload-time bounds.
    this.recomputeInstancedBounds(expressId);
    return true;
  }

  /** Recompute an instanced entity's cached world AABB by unioning the transformed
   *  template AABB across its occurrences (using their CURRENT matrices). Used after
   *  a translate so bounds reflect the moved geometry. No-op for a non-instanced id. */
  private recomputeInstancedBounds(expressId: number): void {
    const occurrences = this.instancedEntityMap.get(expressId);
    if (!occurrences || occurrences.length === 0) return;
    this.boundingBoxes.delete(expressId);
    for (const occ of occurrences) {
      const cpu = this.instancedTemplateCpu[occ.templateIndex];
      if (!cpu) continue;
      const dv = new DataView(cpu.instanceData);
      this.unionInstancedWorldAabb(
        expressId, dv, occ.byteOffset,
        cpu.localMin[0], cpu.localMin[1], cpu.localMin[2],
        cpu.localMax[0], cpu.localMax[1], cpu.localMax[2],
      );
    }
  }

  /** Drop the per-entity selection-highlight meshes for `expressId` (frozen
   *  copies in `this.meshes`) + free their GPU buffers, so the highlight is
   *  rebuilt from the entity's current geometry on the next render. Used after a
   *  translate or removal, which mutate the underlying geometry but don't touch
   *  these standalone highlight meshes. */
  private evictHighlightMeshes(expressId: number): void {
    if (this.meshes.length === 0) return;
    const kept: Mesh[] = [];
    for (const mesh of this.meshes) {
      if (mesh.expressId === expressId) destroyGpuResources(mesh);
      else kept.push(mesh);
    }
    this.meshes = kept;
  }

  /** Bulk variant of `translateMeshesForEntity`. */
  translateMeshesForEntities(updates: Map<number, [number, number, number]>): number {
    let count = 0;
    for (const [id, delta] of updates) {
      if (this.translateMeshesForEntity(id, delta)) count++;
    }
    return count;
  }

  /**
   * Rotate every flat mesh for `expressId` by `angleRad` about the renderer
   * vertical (+Y) axis through `pivot` (renderer world, Y-up). This is the Y-up
   * image of an IFC yaw about the storey-up Z axis. Modifies `positions` and
   * `normals` in place and marks the affected bucket(s) for re-batch.
   *
   * Positions may live in a per-element local frame (`MeshData.origin`, world =
   * origin + position), so the pivot is folded into each mesh's local frame
   * before rotating; normals are direction vectors and rotate as-is.
   *
   * Same colour-merge caveat as `translateFlatMeshesForEntity` (skips meshes
   * whose vertices belong to more than this entity). GPU-instanced occurrences
   * are not rotated (the collab edit path only rotates flat/authored meshes).
   * Returns true when a mesh was modified.
   */
  rotateMeshesForEntity(expressId: number, angleRad: number, pivot: [number, number, number]): boolean {
    const meshDataList = this.meshDataMap.get(expressId);
    if (!meshDataList || meshDataList.length === 0) return false;
    if (angleRad === 0) return false;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const affectedKeys = new Set<string>();
    let anyMoved = false;
    for (const meshData of meshDataList) {
      // Skip a genuinely shared color-merged mesh (see translateFlatMeshesForEntity).
      if (meshData.entityIds && meshData.entityIds.length > 0) {
        let shared = false;
        for (let i = 0; i < meshData.entityIds.length; i++) {
          if (meshData.entityIds[i] !== expressId) { shared = true; break; }
        }
        if (shared) continue;
      }
      // Fold the per-element local-frame origin into the pivot (world = origin + pos).
      const px = pivot[0] - (meshData.origin?.[0] ?? 0);
      const pz = pivot[2] - (meshData.origin?.[2] ?? 0);
      const pos = meshData.positions;
      for (let i = 0; i < pos.length; i += 3) {
        const dx = pos[i] - px;
        const dz = pos[i + 2] - pz;
        pos[i] = px + dx * cos + dz * sin;
        pos[i + 2] = pz - dx * sin + dz * cos;
      }
      const nrm = meshData.normals;
      if (nrm) {
        for (let i = 0; i < nrm.length; i += 3) {
          const nx = nrm[i];
          const nz = nrm[i + 2];
          nrm[i] = nx * cos + nz * sin;
          nrm[i + 2] = -nx * sin + nz * cos;
        }
      }
      const bucket = this.meshDataBucket.get(meshData);
      if (bucket) affectedKeys.add(bucket.key);
      anyMoved = true;
    }
    if (!anyMoved) return false;

    // #961: textured meshes render from their own GPU vertex buffer — re-upload
    // the rotated parts so they don't render stale (mirrors the translate path).
    if (this.texturedDevice && this.texturedMeshes.length > 0) {
      const texturedData = meshDataList.filter((md) => md.texture && md.uvs);
      if (texturedData.length > 0) {
        const entries = this.texturedMeshes.filter((tm) => tm.expressId === expressId);
        for (let i = 0; i < entries.length && i < texturedData.length; i++) {
          const interleaved = this.interleaveTexturedVertices(texturedData[i]);
          if (interleaved) {
            this.texturedDevice.queue.writeBuffer(entries[i].vertexBuffer, 0, interleaved);
          }
        }
      }
    }

    this.boundingBoxes.delete(expressId);
    // Selection-highlight meshes are frozen copies — evict so the highlight
    // re-extracts from the rotated geometry next frame (same as translate).
    this.evictHighlightMeshes(expressId);
    for (const key of affectedKeys) {
      this.pendingBatchKeys.add(key);
    }
    return true;
  }

  /** Bulk variant of `rotateMeshesForEntity`. */
  rotateMeshesForEntities(updates: Map<number, { angle: number; pivot: [number, number, number] }>): number {
    let count = 0;
    for (const [id, { angle, pivot }] of updates) {
      if (this.rotateMeshesForEntity(id, angle, pivot)) count++;
    }
    return count;
  }

  // ─── Mesh command queue ──────────────────────────────────────────────

  /**
   * Queue meshes for deferred GPU upload.
   * Instant (no GPU work) — safe to call from React effects.
   * The animation loop calls flushPending() each frame to drain the queue.
   */
  queueMeshes(meshes: MeshData[]): void {
    for (let i = 0; i < meshes.length; i++) {
      const fragments = this.splitMeshForStreaming(meshes[i]);
      for (let j = 0; j < fragments.length; j++) {
        this.meshQueue.push(fragments[j]);
      }
    }
  }

  /** True if the mesh queue has pending work. */
  hasQueuedMeshes(): boolean {
    return this.meshQueueReadIndex < this.meshQueue.length;
  }

  /** True while un-finalised streaming fragments are still being drawn. An
   *  element appended during streaming (e.g. an authored IfcSpace) renders as
   *  such a fragment AND accumulates in its colour bucket; once the bucket is
   *  re-batched (e.g. by a move) the fragment becomes a stale duplicate, so the
   *  caller should `finalizeStreaming` to merge fragments away. */
  hasStreamingFragments(): boolean {
    return this.streamingFragments.length > 0;
  }

  /** True when streaming runs in ephemeral mode (huge files) — fragments render
   *  directly from GPU and geometry is NOT retained for re-batch, so callers
   *  must NOT finalize (there's nothing to rebuild the batches from). */
  isEphemeralStreaming(): boolean {
    return this.ephemeralStreamingMode;
  }

  setEphemeralStreamingMode(enabled: boolean): void {
    this.ephemeralStreamingMode = enabled;
  }

  /**
   * Drain the mesh queue with a per-frame time budget.
   * Processes queued meshes through appendToBatches in streaming mode
   * (creates lightweight fragment batches for immediate rendering).
   *
   * @returns true if any meshes were processed (caller should render)
   */
  flushPending(device: GPUDevice, pipeline: RenderPipeline): boolean {
    if (!this.hasQueuedMeshes()) return false;

    // Drain the queue in chunks bounded by BOTH mesh count AND triangle volume,
    // yielding the frame back at the TOP of the loop. The mesh-count-only chunker
    // could merge a 512-mesh chunk of high-poly meshes (e.g. 899 Velux roof
    // windows at 7624 tris each → ~3.9M tris) in ONE indivisible mergeGeometry +
    // mappedAtCreation buffer copy — hundreds of ms that parked the main thread
    // past the 16s stream watchdog. Capping each appendToBatches by index volume
    // keeps every synchronous slice ≈ one bounded fragment merge (~12-15ms).
    const MAX_MESHES_PER_FLUSH = 4096;
    const MESHES_PER_APPEND = 512;
    const MAX_INDICES_PER_APPEND = Scene.STREAMING_FRAGMENT_MAX_INDICES;
    const FLUSH_BUDGET_MS = 12;
    const start = performance.now();
    let processed = 0;

    while (this.meshQueueReadIndex < this.meshQueue.length && processed < MAX_MESHES_PER_FLUSH) {
      // Yield once the budget is spent (after at least one append) so the main
      // thread returns to the worker-message pump and the watchdog never trips.
      if (processed > 0 && performance.now() - start >= FLUSH_BUDGET_MS) {
        break;
      }

      const hardEnd = Math.min(
        this.meshQueue.length,
        this.meshQueueReadIndex + MESHES_PER_APPEND,
        this.meshQueueReadIndex + (MAX_MESHES_PER_FLUSH - processed),
      );
      let chunkEnd = this.meshQueueReadIndex;
      let chunkIndices = 0;
      while (chunkEnd < hardEnd) {
        const next = this.meshQueue[chunkEnd].indices.length;
        // Always take at least one mesh (a single oversize mesh is split upstream
        // by splitMeshForStreaming); otherwise stop before exceeding the cap.
        if (chunkEnd > this.meshQueueReadIndex && chunkIndices + next > MAX_INDICES_PER_APPEND) {
          break;
        }
        chunkIndices += next;
        chunkEnd++;
      }

      const chunk = this.meshQueue.slice(this.meshQueueReadIndex, chunkEnd);
      this.meshQueueReadIndex = chunkEnd;
      this.appendToBatches(chunk, device, pipeline, true);
      processed += chunk.length;
    }

    if (this.meshQueueReadIndex >= this.meshQueue.length) {
      this.meshQueue.length = 0;
      this.meshQueueReadIndex = 0;
    } else if (this.meshQueueReadIndex >= 8192 && this.meshQueueReadIndex * 2 >= this.meshQueue.length) {
      this.meshQueue = this.meshQueue.slice(this.meshQueueReadIndex);
      this.meshQueueReadIndex = 0;
    }

    return processed > 0;
  }

  /**
   * Create lightweight fragment batches from a single streaming batch.
   * Fragments are grouped by color and added to batchedMeshes for immediate
   * rendering, but tracked separately for cleanup in finalizeStreaming().
   */
  private createStreamingFragments(meshDataArray: MeshData[], device: GPUDevice, pipeline: RenderPipeline): void {
    if (meshDataArray.length === 0) return;

    // Group new meshes by color for efficient fragment batches
    const colorGroups = new Map<string, MeshData[]>();
    for (const meshData of meshDataArray) {
      for (const fragment of this.splitMeshForStreaming(meshData)) {
        const key = this.colorKey(fragment.color);
        let group = colorGroups.get(key);
        if (!group) {
          group = [];
          colorGroups.set(key, group);
        }
        group.push(fragment);
      }
    }

    // Create one fragment batch per color group (with buffer limit splitting)
    for (const [, group] of colorGroups) {
      const chunks = this.splitMeshDataForBufferLimit(group, this.cachedMaxBufferSize);
      for (const chunk of chunks) {
        const color = chunk[0].color;
        const fragment = this.createBatchedMesh(chunk, color, device, pipeline);
        this.batchedMeshes.push(fragment);
        this.streamingFragments.push(fragment);
      }
    }
  }

  private splitMeshForStreaming(meshData: MeshData): MeshData[] {
    const vertexBytes = meshData.positions.byteLength + meshData.normals.byteLength;
    if (
      meshData.indices.length <= Scene.STREAMING_FRAGMENT_MAX_INDICES &&
      vertexBytes <= Scene.STREAMING_FRAGMENT_MAX_VERTEX_BYTES
    ) {
      return [meshData];
    }

    const maxIndexCount = Math.max(3, Math.floor(Scene.STREAMING_FRAGMENT_MAX_INDICES / 3) * 3);
    const fragments: MeshData[] = [];

    for (let start = 0; start < meshData.indices.length; start += maxIndexCount) {
      const end = Math.min(start + maxIndexCount, meshData.indices.length);
      const sourceIndices = meshData.indices.subarray(start, end);
      const remap = new Map<number, number>();
      const positions: number[] = [];
      const normals: number[] = [];
      const indices = new Uint32Array(sourceIndices.length);

      for (let i = 0; i < sourceIndices.length; i++) {
        const sourceIndex = sourceIndices[i];
        let nextIndex = remap.get(sourceIndex);
        if (nextIndex === undefined) {
          nextIndex = remap.size;
          remap.set(sourceIndex, nextIndex);
          const base = sourceIndex * 3;
          positions.push(
            meshData.positions[base],
            meshData.positions[base + 1],
            meshData.positions[base + 2]
          );
          normals.push(
            meshData.normals[base],
            meshData.normals[base + 1],
            meshData.normals[base + 2]
          );
        }
        indices[i] = nextIndex;
      }

      fragments.push({
        expressId: meshData.expressId,
        ifcType: meshData.ifcType,
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices,
        color: meshData.color,
        // Fragments are subsets of the same source mesh → same local frame.
        // Preserve origin so each fragment relativizes/renders in world space.
        ...(meshData.origin ? { origin: meshData.origin } : {}),
        // Each fragment is a vertex SUBSET of the same source mesh, so the
        // parent's localBounds/localToWorld (issue #1474) still apply
        // unchanged: localBounds is a safe (if loose) superset — the caller
        // unions across an entity's pieces anyway — and localToWorld is the
        // one placement shared by the whole (pre-split) mesh.
        ...(meshData.localBounds ? { localBounds: meshData.localBounds } : {}),
        ...(meshData.localToWorld ? { localToWorld: meshData.localToWorld } : {}),
      });
    }

    return fragments;
  }

  /**
   * Finalize streaming: destroy temporary fragment batches and do one full
   * O(N) merge of all accumulated mesh data into proper batches.
   * Call this when streaming completes instead of rebuildPendingBatches().
   *
   * IMPORTANT: During streaming, external code (applyColorUpdatesToMeshes)
   * may mutate meshData.color in-place for deferred style/material colors.
   * This means the bucket keys (computed at insertion time from the ORIGINAL
   * color) no longer match the meshes' current colors. We must re-group all
   * meshData by their CURRENT color to produce correct batches.
   */
  finalizeStreaming(device: GPUDevice, pipeline: RenderPipeline): void {
    if (this.streamingFragments.length === 0) return;

    // Save references to old fragments/batches — keep them rendering
    // until the new proper batches are fully built (no visual gap).
    const oldFragments = this.streamingFragments;
    const oldBatches = this.batchedMeshes;
    const fragmentSet = new Set(oldFragments);
    this.streamingFragments = [];

    // 1. Collect ALL accumulated meshData before clearing state
    const allMeshData: MeshData[] = [];
    for (const bucket of this.buckets.values()) {
      for (const md of bucket.meshData) allMeshData.push(md);
    }

    // 2. Clear all bucket/batch state for a clean rebuild
    // NOTE: batchedMeshes keeps the OLD array reference — the renderer
    // continues to draw from it until we swap in the new array below.
    this.buckets.clear();
    this.meshDataBucket = new Map();
    this.activeBucketKey.clear();
    this.pendingBatchKeys.clear();
    // Destroy cached partial batches — their colorKeys are now stale
    for (const batch of this.partialBatchCache.values()) destroyGpuResources(batch);
    this.partialBatchCache.clear();
    this.partialBatchCacheKeys.clear();

    // 3. Re-group ALL meshData by their CURRENT color.
    //    meshData.color may have been mutated in-place since the mesh was
    //    first bucketed, so the original bucket key is stale. Re-grouping
    //    by current color ensures batches render with correct colors.
    for (const meshData of allMeshData) {
      const baseKey = this.colorKey(meshData.color);
      const bucketKey = this.resolveActiveBucket(baseKey, meshData);
      let bucket = this.buckets.get(bucketKey);
      if (!bucket) {
        bucket = { key: bucketKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
        this.buckets.set(bucketKey, bucket);
      }
      bucket.meshData.push(meshData);
      this.meshDataBucket.set(meshData, bucket);
      this.pendingBatchKeys.add(bucketKey);
    }

    // 4. Build new proper batches into a fresh array
    this.batchedMeshes = [];
    this.rebuildPendingBatches(device, pipeline);

    // 5. NOW destroy old fragment/batch GPU resources (new batches are live)
    for (const fragment of oldFragments) destroyGpuResources(fragment);
    for (const batch of oldBatches) {
      if (!fragmentSet.has(batch)) destroyGpuResources(batch);
    }
  }

  /**
   * Time-sliced version of finalizeStreaming.
   * Re-groups mesh data and rebuilds GPU batches in small chunks,
   * yielding to the event loop between chunks so orbit/pan stays responsive.
   * Streaming fragments continue rendering until each new batch replaces them.
   *
   * @param device  GPU device
   * @param pipeline  Render pipeline
   * @param budgetMs  Max milliseconds per chunk (default 8 — half a 60fps frame)
   * @returns Promise that resolves when all batches are rebuilt
   */
  finalizeStreamingAsync(
    device: GPUDevice,
    pipeline: RenderPipeline,
    budgetMs: number = 8,
  ): Promise<void> {
    if (this.ephemeralStreamingMode) {
      this.finishEphemeralStreaming();
      return Promise.resolve();
    }
    if (this.streamingFragments.length === 0) return Promise.resolve();

    // --- Synchronous preamble (fast O(N) bookkeeping) ---

    const oldFragments = this.streamingFragments;
    const oldBatches = this.batchedMeshes;
    const fragmentSet = new Set(oldFragments);
    this.streamingFragments = [];

    // 1. Collect ALL accumulated meshData
    const allMeshData: MeshData[] = [];
    for (const bucket of this.buckets.values()) {
      for (const md of bucket.meshData) allMeshData.push(md);
    }

    // 2. Clear bucket/batch state
    this.buckets.clear();
    this.meshDataBucket = new Map();
    this.activeBucketKey.clear();
    this.pendingBatchKeys.clear();
    for (const batch of this.partialBatchCache.values()) destroyGpuResources(batch);
    this.partialBatchCache.clear();
    this.partialBatchCacheKeys.clear();

    // 3. Re-group meshData by current color (fast)
    for (const meshData of allMeshData) {
      const baseKey = this.colorKey(meshData.color);
      const bucketKey = this.resolveActiveBucket(baseKey, meshData);
      let bucket = this.buckets.get(bucketKey);
      if (!bucket) {
        bucket = { key: bucketKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
        this.buckets.set(bucketKey, bucket);
      }
      bucket.meshData.push(meshData);
      this.meshDataBucket.set(meshData, bucket);
      this.pendingBatchKeys.add(bucketKey);
    }

    // Build new batches into a temporary array so the old batchedMeshes
    // (streaming fragments) keep rendering until the swap is complete.
    const newBatches: BatchedMesh[] = [];
    const pendingKeys = Array.from(this.pendingBatchKeys);
    this.pendingBatchKeys.clear();

    // --- Async: rebuild batches in time-sliced chunks ---

    let keyIdx = 0;
    const scene = this;

    return new Promise<void>((resolve) => {
      function processChunk() {
        const chunkStart = performance.now();
        while (keyIdx < pendingKeys.length) {
          const key = pendingKeys[keyIdx++];
          const bucket = scene.buckets.get(key);
          if (!bucket || bucket.meshData.length === 0) {
            scene.buckets.delete(key);
            continue;
          }
          const color = bucket.meshData[0].color;
          const batchedMesh = scene.createBatchedMesh(bucket.meshData, color, device, pipeline, key);
          bucket.batchedMesh = batchedMesh;
          newBatches.push(batchedMesh);

          // Check time budget — yield if exceeded
          if (performance.now() - chunkStart >= budgetMs) {
            setTimeout(processChunk, 0);
            return;
          }
        }

        // All batches built — atomic swap so renderer never sees an empty array
        scene.batchedMeshes = newBatches;

        // Destroy old fragment/batch GPU resources
        for (const fragment of oldFragments) destroyGpuResources(fragment);
        for (const batch of oldBatches) {
          if (!fragmentSet.has(batch)) destroyGpuResources(batch);
        }
        resolve();
      }
      // Start first chunk immediately (no setTimeout delay)
      processChunk();
    });
  }

  finishEphemeralStreaming(): void {
    if (this.streamingFragments.length === 0) {
      this.ephemeralStreamingMode = false;
      return;
    }

    // Preserve lightweight per-entity bounds so large-model picking and
    // selection can continue to work after we discard CPU mesh arrays.
    for (const [expressId, pieces] of this.meshDataMap) {
      if (this.boundingBoxes.has(expressId)) continue;

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      for (const piece of pieces) {
        const positions = piece.positions;
        // world = origin + position (per-element local frame); bake WORLD bbox.
        const ox = piece.origin ? piece.origin[0] : 0;
        const oy = piece.origin ? piece.origin[1] : 0;
        const oz = piece.origin ? piece.origin[2] : 0;
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i] + ox;
          const y = positions[i + 1] + oy;
          const z = positions[i + 2] + oz;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }

      this.boundingBoxes.set(expressId, {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
      });
    }

    this.streamingFragments = [];
    this.buckets.clear();
    this.meshDataBucket = new Map();
    this.meshDataMap.clear();
    // Free the compact instanced template geometry too; the per-occurrence world
    // AABBs already live in boundingBoxes, so bbox-raycast still finds instanced ids.
    this.instancedTemplateCpu = [];
    this.activeBucketKey.clear();
    this.pendingBatchKeys.clear();
    for (const batch of this.partialBatchCache.values()) destroyGpuResources(batch);
    this.partialBatchCache.clear();
    this.partialBatchCacheKeys.clear();
    this.geometryReleased = true;
    this.ephemeralStreamingMode = false;
  }

  /**
   * Release JS-side mesh geometry data (positions, normals, indices) after
   * GPU batches have been built. This frees the ~1.9GB of typed arrays that
   * duplicate data already resident in GPU vertex/index buffers.
   *
   * After calling this method:
   *  - Bounding boxes are precomputed and cached for all entities
   *  - meshDataMap and bucket meshData arrays are cleared (typed arrays become GC-eligible)
   *  - Color updates (updateMeshColors) are no longer available
   *  - Partial batch creation and color overlays are no longer available
   *  - CPU raycasting falls back to bounding-box-only (no triangle intersection)
   *  - Selection highlighting must use GPU picking instead of CPU mesh reconstruction
   *
   * Call this after finalizeStreaming() when all color updates have been applied.
   */
  releaseGeometryData(): void {
    if (this.geometryReleased) return;

    // Guard: releasing while async batch work is in-flight would corrupt GPU state
    if (this.pendingBatchKeys.size > 0 || this.streamingFragments.length > 0) {
      console.warn(
        `[Scene] releaseGeometryData() called with ${this.pendingBatchKeys.size} pending batches ` +
        `and ${this.streamingFragments.length} streaming fragments still in-flight. ` +
        `Call finalizeStreaming()/rebuildPendingBatches() first.`
      );
      return;
    }

    // 1. Precompute and cache ALL entity bounding boxes before releasing data
    for (const [expressId, pieces] of this.meshDataMap) {
      if (this.boundingBoxes.has(expressId)) continue;

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      for (const piece of pieces) {
        const positions = piece.positions;
        // world = origin + position (per-element local frame); bake WORLD bbox.
        const ox = piece.origin ? piece.origin[0] : 0;
        const oy = piece.origin ? piece.origin[1] : 0;
        const oz = piece.origin ? piece.origin[2] : 0;
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i] + ox;
          const y = positions[i + 1] + oy;
          const z = positions[i + 2] + oz;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }

      this.boundingBoxes.set(expressId, {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
      });
    }

    // 2. Clear the heavy data structures — typed arrays become GC-eligible
    this.meshDataMap.clear();
    // Free the compact instanced template geometry; per-occurrence world AABBs are
    // already cached in boundingBoxes, so the released-path bbox-raycast still
    // resolves instanced ids (exact-triangle measure/section is unavailable post-
    // release, same as the flat path).
    this.instancedTemplateCpu = [];
    // Clear meshData arrays in each bucket (typed arrays become GC-eligible)
    // but keep the bucket shells so batchedMesh references remain valid
    for (const bucket of this.buckets.values()) {
      bucket.meshData = [];
    }
    this.meshDataBucket = new Map();
    this.activeBucketKey.clear();

    // 3. Clear partial batch cache (would need mesh data to rebuild)
    for (const batch of this.partialBatchCache.values()) destroyGpuResources(batch);
    this.partialBatchCache.clear();
    this.partialBatchCacheKeys.clear();

    this.geometryReleased = true;

    console.log(
      `[Scene] Released JS geometry data. ${this.boundingBoxes.size} bounding boxes cached. ` +
      `${this.batchedMeshes.length} GPU batches retained.`
    );
  }

  /**
   * Whether JS geometry data has been released (GPU-resident mode).
   */
  isGeometryDataReleased(): boolean {
    return this.geometryReleased;
  }

  /**
   * Update colors for existing meshes and rebuild affected batches
   * Call this when deferred color parsing completes
   *
   * OPTIMIZATION: Uses meshDataBucket reverse-map for O(1) batch lookup
   * instead of O(N) indexOf scan per mesh. Critical for bulk IDS validation updates.
   */
  updateMeshColors(
    updates: Map<number, [number, number, number, number]>,
    device: GPUDevice,
    pipeline: RenderPipeline
  ): void {
    if (updates.size === 0) return;

    if (this.geometryReleased) {
      console.warn('[Scene] updateMeshColors called after geometry data was released — skipping.');
      return;
    }

    // Cache max buffer size if not yet set
    if (this.cachedMaxBufferSize === 0) {
      this.cachedMaxBufferSize = this.getMaxBufferSize(device);
    }

    const affectedOldKeys = new Set<string>();
    const affectedNewKeys = new Set<string>();

    // Update colors in meshDataMap and track affected batches
    for (const [expressId, newColor] of updates) {
      const meshDataList = this.meshDataMap.get(expressId);
      if (!meshDataList) continue;

      const newBaseKey = this.colorKey(newColor);

      for (const meshData of meshDataList) {
        // Use reverse-map for O(1) old bucket lookup
        const oldBucket = this.meshDataBucket.get(meshData);
        const oldBucketKey = oldBucket?.key ?? this.colorKey(meshData.color);
        // Derive old color from bucket key, NOT meshData.color.
        // meshData.color may have been mutated in-place by external code
        // (applyColorUpdatesToMeshes), making it unreliable for change detection.
        const oldBaseKey = this.baseColorKey(oldBucketKey);

        if (oldBaseKey !== newBaseKey) {
          // Route into the correct (possibly new) bucket for the target color
          const newBucketKey = this.resolveActiveBucket(newBaseKey, meshData);

          affectedOldKeys.add(oldBucketKey);
          affectedNewKeys.add(newBucketKey);

          // Remove from old bucket data using indexOf (O(N) within one color bucket, typically <100 items)
          if (oldBucket) {
            const idx = oldBucket.meshData.indexOf(meshData);
            if (idx >= 0) {
              // Swap-remove for O(1)
              const last = oldBucket.meshData.length - 1;
              if (idx !== last) {
                oldBucket.meshData[idx] = oldBucket.meshData[last];
              }
              oldBucket.meshData.pop();
            }
            if (oldBucket.meshData.length === 0) {
              this.buckets.delete(oldBucketKey);
            }
          }

          // Decrease old bucket size tracking
          const meshBytes = (meshData.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
          if (oldBucket) {
            oldBucket.vertexBytes = Math.max(0, oldBucket.vertexBytes - meshBytes);
          }

          // Update mesh color
          meshData.color = newColor;

          // Add to new bucket data (resolveActiveBucket already updated size tracking)
          let newBucket = this.buckets.get(newBucketKey);
          if (!newBucket) {
            newBucket = { key: newBucketKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
            this.buckets.set(newBucketKey, newBucket);
          }
          newBucket.meshData.push(meshData);

          // Update reverse mapping
          this.meshDataBucket.set(meshData, newBucket);
        }
      }
    }

    // Mark affected batches for rebuild
    for (const key of affectedOldKeys) {
      this.pendingBatchKeys.add(key);
    }
    for (const key of affectedNewKeys) {
      this.pendingBatchKeys.add(key);
    }

    // Rebuild affected batches (rebuildPendingBatches handles empty-bucket
    // cleanup and O(1) flat-array updates internally)
    if (this.pendingBatchKeys.size > 0) {
      this.rebuildPendingBatches(device, pipeline);
    }
  }

  /**
   * Create a new batched mesh from mesh data array.
   * @param bucketKey - Optional unique key for this batch. When omitted the
   *   base color key is used (fine for overlay / partial batches that don't
   *   participate in the main buckets map).
   */
  private createBatchedMesh(
    meshDataArray: MeshData[],
    color: [number, number, number, number],
    device: GPUDevice,
    pipeline: RenderPipeline,
    bucketKey?: string
  ): BatchedMesh {
    // Use ONE shared scene origin for every batch (set from the first batch's
    // world bbox centre). A per-batch origin would make abutting elements in
    // different colour batches diverge by a few f32 ULP at building-scale world
    // coords → seam/end-cap z-fighting. A shared origin makes every coincident
    // world point relativize identically → no seam z-fight, and the model
    // sits at most ±(model extent) from it (f32-precise at building scale).
    const merged = this.mergeGeometry(meshDataArray, this.sharedFrameOrigin ?? undefined);
    if (!this.sharedFrameOrigin && (merged.origin[0] || merged.origin[1] || merged.origin[2])) {
      this.sharedFrameOrigin = merged.origin;
    }
    const expressIds = meshDataArray.map(m => m.expressId);

    // Create vertex buffer (interleaved positions + normals)
    // Use mappedAtCreation to avoid a separate writeBuffer IPC round-trip
    // (significant win on Chrome/Dawn where each writeBuffer is a Mojo IPC call)
    const vertexBuffer = device.createBuffer({
      size: merged.vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(merged.vertexData);
    vertexBuffer.unmap();

    // Create index buffer
    const indexBuffer = device.createBuffer({
      size: merged.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(indexBuffer.getMappedRange()).set(merged.indices);
    indexBuffer.unmap();

    // Create uniform buffer for this batch
    const uniformBuffer = device.createBuffer({
      size: pipeline.getUniformBufferSize(),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(),
      entries: [
        {
          binding: 0,
          resource: { buffer: uniformBuffer },
        },
      ],
    });

    return {
      id: this.nextBatchId++,
      colorKey: bucketKey ?? this.colorKey(color),
      vertexBuffer,
      indexBuffer,
      indexCount: merged.indices.length,
      color,
      expressIds,
      bindGroup,
      uniformBuffer,
      bounds: merged.bounds,
      // Per-batch local frame: positions are stored relative to this; the draw
      // loop applies model = translate(origin) so they land in world space.
      origin: merged.origin,
    };
  }


  /**
   * Merge multiple mesh geometries into single vertex/index buffers.
   * Delegates to the extracted mergeGeometry() utility.
   */
  private mergeGeometry(meshDataArray: MeshData[], forcedOrigin?: [number, number, number]): {
    vertexData: Float32Array;
    indices: Uint32Array;
    bounds: { min: [number, number, number]; max: [number, number, number] };
    origin: [number, number, number];
  } {
    return mergeGeometry(meshDataArray, forcedOrigin);
  }

  /**
   * Get the effective max buffer size for this GPU device, with a safety margin.
   */
  private getMaxBufferSize(device: GPUDevice): number {
    const deviceMax = device.limits?.maxBufferSize ?? BATCH_CONSTANTS.FALLBACK_MAX_BUFFER_SIZE;
    return Math.floor(deviceMax * BATCH_CONSTANTS.BUFFER_SIZE_SAFETY_FACTOR);
  }

  /**
   * Split a meshDataArray into chunks that fit within GPU buffer limits.
   * Delegates to the extracted splitMeshDataForBufferLimit() utility.
   */
  private splitMeshDataForBufferLimit(meshDataArray: MeshData[], maxBufferSize: number): MeshData[][] {
    return splitMeshDataForBufferLimit(meshDataArray, maxBufferSize);
  }

  /**
   * Resolve which bucket a mesh should be added to.
   * If the active bucket for this color would overflow the GPU buffer limit,
   * a new sub-bucket is created with a suffixed key (e.g. "500|500|500|1000#1").
   * Returns the bucket key to use (may be the base key or a suffixed key).
   */
  private resolveActiveBucket(baseColorKey: string, meshData: MeshData): string {
    let bucketKey = this.activeBucketKey.get(baseColorKey) ?? baseColorKey;
    const bucket = this.buckets.get(bucketKey);
    const currentBytes = bucket?.vertexBytes ?? 0;
    const meshBytes = (meshData.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;

    if (currentBytes > 0 && currentBytes + meshBytes > this.cachedMaxBufferSize) {
      // Overflow — create a new sub-bucket
      bucketKey = `${baseColorKey}#${this.nextSplitId++}`;
      this.activeBucketKey.set(baseColorKey, bucketKey);
    }

    // Update size tracking on the bucket (create if needed)
    let targetBucket = this.buckets.get(bucketKey);
    if (!targetBucket) {
      targetBucket = { key: bucketKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
      this.buckets.set(bucketKey, targetBucket);
    }
    targetBucket.vertexBytes += meshBytes;
    return bucketKey;
  }

  /**
   * Extract the base color key from a bucket key (strips "#N" suffix if present).
   */
  private baseColorKey(bucketKey: string): string {
    const hashIdx = bucketKey.lastIndexOf('#');
    return hashIdx >= 0 ? bucketKey.substring(0, hashIdx) : bucketKey;
  }

  /**
   * Get or create a partial batch for a subset of visible elements from a batch
   *
   * PERFORMANCE FIX: Instead of creating 10,000+ individual meshes for partially visible batches,
   * this creates a single sub-batch containing only the visible elements.
   * The sub-batch is cached and reused until visibility changes.
   *
   * @param colorKey - The color key of the original batch (unique per bucket, used as cache key)
   * @param visibleIds - Set of visible expressIds from this batch
   * @param device - GPU device for buffer creation
   * @param pipeline - Rendering pipeline
   * @returns BatchedMesh containing only visible elements, or undefined if no visible elements
   */
  getOrCreatePartialBatch(
    sourceBatchKey: string,
    colorKey: string,
    visibleIds: Set<number>,
    device: GPUDevice,
    pipeline: RenderPipeline
  ): BatchedMesh | undefined {
    // Cannot create partial batches after geometry data has been released
    if (this.geometryReleased) return undefined;

    // Create cache key from colorKey + deterministic hash of all visible IDs
    // Using a proper hash over all IDs to avoid collisions when middle IDs differ
    const sortedIds = Array.from(visibleIds).sort((a, b) => a - b);

    // Compute a stable hash over all IDs using FNV-1a algorithm
    let hash = 2166136261; // FNV offset basis
    for (const id of sortedIds) {
      hash ^= id;
      hash = Math.imul(hash, 16777619); // FNV prime
      hash = hash >>> 0; // Convert to unsigned 32-bit
    }
    const idsHash = `${sortedIds.length}:${hash.toString(16)}`;
    const cacheKey = `${colorKey}:${idsHash}`;

    // Check if we already have this exact partial batch cached
    const currentCacheKey = this.partialBatchCacheKeys.get(sourceBatchKey);
    if (currentCacheKey === cacheKey) {
      const cached = this.partialBatchCache.get(cacheKey);
      if (cached) return cached;
    }

    // Invalidate old cache for this colorKey if visibility changed
    if (currentCacheKey && currentCacheKey !== cacheKey) {
      const oldBatch = this.partialBatchCache.get(currentCacheKey);
      if (oldBatch) {
        destroyGpuResources(oldBatch);
        this.partialBatchCache.delete(currentCacheKey);
      }
    }

    // Collect MeshData for visible elements
    // Use base color key (strip bucket suffix) for piece filtering, since
    // meshData stores the original color, not the bucket key.
    const baseKey = this.baseColorKey(colorKey);
    const visibleMeshData: MeshData[] = [];
    for (const expressId of visibleIds) {
      const pieces = this.meshDataMap.get(expressId);
      if (pieces) {
        // Add all pieces for this element
        for (const piece of pieces) {
          // Only include pieces that match this batch's color
          if (this.colorKey(piece.color) === baseKey) {
            visibleMeshData.push(piece);
          }
        }
      }
    }

    if (visibleMeshData.length === 0) {
      return undefined;
    }

    // Create the partial batch
    const color = visibleMeshData[0].color;
    const partialBatch = this.createBatchedMesh(visibleMeshData, color, device, pipeline);

    // Cache it
    this.partialBatchCache.set(cacheKey, partialBatch);
    this.partialBatchCacheKeys.set(sourceBatchKey, cacheKey);

    return partialBatch;
  }

  // ─── Color overlay system ────────────────────────────────────────────
  // Builds overlay batches for lens coloring without modifying original batches.
  // Overlay batches reuse the same geometry (re-merged from MeshData) but with
  // override colors.  They are rendered on top of existing depth via the overlay
  // pipeline (depthCompare 'equal'), so hidden entities never leak through.

  /**
   * Set color overrides for lens coloring.
   * Builds overlay batches grouped by override color.
   * Original batches are NEVER modified — clearing is instant.
   *
   * Applies the same buffer-size splitting as regular batches to prevent
   * GPU buffer overflow on large models.
   */
  setColorOverrides(
    overrides: Map<number, [number, number, number, number]>,
    device: GPUDevice,
    pipeline: RenderPipeline
  ): void {
    // Destroy previous overlay batches
    this.destroyOverrideBatches();

    if (this.geometryReleased) {
      console.warn('[Scene] setColorOverrides called after geometry data was released — skipping.');
      this.colorOverrides = null;
      this.setInstancedColorOverrides(null);
      return;
    }

    if (overrides.size === 0) {
      this.colorOverrides = null;
      this.setInstancedColorOverrides(null);
      return;
    }

    // Defensive copy so external callers can mutate or reuse `overrides`
    // without aliasing the renderer's pipeline-routing state. Tuples are
    // frozen by the readonly type — we don't deep-clone the inner arrays
    // because they're treated as immutable by every consumer.
    this.colorOverrides = new Map(overrides);

    // Mirror the overlay onto the GPU-instanced occurrences: patch their colour
    // bytes in place (no separate overlay pass — the instanced records carry the
    // override colour directly). No-op when no instanced data is loaded.
    this.setInstancedColorOverrides(overrides);

    // Group expressIds by override color
    const colorGroups = new Map<string, { color: [number, number, number, number]; meshData: MeshData[] }>();

    for (const [expressId, color] of overrides) {
      const key = this.colorKey(color);
      let group = colorGroups.get(key);
      if (!group) {
        group = { color, meshData: [] };
        colorGroups.set(key, group);
      }
      const pieces = this.meshDataMap.get(expressId);
      if (pieces) {
        for (const piece of pieces) {
          group.meshData.push(piece);
        }
      }
    }

    // Build overlay batches per override color, splitting if buffers would exceed GPU limit
    const maxBufferSize = this.getMaxBufferSize(device);
    for (const [, { color, meshData }] of colorGroups) {
      if (meshData.length === 0) continue;
      const chunks = this.splitMeshDataForBufferLimit(meshData, maxBufferSize);
      for (const chunk of chunks) {
        const batch = this.createBatchedMesh(chunk, color, device, pipeline);
        this.overrideBatches.push(batch);
      }
    }
  }

  /**
   * Clear all color overrides — instant, no batch rebuild needed.
   */
  clearColorOverrides(): void {
    this.destroyOverrideBatches();
    this.colorOverrides = null;
    this.setInstancedColorOverrides(null);
  }

  /** Get overlay batches for rendering */
  getOverrideBatches(): BatchedMesh[] {
    return this.overrideBatches;
  }

  /** Check if color overrides are active */
  hasColorOverrides(): boolean {
    return this.overrideBatches.length > 0;
  }

  /**
   * Get the active expressId → RGBA override map, or null if none.
   *
   * Used by the renderer to promote overridden meshes/batches to the opaque
   * pipeline so the overlay paint pass (depthCompare 'equal') finds matching
   * depth. Without this, an override on an entity that defaults to the
   * transparent pipeline (IfcSpace, IfcOpeningElement, glass, …) silently
   * fails to paint — the transparent pipeline doesn't write depth, so the
   * equality test rejects every fragment.
   *
   * Returns a `ReadonlyMap` view: the renderer holds the only writeable
   * reference (via `setColorOverrides`) so routing decisions stay in sync
   * with the overlay batches we built from the same data.
   */
  getColorOverrides(): ReadonlyMap<number, readonly [number, number, number, number]> | null {
    return this.colorOverrides;
  }

  /** Destroy GPU resources for overlay batches */
  private destroyOverrideBatches(): void {
    for (const batch of this.overrideBatches) destroyGpuResources(batch);
    this.overrideBatches = [];
  }

  /**
   * Clear scene
   */
  /** Textured meshes (#961) for the renderer's dedicated textured sub-pass. */
  getTexturedMeshes(): readonly TexturedMesh[] {
    return this.texturedMeshes;
  }

  /**
   * Toggle the instanced draw pass. Instanced geometry is class-0 occurrences
   * (the Model view); hide it in the Types view mode, where the flat path shows
   * the class-1/2 type library instead. Buffers stay uploaded — just not drawn —
   * so toggling back is free.
   */
  setInstancedVisible(visible: boolean): void {
    this.instancedVisible = visible;
  }

  /** GPU-instancing templates for the renderer's instanced draw pass. Empty when
   *  hidden (Types view mode) so the draw loop skips it. */
  getInstancedTemplates(): readonly InstancedTemplateGPU[] {
    if (!this.instancedVisible) return EMPTY_INSTANCED_TEMPLATES;
    return this.instancedTemplates;
  }

  /**
   * Decode a per-batch IFNS instancing shard (`processGeometryBatchInstanced`)
   * and upload its templates for GPU-instanced drawing. Each unique geometry
   * becomes a slot-0 vertex buffer (28-byte pos+norm+entityId, matching the flat
   * layout — the per-vertex entityId is a 0 placeholder; vs_instanced reads the
   * per-occurrence id) + index buffer, plus a slot-1 per-instance buffer (mat4 +
   * entityId + rgba) already composed in the WebGL Y-up frame
   * (`prepareInstancedRender` folds the Z-up→Y-up swap). No-op on a non-shard or
   * empty payload. Idempotent only in the sense of "append" — call clear() to
   * reset on a new model.
   *
   * Takes an ALREADY-DECODED shard (the worker/main layer that receives the raw
   * IFNS bytes owns `decodeInstancedShard`), so this module keeps only a
   * type-only dependency on @ifc-lite/geometry and the Scene stays focused on
   * GPU upload.
   */
  addInstancedShard(device: GPUDevice, shard: DecodedInstancedShard): void {
    this.instancedDevice = device; // cached for per-instance selection/overlay writeBuffer
    const prepared = prepareInstancedRender(shard);
    for (const t of prepared) {
      const vcount = Math.floor(t.positions.length / 3);
      if (vcount === 0 || t.indices.length === 0 || t.instanceCount === 0) continue;

      // Interleave the template's local positions + normals into the 28-byte
      // (pos3f + norm3f + entityId u32) vertex layout the instanced pipeline's
      // slot 0 expects. entityId is a 0 placeholder (vs_instanced ignores it).
      const vtx = new ArrayBuffer(vcount * 28);
      const vf = new Float32Array(vtx);
      for (let i = 0; i < vcount; i++) {
        const o = i * 7;
        vf[o + 0] = t.positions[i * 3 + 0];
        vf[o + 1] = t.positions[i * 3 + 1];
        vf[o + 2] = t.positions[i * 3 + 2];
        // normals may be shorter/absent on degenerate meshes — default to 0.
        vf[o + 3] = i * 3 + 0 < t.normals.length ? t.normals[i * 3 + 0] : 0;
        vf[o + 4] = i * 3 + 1 < t.normals.length ? t.normals[i * 3 + 1] : 0;
        vf[o + 5] = i * 3 + 2 < t.normals.length ? t.normals[i * 3 + 2] : 0;
        // vf[o + 6] (entityId lane) stays 0.
      }

      const vertexBuffer = device.createBuffer({
        size: vtx.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint8Array(vertexBuffer.getMappedRange()).set(new Uint8Array(vtx));
      vertexBuffer.unmap();

      const indexBuffer = device.createBuffer({
        size: t.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint32Array(indexBuffer.getMappedRange()).set(t.indices);
      indexBuffer.unmap();

      // instanceBuffer is already the interleaved mat4 + entityId + rgba block
      // (INSTANCE_STRIDE_BYTES per occurrence) from prepareInstancedRender.
      const instSize = t.instanceCount * INSTANCE_STRIDE_BYTES;
      const instanceBuffer = device.createBuffer({
        size: instSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint8Array(instanceBuffer.getMappedRange()).set(
        new Uint8Array(t.instanceBuffer, 0, instSize),
      );
      instanceBuffer.unmap();

      const templateIndex = this.instancedTemplates.length;
      this.instancedTemplates.push({
        vertexBuffer,
        indexBuffer,
        indexCount: t.indices.length,
        instanceBuffer,
        instanceCount: t.instanceCount,
      });

      // Template-local AABB (used to derive per-occurrence world AABBs cheaply).
      let lmnx = Infinity, lmny = Infinity, lmnz = Infinity;
      let lmxx = -Infinity, lmxy = -Infinity, lmxz = -Infinity;
      for (let i = 0; i < t.positions.length; i += 3) {
        const x = t.positions[i], y = t.positions[i + 1], z = t.positions[i + 2];
        if (x < lmnx) lmnx = x; if (y < lmny) lmny = y; if (z < lmnz) lmnz = z;
        if (x > lmxx) lmxx = x; if (y > lmxy) lmxy = y; if (z > lmxz) lmxz = z;
      }
      // Retain the compact CPU geometry + the packed instance records (mat4 per
      // occurrence) so CPU consumers can reach instanced geometry without a full
      // per-occurrence MeshData each. These are references into the decoded shard.
      this.instancedTemplateCpu.push({
        positions: t.positions,
        normals: t.normals,
        indices: t.indices,
        instanceData: t.instanceBuffer,
        localMin: [lmnx, lmny, lmnz],
        localMax: [lmxx, lmxy, lmxz],
      });

      // Map each occurrence's express_id -> (template, byte offset, original
      // colour) so selection (flag byte) + lens/IDS overlays (colour bytes) can
      // patch individual occurrences via writeBuffer without a re-upload. Also fold
      // each occurrence's world AABB (template local box × its mat4) into
      // boundingBoxes so getEntityBoundingBox + the CPU raycast-bounds path
      // (BCF anchors, large/released-model picking, frame-selection) see instanced
      // geometry. (Templates with no finite local box — empty geometry — are skipped.)
      const cdv = new DataView(t.instanceBuffer);
      const haveBox = Number.isFinite(lmnx);
      for (let i = 0; i < t.instanceCount; i++) {
        const byteOffset = i * INSTANCE_STRIDE_BYTES;
        const eid = t.entityIds[i];
        const originalColor: [number, number, number, number] = [
          cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET, true),
          cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET + 4, true),
          cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET + 8, true),
          cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET + 12, true),
        ];
        let arr = this.instancedEntityMap.get(eid);
        if (!arr) {
          arr = [];
          this.instancedEntityMap.set(eid, arr);
        }
        arr.push({ templateIndex, byteOffset, originalColor });

        if (haveBox) {
          this.unionInstancedWorldAabb(eid, cdv, byteOffset, lmnx, lmny, lmnz, lmxx, lmxy, lmxz);
        }
      }
    }
    // New occurrences default to flags=0 (visible). Force the next setInstancedVisibility
    // to recompute so an already-active isolate/hide also applies to geometry that
    // streamed in after the visibility was set.
    this.instancedVisibilityDirty = true;
  }

  /** Transform a template's local AABB by an occurrence's column-major mat4 (read
   *  from the packed instance record at `matOffset`) and union the world box into
   *  boundingBoxes[eid]. */
  private unionInstancedWorldAabb(
    eid: number,
    dv: DataView,
    matOffset: number,
    lmnx: number, lmny: number, lmnz: number,
    lmxx: number, lmxy: number, lmxz: number,
  ): void {
    const m0 = dv.getFloat32(matOffset + 0, true), m1 = dv.getFloat32(matOffset + 4, true), m2 = dv.getFloat32(matOffset + 8, true);
    const m4 = dv.getFloat32(matOffset + 16, true), m5 = dv.getFloat32(matOffset + 20, true), m6 = dv.getFloat32(matOffset + 24, true);
    const m8 = dv.getFloat32(matOffset + 32, true), m9 = dv.getFloat32(matOffset + 36, true), m10 = dv.getFloat32(matOffset + 40, true);
    const m12 = dv.getFloat32(matOffset + 48, true), m13 = dv.getFloat32(matOffset + 52, true), m14 = dv.getFloat32(matOffset + 56, true);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = (c & 1) ? lmxx : lmnx, y = (c & 2) ? lmxy : lmny, z = (c & 4) ? lmxz : lmnz;
      const wx = m0 * x + m4 * y + m8 * z + m12;
      const wy = m1 * x + m5 * y + m9 * z + m13;
      const wz = m2 * x + m6 * y + m10 * z + m14;
      if (wx < minX) minX = wx; if (wy < minY) minY = wy; if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx; if (wy > maxY) maxY = wy; if (wz > maxZ) maxZ = wz;
    }
    const existing = this.boundingBoxes.get(eid);
    if (existing) {
      existing.min.x = Math.min(existing.min.x, minX);
      existing.min.y = Math.min(existing.min.y, minY);
      existing.min.z = Math.min(existing.min.z, minZ);
      existing.max.x = Math.max(existing.max.x, maxX);
      existing.max.y = Math.max(existing.max.y, maxY);
      existing.max.z = Math.max(existing.max.z, maxZ);
    } else {
      this.boundingBoxes.set(eid, { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } });
    }
  }

  /** True if `expressId` is a GPU-instanced occurrence (lives only in the instanced
   *  shard, not the flat meshDataMap). CPU consumers use this to decide whether to
   *  fall back to the instanced accessors below. */
  isInstancedEntity(expressId: number): boolean {
    return this.instancedEntityMap.has(expressId);
  }

  /** All instanced occurrence express_ids (for CPU consumers that enumerate geometry,
   *  e.g. the raycast-engine and exporters). */
  getInstancedEntityIds(): IterableIterator<number> {
    return this.instancedEntityMap.keys();
  }

  /** Materialize EVERY instanced occurrence as world-space MeshData. Transient + not
   *  retained — for one-shot full-geometry consumers (glTF / IFC5 export) that must
   *  include the instanced occurrences absent from geometryResult.meshes. Returns []
   *  when no instanced data is loaded or after geometry release (templates freed). */
  getAllInstancedMeshData(): MeshData[] {
    const out: MeshData[] = [];
    for (const eid of this.instancedEntityMap.keys()) {
      const pieces = this.getInstancedMeshDataPieces(eid);
      if (pieces) out.push(...pieces);
    }
    return out;
  }

  /** World-space AABB for an instanced occurrence (union over its occurrences),
   *  or null if not instanced. Populated at upload time, so this is O(1). */
  getInstancedEntityBounds(expressId: number): BoundingBox | null {
    if (!this.instancedEntityMap.has(expressId)) return null;
    return this.boundingBoxes.get(expressId) ?? null;
  }

  /** Lazily materialize per-occurrence world-space MeshData for an instanced entity
   *  (template geometry × each occurrence's matrix). NOT retained — built on demand
   *  for CPU consumers that need triangles (exact raycast / measure / section-face /
   *  export). Returns undefined if the id is not instanced. */
  getInstancedMeshDataPieces(expressId: number): MeshData[] | undefined {
    const occ = this.instancedEntityMap.get(expressId);
    if (!occ || occ.length === 0) return undefined;
    const out: MeshData[] = [];
    for (const o of occ) {
      const tpl = this.instancedTemplateCpu[o.templateIndex];
      if (!tpl || tpl.positions.length === 0) continue;
      const dv = new DataView(tpl.instanceData);
      const b = o.byteOffset;
      const m0 = dv.getFloat32(b + 0, true), m1 = dv.getFloat32(b + 4, true), m2 = dv.getFloat32(b + 8, true);
      const m4 = dv.getFloat32(b + 16, true), m5 = dv.getFloat32(b + 20, true), m6 = dv.getFloat32(b + 24, true);
      const m8 = dv.getFloat32(b + 32, true), m9 = dv.getFloat32(b + 36, true), m10 = dv.getFloat32(b + 40, true);
      const m12 = dv.getFloat32(b + 48, true), m13 = dv.getFloat32(b + 52, true), m14 = dv.getFloat32(b + 56, true);
      const n = tpl.positions.length;
      const positions = new Float32Array(n);
      const normals = new Float32Array(tpl.normals.length);
      for (let i = 0; i < n; i += 3) {
        const x = tpl.positions[i], y = tpl.positions[i + 1], z = tpl.positions[i + 2];
        positions[i] = m0 * x + m4 * y + m8 * z + m12;
        positions[i + 1] = m1 * x + m5 * y + m9 * z + m13;
        positions[i + 2] = m2 * x + m6 * y + m10 * z + m14;
        if (i + 2 < tpl.normals.length) {
          // Rotate normals by the upper-3×3 (instancing transforms are rigid +
          // uniform scale, so this is correct up to a renormalize).
          const nx = tpl.normals[i], ny = tpl.normals[i + 1], nz = tpl.normals[i + 2];
          let rx = m0 * nx + m4 * ny + m8 * nz;
          let ry = m1 * nx + m5 * ny + m9 * nz;
          let rz = m2 * nx + m6 * ny + m10 * nz;
          const len = Math.hypot(rx, ry, rz) || 1;
          rx /= len; ry /= len; rz /= len;
          normals[i] = rx; normals[i + 1] = ry; normals[i + 2] = rz;
        }
      }
      const color: [number, number, number, number] = [...o.originalColor];
      // Per-occurrence key so CPU caches that would otherwise key on `expressId`
      // alone (measure-snap geometry cache) don't collide across occurrences of
      // this instanced entity, which share `expressId` but hold distinct
      // world-space positions (issue #1405). templateIndex+byteOffset uniquely
      // and stably identifies an occurrence within the instance buffers.
      const occurrenceKey = `${expressId}:inst:${o.templateIndex}:${o.byteOffset}`;
      out.push({ expressId, positions, normals, indices: tpl.indices, color, occurrenceKey });
    }
    return out.length > 0 ? out : undefined;
  }

  /**
   * Per-instance SELECTION: highlight the occurrences of `expressIds` by setting
   * their flag byte (bit 0) and clearing the previously-selected ones. The shader
   * (vs_instanced -> fs_main) applies the blue highlight per occurrence, so no
   * re-draw is needed. No-op until a shard has been uploaded.
   */
  setInstancedSelection(expressIds: ReadonlySet<number>): void {
    const device = this.instancedDevice;
    if (!device || this.instancedTemplates.length === 0) return;
    // Called every render frame from the renderer. Fast-path an UNCHANGED selection
    // (the common orbit case, especially the empty set) so we skip both the per-frame
    // writeBuffer loops AND the `new Set(...)` allocation — equal sizes + full
    // containment ⇒ set equality.
    let changed = expressIds.size !== this.instancedSelected.size;
    if (!changed) {
      for (const eid of expressIds) {
        if (!this.instancedSelected.has(eid)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    // Re-derive the combined flag lane (selected | hidden) for every occurrence whose
    // selected-membership flips, so we never clobber the hidden bit.
    const prev = this.instancedSelected;
    this.instancedSelected = new Set(expressIds);
    for (const eid of prev) {
      if (!expressIds.has(eid)) this.writeInstanceFlags(device, eid);
    }
    for (const eid of expressIds) {
      if (!prev.has(eid)) this.writeInstanceFlags(device, eid);
    }
  }

  /**
   * Per-instance VISIBILITY (hide / isolate): set the hidden flag bit on occurrences
   * that should not render, mirroring the flat path's hiddenIds/isolatedIds filter.
   * The shader discards hidden occurrences in BOTH the render and pick passes, so they
   * neither draw nor are pickable. `isolatedIds != null` means "show only these"; any
   * occurrence not in the set is hidden. Diffed so an unchanged visibility set is a
   * no-op (no writeBuffer). No-op until a shard has been uploaded.
   */
  setInstancedVisibility(
    hiddenIds: ReadonlySet<number> | null | undefined,
    isolatedIds: ReadonlySet<number> | null | undefined,
  ): void {
    const device = this.instancedDevice;
    if (!device || this.instancedTemplates.length === 0) return;
    // Called every render frame. The viewer passes stable Set references that only
    // change when visibility changes, so a reference-equality guard skips the O(N)
    // set rebuild + allocation during orbit (the common, unchanged case). The dirty
    // flag forces a recompute after a new shard adds occurrences mid-stream, so an
    // active isolate/hide also applies to geometry that streams in afterwards.
    if (
      !this.instancedVisibilityDirty &&
      hiddenIds === this.lastInstancedHiddenIds &&
      isolatedIds === this.lastInstancedIsolatedIds
    ) {
      return;
    }
    this.instancedVisibilityDirty = false;
    this.lastInstancedHiddenIds = hiddenIds ?? null;
    this.lastInstancedIsolatedIds = isolatedIds ?? null;
    const isHidden = (eid: number): boolean =>
      (hiddenIds != null && hiddenIds.has(eid)) ||
      (isolatedIds != null && !isolatedIds.has(eid));
    // Recompute the effective hidden set over all instanced occurrences and diff vs
    // the current one; only flips touch the GPU buffer.
    const next = new Set<number>();
    for (const eid of this.instancedEntityMap.keys()) {
      if (isHidden(eid)) next.add(eid);
    }
    // Fast-path: unchanged hidden set → nothing to write.
    let changed = next.size !== this.instancedHidden.size;
    if (!changed) {
      for (const eid of next) {
        if (!this.instancedHidden.has(eid)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    const prev = this.instancedHidden;
    this.instancedHidden = next;
    for (const eid of prev) {
      if (!next.has(eid)) this.writeInstanceFlags(device, eid);
    }
    for (const eid of next) {
      if (!prev.has(eid)) this.writeInstanceFlags(device, eid);
    }
  }

  /**
   * Per-instance COLOUR OVERRIDE (lens / IDS / compare / 4D): patch the colour
   * bytes of the affected occurrences in place; occurrences dropped from the map
   * are restored to their original colour. Pass null/empty to clear all.
   */
  setInstancedColorOverrides(
    overrides: ReadonlyMap<number, readonly [number, number, number, number]> | null,
  ): void {
    const device = this.instancedDevice;
    if (!device || this.instancedTemplates.length === 0) return;
    const next = overrides ?? new Map<number, readonly [number, number, number, number]>();
    for (const eid of this.instancedOverridden) {
      if (!next.has(eid)) this.restoreInstanceColor(device, eid);
    }
    let hasTransparent = false;
    for (const [eid, rgba] of next) {
      this.writeInstanceColor(device, eid, rgba);
      // Instanced occurrences are opaque by partition; only an override can drop alpha
      // below the cutoff (lens-ghost / x-ray / compare). Track it so the renderer runs
      // the transparent instanced sub-pass only when something is actually translucent.
      if (rgba[3] < OPAQUE_ALPHA_CUTOFF) hasTransparent = true;
    }
    this.instancedOverridden = new Set(next.keys());
    this.instancedHasTransparent = hasTransparent;
  }

  /** True when an active colour override made some instanced occurrence translucent,
   *  so the renderer should run the transparent instanced sub-pass. */
  hasTransparentInstances(): boolean {
    return this.instancedHasTransparent;
  }

  /** Write the combined flag lane (selected | hidden) for every occurrence of `eid`.
   *  Folding both bits here means selection and visibility updates never clobber each
   *  other (they share the one u32 flags lane at INSTANCE_FLAGS_OFFSET). */
  private writeInstanceFlags(device: GPUDevice, eid: number): void {
    const locs = this.instancedEntityMap.get(eid);
    if (!locs) return;
    const flags =
      (this.instancedSelected.has(eid) ? INSTANCE_FLAG_SELECTED : 0) |
      (this.instancedHidden.has(eid) ? INSTANCE_FLAG_HIDDEN : 0);
    const data = new Uint32Array([flags >>> 0]);
    for (const loc of locs) {
      const buf = this.instancedTemplates[loc.templateIndex]?.instanceBuffer;
      if (buf) device.queue.writeBuffer(buf, loc.byteOffset + INSTANCE_FLAGS_OFFSET, data);
    }
  }

  private writeInstanceColor(
    device: GPUDevice,
    eid: number,
    rgba: readonly [number, number, number, number],
  ): void {
    const locs = this.instancedEntityMap.get(eid);
    if (!locs) return;
    const data = new Float32Array([rgba[0], rgba[1], rgba[2], rgba[3]]);
    for (const loc of locs) {
      const buf = this.instancedTemplates[loc.templateIndex]?.instanceBuffer;
      if (buf) device.queue.writeBuffer(buf, loc.byteOffset + INSTANCE_COLOR_OFFSET, data);
    }
  }

  private restoreInstanceColor(device: GPUDevice, eid: number): void {
    const locs = this.instancedEntityMap.get(eid);
    if (!locs) return;
    for (const loc of locs) {
      const buf = this.instancedTemplates[loc.templateIndex]?.instanceBuffer;
      if (buf) device.queue.writeBuffer(buf, loc.byteOffset + INSTANCE_COLOR_OFFSET, new Float32Array(loc.originalColor));
    }
  }

  /**
   * Build a textured mesh (#961): interleave position+normal+entityId+uv into one
   * vertex buffer, upload the decoded RGBA8 texture, create a sampler honouring
   * the IFC RepeatS/RepeatT wrap, and wire a bindGroup (uniform+texture+sampler).
   * The per-frame uniform (viewProj/section/flags + colour tint) is written by
   * the renderer each frame, mirroring how colour batches are driven.
   */
  /**
   * Interleave a textured mesh's vertices into the stride-36 layout
   * `[px,py,pz, nx,ny,nz, entityId(u32), u,v]`. Shared by initial upload and
   * the translate re-upload so the two can't drift. Returns null when the mesh
   * has no texture/uvs/geometry.
   */
  private interleaveTexturedVertices(meshData: MeshData): ArrayBuffer | null {
    const uvs = meshData.uvs;
    if (!meshData.texture || !uvs) return null;
    const positions = meshData.positions;
    const normals = meshData.normals;
    const vertexCount = positions.length / 3;
    if (vertexCount === 0 || meshData.indices.length === 0) return null;

    const interleaved = new ArrayBuffer(vertexCount * 36);
    const f = new Float32Array(interleaved);
    const u = new Uint32Array(interleaved);
    const entityIds = meshData.entityIds;
    // Match mergeGeometry's entityId-lane packing so an overlay (lens/IDS/...)
    // drawn over a textured mesh computes the same z-nudge → depthCompare:'equal'
    // matches. High 8 bits = colour salt, low 24 = picking id.
    const saltByte = colorSaltByte(meshData.color);
    for (let i = 0; i < vertexCount; i++) {
      const o = i * 9;
      f[o] = positions[i * 3];
      f[o + 1] = positions[i * 3 + 1];
      f[o + 2] = positions[i * 3 + 2];
      f[o + 3] = normals[i * 3] ?? 0;
      f[o + 4] = normals[i * 3 + 1] ?? 0;
      f[o + 5] = normals[i * 3 + 2] ?? 0;
      u[o + 6] = packEntityLane(entityIds ? entityIds[i] : meshData.expressId, saltByte);
      f[o + 7] = uvs[i * 2] ?? 0;
      f[o + 8] = uvs[i * 2 + 1] ?? 0;
    }
    return interleaved;
  }

  private createTexturedMesh(meshData: MeshData, device: GPUDevice, pipeline: RenderPipeline): void {
    const tex = meshData.texture;
    const interleaved = this.interleaveTexturedVertices(meshData);
    if (!tex || !interleaved) return;
    this.texturedDevice = device; // reused by translateMeshesForEntity re-upload

    const vertexBuffer = device.createBuffer({
      size: interleaved.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, interleaved);

    const indexBuffer = device.createBuffer({
      size: meshData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, meshData.indices);

    // Upload the Rust-decoded RGBA8 verbatim — no image decoding in JS.
    const texture = device.createTexture({
      size: { width: tex.width, height: tex.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      tex.rgba,
      { bytesPerRow: tex.width * 4, rowsPerImage: tex.height },
      { width: tex.width, height: tex.height },
    );

    const wrap = (repeat: boolean): GPUAddressMode => (repeat ? 'repeat' : 'clamp-to-edge');
    const sampler = device.createSampler({
      addressModeU: wrap(tex.repeatS),
      addressModeV: wrap(tex.repeatT),
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });

    const uniformBuffer = device.createBuffer({
      size: pipeline.getUniformBufferSize(),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = pipeline.createTexturedBindGroup(uniformBuffer, texture.createView(), sampler);

    this.texturedMeshes.push({
      expressId: meshData.expressId,
      vertexBuffer,
      indexBuffer,
      indexCount: meshData.indices.length,
      uniformBuffer,
      texture,
      sampler,
      bindGroup,
      color: meshData.color,
    });
  }

  clear(): void {
    for (const mesh of this.meshes) destroyGpuResources(mesh);
    for (const batch of this.batchedMeshes) destroyGpuResources(batch);
    for (const tm of this.texturedMeshes) {
      tm.vertexBuffer.destroy();
      tm.indexBuffer.destroy();
      tm.uniformBuffer.destroy();
      tm.texture.destroy();
    }
    this.texturedMeshes = [];
    // GPU-instancing templates own their vertex/index/instance buffers.
    for (const it of this.instancedTemplates) {
      it.vertexBuffer.destroy();
      it.indexBuffer.destroy();
      it.instanceBuffer.destroy();
    }
    this.instancedTemplates = [];
    this.instancedTemplateCpu = [];
    this.instancedEntityMap.clear();
    this.instancedSelected.clear();
    this.instancedHidden.clear();
    this.instancedOverridden.clear();
    this.instancedHasTransparent = false;
    this.lastInstancedHiddenIds = null;
    this.lastInstancedIsolatedIds = null;
    this.instancedVisibilityDirty = false;
    this.instancedDevice = undefined;
    // Clear partial batch cache
    for (const batch of this.partialBatchCache.values()) destroyGpuResources(batch);
    // Destroy streaming fragments (already included in batchedMeshes, but tracked separately)
    this.streamingFragments = [];
    this.destroyOverrideBatches();
    this.colorOverrides = null;
    // Reset the shared frame origin so the next model picks its own.
    this.sharedFrameOrigin = null;
    this.meshes = [];
    this.batchedMeshes = [];
    this.buckets.clear();
    this.meshDataBucket = new Map();
    this.meshDataMap.clear();
    this.boundingBoxes.clear();
    this.activeBucketKey.clear();
    this.cachedMaxBufferSize = 0;
    this.pendingBatchKeys.clear();
    this.partialBatchCache.clear();
    this.partialBatchCacheKeys.clear();
    this.meshQueue = [];
    this.meshQueueReadIndex = 0;
    this.geometryReleased = false;
    this.ephemeralStreamingMode = false;
  }

  /**
   * Calculate bounding box from actual mesh vertex data
   */
  getBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
    // When geometry data is released, compute bounds from cached bounding boxes
    if (this.geometryReleased) {
      if (this.boundingBoxes.size === 0) return null;

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      for (const bbox of this.boundingBoxes.values()) {
        if (bbox.min.x < minX) minX = bbox.min.x;
        if (bbox.min.y < minY) minY = bbox.min.y;
        if (bbox.min.z < minZ) minZ = bbox.min.z;
        if (bbox.max.x > maxX) maxX = bbox.max.x;
        if (bbox.max.y > maxY) maxY = bbox.max.y;
        if (bbox.max.z > maxZ) maxZ = bbox.max.z;
      }

      return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
      };
    }

    if (this.meshDataMap.size === 0) return null;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let hasValidData = false;

    // Compute bounds from all mesh data
    for (const pieces of this.meshDataMap.values()) {
      for (const piece of pieces) {
        const positions = piece.positions;
        // world = origin + position (per-element local frame).
        const ox = piece.origin ? piece.origin[0] : 0;
        const oy = piece.origin ? piece.origin[1] : 0;
        const oz = piece.origin ? piece.origin[2] : 0;
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i] + ox;
          const y = positions[i + 1] + oy;
          const z = positions[i + 2] + oz;
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            hasValidData = true;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
          }
        }
      }
    }

    if (!hasValidData) return null;

    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };
  }

  /**
   * Get all expressIds that have mesh data (for CPU raycasting).
   * After geometry release, returns expressIds from the cached bounding boxes.
   */
  getAllMeshDataExpressIds(): number[] {
    if (this.geometryReleased) {
      // boundingBoxes already includes instanced occurrences (their AABBs are
      // stored there at upload), so the released path needs no extra union.
      return Array.from(this.boundingBoxes.keys());
    }
    // Union instanced-only occurrences (absent from meshDataMap) so CPU consumers
    // enumerating geometry see them too. IDs only — no geometry materialized.
    // (#1238 review)
    const ids = new Set<number>(this.meshDataMap.keys());
    for (const eid of this.instancedEntityMap.keys()) ids.add(eid);
    return Array.from(ids);
  }

  /**
   * Get or compute bounding box for an entity from its mesh vertex data.
   * Results are cached per expressId for subsequent calls.
   * @param expressId - The expressId (globalId) to look up
   * @returns Bounding box with min/max corners, or null if no mesh data exists
   */
  getEntityBoundingBox(expressId: number): BoundingBox | null {
    // Check cache first
    const cached = this.boundingBoxes.get(expressId);
    if (cached) return cached;

    // Compute from mesh data
    const pieces = this.meshDataMap.get(expressId);
    if (!pieces || pieces.length === 0) return null;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const piece of pieces) {
      const positions = piece.positions;
      // world = origin + position (per-element local frame); origin absent/[0,0,0]
      // for legacy absolute meshes.
      const ox = piece.origin ? piece.origin[0] : 0;
      const oy = piece.origin ? piece.origin[1] : 0;
      const oz = piece.origin ? piece.origin[2] : 0;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i] + ox;
        const y = positions[i + 1] + oy;
        const z = positions[i + 2] + oz;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }

    const bbox: BoundingBox = {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };
    this.boundingBoxes.set(expressId, bbox);
    return bbox;
  }

  /**
   * Local (pre-placement, object-space) AABB for an entity (issue #1474) — the
   * element's true, un-rotated extent, unlike {@link getEntityBoundingBox}'s
   * world-space (axis-aligned-to-world) box. Y-up metres, same frame as
   * `positions`. O(1): no vertex scan, reads `MeshData.localBounds` captured
   * by the geometry pipeline.
   *
   * Unions `localBounds` across all of the entity's mesh pieces — safe with
   * no reconciliation, since every piece of one element is already expressed
   * in the same local frame (see `MeshData.localBounds` docs). For a
   * GPU-instanced entity, unions the local box of every occurrence's
   * template — one `expressId` can hold multiple occurrence records backed
   * by DIFFERENT templates (e.g. a mapped-item assembly whose sub-items
   * split across materials), not just repeats of one template, mirroring the
   * flat-path union above.
   *
   * Returns `null` for a container/assembly with no mesh (e.g.
   * `IfcElementAssembly`), or when not captured (older cached geometry).
   */
  getEntityLocalBounds(expressId: number): { min: [number, number, number]; max: [number, number, number] } | null {
    const pieces = this.meshDataMap.get(expressId);
    if (pieces && pieces.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let found = false;
      for (const piece of pieces) {
        const lb = piece.localBounds;
        if (!lb) continue;
        found = true;
        if (lb.min[0] < minX) minX = lb.min[0];
        if (lb.min[1] < minY) minY = lb.min[1];
        if (lb.min[2] < minZ) minZ = lb.min[2];
        if (lb.max[0] > maxX) maxX = lb.max[0];
        if (lb.max[1] > maxY) maxY = lb.max[1];
        if (lb.max[2] > maxZ) maxZ = lb.max[2];
      }
      return found ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null;
    }

    // GPU-instanced entity: no flat mesh piece. Union every occurrence's
    // template box (computed once at upload time, `scene.ts` instancing
    // upload path) — distinct occurrence records for one expressId can point
    // at distinct templates.
    const occurrences = this.instancedEntityMap.get(expressId);
    if (occurrences && occurrences.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let found = false;
      for (const occ of occurrences) {
        const tmpl = this.instancedTemplateCpu[occ.templateIndex];
        if (!tmpl || !Number.isFinite(tmpl.localMin[0])) continue;
        found = true;
        if (tmpl.localMin[0] < minX) minX = tmpl.localMin[0];
        if (tmpl.localMin[1] < minY) minY = tmpl.localMin[1];
        if (tmpl.localMin[2] < minZ) minZ = tmpl.localMin[2];
        if (tmpl.localMax[0] > maxX) maxX = tmpl.localMax[0];
        if (tmpl.localMax[1] > maxY) maxY = tmpl.localMax[1];
        if (tmpl.localMax[2] > maxZ) maxZ = tmpl.localMax[2];
      }
      return found ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null;
    }
    return null;
  }

  /**
   * The resolved local→world placement transform for an entity (issue
   * #1474): row-major 4×4 (16 numbers), Y-up metres — pairs with
   * {@link getEntityLocalBounds} to reconstruct the element's true oriented
   * world box (an OBB), unlike {@link getEntityBoundingBox}'s pre-unioned
   * world-axis-aligned box.
   *
   * A flat entity's mesh pieces all share one placement (one
   * `IfcLocalPlacement` per element) — returns the first piece that carries
   * one. For a GPU-instanced entity, reads the FIRST occurrence record's
   * transform (from the packed instance buffer, column-major, transposed
   * here so the public contract is row-major regardless of path).
   *
   * KNOWN LIMITATION: unlike {@link getEntityLocalBounds} (safe to union),
   * a transform can't be meaningfully aggregated across multiple occurrence
   * records — an entity whose shape is internally composed of several
   * independently-placed mapped sub-items (e.g. a railing with repeated
   * baluster geometry) has genuinely DIFFERENT per-occurrence transforms
   * under one `expressId`. This returns one representative transform, not
   * necessarily the "whole entity's" placement, for such cases.
   *
   * Returns `null` for a container/assembly with no mesh, or when not
   * captured (older cached geometry, or the instancing template was released).
   *
   * Returns `Float64Array`, NOT `Float32Array`: `localToWorld` carries the
   * placement's translation in the *original* (pre-RTC) coordinate frame,
   * which for a building-scale/georeferenced model can be tens of thousands
   * of metres from the origin — f32 there loses sub-millimetre precision
   * (the exact fan-collapse failure mode `MeshData.origin` exists to avoid
   * for `positions`). The flat path's source data is already f64
   * (`piece.localToWorld` round-trips from Rust's `[f64; 16]`); the
   * instanced path's source (the GPU instance buffer) is genuinely f32, so
   * widening it here is lossless but doesn't recover precision already lost
   * upstream in that path.
   */
  getEntityTransform(expressId: number): Float64Array | null {
    const pieces = this.meshDataMap.get(expressId);
    if (pieces && pieces.length > 0) {
      for (const piece of pieces) {
        if (piece.localToWorld && piece.localToWorld.length === 16) {
          return new Float64Array(piece.localToWorld);
        }
      }
      return null;
    }

    const occurrences = this.instancedEntityMap.get(expressId);
    if (occurrences && occurrences.length > 0) {
      const { templateIndex, byteOffset } = occurrences[0];
      const tmpl = this.instancedTemplateCpu[templateIndex];
      if (!tmpl) return null;
      const dv = new DataView(tmpl.instanceData);
      const row = new Float64Array(16);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          // Source is column-major (mat[c][r] at byteOffset + (c*4+r)*4);
          // write it out row-major.
          row[r * 4 + c] = dv.getFloat32(byteOffset + (c * 4 + r) * 4, true);
        }
      }
      return row;
    }
    return null;
  }

  /**
   * CPU raycast against all mesh data.
   * Returns expressId and modelIndex of closest hit, or null.
   * Delegates to extracted raycaster utilities.
   */
  raycast(
    rayOrigin: Vec3,
    rayDir: Vec3,
    hiddenIds?: Set<number>,
    isolatedIds?: Set<number> | null,
    clip?: PickClipState | null
  ): RaycastHit | null {
    const { rayDirInv, rayDirSign } = prepareRayDirInv(rayDir);

    // When geometry data has been released, use bounding-box-only raycast.
    if (this.geometryReleased) {
      return raycastBoundingBoxes(rayOrigin, rayDir, rayDirInv, rayDirSign, this.boundingBoxes, hiddenIds, isolatedIds, clip);
    }

    // Full triangle-level raycast with bounding-box pre-filter
    const flatHit = raycastTriangles(
      rayOrigin,
      rayDir,
      rayDirInv,
      rayDirSign,
      this.meshDataMap,
      (id) => this.getEntityBoundingBox(id),
      hiddenIds,
      isolatedIds,
      clip,
    );

    // Instanced-only occurrences live in the shard, not meshDataMap, so the CPU
    // pick fallback would miss them. Materialize triangles lazily ONLY for
    // entities whose world AABB the ray actually hits (never the whole instanced
    // population), then return whichever hit is closer. (#1238 review)
    let instancedHit: RaycastHit | null = null;
    if (this.instancedEntityMap.size > 0) {
      const instancedMap = new Map<number, MeshData[]>();
      for (const eid of this.instancedEntityMap.keys()) {
        if (hiddenIds?.has(eid)) continue;
        if (isolatedIds != null && !isolatedIds.has(eid)) continue;
        const bounds = this.getInstancedEntityBounds(eid);
        if (!bounds || !rayIntersectsBox(rayOrigin, rayDirInv, rayDirSign, bounds)) continue;
        const pieces = this.getInstancedMeshDataPieces(eid);
        if (pieces && pieces.length > 0) instancedMap.set(eid, pieces);
      }
      if (instancedMap.size > 0) {
        instancedHit = raycastTriangles(
          rayOrigin,
          rayDir,
          rayDirInv,
          rayDirSign,
          instancedMap,
          (id) => this.getInstancedEntityBounds(id),
          hiddenIds,
          isolatedIds,
          clip,
        );
      }
    }

    if (flatHit && instancedHit) {
      return instancedHit.distance < flatHit.distance ? instancedHit : flatHit;
    }
    return flatHit ?? instancedHit;
  }
}
