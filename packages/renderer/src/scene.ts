/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene graph and mesh management
 */

import type { Mesh, InstancedMesh, BatchedMesh, Vec3 } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import { BATCH_CONSTANTS } from './constants.js';
import {
  type BoundingBox,
  type RaycastHit,
  prepareRayDirInv,
  raycastBoundingBoxes,
  raycastTriangles,
} from './scene-raycaster.js';
import { mergeGeometry, splitMeshDataForBufferLimit } from './scene-geometry.js';

/** Consolidated per-bucket state — replaces six separate tracking maps. */
interface BatchBucket {
  key: string;                      // bucket key (color hash or "hash#N")
  meshData: MeshData[];             // accumulated source mesh data
  batchedMesh: BatchedMesh | null;  // built GPU batch (null during streaming)
  vertexBytes: number;              // accumulated vertex buffer bytes
}

export class Scene {
  private meshes: Mesh[] = [];
  private instancedMeshes: InstancedMesh[] = [];
  private batchedMeshes: BatchedMesh[] = [];                        // flat render array (rebuilt from buckets)
  private buckets: Map<string, BatchBucket> = new Map();            // bucketKey -> consolidated bucket state
  private meshDataBucket: Map<MeshData, BatchBucket> = new Map();   // reverse lookup: MeshData -> owning bucket
  private meshDataMap: Map<number, MeshData[]> = new Map();         // Map expressId -> MeshData[] (for lazy buffer creation, accumulates multiple pieces)
  private boundingBoxes: Map<number, BoundingBox> = new Map();      // Map expressId -> bounding box (computed lazily)

  // Buffer-size-aware bucket splitting: when a single color group's geometry
  // would exceed the GPU maxBufferSize, overflow is directed to a new
  // sub-bucket with a suffixed key (e.g. "500|500|500|1000#1"). This keeps
  // all downstream maps single-valued and the rendering code unchanged.
  private activeBucketKey: Map<string, string> = new Map(); // base colorKey -> current active bucket key
  private nextSplitId: number = 0; // Monotonic counter for sub-bucket keys
  private nextBatchId: number = 0; // Monotonic counter for unique batch identifiers
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
  private colorOverrides: Map<number, [number, number, number, number]> | null = null;

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
   * Add instanced mesh to scene
   */
  addInstancedMesh(mesh: InstancedMesh): void {
    this.instancedMeshes.push(mesh);
  }

  /**
   * Get all meshes
   */
  getMeshes(): Mesh[] {
    return this.meshes;
  }

  /**
   * Get all instanced meshes
   */
  getInstancedMeshes(): InstancedMesh[] {
    return this.instancedMeshes;
  }

  /**
   * Get all batched meshes
   */
  getBatchedMeshes(): BatchedMesh[] {
    return this.batchedMeshes;
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

    // Route each mesh into a size-aware bucket for its color
    for (const meshData of meshDataArray) {
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
      this.createStreamingFragments(meshDataArray, device, pipeline);
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
        bucket.batchedMesh.vertexBuffer.destroy();
        bucket.batchedMesh.indexBuffer.destroy();
        if (bucket.batchedMesh.uniformBuffer) {
          bucket.batchedMesh.uniformBuffer.destroy();
        }
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

    // Drain the queue in moderately sized chunks instead of one mesh at a time.
    // This preserves the per-frame time budget while cutting appendToBatches()
    // overhead and front-of-array churn during huge desktop streams.
    const MAX_MESHES_PER_FLUSH = 4096;
    const MESHES_PER_APPEND = 512;
    const FLUSH_BUDGET_MS = 12;
    const start = performance.now();
    let processed = 0;

    while (this.meshQueueReadIndex < this.meshQueue.length && processed < MAX_MESHES_PER_FLUSH) {
      const chunkSize = Math.min(
        MESHES_PER_APPEND,
        MAX_MESHES_PER_FLUSH - processed,
        this.meshQueue.length - this.meshQueueReadIndex,
      );
      const chunk = this.meshQueue.slice(this.meshQueueReadIndex, this.meshQueueReadIndex + chunkSize);
      this.meshQueueReadIndex += chunkSize;
      this.appendToBatches(chunk, device, pipeline, true);
      processed += chunk.length;
      if (processed >= MESHES_PER_APPEND && performance.now() - start >= FLUSH_BUDGET_MS) {
        break;
      }
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
    for (const batch of this.partialBatchCache.values()) {
      batch.vertexBuffer.destroy();
      batch.indexBuffer.destroy();
      if (batch.uniformBuffer) {
        batch.uniformBuffer.destroy();
      }
    }
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
    for (const fragment of oldFragments) {
      fragment.vertexBuffer.destroy();
      fragment.indexBuffer.destroy();
      if (fragment.uniformBuffer) {
        fragment.uniformBuffer.destroy();
      }
    }
    for (const batch of oldBatches) {
      if (!fragmentSet.has(batch)) {
        batch.vertexBuffer.destroy();
        batch.indexBuffer.destroy();
        if (batch.uniformBuffer) {
          batch.uniformBuffer.destroy();
        }
      }
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
    for (const batch of this.partialBatchCache.values()) {
      batch.vertexBuffer.destroy();
      batch.indexBuffer.destroy();
      if (batch.uniformBuffer) batch.uniformBuffer.destroy();
    }
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
        for (const fragment of oldFragments) {
          fragment.vertexBuffer.destroy();
          fragment.indexBuffer.destroy();
          if (fragment.uniformBuffer) fragment.uniformBuffer.destroy();
        }
        for (const batch of oldBatches) {
          if (!fragmentSet.has(batch)) {
            batch.vertexBuffer.destroy();
            batch.indexBuffer.destroy();
            if (batch.uniformBuffer) batch.uniformBuffer.destroy();
          }
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
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i];
          const y = positions[i + 1];
          const z = positions[i + 2];
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
    this.activeBucketKey.clear();
    this.pendingBatchKeys.clear();
    for (const batch of this.partialBatchCache.values()) {
      batch.vertexBuffer.destroy();
      batch.indexBuffer.destroy();
      if (batch.uniformBuffer) batch.uniformBuffer.destroy();
    }
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
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i];
          const y = positions[i + 1];
          const z = positions[i + 2];
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
    // Clear meshData arrays in each bucket (typed arrays become GC-eligible)
    // but keep the bucket shells so batchedMesh references remain valid
    for (const bucket of this.buckets.values()) {
      bucket.meshData = [];
    }
    this.meshDataBucket = new Map();
    this.activeBucketKey.clear();

    // 3. Clear partial batch cache (would need mesh data to rebuild)
    for (const batch of this.partialBatchCache.values()) {
      batch.vertexBuffer.destroy();
      batch.indexBuffer.destroy();
      if (batch.uniformBuffer) batch.uniformBuffer.destroy();
    }
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
    const merged = this.mergeGeometry(meshDataArray);
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
    };
  }


  /**
   * Merge multiple mesh geometries into single vertex/index buffers.
   * Delegates to the extracted mergeGeometry() utility.
   */
  private mergeGeometry(meshDataArray: MeshData[]): {
    vertexData: Float32Array;
    indices: Uint32Array;
    bounds: { min: [number, number, number]; max: [number, number, number] };
  } {
    return mergeGeometry(meshDataArray);
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
        oldBatch.vertexBuffer.destroy();
        oldBatch.indexBuffer.destroy();
        if (oldBatch.uniformBuffer) {
          oldBatch.uniformBuffer.destroy();
        }
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
      return;
    }

    if (overrides.size === 0) {
      this.colorOverrides = null;
      return;
    }

    this.colorOverrides = overrides;

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
  }

