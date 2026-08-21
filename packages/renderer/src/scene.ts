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
import { selectBoundingBoxesInRect } from './scene-rect-select.js';
import { mergeGeometry, splitMeshDataForBufferLimit, colorSaltByte, packEntityLane, worldAabbFromPieces } from './scene-geometry.js';
import { sumResidentGpuBytes, type ResidentGpuBytes } from './render-stats.js';
import { simplifyIndicesByClustering, lodCellSizeForBounds, LOD_MIN_TRIANGLES } from './lod-simplify.js';
import { quantizeInterleaved } from './quantize.js';
import { bucketBaseKeyFor, type SpatialChunkingConfig } from './chunk-grid.js';
import { VisibilityEpochTracker } from './visibility-epoch.js';
import { isEntityVisible } from './entity-visibility.js';
import { planInstancedGhosting } from './instanced-ghost-plan.js';
import { selectEvictions, type ResidencyShell, type ColdGeometryProvider } from './residency.js';
import { OPAQUE_ALPHA_CUTOFF } from './overlay-routing.js';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import {
  prepareInstancedRender,
  foldOccurrenceWorldBox,
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
  /**
   * The mesh's per-element local frame (`MeshData.origin`, already Y-up) — the
   * renderer must reconstruct `world = origin + position`.
   *
   * The interleaved vertex buffer stores positions RELATIVE to this, which is
   * the whole point of the local frame (#1114): keeping the world magnitude out
   * of f32 so building-scale coordinates don't collapse adjacent vertices into
   * degenerate fans. So it is applied as the draw's model translation, never
   * folded back into the vertex data.
   *
   * `[0, 0, 0]` for the #961 orphan type-geometry path, whose positions are
   * already absolute (`transform_mesh_local`); non-zero for the #1793
   * occurrence path (`apply_submesh_placement` → `transform_mesh_world`), which
   * is what real exporters write. Dropping it drew every textured occurrence
   * collapsed toward the world origin (#1973).
   */
  origin: [number, number, number];
  /** Set when `texture` lives in the shared registry (#1781: one GPU texture
   *  per `IfcImageTexture`, sampled by many meshes) — released by refcount,
   *  never destroyed per-mesh. Undefined for per-mesh #961 blob/pixel uploads. */
  sharedTextureKey?: number;
}

function destroyGpuResources(
  m: { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; uniformBuffer?: GPUBuffer; lod1IndexBuffer?: GPUBuffer },
): void {
  m.vertexBuffer.destroy();
  m.indexBuffer.destroy();
  if (m.uniformBuffer) m.uniformBuffer.destroy();
  if (m.lod1IndexBuffer) m.lod1IndexBuffer.destroy();
}

/**
 * One GPU-uploaded instanced template: unique geometry (slot-0 vertex + index
 * buffers, 28-byte pos+norm+entityId vertex matching the flat layout) drawn once
 * per occurrence via a per-instance buffer at slot 1 and
 * `drawIndexed(indexCount, instanceCount)`. Buffers are Scene-owned, freed in clear().
 */
export interface InstancedTemplateGPU {
  /** Owning model (federation index). Templates are identified by
   *  `(modelIndex, slot)`, so one model's templates can be freed without
   *  disturbing another's — see `removeInstancedTemplatesForModel`. Defaults to
   *  0, the single-model / primary case. */
  modelIndex: number;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
  /** Union of the occurrences' world AABBs (null when no occurrence has a
   *  finite box — such templates are never culled). Same tuple layout as
   *  BatchedMesh.bounds so the render loop's frustum test is shared. */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Largest single-occurrence bounding-sphere radius (world units). Upper
   *  bound for the contribution cull: no occurrence can project larger than
   *  this radius at the union box's nearest view depth. */
  maxOccRadius: number;
  /** Occurrences currently selected (highlight flag set). A template with a
   *  selected occurrence is exempt from contribution culling so the highlight
   *  can't vanish while the entity is the user's focus. */
  selectedCount: number;
}

/** Shared empty result for getInstancedTemplates() when the instanced pass is hidden. */
const EMPTY_INSTANCED_TEMPLATES: readonly InstancedTemplateGPU[] = [];

/** One occurrence's location in the instanced buffers, for per-instance selection
 *  + colour-override patching. originalColor restores after a lens/IDS overlay clears. */
interface InstancedOccurrence {
  /** STABLE slot in `instancedTemplates` / `instancedTemplateCpu` — never
   *  reused after the slot is freed, so a stale reference resolves to a hole
   *  rather than to another model's template. */
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

/**
 * Pure helper: compute the exclusive end index of the next flushPending()
 * append chunk, starting at `readIndex` and bounded by BOTH mesh count
 * (`hardEnd`, computed by the caller) and index volume (`maxIndicesPerAppend`).
 * Always takes at least one mesh past `readIndex` -- a single oversize mesh is
 * split upstream by splitMeshForStreaming, so the volume cap never blocks the
 * first mesh of a chunk.
 *
 * Non-finite-safe by construction: every non-finite `next` (a malformed mesh
 * reporting NaN, +Infinity, or -Infinity for `indices.length`) closes the
 * chunk explicitly instead of being folded into the running `chunkIndices`
 * total. Only NaN would have made a naive cap check `chunkIndices + next >
 * maxIndicesPerAppend` silently `false` forever (`NaN > cap` is always
 * `false`); +Infinity actually made that same check fire immediately
 * (`chunkIndices + Infinity > cap` is `true`), closing the chunk after a
 * single oversize mesh instead of growing it unbounded. The current
 * `!(chunkIndices + next <= maxIndicesPerAppend)` form below rejects both
 * NaN and +Infinity explicitly rather than relying on that asymmetry.
 * -Infinity needed a separate, explicit check: `-Infinity <= cap` is always
 * `true`, so `!(... <= cap)` lets it straight through, and folding it into
 * `chunkIndices` would poison the running total to -Infinity permanently,
 * keeping the cap vacuous for every mesh after it, not just the malformed
 * one.
 */
export function computeFlushChunkEnd(
  getIndicesLength: (meshIndex: number) => number,
  readIndex: number,
  hardEnd: number,
  maxIndicesPerAppend: number,
): number {
  let chunkEnd = readIndex;
  let chunkIndices = 0;
  while (chunkEnd < hardEnd) {
    const next = getIndicesLength(chunkEnd);
    if (!Number.isFinite(next)) {
      // A malformed mesh reporting a non-finite indices.length (NaN, +/-Infinity)
      // must close the chunk here rather than being folded into chunkIndices:
      // `chunkIndices += -Infinity` would poison the running total to -Infinity
      // permanently, making `!(chunkIndices + next <= maxIndicesPerAppend)`
      // false forever and letting the volume cap never fire again for the
      // rest of this chunk. Always take at least the first mesh past
      // readIndex (same progress guarantee as the NaN case below).
      if (chunkEnd === readIndex) chunkEnd++;
      break;
    }
    if (chunkEnd > readIndex && !(chunkIndices + next <= maxIndicesPerAppend)) {
      break;
    }
    chunkIndices += next;
    chunkEnd++;
  }
  return chunkEnd;
}

export class Scene {
  private meshes: Mesh[] = [];
  private batchedMeshes: BatchedMesh[] = [];                        // flat render array (rebuilt from buckets)
  private buckets: Map<string, BatchBucket> = new Map();            // bucketKey -> consolidated bucket state
  private meshDataBucket: Map<MeshData, BatchBucket> = new Map();   // reverse lookup: MeshData -> owning bucket
  private meshDataMap: Map<number, MeshData[]> = new Map();         // Map expressId -> MeshData[] (for lazy buffer creation, accumulates multiple pieces)
  private boundingBoxes: Map<number, BoundingBox> = new Map();      // Map expressId -> bounding box (computed lazily)
  private texturedMeshes: TexturedMesh[] = [];                      // #961: IFC surface-textured meshes (own buffers/texture/bindGroup)
  /** #1781: GPU textures shared across meshes, keyed by `MeshTextureRef.textureId`
   *  (one `IfcImageTexture` → one upload, sampled by every face set mapping it).
   *  Refcounted: entries die when the last referencing mesh is removed / on clear(). */
  private sharedTextures = new Map<number, { texture: GPUTexture; refs: number }>();
  private texturedDevice?: GPUDevice;                               // #961: cached for textured-mesh re-upload on translate
  /** GPU-instancing: unique templates + per-occurrence buffers (fed by
   *  addInstancedShard). SLOT-STABLE and therefore SPARSE: a per-model removal
   *  (`removeInstancedTemplatesForModel`) leaves `undefined` holes instead of
   *  splicing, because `InstancedOccurrence.templateIndex` holds the slot by
   *  value and a splice would silently repoint every later occurrence at the
   *  wrong template. New templates always append at `length`; freed slots are
   *  never recycled. Iterate `getInstancedTemplates()` (compacted, cached) for
   *  the draw/pick/accounting walks — never this array directly. */
  private instancedTemplates: (InstancedTemplateGPU | undefined)[] = [];
  /** Compacted live view of `instancedTemplates`, rebuilt on mutation. */
  private liveInstancedTemplates: InstancedTemplateGPU[] = [];
  private instancedVisible = true;                                  // GPU-instancing: hidden in Types view mode (instanced geometry is class-0 occurrences)
  private instancedEntityMap: Map<number, InstancedOccurrence[]> = new Map(); // express_id -> occurrences, for per-instance selection/overlay patching
  /** Compact CPU geometry per template, slot-aligned with `instancedTemplates`
   *  (so equally sparse) for CPU consumers. Also emptied wholesale on geometry
   *  release — every reader already tolerates a missing entry. */
  private instancedTemplateCpu: (InstancedTemplateCpu | undefined)[] = [];
  private instancedDevice?: GPUDevice;                              // cached for per-instance flag/colour writeBuffer updates
  private instancedSelected: Set<number> = new Set();              // currently flag-selected instanced express_ids
  private instancedHidden: Set<number> = new Set();               // currently hidden instanced express_ids (hide/isolate)
  private instancedOverridden: Set<number> = new Set();            // currently colour-overridden instanced express_ids
  private instancedGhosted: Set<number> = new Set();               // currently X-Ray ghosted instanced express_ids
  // The colours the instanced channel was last overridden with. Ghosting reads
  // THIS rather than the flat path's `colorOverrides`: the two are set by
  // different calls and can diverge, and a fade must compose with whatever is
  // actually on the instance buffer.
  private instancedOverrideColors: ReadonlyMap<number, readonly [number, number, number, number]> | null = null;
  private lastGhostAlpha = 1;                                      // alpha the active X-Ray fade was written with
  // Set when something OTHER than the ghost set changed the instance colour
  // bytes — a shard streaming in, or an override applied/dropped. The
  // membership diff cannot see those, so without this an occurrence can sit
  // solid while the set says it is ghosted (#2606 review).
  private instancedGhostDirty = false;
  private instancedHasTransparent = false;                         // an override made some instanced occurrence translucent
  private instancedGhostTransparent = false;                       // X-Ray ghosting made some instanced occurrence translucent
  // Content-based change guard for setInstancedVisibility — same contract as
  // RenderOptions.hiddenIds (in-place mutation and fresh identical Sets both
  // behave), keeping the instanced path in lockstep with the batched path.
  private readonly instancedVisibilityEpochs = new VisibilityEpochTracker();
  private lastInstancedVisibilityVersion = -1;
  private instancedVisibilityDirty = false;                       // set when a new shard adds occurrences → re-apply visibility