  /** Get overlay batches for rendering */
  getOverrideBatches(): BatchedMesh[] {
    return this.overrideBatches;
  }

  /** Check if color overrides are active */
  hasColorOverrides(): boolean {
    return this.overrideBatches.length > 0;
  }

  /** Destroy GPU resources for overlay batches */
  private destroyOverrideBatches(): void {
    for (const batch of this.overrideBatches) {
      batch.vertexBuffer.destroy();
      batch.indexBuffer.destroy();
      if (batch.uniformBuffer) {
        batch.uniformBuffer.destroy();
      }
    }
    this.overrideBatches = [];
  }

  /**
   * Clear regular meshes only (used when converting to instanced rendering)
   */
  clearRegularMeshes(): void {
    for (const mesh of this.meshes) {
      mesh.vertexBuffer.destroy();
      mesh.indexBuffer.destroy();
      // Destroy per-mesh uniform buffer if it exists
      if (mesh.uniformBuffer) {
        mesh.uniformBuffer.destroy();
      }
    }
    this.meshes = [];
  }

  /**
   * Clear scene
   */
  clear(): void {
    for (const mesh of this.meshes) {
      mesh.vertexBuffer.destroy();
      mesh.indexBuffer.destroy();
      // Destroy per-mesh uniform buffer if it exists
      if (mesh.uniformBuffer) {
        mesh.uniformBuffer.destroy();
      }
    }
    for (const mesh of this.instancedMeshes) {
      mesh.vertexBuffer.destroy();
      mesh.indexBuffer.destroy();
      mesh.instanceBuffer.destroy();
    }
    for (const batch of this.batchedMeshes) {
      batch.vertexBuffer.destroy();
      batch.indexBuffer.destroy();
      if (batch.uniformBuffer) {
        batch.uniformBuffer.destroy();
      }
    }
    // Clear partial batch cache
    for (const batch of this.partialBatchCache.values()) {
      batch.vertexBuffer.destroy();
      batch.indexBuffer.destroy();
      if (batch.uniformBuffer) {
        batch.uniformBuffer.destroy();
      }
    }
    // Destroy streaming fragments (already included in batchedMeshes, but tracked separately)
    this.streamingFragments = [];
    this.destroyOverrideBatches();
    this.colorOverrides = null;
    this.meshes = [];
    this.instancedMeshes = [];
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
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i];
          const y = positions[i + 1];
          const z = positions[i + 2];
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
      return Array.from(this.boundingBoxes.keys());
    }
    return Array.from(this.meshDataMap.keys());
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
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
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
   * CPU raycast against all mesh data.
   * Returns expressId and modelIndex of closest hit, or null.
   * Delegates to extracted raycaster utilities.
   */
  raycast(
    rayOrigin: Vec3,
    rayDir: Vec3,
    hiddenIds?: Set<number>,
    isolatedIds?: Set<number> | null
  ): RaycastHit | null {
    const { rayDirInv, rayDirSign } = prepareRayDirInv(rayDir);

    // When geometry data has been released, use bounding-box-only raycast.
    if (this.geometryReleased) {
      return raycastBoundingBoxes(rayOrigin, rayDirInv, rayDirSign, this.boundingBoxes, hiddenIds, isolatedIds);
    }

    // Full triangle-level raycast with bounding-box pre-filter
    return raycastTriangles(
      rayOrigin,
      rayDir,
      rayDirInv,
      rayDirSign,
      this.meshDataMap,
      (id) => this.getEntityBoundingBox(id),
      hiddenIds,
      isolatedIds,
    );
  }
}