  // Buffer-size-aware bucket splitting: when a single color group's geometry
  // would exceed the GPU maxBufferSize, overflow is directed to a new
  // sub-bucket with a suffixed key (e.g. "500|500|500|1000#1"). This keeps
  // all downstream maps single-valued and the rendering code unchanged.
  private activeBucketKey: Map<string, string> = new Map(); // base colorKey -> current active bucket key
  // Spatial chunking (issue #1682 phase 2): when set, bucket base keys gain a
  // grid-cell prefix so batches are spatially compact and cullable. Null = off
  // (plain colour bucketing, the historical behaviour).
  private spatialChunking: SpatialChunkingConfig | null = null;
  // GPU residency budget (issue #1682 phase 3a): when set, bucket-owned
  // batches not drawn recently are evicted (GPU buffers destroyed, CPU
  // meshData + metadata shell kept) once their combined bytes exceed the
  // budget, and rebuilt on demand when the draw loop wants them again.
  private gpuBudgetBytes: number | null = null;
  private residencyFrame = 0;                                  // bumped once per render()
  private lastDrawnFrame: Map<number, number> = new Map();     // batch.id -> residencyFrame
  private residencyRestoreQueue: Set<string> = new Set();      // bucket keys awaiting re-upload
  private residencyOverBudgetWarned = false;
  // Cold tier (issue #1682 phase 3b): warm buckets (GPU-evicted, CPU kept)
  // can additionally drop their CPU meshData when a HOST budget is set and a
  // cold-storage provider (v13 cache chunks) can restore it on demand.
  // hot = GPU+CPU, warm = CPU only, cold = metadata shell only.
  private coldProvider: ColdGeometryProvider | null = null;
  private hostBudgetBytes: number | null = null;
  private coldBuckets: Set<string> = new Set();                // CPU dropped, provider-restorable
  private dirtyBuckets: Set<string> = new Set();               // diverged from disk (recolour/move/remove)
  private coldRestoresInFlight: Map<string, Promise<void>> = new Map();
  private hostOverBudgetWarned = false;
  private hostEnforceCountdown = 0;
  // LOD1 builds (issue #1682 phase 5): off unless the app enables them.
  private lodBuildsEnabled = false;
  // 12-byte quantized batch vertices (issue #1682 phase 6): off unless the
  // renderer probed its quantized pipelines and enabled it.
  private quantizedBatchesEnabled = false;
  // True while a (possibly time-sliced) finalize rebuild is running. The
  // preamble clears streamingFragments synchronously, so hasStreamingFragments
  // alone under-reports "still settling" — settle-sensitive consumers
  // (post-load telemetry) must also check this.
  private finalizeInProgress = false;
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
  // sourceBatchKey -> visibility/override epoch its cached partial batch was
  // built for. Lets getOrCreatePartialBatch return the cached clone WITHOUT
  // re-sorting + re-hashing every visible id each frame while the epoch holds
  // (issue: O(elements) per-frame work under hide/isolate). See render loop.
  private partialBatchCacheVersions: Map<string, number> = new Map();

  // Color overlay system for lens coloring — NEVER modifies original batches.
  // Overlay batches render on top using depthCompare 'equal', so they only
  // paint where original geometry already wrote depth. Clearing is instant.
  private overrideBatches: BatchedMesh[] = [];
  // Defensively-typed: the renderer is the sole writer (via setColorOverrides),
  // external readers go through getColorOverrides() and get a ReadonlyMap.
  private colorOverrides: ReadonlyMap<number, readonly [number, number, number, number]> | null = null;
  // Bumped whenever the colour-override set changes. The partial sub-batch's
  // visible subset depends on override promotion (splitVisibleIdsByPromotion),
  // so the render loop folds this into the partial-batch cache epoch to keep the
  // per-frame fast path correct when overrides change with no visibility change.
  private colorOverrideGeneration = 0;

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
   * Enable/disable spatial chunk bucketing (issue #1682 phase 2). When set,
   * colour buckets are additionally partitioned by world grid cell, making
   * batches spatially compact so per-batch frustum/contribution culling
   * fires at chunk granularity. Pure reorganization: same triangles, same
   * shared frame origin, same draw path — only the batch partition changes.
   *
   * Set BEFORE geometry loads. Existing buckets keep their keys (keys are
   * opaque downstream), so flipping mid-model only affects meshes routed
   * afterwards; the next finalize/recolour re-groups stragglers.
   */
  setSpatialChunking(config: SpatialChunkingConfig | null): void {
    if (config && !(Number.isFinite(config.cellSize) && config.cellSize > 0)) {
      console.warn('[Scene] ignoring invalid spatial chunking cellSize:', config.cellSize);
      return;
    }
    this.spatialChunking = config;
  }

  getSpatialChunking(): SpatialChunkingConfig | null {
    return this.spatialChunking;
  }

  // ─── GPU residency (issue #1682 phase 3a) ──────────────────────────────
  // The budget applies to bucket-owned colour/chunk batches (the evictable
  // set). Streaming fragments, partial sub-batches, overlay batches,
  // textured meshes and instanced templates are never evicted: fragments are
  // transient, the rest are small or lack a rebuild source. Enforcement
  // no-ops while geometry is released or in ephemeral streaming mode (no CPU
  // meshData to rebuild from — that is phase 3b's evict-to-disk territory).

  /** Set (or clear) the GPU residency budget in bytes. */
  setGpuResidencyBudget(bytes: number | null): void {
    if (bytes !== null && !(Number.isFinite(bytes) && bytes > 0)) {
      console.warn('[Scene] ignoring invalid GPU residency budget:', bytes);
      return;
    }
    this.gpuBudgetBytes = bytes;
    this.residencyOverBudgetWarned = false;
  }

  getGpuResidencyBudget(): number | null {
    return this.gpuBudgetBytes;
  }

  /** Called once at the start of every Renderer.render() — residency ages
   *  are measured in RENDERED frames, so idle scenes never age out. */
  beginResidencyFrame(): void {
    this.residencyFrame++;
  }

  /** Record that the draw loop drew this batch this frame. */
  recordBatchDrawn(batch: BatchedMesh): void {
    if (this.gpuBudgetBytes === null) return;
    this.lastDrawnFrame.set(batch.id, this.residencyFrame);
  }

  /**
   * The draw loop wants an evicted batch back on the GPU. Queues its bucket
   * for a time-budgeted rebuild in processResidencyRestores (driven by the
   * app's animation loop) — the batch is skipped this frame and pops back in
   * within a frame or two.
   */
  requestBatchResidency(batch: BatchedMesh): void {
    const bucket = this.buckets.get(batch.colorKey);
    if (!bucket || bucket.batchedMesh !== batch) return;
    // Warm (CPU kept) OR cold (disk-restorable) — both are restorable.
    if (bucket.meshData.length > 0 || this.coldBuckets.has(bucket.key)) {
      this.residencyRestoreQueue.add(bucket.key);
    }
  }

  hasResidencyRestoreWork(): boolean {
    return this.residencyRestoreQueue.size > 0;
  }

  /**
   * Rebuild evicted batches from their buckets' CPU meshData, up to
   * `budgetMs` per call (same time-slicing philosophy as flushPending).
   * Returns the number of batches restored.
   */
  processResidencyRestores(device: GPUDevice, pipeline: RenderPipeline, budgetMs: number = 6): number {
    if (this.residencyRestoreQueue.size === 0) return 0;
    const start = performance.now();
    let restored = 0;
    for (const key of this.residencyRestoreQueue) {
      this.residencyRestoreQueue.delete(key);
      const bucket = this.buckets.get(key);
      const old = bucket?.batchedMesh;
      // Only restore a still-evicted bucket batch — a recolour/finalize may
      // have rebuilt (or emptied) it in the meantime.
      if (!bucket || !old || old.gpuResident !== false) continue;
      // Cold bucket: geometry is on disk — kick off the async provider fetch
      // (it re-queues the key as warm when the meshes land).
      if (bucket.meshData.length === 0) {
        if (this.coldBuckets.has(key)) this.startColdRestore(key);
        continue;
      }

      const rebuilt = this.createBatchedMesh(bucket.meshData, bucket.meshData[0].color, device, pipeline, key);
      bucket.batchedMesh = rebuilt;
      const idx = this.batchedMeshes.indexOf(old);
      if (idx >= 0) this.batchedMeshes[idx] = rebuilt;
      else this.batchedMeshes.push(rebuilt);
      this.lastDrawnFrame.delete(old.id);
      // Seed as just-drawn so the budget pass can't evict it before the
      // frame that asked for it gets to draw it.
      this.lastDrawnFrame.set(rebuilt.id, this.residencyFrame);
      restored++;
      if (performance.now() - start >= budgetMs) break;
    }
    return restored;
  }

  // ─── Cold tier (issue #1682 phase 3b) ──────────────────────────────────

  /** Wire the cold-storage source (v13 cache chunks). Null disables the tier. */
  setColdGeometryProvider(provider: ColdGeometryProvider | null): void {
    this.coldProvider = provider;
  }

  /**
   * Enable LOD1 builds (issue #1682 phase 5): bucket batches built from now
   * on (finalize, rebuild, residency restore) get a simplified second index
   * range when it pays. Set BEFORE geometry loads; streaming fragments and
   * partial/overlay sub-batches never build LOD.
   */
  setLodBuildsEnabled(enabled: boolean): void {
    this.lodBuildsEnabled = enabled;
  }

  /**
   * Enable 12-byte lattice-quantized batch vertices (issue #1682 phase 6).
   * ONLY call after the renderer verified its quantized pipeline variants
   * exist (see Renderer.enableQuantizedBatches) — quantized buffers are
   * undrawable without them. Applies to batches built from now on; every
   * createBatchedMesh output (buckets, fragments, partial + override
   * batches) quantizes onto the SAME 2^-10 lattice, so depth-equal overlay
   * matching and cross-batch coincidence are preserved bit-exactly. Batches
   * whose extent exceeds the u16 lattice range fall back to f32 silently.
   */
  setQuantizedBatches(enabled: boolean): void {
    this.quantizedBatchesEnabled = enabled;
  }

  /**
   * Whether THIS mesh's source batch renders quantized — drives the
   * hydrated-mesh lattice snap in createMeshFromData (a mesh whose batch
   * fell back to f32, e.g. >64m extent, must NOT snap). Falls back to the
   * global flag when the mesh isn't bucketed (mid-stream hydration).
   */
  isMeshQuantized(meshData: MeshData): boolean {
    if (!this.quantizedBatchesEnabled) return false;
    const bucket = this.meshDataBucket.get(meshData);
    if (bucket?.batchedMesh) return bucket.batchedMesh.quantized !== undefined;
    return true;
  }

  /** Set (or clear) the HOST budget in bytes for bucket CPU geometry. */
  setHostResidencyBudget(bytes: number | null): void {
    if (bytes !== null && !(Number.isFinite(bytes) && bytes > 0)) {
      console.warn('[Scene] ignoring invalid host residency budget:', bytes);
      return;
    }
    this.hostBudgetBytes = bytes;
    this.hostOverBudgetWarned = false;
  }

  /** CPU bytes held by bucket meshData (positions + normals + indices). */
  getResidentCpuBytes(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      for (const md of bucket.meshData) {
        total += md.positions.byteLength + md.normals.byteLength + md.indices.byteLength;
      }
    }
    return total;
  }

  /** A bucket whose content diverged from what the cache entry holds
   *  (recolour / move / removal) must never be cold-evicted: restoring it
   *  from disk would resurrect the pre-edit geometry. */
  private markBucketDirty(key: string): void {
    this.dirtyBuckets.add(key);
  }

  /**
   * Demote warm buckets (GPU-evicted, CPU kept) to cold (shell only) until
   * bucket CPU bytes fit the host budget. Same LRU policy as the GPU tier.
   * Eligibility is strict: pristine, non-overflow ("#N" sub-buckets are
   * excluded — their piece membership cannot be re-derived unambiguously),
   * GPU-evicted, provider present. Cold eviction removes the bucket's meshes
   * from meshDataMap/meshDataBucket too — that is what actually frees the
   * typed arrays.
   */
  private enforceHostBudget(): void {
    const budget = this.hostBudgetBytes;
    if (budget === null || !this.coldProvider) return;
    if (this.geometryReleased || this.ephemeralStreamingMode) return;
    if (this.streamingFragments.length > 0) return;

    const residentBytes = this.getResidentCpuBytes();
    if (residentBytes <= budget) return;

    const shells: ResidencyShell[] = [];
    for (const bucket of this.buckets.values()) {
      const b = bucket.batchedMesh;
      if (!b || b.gpuResident !== false) continue;             // hot buckets stay warm-skippable
      if (bucket.meshData.length === 0) continue;              // already cold
      if (bucket.key.includes('#')) continue;                  // overflow sub-bucket
      if (this.dirtyBuckets.has(bucket.key)) continue;         // diverged from disk
      // Colour-merged meshes (per-vertex entityIds) are registered in
      // meshDataMap under EVERY contained id; evicting only the primary id's
      // entry would leave the typed arrays reachable (no memory freed) and a
      // later restore would duplicate the object. Ineligible.
      let colorMerged = false;
      let bytes = 0;
      for (const md of bucket.meshData) {
        if (md.entityIds && md.entityIds.length > 0) { colorMerged = true; break; }
        bytes += md.positions.byteLength + md.normals.byteLength + md.indices.byteLength;
      }
      if (colorMerged) continue;
      shells.push({
        key: bucket.key,
        bytes,
        lastDrawnFrame: this.lastDrawnFrame.get(b.id) ?? -1,
      });
    }

    const evictKeys = selectEvictions(shells, residentBytes, budget, this.residencyFrame);
    let evictedBytes = 0;
    for (const key of evictKeys) {
      const bucket = this.buckets.get(key);
      if (!bucket || bucket.meshData.length === 0) continue;
      for (const md of bucket.meshData) {
        evictedBytes += md.positions.byteLength + md.normals.byteLength + md.indices.byteLength;
        this.meshDataBucket.delete(md);
        // Remove THIS object from the entity's piece list (identity match:
        // other pieces of the entity may live in other, still-warm buckets).
        const pieces = this.meshDataMap.get(md.expressId);
        if (pieces) {
          const idx = pieces.indexOf(md);
          if (idx >= 0) pieces.splice(idx, 1);
          if (pieces.length === 0) this.meshDataMap.delete(md.expressId);
        }
      }
      bucket.meshData = [];
      bucket.vertexBytes = 0;
      this.coldBuckets.add(key);
    }

    if (residentBytes - evictedBytes > budget && !this.hostOverBudgetWarned) {
      this.hostOverBudgetWarned = true;
      console.warn(
        `[Scene] host residency budget ${(budget / 1048576).toFixed(0)}MB exceeded ` +
        `(${((residentBytes - evictedBytes) / 1048576).toFixed(0)}MB CPU resident) — ` +
        `remaining buckets are hot, dirty, or overflow sub-buckets. Rendering is unaffected.`
      );
    }
  }

  /**
   * Restore EVERY cold bucket to warm (used before the cold provider goes
   * away, e.g. a federated add invalidates the entry-backed provider while
   * primary chunks are cold — without this they would be stranded shells).
   * Resolves when all in-flight restores settle; failures are logged by the
   * per-bucket restore path and leave those buckets cold.
   */
  async drainColdTier(): Promise<void> {
    if (this.coldBuckets.size === 0) return;
    for (const key of Array.from(this.coldBuckets)) {
      this.startColdRestore(key);
    }
    await Promise.all(Array.from(this.coldRestoresInFlight.values()));
  }

  /** Kick off the async disk restore for a cold bucket the draw loop wants.
   *  On completion the bucket is warm again and re-queued for GPU rebuild. */
  private startColdRestore(key: string): void {
    if (this.geometryReleased || this.ephemeralStreamingMode) return;
    if (this.coldRestoresInFlight.has(key)) return;
    const bucket = this.buckets.get(key);
    const shell = bucket?.batchedMesh;
    const provider = this.coldProvider;
    if (!bucket || !shell || !shell.bounds || !provider) return;

    const promise = provider
      .loadMeshesInBounds(shell.bounds.min, shell.bounds.max)
      .then((meshes) => {
        // Re-validate: a clear()/finalize may have replaced the world.
        const current = this.buckets.get(key);
        if (!current || current !== bucket || !this.coldBuckets.has(key)) return;
        const baseKey = this.baseColorKey(key);
        const idSet = new Set(shell.expressIds);
        const members = meshes.filter(
          (m) => idSet.has(m.expressId) && this.bucketBaseKey(m) === baseKey
        );
        for (const m of members) {
          bucket.meshData.push(m);
          bucket.vertexBytes += (m.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
          this.meshDataBucket.set(m, bucket);
          this.addMeshData(m);
        }
        this.coldBuckets.delete(key);
        if (members.length > 0) {
          // Warm now — re-queue so the next restore tick rebuilds the GPU batch.
          this.residencyRestoreQueue.add(key);
        } else {
          console.warn(`[Scene] cold restore for ${key} found no members — bucket stays a shell`);
        }
      })
      .catch((err) => {
        console.warn('[Scene] cold restore failed (bucket stays cold, will retry on demand):', err);
      })
      .finally(() => {
        this.coldRestoresInFlight.delete(key);
      });
    this.coldRestoresInFlight.set(key, promise);
  }

  /**
   * Synchronously rebuild EVERY evicted bucket batch (no time budget) —
   * for one-shot capture renders (IDS/clash/BCF snapshots) whose isolation
   * options may reveal batches that aged out under the budget. The live
   * view never needs this: visible batches are never evicted. The budget
   * pass re-evicts unused batches after the usual idle age.
   * Returns the number of batches restored.
   */
  restoreAllEvicted(device: GPUDevice, pipeline: RenderPipeline): number {
    if (this.geometryReleased || this.ephemeralStreamingMode) return 0;
    let restored = 0;
    for (const bucket of this.buckets.values()) {
      const old = bucket.batchedMesh;
      if (!old || old.gpuResident !== false || bucket.meshData.length === 0) continue;
      const rebuilt = this.createBatchedMesh(bucket.meshData, bucket.meshData[0].color, device, pipeline, bucket.key);
      bucket.batchedMesh = rebuilt;
      const idx = this.batchedMeshes.indexOf(old);
      if (idx >= 0) this.batchedMeshes[idx] = rebuilt;
      else this.batchedMeshes.push(rebuilt);
      this.lastDrawnFrame.delete(old.id);
      this.lastDrawnFrame.set(rebuilt.id, this.residencyFrame);
      this.residencyRestoreQueue.delete(bucket.key);
      restored++;
    }
    return restored;
  }

  /**
   * Evict least-recently-drawn bucket batches until the resident set fits
   * the budget. Called after each frame's submit; destroying just-submitted
   * buffers is safe (WebGPU defers destruction past in-flight work). Never
   * evicts a batch drawn this frame — a visible set larger than the budget
   * renders correctly and stays over budget (warned once).
   */
  enforceGpuBudget(): void {
    // Host (CPU) tier rides the same post-submit hook on a slow cadence —
    // warm->cold demotion is not latency-sensitive and the CPU-bytes walk is
    // O(total meshes).
    if (this.hostBudgetBytes !== null && --this.hostEnforceCountdown <= 0) {
      this.hostEnforceCountdown = 120;
      this.enforceHostBudget();
    }

    const budget = this.gpuBudgetBytes;
    if (budget === null) return;
    if (this.geometryReleased || this.ephemeralStreamingMode) return;
    // During streaming the batch set churns (fragments + finalize rebuild
    // everything anyway) — start enforcing once the scene is stable.
    if (this.streamingFragments.length > 0) return;

    let residentBytes = 0;
    const shells: ResidencyShell[] = [];
    for (const bucket of this.buckets.values()) {
      const b = bucket.batchedMesh;
      if (!b || b.gpuResident === false) continue;
      const bytes = b.vertexBuffer.size + b.indexBuffer.size + (b.uniformBuffer?.size ?? 0)
        + (b.lod1IndexBuffer?.size ?? 0);
      residentBytes += bytes;
      const lastDrawn = this.lastDrawnFrame.get(b.id) ?? -1;
      if (lastDrawn === this.residencyFrame) continue;      // drawn this frame: not evictable
      if (bucket.meshData.length === 0) continue;           // no rebuild source: keep resident
      shells.push({ key: bucket.key, bytes, lastDrawnFrame: lastDrawn });
    }
    if (residentBytes <= budget) return;

    const evictKeys = selectEvictions(shells, residentBytes, budget, this.residencyFrame);
    let evictedBytes = 0;
    for (const key of evictKeys) {
      const bucket = this.buckets.get(key);
      const batch = bucket?.batchedMesh;
      if (!bucket || !batch || batch.gpuResident === false) continue;
      destroyGpuResources(batch);
      batch.gpuResident = false;
      evictedBytes += batch.vertexBuffer.size + batch.indexBuffer.size + (batch.uniformBuffer?.size ?? 0)
        + (batch.lod1IndexBuffer?.size ?? 0);
      this.lastDrawnFrame.delete(batch.id);
      this.dropPartialCacheForBatch(batch);
    }

    if (residentBytes - evictedBytes > budget && !this.residencyOverBudgetWarned) {
      this.residencyOverBudgetWarned = true;
      console.warn(
        `[Scene] GPU residency budget ${(budget / 1048576).toFixed(0)}MB exceeded by the ` +
        `recently-drawn set (${((residentBytes - evictedBytes) / 1048576).toFixed(0)}MB resident) — ` +
        `nothing old enough to evict. Rendering is unaffected.`
      );
    }
  }

  /** Destroy + drop cached partial sub-batches derived from `batch` (their
   *  sourceBatchKeys embed the batch id, so they are stale once it is
   *  evicted/replaced). */
  private dropPartialCacheForBatch(batch: BatchedMesh): void {
    const prefix = `${batch.colorKey}:${batch.id}`;
    for (const [sourceBatchKey, cacheKey] of this.partialBatchCacheKeys) {
      if (!sourceBatchKey.startsWith(prefix)) continue;
      const cached = this.partialBatchCache.get(cacheKey);
      if (cached) {
        destroyGpuResources(cached);
        this.partialBatchCache.delete(cacheKey);
      }
      this.partialBatchCacheKeys.delete(sourceBatchKey);
      this.partialBatchCacheVersions.delete(sourceBatchKey);
    }
  }

  /** Destroy + drop EVERY cached partial sub-batch. The clones built during
   *  hide/isolate are deliberately excluded from the GPU residency budget and
   *  are otherwise only freed on clear()/finalize/evict — never when filtering
   *  ends. The render loop calls this on the transition back to fully-visible so
   *  the ~model-sized clone VRAM is not pinned until the next model reload. Uses
   *  the same destroy-then-clear idiom as clear(); safe to call between frames
   *  because the previous frame is already submitted (WebGPU defers the free
   *  past in-flight work). */
  dropAllPartialCaches(): void {
    if (this.partialBatchCache.size === 0
        && this.partialBatchCacheKeys.size === 0
        && this.partialBatchCacheVersions.size === 0) {
      return;
    }
    for (const batch of this.partialBatchCache.values()) destroyGpuResources(batch);
    this.partialBatchCache.clear();
    this.partialBatchCacheKeys.clear();
    this.partialBatchCacheVersions.clear();
  }

  /** Free the hydrated (pick / selection-highlight) individual meshes that are
   *  no longer selected, destroying their GPU buffers and dropping them from
   *  `this.meshes`. A mesh is kept iff its expressId is in `keep` AND it
   *  matches `keepModelIndex` (undefined = any model) — the same predicate the
   *  render loop uses to draw selection highlights, so disposal is its exact
   *  complement. The model scoping matters for federation: models can share
   *  express ids, and an id-only check would strand the OTHER model's hydrated
   *  mesh resident and drawing when selection moves across models. Only meshes
   *  flagged `hydrated` are touched — authored geometry added via addMesh()
   *  and batch geometry are left untouched. Returns how many were freed. */
  disposeHydratedMeshesExcept(keep: ReadonlySet<number>, keepModelIndex?: number): number {
    if (this.meshes.length === 0) return 0;
    const kept: Mesh[] = [];
    let disposed = 0;
    for (const mesh of this.meshes) {
      const keepMesh = keep.has(mesh.expressId)
        && (keepModelIndex === undefined || mesh.modelIndex === keepModelIndex);
      if (mesh.hydrated && !keepMesh) {
        destroyGpuResources(mesh);
        disposed++;
      } else {
        kept.push(mesh);
      }
    }
    if (disposed > 0) this.meshes = kept;
    return disposed;
  }

  /**
   * Bucket BASE key for a mesh: colour key, prefixed with the mesh's grid
   * cell when spatial chunking is on. EVERY bucket-key derivation
   * (streaming append, fragment grouping, finalize re-group, recolour move,
   * partial-batch piece filter) must go through this so a mesh always
   * resolves to the same bucket. `color` overrides the mesh's own colour for
   * recolour routing.
   */
  private bucketBaseKey(meshData: MeshData, color?: [number, number, number, number]): string {
    return bucketBaseKeyFor(meshData, this.colorKey(color ?? meshData.color), this.spatialChunking);
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
    if (meshDataArray.some((m) => Scene.hasRenderableTexture(m))) {
      renderable = [];
      for (const meshData of meshDataArray) {
        if (Scene.hasRenderableTexture(meshData)) {
          this.createTexturedMesh(meshData, device, pipeline);
          this.addMeshData(meshData);
        } else {
          renderable.push(meshData);
        }
      }
    }

    // Route each mesh into a size-aware bucket for its color (and, with
    // spatial chunking on, its grid cell)
    for (const meshData of renderable) {
      const baseKey = this.bucketBaseKey(meshData);
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
        // Entity removal diverges the bucket from the cache entry.
        this.markBucketDirty(bucket.key);
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
      this.releaseTexturedMeshTexture(tm);
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
    // Release the contribution-cull exemption BEFORE forgetting the occurrence
    // locations — deleting the map entry first would leak selectedCount and
    // leave the templates permanently uncullable.
    if (this.instancedSelected.has(expressId)) {
      this.bumpTemplateSelectedCount(expressId, -1);
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
  /**
   * Mark a mesh's bucket for rebuild after its positions were mutated in
   * place (move/rotate), migrating it to a new bucket when spatial chunking
   * is on and the mesh crossed a grid-cell boundary. Without the migration
   * the mesh would keep its stale cell key, so the partial-batch piece
   * filter (which re-derives keys from CURRENT positions) would silently
   * drop it under hide/isolate. Same move mechanics as updateMeshColors.
   */
  private rebucketMovedMesh(meshData: MeshData, affectedKeys: Set<string>): void {
    const bucket = this.meshDataBucket.get(meshData);
    if (bucket) {
      affectedKeys.add(bucket.key);
      // Moved geometry diverges from the cache entry — see markBucketDirty.
      this.markBucketDirty(bucket.key);
    }
    if (!this.spatialChunking || !bucket) return;

    const newBaseKey = this.bucketBaseKey(meshData);
    if (this.baseColorKey(bucket.key) === newBaseKey) return;

    const newBucketKey = this.resolveActiveBucket(newBaseKey, meshData);
    this.markBucketDirty(newBucketKey);
    // Swap-remove from the old bucket + decrement its byte accounting
    const idx = bucket.meshData.indexOf(meshData);
    if (idx >= 0) {
      const last = bucket.meshData.length - 1;
      if (idx !== last) bucket.meshData[idx] = bucket.meshData[last];
      bucket.meshData.pop();
    }
    const meshBytes = (meshData.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
    bucket.vertexBytes = Math.max(0, bucket.vertexBytes - meshBytes);
    // Deliberately KEEP an emptied bucket in the map: rebuildPendingBatches
    // destroys its batchedMesh and deletes the shell. Removing it here would
    // orphan the live GPU buffers (rebuild skips keys it can't find).

    // resolveActiveBucket already created the target bucket + tracked bytes
    const newBucket = this.buckets.get(newBucketKey)!;
    newBucket.meshData.push(meshData);
    this.meshDataBucket.set(meshData, newBucket);
    affectedKeys.add(newBucketKey);
  }

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
      this.rebucketMovedMesh(meshData, affectedKeys);
      anyMoved = true;
    }
    if (!anyMoved) return false;

    // #961: a textured mesh's GPU vertex buffer lives outside the colour buckets,
    // so the in-place position translation above won't reach the GPU on its own —
    // re-interleave + re-upload the moved textured parts (paired by expressId,
    // in creation order). Without this a moved textured entity renders stale.
    if (this.texturedDevice && this.texturedMeshes.length > 0) {
      const texturedData = meshDataList.filter((md) => Scene.hasRenderableTexture(md));
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
      const w = this.unionInstancedWorldAabb(
        expressId, dv, occ.byteOffset,
        cpu.localMin[0], cpu.localMin[1], cpu.localMin[2],
        cpu.localMax[0], cpu.localMax[1], cpu.localMax[2],
      );
      // GROW the template's cull union so a moved occurrence (Exploded mode,
      // #1289) can't be frustum/contribution-culled by its pre-move bounds.
      // The pre-move region stays in the union — monotonic growth only ever
      // culls LESS — and translation never changes an occurrence's size, so
      // maxOccRadius needs no update.
      const template = this.instancedTemplates[occ.templateIndex];
      if (template) foldOccurrenceWorldBox(template, w);
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
      this.rebucketMovedMesh(meshData, affectedKeys);
      anyMoved = true;
    }
    if (!anyMoved) return false;

    // #961: textured meshes render from their own GPU vertex buffer — re-upload
    // the rotated parts so they don't render stale (mirrors the translate path).
    if (this.texturedDevice && this.texturedMeshes.length > 0) {
      const texturedData = meshDataList.filter((md) => Scene.hasRenderableTexture(md));
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

  /** True while a finalize rebuild (sync or time-sliced) is mid-flight —
   *  the fragment list is already cleared then, so settle-sensitive callers
   *  must check BOTH this and hasStreamingFragments(). */
  isFinalizeInProgress(): boolean {
    return this.finalizeInProgress;
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
      const chunkEnd = computeFlushChunkEnd(
        (i) => this.meshQueue[i].indices.length,
        this.meshQueueReadIndex,
        hardEnd,
        MAX_INDICES_PER_APPEND,
      );

      // Defensive, not reachable today: chunkEnd is provably > meshQueueReadIndex
      // here because hardEnd is provably > meshQueueReadIndex whenever this outer
      // loop iterates, via three invariants that hold simultaneously above:
      //   (1) this.meshQueue.length > this.meshQueueReadIndex -- the outer while
      //       condition that got us into this iteration;
      //   (2) this.meshQueueReadIndex + MESHES_PER_APPEND, and MESHES_PER_APPEND
      //       (512) is a positive constant;
      //   (3) this.meshQueueReadIndex + (MAX_MESHES_PER_FLUSH - processed), and
      //       processed < MAX_MESHES_PER_FLUSH -- the other half of the outer
      //       while condition -- so that term is >= readIndex + 1 too.
      // hardEnd is the min of all three, so hardEnd >= readIndex + 1, and
      // computeFlushChunkEnd always advances by at least one past readIndex.
      // If a future change breaks any one of those three invariants, hardEnd
      // could collapse to readIndex and the loop would spin the main thread at
      // 100% CPU doing zero allocation -- the exact signature that made #2379
      // expensive to diagnose. This break turns that failure mode into "flush
      // stops early" instead.
      if (chunkEnd === this.meshQueueReadIndex) break;

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

    // Group new meshes by color (and grid cell, when chunking) for efficient
    // fragment batches. Fragments of one mesh share the PARENT's key: they
    // are vertex subsets of the same element, and the mesh-never-splits rule
    // applies to cells exactly like it does to buckets.
    const colorGroups = new Map<string, MeshData[]>();
    for (const meshData of meshDataArray) {
      const key = this.bucketBaseKey(meshData);
      for (const fragment of this.splitMeshForStreaming(meshData)) {
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
    this.finalizeInProgress = true;
    try {
      this.finalizeStreamingInner(device, pipeline);
    } finally {
      this.finalizeInProgress = false;
    }
  }

  private finalizeStreamingInner(device: GPUDevice, pipeline: RenderPipeline): void {
    // Save references to old fragments/batches — keep them rendering
    // until the new proper batches are fully built (no visual gap).
    const oldFragments = this.streamingFragments;
    const oldBatches = this.batchedMeshes;
    const fragmentSet = new Set(oldFragments);
    const oldBatchSet = new Set(oldBatches);
    // Steps 1-4 detach the old drawables (streamingFragments = [],
    // batchedMeshes = []) BEFORE the replacement GPU buffers exist. If a
    // createBuffer fails part-way through, callers that CONTAIN the throw to
    // keep the canvas alive would otherwise be left rendering a half-built —
    // often empty — scene, turning a crash into a silently blank model.
    let rebuilt = false;
    try {
      this.streamingFragments = [];

      // 1. Collect ALL accumulated meshData before clearing state.
      //    Cold buckets (issue #1682 phase 3b) hold NO meshData — their
      //    geometry lives on disk — so they are carried through the rebuild as
      //    sealed shells instead of being re-grouped (re-grouping would
      //    silently drop them).
      const allMeshData: MeshData[] = [];
      const carriedCold: Array<[string, BatchBucket]> = [];
      for (const [key, bucket] of this.buckets) {
        if (this.coldBuckets.has(key) && bucket.meshData.length === 0 && bucket.batchedMesh) {
          carriedCold.push([key, bucket]);
          continue;
        }
        for (const md of bucket.meshData) allMeshData.push(md);
      }

      // 2. Clear all bucket/batch state for a clean rebuild
      // NOTE: batchedMeshes keeps the OLD array reference — the renderer
      // continues to draw from it until we swap in the new array below.
      this.buckets.clear();
      this.meshDataBucket = new Map();
      this.activeBucketKey.clear();
      this.lastDrawnFrame.clear();
      this.residencyRestoreQueue.clear();
      this.pendingBatchKeys.clear();

      // Re-seat the carried cold shells in the fresh bucket map (their GPU
      // shells re-enter the flat array via rebuildPendingBatches below).
      for (const [key, bucket] of carriedCold) this.buckets.set(key, bucket);

      // 3. Re-group ALL meshData by their CURRENT color (and grid cell).
      //    meshData.color may have been mutated in-place since the mesh was
      //    first bucketed, so the original bucket key is stale. Re-grouping
      //    by current color ensures batches render with correct colors.
      for (const meshData of allMeshData) {
        const baseKey = this.bucketBaseKey(meshData);
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
      rebuilt = true;

      // Cached partial (filtered-visibility) batches are keyed by their SOURCE
      // batch, so they only go stale once the replacement batches are live.
      // Dropping them up in step 2 destroyed their GPU resources BEFORE the
      // rebuild could fail, and the rollback cannot bring them back — an active
      // hide/isolate view lost its visible subset and had to recreate it
      // against the very device that just failed. On the failure path they now
      // survive, still matching the restored batches.
      this.dropAllPartialCaches();
    } finally {
      if (!rebuilt) {
        // Free ONLY what this attempt created. Carried cold shells are aliased
        // into BOTH the old and the new array, so anything that was already
        // live before the rebuild must be left alone — destroying it would
        // leave the restored arrays pointing at dead buffers.
        for (const created of this.batchedMeshes) {
          if (!oldBatchSet.has(created) && !fragmentSet.has(created)) {
            destroyGpuResources(created);
          }
        }
        // Step 5 never ran, so every old fragment/batch is still a live GPU
        // resource: putting the arrays back restores exactly what was on
        // screen.
        this.streamingFragments = oldFragments;
        this.batchedMeshes = oldBatches;
      }
    }


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
    // Mark the rebuild as in-flight: the preamble empties streamingFragments
    // synchronously, so settle-sensitive consumers need this flag until the
    // time-sliced rebuild swaps the new batch array in.
    this.finalizeInProgress = true;

    const scene = this;
    const oldFragments = this.streamingFragments;
    const oldBatches = this.batchedMeshes;
    const fragmentSet = new Set(oldFragments);
    const oldBatchSet = new Set(oldBatches);

    // The chunked rebuild spans multiple event-loop turns via setTimeout, so a
    // throw inside a LATER chunk is a distinct macrotask — it does NOT reject
    // the promise below just because that code sits inside its executor (only
    // a SYNCHRONOUS throw during the executor's own call frame does that per
    // spec). Every entry point that can fail — the synchronous preamble AND
    // each chunked continuation — must therefore run under its own try/catch
    // that explicitly calls `reject`, mirroring finalizeStreamingInner's
    // try/finally contract: restore oldFragments/oldBatches, free only what
    // this attempt created, defer dropAllPartialCaches() until success, and
    // always clear finalizeInProgress.
    return new Promise<void>((resolve, reject) => {
      const newBatches: BatchedMesh[] = [];
      // Every batch this attempt creates, paired with the bucket that now owns
      // it and the value it displaced. `newBatches` alone is not enough to roll
      // back: processChunk publishes each batch into `bucket.batchedMesh`, so
      // freeing it without repairing the owner leaves the bucket map pointing
      // at destroyed GPU resources (use-after-free on the next bucket-driven
      // access). `previous` is null for the freshly built buckets and, for a
      // carried COLD bucket a re-grouped meshData landed in, the shell that the
      // restored `batchedMeshes` still holds — which must be put back, not
      // nulled.
      const createdOwned: Array<{ bucket: BatchBucket; previous: BatchedMesh | null; batch: BatchedMesh }> = [];
      let carriedCold: Array<[string, BatchBucket]> = [];
      let pendingKeys: string[] = [];
      let keyIdx = 0;

      function rollback(): void {
        // Free ONLY what this attempt created — carried cold shells and
        // anything already live before the rebuild must be left alone (they
        // are what the restored arrays point back at). Iterating the owned
        // pairs rather than `newBatches` also skips the carried cold shells
        // appended just before the swap, which this attempt did not create.
        for (const { bucket, previous, batch } of createdOwned) {
          // Repair the owner BEFORE the free, so no bucket is ever observable
          // holding a destroyed batch.
          if (bucket.batchedMesh === batch) bucket.batchedMesh = previous;
          if (!oldBatchSet.has(batch) && !fragmentSet.has(batch)) {
            destroyGpuResources(batch);
          }
        }
        scene.streamingFragments = oldFragments;
        scene.batchedMeshes = oldBatches;
        scene.finalizeInProgress = false;
      }

      function processChunk(): void {
        try {
          const chunkStart = performance.now();
          while (keyIdx < pendingKeys.length) {
            const key = pendingKeys[keyIdx++];
            const bucket = scene.buckets.get(key);
            if (!bucket || bucket.meshData.length === 0) {
              scene.buckets.delete(key);
              continue;
            }
            const color = bucket.meshData[0].color;
            const previous = bucket.batchedMesh;
            const batchedMesh = scene.createBatchedMesh(bucket.meshData, color, device, pipeline, key);
            bucket.batchedMesh = batchedMesh;
            createdOwned.push({ bucket, previous, batch: batchedMesh });
            newBatches.push(batchedMesh);

            // Check time budget — yield if exceeded
            if (performance.now() - chunkStart >= budgetMs) {
              setTimeout(processChunk, 0);
              return;
            }
          }

          // Carried cold shells stay drawable-when-restored: keep them in the
          // flat array (their buffers are already destroyed; the draw loop
          // skips gpuResident === false and the restore path revives them).
          for (const [, bucket] of carriedCold) {
            if (bucket.batchedMesh) newBatches.push(bucket.batchedMesh);
          }
          // All batches built — atomic swap so renderer never sees an empty array
          scene.batchedMeshes = newBatches;

          // Cached partial (filtered-visibility) batches are keyed by their
          // SOURCE batch, so they only go stale once the replacement batches
          // are live — dropping them any earlier destroys GPU resources a
          // mid-rebuild failure could never get back (same rationale as
          // finalizeStreamingInner).
          scene.dropAllPartialCaches();

          // Destroy old fragment/batch GPU resources
          for (const fragment of oldFragments) destroyGpuResources(fragment);
          for (const batch of oldBatches) {
            if (!fragmentSet.has(batch)) destroyGpuResources(batch);
          }
          scene.finalizeInProgress = false;
          resolve();
        } catch (err) {
          rollback();
          reject(err);
        }
      }

      try {
        // --- Synchronous preamble (fast O(N) bookkeeping) ---
        scene.streamingFragments = [];

        // 1. Collect ALL accumulated meshData (cold buckets carried as sealed
        //    shells — see the sync finalize for the rationale)
        const allMeshData: MeshData[] = [];
        for (const [key, bucket] of scene.buckets) {
          if (scene.coldBuckets.has(key) && bucket.meshData.length === 0 && bucket.batchedMesh) {
            carriedCold.push([key, bucket]);
            continue;
          }
          for (const md of bucket.meshData) allMeshData.push(md);
        }

        // 2. Clear bucket/batch state. dropAllPartialCaches() is deliberately
        //    NOT called here — see the success path above.
        scene.buckets.clear();
        scene.meshDataBucket = new Map();
        scene.activeBucketKey.clear();
        scene.lastDrawnFrame.clear();
        scene.residencyRestoreQueue.clear();
        scene.pendingBatchKeys.clear();

        // Re-seat the carried cold shells in the fresh bucket map.
        for (const [key, bucket] of carriedCold) scene.buckets.set(key, bucket);

        // 3. Re-group meshData by current color (and grid cell) — fast
        for (const meshData of allMeshData) {
          const baseKey = scene.bucketBaseKey(meshData);
          const bucketKey = scene.resolveActiveBucket(baseKey, meshData);
          let bucket = scene.buckets.get(bucketKey);
          if (!bucket) {
            bucket = { key: bucketKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
            scene.buckets.set(bucketKey, bucket);
          }
          bucket.meshData.push(meshData);
          scene.meshDataBucket.set(meshData, bucket);
          scene.pendingBatchKeys.add(bucketKey);
        }

        // Build new batches into a temporary array so the old batchedMeshes
        // (streaming fragments) keep rendering until the swap is complete.
        pendingKeys = Array.from(scene.pendingBatchKeys);
        scene.pendingBatchKeys.clear();
      } catch (err) {
        rollback();
        reject(err);
        return;
      }

      // --- Async: rebuild batches in time-sliced chunks ---
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
    // selection can continue to work after we discard CPU mesh arrays. An
    // entity with no usable vertex gets NO entry: after release, the keys of
    // `boundingBoxes` become the authoritative id set (`getAllMeshDataExpressIds`),
    // so caching the inverted-empty sentinel here would publish a geometry-less
    // entity to every CPU consumer with a garbage box (#2480).
    for (const [expressId, pieces] of this.meshDataMap) {
      if (this.boundingBoxes.has(expressId)) continue;
      const bbox = worldAabbFromPieces(pieces);
      if (bbox) this.boundingBoxes.set(expressId, bbox);
    }

    this.streamingFragments = [];
    this.buckets.clear();
    this.meshDataBucket = new Map();
    this.meshDataMap.clear();
    // Free the compact instanced template geometry too; the per-occurrence world
    // AABBs already live in boundingBoxes, so bbox-raycast still finds instanced ids.
    this.instancedTemplateCpu = [];
    this.activeBucketKey.clear();
    this.lastDrawnFrame.clear();
    this.residencyRestoreQueue.clear();
    this.coldBuckets.clear();
    this.dirtyBuckets.clear();
    this.pendingBatchKeys.clear();
    this.dropAllPartialCaches();
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

    // 1. Precompute and cache ALL entity bounding boxes before releasing data.
    // Same rule as `finishEphemeralStreaming`: an entity with no usable vertex
    // gets no entry rather than the inverted-empty sentinel (#2480).
    for (const [expressId, pieces] of this.meshDataMap) {
      if (this.boundingBoxes.has(expressId)) continue;
      const bbox = worldAabbFromPieces(pieces);
      if (bbox) this.boundingBoxes.set(expressId, bbox);
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
    this.lastDrawnFrame.clear();
    this.residencyRestoreQueue.clear();
    // Released mode has no restore source at all — drop the cold tier state
    // (the geometryReleased guards stop any further cold activity).
    this.coldBuckets.clear();
    this.dirtyBuckets.clear();

    // 3. Clear partial batch cache (would need mesh data to rebuild)
    this.dropAllPartialCaches();

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

      for (const meshData of meshDataList) {
        // Per-mesh, not per-entity: with spatial chunking the base key
        // carries the mesh's grid cell, which differs between an entity's
        // pieces. A recolour changes the colour part only — the mesh stays
        // in its cell.
        const newBaseKey = this.bucketBaseKey(meshData, newColor);
        // Use reverse-map for O(1) old bucket lookup
        const oldBucket = this.meshDataBucket.get(meshData);
        const oldBucketKey = oldBucket?.key ?? this.bucketBaseKey(meshData);
        // Derive old color from bucket key, NOT meshData.color.
        // meshData.color may have been mutated in-place by external code
        // (applyColorUpdatesToMeshes), making it unreliable for change detection.
        const oldBaseKey = this.baseColorKey(oldBucketKey);

        if (oldBaseKey !== newBaseKey) {
          // Route into the correct (possibly new) bucket for the target color
          const newBucketKey = this.resolveActiveBucket(newBaseKey, meshData);

          affectedOldKeys.add(oldBucketKey);
          affectedNewKeys.add(newBucketKey);
          // Both buckets now diverge from the cache entry: never cold-evict
          // them (a disk restore would resurrect the pre-recolour geometry).
          this.markBucketDirty(oldBucketKey);
          this.markBucketDirty(newBucketKey);

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
            // Do NOT delete an emptied bucket here: it is queued in
            // affectedOldKeys, and rebuildPendingBatches both destroys its
            // batchedMesh GPU buffers and removes the shell. Deleting the
            // map entry early orphaned those buffers (rebuild skips keys it
            // can't resolve) — a GPU memory leak on every recolour that
            // emptied a colour group.
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
    // Parallel to `expressIds` (same index = same source piece) so picking
    // can scope each batch ENTRY to its own model — batches group by colour,
    // not by model, so distinct models sharing an expressId+colour can be
    // co-batched (see BatchedMesh.modelIndices doc).
    const modelIndices = meshDataArray.map(m => m.modelIndex);

    // Create vertex buffer (interleaved positions + normals)
    // Use mappedAtCreation to avoid a separate writeBuffer IPC round-trip
    // (significant win on Chrome/Dawn where each writeBuffer is a Mojo IPC call)
    // Quantized path (issue #1682 phase 6): 12-byte lattice records instead
    // of the 28-byte f32 layout. Falls back to f32 when the batch exceeds
    // the u16 lattice range. Order note: the LOD build further down reads
    // merged.vertexData (the CPU f32 copy) and produces INDICES only, which
    // are valid for either vertex format.
    let quantized: { min: [number, number, number]; step: number } | undefined;
    let vertexBuffer: GPUBuffer;
    const quantizedData = this.quantizedBatchesEnabled
      ? quantizeInterleaved(merged.vertexData, BATCH_CONSTANTS.BYTES_PER_VERTEX / 4)
      : null;
    if (quantizedData) {
      vertexBuffer = device.createBuffer({
        size: Math.max(4, quantizedData.vertexData.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint8Array(vertexBuffer.getMappedRange())
        .set(new Uint8Array(quantizedData.vertexData));
      vertexBuffer.unmap();
      quantized = { min: quantizedData.quantMin, step: quantizedData.step };
    } else {
      vertexBuffer = device.createBuffer({
        size: merged.vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(vertexBuffer.getMappedRange()).set(merged.vertexData);
      vertexBuffer.unmap();
    }

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

    // LOD1 (issue #1682 phase 5): simplified second index range over the SAME
    // vertex buffer. Bucket-owned batches only (`bucketKey` present) — the
    // transient streaming fragments and partial/overlay sub-batches never pay
    // the build. Positions in `merged.vertexData` are relative to the batch
    // origin, which is fine: clustering is translation-invariant as long as
    // the cell size comes from the same-space bounds extent.
    let lod1IndexBuffer: GPUBuffer | undefined;
    let lod1IndexCount: number | undefined;
    if (
      this.lodBuildsEnabled &&
      bucketKey !== undefined &&
      merged.bounds &&
      merged.indices.length >= LOD_MIN_TRIANGLES * 3
    ) {
      const cellSize = lodCellSizeForBounds(merged.bounds.min, merged.bounds.max);
      const lodIndices = simplifyIndicesByClustering(
        merged.vertexData,
        BATCH_CONSTANTS.BYTES_PER_VERTEX / 4,
        merged.indices,
        cellSize,
      );
      if (lodIndices) {
        lod1IndexBuffer = device.createBuffer({
          size: lodIndices.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Uint32Array(lod1IndexBuffer.getMappedRange()).set(lodIndices);
        lod1IndexBuffer.unmap();
        lod1IndexCount = lodIndices.length;
      }
    }

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
      modelIndices,
      // Per-batch local frame: positions are stored relative to this; the draw
      // loop applies model = translate(origin) so they land in world space.
      origin: merged.origin,
      ...(lod1IndexBuffer ? { lod1IndexBuffer, lod1IndexCount } : {}),
      ...(quantized ? { quantized } : {}),
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

    // A COLD bucket is sealed (its content lives on disk and its shell's
    // expressIds are the restore contract) — route new arrivals (e.g. a
    // federated add landing in the same cell+colour) to an overflow
    // sub-bucket instead of corrupting the sealed one.
    if (bucket && this.coldBuckets.has(bucketKey)) {
      bucketKey = `${baseColorKey}#${this.nextSplitId++}`;
      this.activeBucketKey.set(baseColorKey, bucketKey);
      let target = this.buckets.get(bucketKey);
      if (!target) {
        target = { key: bucketKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
        this.buckets.set(bucketKey, target);
      }
      target.vertexBytes += meshBytes;
      return bucketKey;
    }

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
    pipeline: RenderPipeline,
    visibilityEpoch?: number
  ): BatchedMesh | undefined {
    // Cannot create partial batches after geometry data has been released
    if (this.geometryReleased) return undefined;

    // Fast path (PERF): while the visibility + colour-override epoch is
    // unchanged, the visible subset for this sourceBatch is provably identical
    // to what we cached (the source batch is immutable per id and both hide/
    // isolate and override promotion are folded into the epoch). Return the
    // cached clone WITHOUT the O(n) sort + FNV hash below. A rebuilt/evicted
    // source batch gets a new id → new sourceBatchKey → cache miss here.
    if (
      visibilityEpoch !== undefined &&
      this.partialBatchCacheVersions.get(sourceBatchKey) === visibilityEpoch
    ) {
      const key = this.partialBatchCacheKeys.get(sourceBatchKey);
      if (key !== undefined) {
        const cached = this.partialBatchCache.get(key);
        if (cached) return cached;
      }
    }

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
      if (cached) {
        // Record the epoch so subsequent frames take the sort-free fast path.
        if (visibilityEpoch !== undefined) {
          this.partialBatchCacheVersions.set(sourceBatchKey, visibilityEpoch);
        }
        return cached;
      }
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
    // Use the base key (strip "#N" bucket suffix) for piece filtering, since
    // meshData stores the original color, not the bucket key. Pieces are
    // matched through bucketBaseKey so the comparison stays correct with
    // spatial chunking on (base key = "cell~colour" then, and a piece only
    // belongs to this batch when BOTH its cell and colour match).
    const baseKey = this.baseColorKey(colorKey);
    const visibleMeshData: MeshData[] = [];
    for (const expressId of visibleIds) {
      const pieces = this.meshDataMap.get(expressId);
      if (pieces) {
        // Add all pieces for this element
        for (const piece of pieces) {
          // Only include pieces that match this batch's cell + color
          if (this.bucketBaseKey(piece) === baseKey) {
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
    if (visibilityEpoch !== undefined) {
      this.partialBatchCacheVersions.set(sourceBatchKey, visibilityEpoch);
    }

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
    // The override set is changing — invalidate the partial-batch cache epoch so
    // the render loop rebuilds any promotion-split sub-batches (see render loop).
    this.colorOverrideGeneration++;

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
    this.colorOverrideGeneration++;
    this.colorOverrides = null;
    this.setInstancedColorOverrides(null);
  }

  /** Monotonic counter that changes whenever the colour-override set changes.
   *  The render loop folds it into the partial sub-batch cache epoch so the
   *  per-frame fast path stays correct across override changes. */
  getColorOverrideGeneration(): number {
    return this.colorOverrideGeneration;
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
   * GPU bytes currently held by the scene's mesh collections (issue #1682
   * observability). Sums actual `GPUBuffer.size` values across colour batches
   * (streaming fragments are members of `batchedMeshes`, so they are counted
   * exactly once), cached partial sub-batches, hydrated individual meshes,
   * textured meshes (plus a 4 B/texel texture estimate) and instanced
   * templates. Instanced templates are counted even while hidden in the Types
   * view: hiding does not free their buffers. O(collections) walk with no GPU
   * calls, intended for on-demand telemetry, not per-frame use.
   */
  getResidentGpuBytes(): ResidentGpuBytes {
    return sumResidentGpuBytes({
      // Evicted batches are metadata shells — their destroyed buffers still
      // report .size, so they must be excluded from the resident sum.
      batches: this.batchedMeshes.filter((b) => b.gpuResident !== false),
      partialBatches: this.partialBatchCache.values(),
      meshes: this.meshes,
      textured: this.texturedMeshes,
      // Live templates only — freed slots are holes with destroyed buffers.
      instanced: this.liveInstancedTemplates,
    });
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
    return this.liveInstancedTemplates;
  }

  /** Rebuild the compacted live-template view after a slot add/remove. */
  private refreshLiveInstancedTemplates(): void {
    const live: InstancedTemplateGPU[] = [];
    for (const t of this.instancedTemplates) {
      if (t) live.push(t);
    }
    this.liveInstancedTemplates = live;
  }

  /** Model indices that currently own at least one instanced template. Unlike
   *  `getInstancedTemplates()` this ignores the Types-view visibility toggle —
   *  hiding the pass does not change who owns what. */
  getInstancedModelIndices(): number[] {
    const seen = new Set<number>();
    for (const t of this.instancedTemplates) {
      if (t) seen.add(t.modelIndex);
    }
    return [...seen];
  }

  /**
   * Free every instanced template owned by `modelIndex`: destroy exactly its
   * own vertex/index/instance buffers, blank its slots (leaving holes, so no
   * other model's `templateIndex` shifts), prune its occurrences from
   * `instancedEntityMap`, and drop the per-id selection/hidden/override
   * bookkeeping for ids that lost their LAST occurrence. Express ids shared
   * with another model — the federated case before id offsetting — keep the
   * surviving model's occurrences.
   *
   * `boundingBoxes` bookkeeping (#2073): an id that ALSO owns flat geometry is
   * a mixed id — `removeMeshesForEntity` owns that cache, so it is left alone
   * here even when the id's last instanced occurrence is pruned. An
   * instanced-only id that loses its last occurrence has nothing left to keep
   * a cached box for, so its entry is dropped — otherwise bbox-raycast and
   * `getBounds()` (post geometry-release) keep finding/sizing an element that
   * no longer has geometry. An id that keeps SOME occurrences (the shared,
   * federated case) has its box recomputed from just the survivors, not left
   * as the stale union that also covered the freed model's occurrences.
   *
   * Returns the number of templates removed (0 for an unknown model, which is a
   * no-op).
   */
  removeInstancedTemplatesForModel(modelIndex: number): number {
    const freed = new Set<number>();
    for (let i = 0; i < this.instancedTemplates.length; i++) {
      const t = this.instancedTemplates[i];
      if (!t || t.modelIndex !== modelIndex) continue;
      t.vertexBuffer.destroy();
      t.indexBuffer.destroy();
      t.instanceBuffer.destroy();
      this.instancedTemplates[i] = undefined;
      this.instancedTemplateCpu[i] = undefined;
      freed.add(i);
    }
    if (freed.size === 0) return 0;

    for (const [eid, occurrences] of this.instancedEntityMap) {
      const kept = occurrences.filter((o) => !freed.has(o.templateIndex));
      if (kept.length === occurrences.length) continue;
      if (kept.length > 0) {
        this.instancedEntityMap.set(eid, kept);
        // Shared id: some occurrences survive in another model. The cached box
        // is a union that also covered the freed occurrences — recompute it
        // from exactly the survivors rather than leave it oversized.
        this.recomputeInstancedWorldAabb(eid, kept);
        continue;
      }
      // Last occurrence gone: the id is no longer instanced at all.
      this.instancedEntityMap.delete(eid);
      this.instancedSelected.delete(eid);
      this.instancedHidden.delete(eid);
      this.instancedOverridden.delete(eid);
      // Only drop the cached box when the id has no flat geometry either — a
      // mixed id's box is owned by the flat-removal path (removeMeshesForEntity),
      // which clears it on its own schedule.
      if (!this.meshDataMap.has(eid)) {
        this.boundingBoxes.delete(eid);
      }
    }

    this.refreshLiveInstancedTemplates();
    // Occurrence population changed → force the next visibility pass to
    // recompute rather than early-return on an unchanged id set.
    this.lastInstancedVisibilityVersion = -1;
    this.instancedVisibilityDirty = true;
    return freed.size;
  }

  /**
   * Recompute `boundingBoxes[eid]` from exactly `occurrences` (REPLACING any
   * existing entry rather than unioning into it), reading each occurrence's
   * template-local AABB + packed instance matrix the same way
   * `unionInstancedWorldAabb` does at upload time. Used when a model-level
   * template removal (`removeInstancedTemplatesForModel`) prunes some but not
   * all of a shared id's occurrences — a plain union only ever grows, so it
   * cannot shrink to reflect occurrences that no longer exist. Deletes the
   * entry outright if no surviving occurrence has a finite local box (#2073).
   */
  private recomputeInstancedWorldAabb(eid: number, occurrences: InstancedOccurrence[]): void {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let any = false;
    for (const occ of occurrences) {
      const cpu = this.instancedTemplateCpu[occ.templateIndex];
      if (!cpu || !Number.isFinite(cpu.localMin[0])) continue;
      const dv = new DataView(cpu.instanceData);
      const [lmnx, lmny, lmnz] = cpu.localMin;
      const [lmxx, lmxy, lmxz] = cpu.localMax;
      const b = occ.byteOffset;
      const m0 = dv.getFloat32(b + 0, true), m1 = dv.getFloat32(b + 4, true), m2 = dv.getFloat32(b + 8, true);
      const m4 = dv.getFloat32(b + 16, true), m5 = dv.getFloat32(b + 20, true), m6 = dv.getFloat32(b + 24, true);
      const m8 = dv.getFloat32(b + 32, true), m9 = dv.getFloat32(b + 36, true), m10 = dv.getFloat32(b + 40, true);
      const m12 = dv.getFloat32(b + 48, true), m13 = dv.getFloat32(b + 52, true), m14 = dv.getFloat32(b + 56, true);
      for (let c = 0; c < 8; c++) {
        const x = (c & 1) ? lmxx : lmnx, y = (c & 2) ? lmxy : lmny, z = (c & 4) ? lmxz : lmnz;
        const wx = m0 * x + m4 * y + m8 * z + m12;
        const wy = m1 * x + m5 * y + m9 * z + m13;
        const wz = m2 * x + m6 * y + m10 * z + m14;
        if (wx < minX) minX = wx; if (wy < minY) minY = wy; if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx; if (wy > maxY) maxY = wy; if (wz > maxZ) maxZ = wz;
      }
      any = true;
    }
    if (any) {
      this.boundingBoxes.set(eid, { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } });
    } else {
      this.boundingBoxes.delete(eid);
    }
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
  addInstancedShard(device: GPUDevice, shard: DecodedInstancedShard, modelIndex = 0): void {
    this.instancedDevice = device; // cached for per-instance selection/overlay writeBuffer
    const prepared = prepareInstancedRender(shard);
    // Selected ids whose occurrences arrived in THIS shard (selection recorded
    // before the shard streamed in) — their flags are written after upload.
    const lateSelectedEids = new Set<number>();
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

      // Always append: slots are stable identities, never recycled.
      const templateIndex = this.instancedTemplates.length;
      const template: InstancedTemplateGPU = {
        modelIndex,
        vertexBuffer,
        indexBuffer,
        indexCount: t.indices.length,
        instanceBuffer,
        instanceCount: t.instanceCount,
        bounds: null,
        maxOccRadius: 0,
        selectedCount: 0,
      };
      this.instancedTemplates[templateIndex] = template;

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
      // Slot-assigned, not pushed: the CPU array is emptied on geometry release
      // while the GPU slots live on, so `push` would silently misalign the two.
      this.instancedTemplateCpu[templateIndex] = {
        positions: t.positions,
        normals: t.normals,
        indices: t.indices,
        instanceData: t.instanceBuffer,
        localMin: [lmnx, lmny, lmnz],
        localMax: [lmxx, lmxy, lmxz],
      };

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

        // A shard can stream in AFTER a selection was recorded (its ids may
        // exist in earlier shards or the flat path). setInstancedSelection
        // diffs by id and would early-return on the unchanged set, so seed the
        // late occurrences here: count them for the contribution-cull
        // exemption and remember the id to write its selected flag below.
        if (this.instancedSelected.has(eid)) {
          template.selectedCount++;
          lateSelectedEids.add(eid);
        }

        if (haveBox) {
          const w = this.unionInstancedWorldAabb(eid, cdv, byteOffset, lmnx, lmny, lmnz, lmxx, lmxy, lmxz);
          // Fold the occurrence's world box into the template's cull metadata
          // (union bounds + largest occurrence bounding-sphere radius) for the
          // per-frame instanced frustum/contribution culls. Non-finite boxes
          // poison the template so it fails OPEN (never culled).
          foldOccurrenceWorldBox(template, w);
        }
      }
    }
    this.refreshLiveInstancedTemplates();
    // Write the selected flag for ids whose occurrences arrived after the
    // selection was recorded (idempotent for their pre-existing occurrences),
    // so the highlight shows on late-streamed geometry too.
    for (const eid of lateSelectedEids) {
      this.writeInstanceFlags(device, eid);
    }
    // New occurrences default to flags=0 (visible). Force the next setInstancedVisibility
    // to recompute so an already-active isolate/hide also applies to geometry that
    // streamed in after the visibility was set. X-Ray needs the same: new
    // occurrences of an already-ghosted id arrive at their uploaded, solid
    // colour, and the ghost set's membership has not changed to reveal it.
    this.instancedVisibilityDirty = true;
    this.instancedGhostDirty = true;
  }

  /** Transform a template's local AABB by an occurrence's column-major mat4 (read
   *  from the packed instance record at `matOffset`) and union the world box into
   *  boundingBoxes[eid]. Returns the occurrence's world box so the caller can also
   *  fold it into the template's cull metadata. */
  private unionInstancedWorldAabb(
    eid: number,
    dv: DataView,
    matOffset: number,
    lmnx: number, lmny: number, lmnz: number,
    lmxx: number, lmxy: number, lmxz: number,
  ): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
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
    return { minX, minY, minZ, maxX, maxY, maxZ };
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

  /** Number of distinct GPU-instanced entities. O(1) — for size heuristics
   *  (e.g. the orbit-pivot raycast skip) that must not miss instanced-heavy
   *  models where the flat mesh/batch census reads deceptively small. */
  getInstancedEntityCount(): number {
    return this.instancedEntityMap.size;
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
      if (!expressIds.has(eid)) {
        this.writeInstanceFlags(device, eid);
        this.bumpTemplateSelectedCount(eid, -1);
      }
    }
    for (const eid of expressIds) {
      if (!prev.has(eid)) {
        this.writeInstanceFlags(device, eid);
        this.bumpTemplateSelectedCount(eid, +1);
      }
    }
  }

  /** Keep each template's selectedCount in sync with selection flips so the
   *  render loop can exempt templates with selected occurrences from
   *  contribution culling (the highlight must not vanish on the user's focus). */
  private bumpTemplateSelectedCount(eid: number, delta: number): void {
    const occurrences = this.instancedEntityMap.get(eid);
    if (!occurrences) return;
    for (const occ of occurrences) {
      const t = this.instancedTemplates[occ.templateIndex];
      if (t) t.selectedCount = Math.max(0, t.selectedCount + delta);
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
    // Called every render frame. Change detection is by CONTENT (the tracker
    // snapshot-compares), matching the RenderOptions.hiddenIds contract: an
    // in-place mutation of the caller's Set is seen, a fresh identical Set is
    // not treated as a change, and the O(occurrences) rebuild below still only
    // runs on a real visibility change (orbit stays cheap). The dirty flag
    // forces a recompute after a new shard adds occurrences mid-stream, so an
    // active isolate/hide also applies to geometry that streams in afterwards.
    const visibilityVersion = this.instancedVisibilityEpochs.update(hiddenIds, isolatedIds);
    if (
      !this.instancedVisibilityDirty &&
      visibilityVersion === this.lastInstancedVisibilityVersion
    ) {
      return;
    }
    this.instancedVisibilityDirty = false;
    this.lastInstancedVisibilityVersion = visibilityVersion;
    // Recompute the effective hidden set over all instanced occurrences and diff vs
    // the current one; only flips touch the GPU buffer.
    const next = new Set<number>();
    for (const eid of this.instancedEntityMap.keys()) {
      if (!isEntityVisible(eid, hiddenIds, isolatedIds)) next.add(eid);
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
      // An occurrence that is currently ghosted keeps the ghost alpha: X-Ray is
      // a stronger statement about visibility than a lens tint, and the flat
      // path resolves the same way.
      const ghosted = this.instancedGhosted.has(eid);
      this.writeInstanceColor(device, eid, ghosted ? [rgba[0], rgba[1], rgba[2], this.lastGhostAlpha] : rgba);
      // Instanced occurrences are opaque by partition; only an override can drop alpha
      // below the cutoff (lens-ghost / x-ray / compare). Track it so the renderer runs
      // the transparent instanced sub-pass only when something is actually translucent.
      if (rgba[3] < OPAQUE_ALPHA_CUTOFF) hasTransparent = true;
    }
    this.instancedOverridden = new Set(next.keys());
    this.instancedOverrideColors = next.size > 0 ? next : null;
    this.instancedHasTransparent = hasTransparent;
    // Restoring a dropped override writes FULL alpha, which un-fades a ghosted
    // occurrence. The ghost set has not changed, so only this flag gets the
    // fade re-applied on the next frame.
    this.instancedGhostDirty = true;
  }

  /** True when an active colour override made some instanced occurrence translucent,
   *  so the renderer should run the transparent instanced sub-pass. */
  hasTransparentInstances(): boolean {
    return this.instancedHasTransparent || this.instancedGhostTransparent;
  }

  /**
   * Per-instance X-RAY GHOSTING: fade every instanced occurrence outside
   * `ghostExceptIds` to `ghostAlpha`, leaving the excepted set and the current
   * selection solid.
   *
   * The instanced pass used to receive only the hide and isolate sets, so
   * ghosting stopped at the flat geometry: on a model whose facade is
   * instanced, X-Ray left a solid facade in front of a ghosted interior
   * (#2606). The Cesium world view had already started doing this correctly
   * (#2591), which is what surfaced the gap.
   *
   * Composes with colour overrides instead of clobbering them: a ghosted
   * occurrence keeps its override's RGB and takes the ghost alpha, and
   * restoring re-applies the override rather than the original colour. The two
   * channels share the instance colour bytes, so whichever wrote last would
   * otherwise win.
   *
   * `ghostExceptIds == null` means no X-Ray: everything ghosted is restored.
   */
  setInstancedGhosting(
    ghostExceptIds: ReadonlySet<number> | null | undefined,
    selectedIds: ReadonlySet<number> | null | undefined,
    ghostAlpha: number,
  ): void {
    const device = this.instancedDevice;
    if (!device || this.instancedTemplates.length === 0) return;

    const { next, toFade, toRestore, changed } = planInstancedGhosting({
      ghostExceptIds,
      selectedIds,
      instancedIds: this.instancedEntityMap.keys(),
      current: this.instancedGhosted,
      ghostAlpha,
      lastGhostAlpha: this.lastGhostAlpha,
      dirty: this.instancedGhostDirty,
    });
    if (!changed) return;

    for (const eid of toRestore) {
      // Back to whatever owns the colour now: an override if one is active,
      // otherwise the occurrence's baked colour.
      const override = this.instancedOverrideColors?.get(eid);
      if (override) this.writeInstanceColor(device, eid, override);
      else this.restoreInstanceColor(device, eid);
    }

    for (const eid of toFade) {
      const base = this.instancedOverrideColors?.get(eid) ?? this.originalInstanceColor(eid);
      if (!base) continue;
      this.writeInstanceColor(device, eid, [base[0], base[1], base[2], ghostAlpha]);
    }

    this.instancedGhosted = next;
    this.lastGhostAlpha = ghostAlpha;
    this.instancedGhostDirty = false;
    this.instancedGhostTransparent = next.size > 0 && ghostAlpha < OPAQUE_ALPHA_CUTOFF;
  }

  /** The colour an occurrence was uploaded with, before any override or ghost. */
  private originalInstanceColor(eid: number): readonly [number, number, number, number] | null {
    const locs = this.instancedEntityMap.get(eid);
    const first = locs?.[0];
    return first ? first.originalColor : null;
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
  /** True when the mesh can render through the textured pipeline: UVs plus
   *  either a Rust-decoded image (#961) or a viewer-resolved ImageBitmap for
   *  an external `IfcImageTexture` reference (#1781). A `textureRef` whose
   *  image was NOT resolved (missing zip sibling) renders as ordinary
   *  flat-colour geometry instead. */
  private static hasRenderableTexture(meshData: MeshData): boolean {
    return Boolean(meshData.uvs) &&
      Boolean(meshData.texture || (meshData.textureRef && meshData.textureBitmap));
  }

  /**
   * Interleave a textured mesh's vertices into the stride-36 layout
   * `[px,py,pz, nx,ny,nz, entityId(u32), u,v]`. Shared by initial upload and
   * the translate re-upload so the two can't drift. Returns null when the mesh
   * has no texture/uvs/geometry.
   */
  private interleaveTexturedVertices(meshData: MeshData): ArrayBuffer | null {
    const uvs = meshData.uvs;
    if (!Scene.hasRenderableTexture(meshData) || !uvs) return null;
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
    const ref = meshData.textureRef;
    const bitmap = meshData.textureBitmap;
    const interleaved = this.interleaveTexturedVertices(meshData);
    if (!interleaved || !(tex || (ref && bitmap))) return;
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

    let texture: GPUTexture;
    let sharedTextureKey: number | undefined;
    if (tex) {
      // #961: upload the Rust-decoded RGBA8 verbatim — no image decoding in JS.
      texture = device.createTexture({
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
    } else {
      // #1781: external image texture — the viewer decoded the `.ifcZIP`
      // sibling to an ImageBitmap once per textureId; upload it ONCE and share
      // the GPU texture across every mesh sampling it (real files map one
      // 4096² image from dozens of face sets — per-mesh copies would be GBs).
      const refKey = ref!.textureId;
      const bmp = bitmap!;
      let entry = this.sharedTextures.get(refKey);
      if (!entry) {
        const gpuTex = device.createTexture({
          size: { width: bmp.width, height: bmp.height },
          format: 'rgba8unorm',
          // RENDER_ATTACHMENT is required by copyExternalImageToTexture.
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture(
          { source: bmp },
          { texture: gpuTex },
          { width: bmp.width, height: bmp.height },
        );
        entry = { texture: gpuTex, refs: 0 };
        this.sharedTextures.set(refKey, entry);
      }
      entry.refs++;
      texture = entry.texture;
      sharedTextureKey = refKey;
    }

    const repeatS = tex ? tex.repeatS : ref!.repeatS;
    const repeatT = tex ? tex.repeatT : ref!.repeatT;
    const wrap = (repeat: boolean): GPUAddressMode => (repeat ? 'repeat' : 'clamp-to-edge');
    const sampler = device.createSampler({
      addressModeU: wrap(repeatS),
      addressModeV: wrap(repeatT),
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
      // `world = origin + position` (#1973). Absent on the orphan
      // type-geometry path, whose positions are already absolute.
      origin: meshData.origin
        ? [meshData.origin[0], meshData.origin[1], meshData.origin[2]]
        : [0, 0, 0],
      ...(sharedTextureKey !== undefined ? { sharedTextureKey } : {}),
    });
  }

  /** Release a textured mesh's GPU texture: shared (#1781) entries decrement
   *  the registry refcount and die with their LAST reference; per-mesh (#961)
   *  uploads are destroyed outright. */
  private releaseTexturedMeshTexture(tm: TexturedMesh): void {
    if (tm.sharedTextureKey === undefined) {
      tm.texture.destroy();
      return;
    }
    const entry = this.sharedTextures.get(tm.sharedTextureKey);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      entry.texture.destroy();
      this.sharedTextures.delete(tm.sharedTextureKey);
    }
  }

  /**
   * Destroy every GPU-instanced template's buffers and reset all instanced
   * bookkeeping, regardless of owning model. Shared by `clear()` (full reset)
   * — `clearFlatGeometry()` deliberately does NOT call this, so a reshape
   * that still has models present can retain their instanced geometry
   * (#2073).
   */
  private destroyAllInstancedTemplates(): void {
    for (const it of this.instancedTemplates) {
      if (!it) continue;
      it.vertexBuffer.destroy();
      it.indexBuffer.destroy();
      it.instanceBuffer.destroy();
    }
    this.instancedTemplates = [];
    this.liveInstancedTemplates = [];
    this.instancedTemplateCpu = [];
    this.instancedEntityMap.clear();
    this.instancedSelected.clear();
    this.instancedHidden.clear();
    this.instancedOverridden.clear();
    this.instancedGhosted.clear();
    this.instancedGhostDirty = false;
    this.instancedOverrideColors = null;
    this.instancedHasTransparent = false;
    this.instancedGhostTransparent = false;
    // Force the next setInstancedVisibility to recompute against fresh state.
    this.lastInstancedVisibilityVersion = -1;
    this.instancedVisibilityDirty = false;
    this.instancedDevice = undefined;
  }

  clear(): void {
    // GPU-instancing templates own their vertex/index/instance buffers.
    // (Freed slots are holes whose buffers are already destroyed — skip them so
    // a per-model removal followed by clear() can't double-destroy.)
    this.destroyAllInstancedTemplates();
    this.clearFlatGeometry();
  }

  /**
   * Clear flat/batched geometry (meshes, batches, buckets, textured meshes,
   * colour overlays, streaming state, residency bookkeeping) WITHOUT
   * touching GPU-instanced templates (#2073). A reshape that still has at
   * least one model present should call this instead of `clear()`, then
   * reconcile instanced ownership with `removeInstancedTemplatesForModel`
   * for any model that did NOT survive — that way a still-loaded model's
   * repeated geometry (windows, doors, bolts, ...) stays resident across a
   * visibility toggle / in-place content mutation / federated model add
   * instead of silently vanishing (nothing re-uploads instanced shard bytes
   * after their one-time drain).
   *
   * Bounding boxes are only dropped for ids with NO surviving instanced
   * occurrence — an instanced-only id's box must outlive this call so
   * raycast / measure / section keep working for the geometry that was
   * just retained; a flat-only id's box is stale the moment its mesh data
   * is gone, so it is dropped like everything else here.
   */
  clearFlatGeometry(): void {
    for (const mesh of this.meshes) destroyGpuResources(mesh);
    for (const batch of this.batchedMeshes) destroyGpuResources(batch);
    for (const tm of this.texturedMeshes) {
      tm.vertexBuffer.destroy();
      tm.indexBuffer.destroy();
      tm.uniformBuffer.destroy();
      this.releaseTexturedMeshTexture(tm);
    }
    this.texturedMeshes = [];
    // Belt-and-braces: refcounting above should have emptied the registry;
    // destroy any straggler so clear() can never leak a shared GPU texture.
    for (const entry of this.sharedTextures.values()) entry.texture.destroy();
    this.sharedTextures.clear();
    // Clear partial batch cache (destroys buffers + drops all cache maps)
    this.dropAllPartialCaches();
    this.colorOverrideGeneration++;
    // Destroy streaming fragments (already included in batchedMeshes, but tracked separately)
    this.streamingFragments = [];
    this.destroyOverrideBatches();
    this.colorOverrides = null;
    // Reset the shared frame origin so the next model picks its own. Retained
    // instanced templates are unaffected — their per-occurrence transforms are
    // already baked to absolute world coordinates at upload time, not relative
    // to this origin.
    this.sharedFrameOrigin = null;
    this.meshes = [];
    this.batchedMeshes = [];
    this.buckets.clear();
    this.meshDataBucket = new Map();
    this.meshDataMap.clear();
    for (const eid of [...this.boundingBoxes.keys()]) {
      if (!this.instancedEntityMap.has(eid)) {
        this.boundingBoxes.delete(eid);
      }
    }
    this.activeBucketKey.clear();
    this.lastDrawnFrame.clear();
    this.residencyRestoreQueue.clear();
    this.coldBuckets.clear();
    this.dirtyBuckets.clear();
    this.cachedMaxBufferSize = 0;
    this.pendingBatchKeys.clear();
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

    // Compute from mesh data. `null` covers both "no pieces at all" and
    // "pieces with no vertex a box can be built from" — and, critically, is
    // NOT cached (#2480): a transient empty piece must not poison the entry
    // for an entity that later gains real geometry, and this cache has no
    // invalidation tied to that.
    const bbox = worldAabbFromPieces(this.meshDataMap.get(expressId));
    if (!bbox) return null;
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
        if (!isEntityVisible(eid, hiddenIds, isolatedIds)) continue;
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

  /**
   * CPU rectangle selection — the rect counterpart of {@link Scene.raycast}.
   *
   * Used by the pick path when the GPU rect pass cannot see the geometry:
   * either JS geometry data was released, or hydrating an individual mesh per
   * visible piece would blow the pick-mesh budget. Without it, rectangle
   * select silently returned nothing on batched models (#1904).
   *
   * Bounding-box granularity, the same fidelity the released-geometry raycast
   * path has. Unlike that path it runs no depth test at all, so an entity fully
   * hidden behind another is still selected. Instanced-only occurrences are
   * covered: their world AABBs are registered in `boundingBoxes` when the
   * instanced shard is built.
   */
  selectRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    viewportWidth: number,
    viewportHeight: number,
    viewProj: Float32Array,
    hiddenIds?: Set<number>,
    isolatedIds?: Set<number> | null,
    clip?: PickClipState | null,
  ): Set<number> {
    // After release the cache is already the complete set; before it, boxes are
    // computed lazily, so make sure every entity that still has mesh data has
    // one. Same authoritative id set pick() uses, so colour-fused fillers whose
    // id lives only in per-vertex entityIds are not skipped (#1358).
    // Cost shape: `getEntityBoundingBox` walks every vertex of an entity on a
    // miss and memoises into `boundingBoxes`, so the scan is O(total vertices)
    // but one-time — it is the same cache the CPU raycast path warms, and every
    // later drag only pays the O(entities) box loop below. Earlier picks do not
    // necessarily prime all of it, though: the raycast path applies the
    // hiddenIds/isolatedIds filters *before* it calls getEntityBoundingBox (see
    // raycastTriangles in scene-raycaster.ts), so under isolation the first
    // Ctrl+drag can still scan entities no click ever reached.
    if (!this.geometryReleased) {
      for (const expressId of this.getAllMeshDataExpressIds()) {
        this.getEntityBoundingBox(expressId);
      }
    }

    return selectBoundingBoxesInRect(
      this.boundingBoxes,
      viewProj,
      { x0, y0, x1, y1 },
      viewportWidth,
      viewportHeight,
      hiddenIds,
      isolatedIds,
      clip,
    );
  }
}
