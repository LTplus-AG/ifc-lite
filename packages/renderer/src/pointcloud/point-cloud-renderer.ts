/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { assertModelTranslation } from '../model-translation.js';

/**
 * Manages point cloud assets in the renderer.
 *
 * Supports two ingest modes:
 *   - One-shot: `addAsset(asset)` for inline IFCx pointclouds.
 *   - Streaming: `beginAsset(meta) → handle`, `appendChunk(handle, chunk)`,
 *     `endAsset(handle)` for LAS/LAZ files arriving in chunks.
 *
 * The renderer owns the pipeline, per-asset GPU resources, and the per-frame
 * draw call. Designed to slot into the existing `Renderer.render()` so points
 * share the depth buffer and section-plane state with triangle meshes.
 */

import type { PointCloudAsset } from '@ifc-lite/geometry';
import { PointCloudHandleIds } from './point-cloud-handle-ids.js';
import { PointCloudPlacements, unionPointCloudBounds } from './point-cloud-placement.js';
import { PointCloudVisibility } from './point-cloud-visibility.js';
import { PointRenderPipeline, POINT_QUAD_VERTS, POINT_UNIFORM_SIZE } from './point-pipeline.js';
import {
  appendChunkToNode,
  createNode,
  destroyNode, clearOwnedPointCloudNodes,
  uploadAssetToGpu,
  type PointCloudChunkInput,
  type PointCloudNode,
  type PointCloudNodeMeta,
} from './point-cloud-node.js';
import type { PointCloudSpatialIndex } from './point-cloud-spatial-index.js';
import { buildPickNodeSources, resolvePickedAsset } from './point-cloud-pick-sources.js';
import { buildRayQuerySources } from './point-cloud-ray-transform.js';
import {
  normalizeClassMask,
  writePointCloudUniforms,
  type PointColorMode,
  type PointSizeMode,
} from './point-cloud-uniforms.js';
import type { RelativeToEyeFrame } from '../relative-to-eye.js';
import type { ClipBox } from '../types.js';

export interface ResolvedSectionPlane {
  normal: [number, number, number];
  distance: number;
  enabled: boolean;
  flipped?: boolean;
}

export type { PointColorMode, PointSizeMode };

/**
 * How to size a splat on screen.
 *   - `fixed-px`        every splat is `pointSize` pixels wide
 *   - `adaptive-world`  splat covers `worldRadius` metres in source space,
 *                       projected each frame (closer → bigger)
 *   - `attenuated`      adaptive but clamped between 1 px and `pointSize`
 *                       so splats stay visible at the far plane and don't
 *                       blow up to half the screen when you nose into the
 *                       cloud — usually the best default for nav.
 */

export interface PointCloudDrawState {
  /** column-major view-projection matrix (16 floats) */
  viewProj: Float32Array;
  /** Shared RTE camera frame; point paths may not derive another rebase. */
  relativeToEyeFrame: RelativeToEyeFrame;
  /** Section plane resolved by the main render path. */
  sectionPlane?: ResolvedSectionPlane | null;
  /** Main mesh crop box, packed in the same RTE camera frame. */
  clipBox?: ClipBox | null;
  /** Viewport pixels for splat shader clip-space offsets. */
  viewport?: { width: number; height: number };
}

export interface PointCloudRenderOptions {
  /** How to color points each frame. Defaults to 'rgb'. */
  colorMode?: PointColorMode;
  /** RGBA in 0..1, used when colorMode === 'fixed'. */
  fixedColor?: [number, number, number, number];
  /** Splat size in pixels (mode='fixed-px'/'attenuated') or maximum size cap. */
  pointSize?: number;
  /** Splat sizing strategy. Defaults to `attenuated`. */
  sizeMode?: PointSizeMode;
  /** World-space splat radius in metres for adaptive / attenuated modes.
   *  Defaults to 0.02 m which works well for typical 5–20 mm scan spacing. */
  worldRadius?: number;
  /** Render splats as discs instead of squares. Defaults to true. */
  roundShape?: boolean;
  /**
   * Per-LAS-class visibility bitmask covering the full 0..255 code
   * range (#1783). Bit `i % 32` of word `i / 32` set → class `i` is
   * visible. Pass up to 8 u32 words LSB-first (missing words default
   * to all-visible), or a plain `number` for the legacy 32-bit form
   * (classes 32..255 stay visible). Defaults to everything visible.
   * Only affects points carrying classifications; meshes ignore it.
   */
  classMask?: number | ArrayLike<number>;
  /**
   * Stride-cull factor for the splat shader: 1 = render every point,
   * 2 = every other, 4 = every fourth, etc. Used by the section-plane
   * preview path so dragging a slider over a 100M-point scan stays
   * responsive — UI flips this to e.g. 4 on drag start and back to 1
   * on drag end. Default 1.
   */
  previewStride?: number;
  /**
   * BIM↔scan deviation heatmap range. `centerOffset` shifts the
   * "white" point off zero (handy when a scan has a global offset
   * from the model); `halfRange` is the metres mapped to ±1 on the
   * blue→white→red ramp. Defaults to (0, 0.05) → ±5cm.
   * Only consulted when `colorMode === 'deviation'`.
   */
  deviationRange?: { centerOffset: number; halfRange: number };
}

export interface PointCloudAssetHandle {
  readonly id: number;
}

/**
 * `PointCloudRenderOptions` with every field present and `classMask`
 * normalized to the 8-word uniform layout.
 */
export type ResolvedPointCloudRenderOptions =
  Omit<Required<PointCloudRenderOptions>, 'classMask'> & { classMask: Uint32Array };

/**
 * Owner of a point cloud node — drives whether `setAssets` clears it.
 *
 * `'ifcx'` nodes are replaced wholesale every time `setAssets` runs (the
 * IFCx ingest is declarative — an array of assets in, the renderer mirrors
 * it). `'streamed'` nodes are managed individually via beginAsset /
 * appendChunk / endAsset and survive `setAssets` calls so a streamed
 * scan can coexist with IFCx mesh selection updates.
 */
type NodeOwner = 'ifcx' | 'streamed';

export class PointCloudRenderer {
  private device: GPUDevice;
  private pipeline: PointRenderPipeline;
  private placements = new PointCloudPlacements();
  private modelTranslations = new Map<number, readonly [number, number, number]>();
  private nodes = new Map<number, PointCloudNode>();
  private nodeOwners = new Map<number, NodeOwner>();
  private readonly visibility = new PointCloudVisibility();
  readonly handleIds: PointCloudHandleIds;
  private uniformScratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
  private uniformScratchU32 = new Uint32Array(this.uniformScratch.buffer);
  private options: ResolvedPointCloudRenderOptions = {
    colorMode: 'rgb',
    fixedColor: [1, 1, 1, 1],
    pointSize: 4,
    sizeMode: 'attenuated',
    worldRadius: 0.02,
    roundShape: true,
    classMask: normalizeClassMask(undefined),
    previewStride: 1,
    deviationRange: { centerOffset: 0, halfRange: 0.05 },
  };

  constructor(
    device: GPUDevice,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    sampleCount: number,
    startHandleId = 1, // see PointCloudHandleIds — Renderer.teardown() passes its watermark here
  ) {
    this.device = device;
    this.pipeline = new PointRenderPipeline(device, colorFormat, depthFormat, sampleCount);
    this.handleIds = new PointCloudHandleIds(startHandleId);
  }

  setOptions(opts: PointCloudRenderOptions): void {
    if (opts.colorMode !== undefined) this.options.colorMode = opts.colorMode;
    if (opts.fixedColor !== undefined) this.options.fixedColor = opts.fixedColor;
    if (opts.pointSize !== undefined) this.options.pointSize = opts.pointSize;
    if (opts.sizeMode !== undefined) this.options.sizeMode = opts.sizeMode;
    if (opts.worldRadius !== undefined) this.options.worldRadius = opts.worldRadius;
    if (opts.roundShape !== undefined) this.options.roundShape = opts.roundShape;
    if (opts.classMask !== undefined) this.options.classMask = normalizeClassMask(opts.classMask);
    if (opts.previewStride !== undefined) {
      // Clamp to a sane positive integer — stride 0 would divide by
      // zero in the shader's modulo. >256 is silly but harmless.
      const s = Math.max(1, Math.min(256, Math.floor(opts.previewStride) || 1));
      this.options.previewStride = s;
    }
    if (opts.deviationRange !== undefined) {
      const r = opts.deviationRange;
      this.options.deviationRange = {
        centerOffset: Number.isFinite(r.centerOffset) ? r.centerOffset : 0,
        // halfRange = 0 would divide by zero in the shader; clamp to
        // a tiny positive value so dragging the slider to the floor
        // doesn't NaN the colour.
        halfRange: Number.isFinite(r.halfRange) && r.halfRange > 0 ? r.halfRange : 1e-6,
      };
    }
  }

  getOptions(): Readonly<ResolvedPointCloudRenderOptions> {
    // Snapshot the mask so callers cannot mutate visibility outside setOptions.
    return { ...this.options, classMask: this.options.classMask.slice() };
  }

  // ─── one-shot API (IFCx) ──────────────────────────────────────────────────

  /**
   * Replace every IFCx-owned asset with `assets`. Streamed assets are
   * untouched. Use this from the viewer's IFCx sync hook.
   */
  setAssets(assets: ReadonlyArray<PointCloudAsset>): void {
    this.clearOwner('ifcx');
    for (const asset of assets) {
      if (asset.chunk.pointCount === 0) continue; // streamed identity descriptors carry no geometry
      this.addAsset(asset);
    }
  }

  addAsset(asset: PointCloudAsset): PointCloudAssetHandle {
    const node = uploadAssetToGpu(this.device, this.pipeline, asset);
    const id = this.handleIds.allocate();
    this.nodes.set(id, node);
    this.nodeOwners.set(id, 'ifcx');
    this.visibility.add(id);
    this.placements.translate(node, this.modelTranslations.get(asset.modelIndex ?? 0) ?? [0, 0, 0]);
    return { id };
  }

  // ─── streaming API (LAS / LAZ) ────────────────────────────────────────────

  /** Open an empty asset that chunks will be appended to. */
  beginAsset(meta: PointCloudNodeMeta): PointCloudAssetHandle {
    const node = createNode(this.device, this.pipeline, meta);
    const id = this.handleIds.allocate();
    this.nodes.set(id, node);
    this.nodeOwners.set(id, 'streamed');
    this.visibility.add(id);
    return { id };
  }

  appendChunk(handle: PointCloudAssetHandle, chunk: PointCloudChunkInput): void {
    const node = this.nodes.get(handle.id);
    if (!node) {
      console.warn(`[PointCloudRenderer] appendChunk: no node for handle ${handle.id}`);
      return;
    }
    appendChunkToNode(this.device, node, chunk);
  }

  /** Mark streaming complete. No-op for now — kept for symmetry. */
  endAsset(handle: PointCloudAssetHandle): void {
    void handle;
  }

  removeAsset(handle: PointCloudAssetHandle): void {
    const node = this.nodes.get(handle.id);
    if (!node) return;
    destroyNode(node);
    this.nodes.delete(handle.id);
    this.nodeOwners.delete(handle.id);
    this.visibility.remove(handle.id);
  }

  /**
   * Reassign a streamed asset's `expressId` after upload — used by
   * `useIfcFederation` when the FederationRegistry hands out an
   * `idOffset` for the model. The shader reads expressId from a
   * per-asset uniform (flags.x), so this is just a metadata update;
   * the next frame writes the new value into the GPU uniform without
   * touching the per-vertex attributes.
   */
  relabelAsset(handle: PointCloudAssetHandle, newExpressId: number): void {
    const node = this.nodes.get(handle.id);
    if (!node) return;
    node.meta.expressId = newExpressId >>> 0;
  }

  /** Import alignment composes with manual placement without reuploading points. */
  setAssetTransform(handle: PointCloudAssetHandle, matrix: Float32Array | Float64Array | null): void {
    const node = this.nodes.get(handle.id);
    if (!node) return;
    this.placements.align(node, matrix);
  }

  setAssetTranslation(handle: PointCloudAssetHandle, translation: readonly [number, number, number]): void {
    const node = this.nodes.get(handle.id);
    if (node) this.placements.translate(node, translation);
  }

  /** Hide a resident asset from rendering and both point-cloud pick paths. */
  setAssetVisible(handle: PointCloudAssetHandle, visible: boolean): boolean { return this.visibility.set(handle.id, visible, this.nodes.has(handle.id)); }

  validateModelTranslation(modelIndex: number, translation: readonly [number, number, number]): void {
    assertModelTranslation(modelIndex, translation);
    for (const [id, node] of this.nodes) if (this.nodeOwners.get(id) === 'ifcx' && (node.meta.modelIndex ?? 0) === modelIndex) {
      this.placements.validateTranslation(node, translation);
    }
  }

  setModelTranslation(modelIndex: number, translation: readonly [number, number, number]): void {
    this.validateModelTranslation(modelIndex, translation);
    this.modelTranslations.set(modelIndex, [...translation]);
    for (const [id, node] of this.nodes) {
      if (this.nodeOwners.get(id) === 'ifcx' && (node.meta.modelIndex ?? 0) === modelIndex) {
        this.placements.translate(node, translation);
      }
    }
  }

  getAssetTransform(handle: PointCloudAssetHandle): Float32Array | undefined { const matrix = this.nodes.get(handle.id)?.model; return matrix ? new Float32Array(matrix) : undefined; }

  getPlacementBounds(modelIndex: number, handle?: PointCloudAssetHandle) {
    // Model-specific framing must obey whole-scene visibility: a hidden scan cannot move the camera.
    const nodes = handle
      ? this.visibility.visible(handle.id) ? [this.nodes.get(handle.id)] : []
      : [...this.nodes].filter(([id, node]) => this.visibility.visible(id)
        && this.nodeOwners.get(id) === 'ifcx' && (node.meta.modelIndex ?? 0) === modelIndex)
        .map(([, node]) => node);
    return unionPointCloudBounds(nodes);
  }

  // ─── lifecycle / queries ─────────────────────────────────────────────────

  clear(): void {
    // Clearing assets is independent of model placement. Full renderer teardown
    // discards this renderer instance and its offset map together.
    clearOwnedPointCloudNodes(this.nodes, this.nodeOwners);
    this.visibility.clear();
  }

  private clearOwner(owner: NodeOwner): void {
    for (const [id, current] of this.nodeOwners) if (current === owner) this.visibility.remove(id);
    clearOwnedPointCloudNodes(this.nodes, this.nodeOwners, owner);
  }

  hasAssets(): boolean { return this.nodes.size > 0; }
  getNodeCount(): number { return this.nodes.size; }

  /**
   * Iterate every uploaded node. Exposed so the deviation compute
   * pass can reach each node's vertex + deviation buffers without
   * the renderer having to mirror its internal map.
   */
  getInternalNodes(): Iterable<PointCloudNode> {
    return this.nodes.values();
  }

  /** Total number of points currently uploaded across all assets. */
  getPointCount(): number {
    let total = 0;
    for (const node of this.nodes.values()) {
      total += node.pointCount;
    }
    return total;
  }

  getBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    return unionPointCloudBounds(this.visibleNodes());
  }

  /**
   * Issue draw calls into an already-open render pass. The caller owns
   * the encoder/pass and is responsible for the depth attachment.
   */
  draw(pass: GPURenderPassEncoder, state: PointCloudDrawState): void {
    if (this.nodes.size === 0) return;

    pass.setPipeline(this.pipeline.getPipeline());

    const sp = state.sectionPlane ?? null;
    let normal: [number, number, number];
    let distance: number;
    let enabled: boolean;
    if (sp && sp.enabled) {
      enabled = true;
      if (sp.flipped) {
        normal = [-sp.normal[0], -sp.normal[1], -sp.normal[2]];
        distance = -sp.distance;
      } else {
        normal = sp.normal;
        distance = sp.distance;
      }
    } else {
      enabled = false;
      normal = [0, 1, 0];
      distance = 0;
    }

    const bounds = this.getBounds();
    const heightMin = bounds ? bounds.min[1] : 0;
    const heightMax = bounds ? bounds.max[1] : 1;
    // A missing viewport uses 1×1, avoiding adaptive-world division by zero.
    const viewportW = Math.max(1, state.viewport?.width ?? 1);
    const viewportH = Math.max(1, state.viewport?.height ?? 1);

    for (const [id, node] of this.nodes) {
      if (!this.visibility.visible(id)) continue;
      const drawable = writePointCloudUniforms(
        this.device,
        this.uniformScratch,
        this.uniformScratchU32,
        node,
        {
          viewProj: state.viewProj,
          relativeToEyeFrame: state.relativeToEyeFrame,
          fixedColor: this.options.fixedColor,
          colorMode: this.options.colorMode,
          sizeMode: this.options.sizeMode,
          pointSize: this.options.pointSize,
          worldRadius: this.options.worldRadius,
          roundShape: this.options.roundShape,
          sectionNormal: normal,
          sectionDist: distance,
          sectionEnabled: enabled,
          clipBox: state.clipBox,
          heightMin,
          heightMax,
          viewportW,
          viewportH,
          classMask: this.options.classMask,
          previewStride: this.options.previewStride,
          deviationCenterOffset: this.options.deviationRange.centerOffset,
          deviationHalfRange: this.options.deviationRange.halfRange,
        },
      );
      if (!drawable) continue;
      pass.setBindGroup(0, node.bindGroup);
      for (const chunk of node.chunks) {
        pass.setVertexBuffer(0, chunk.vertexBuffer);
        // 2nd buffer: per-point deviation float (location 4 in shader).
        pass.setVertexBuffer(1, chunk.deviationBuffer);
        // Six verts per splat, one instance per source point.
        pass.draw(POINT_QUAD_VERTS, chunk.pointCount, 0, 0);
      }
    }
  }

  /** Resolve an objectId rgba8 sample, or null when it matches no asset. */
  resolvePick(expressId: number): { handle: PointCloudAssetHandle; meta: PointCloudNodeMeta } | null {
    return resolvePickedAsset(this.nodes.entries(), expressId);
  }

  /** Picker snapshot uses each visible splat's exact model matrix. */
  getPickNodes(): Array<{
    expressId: number;
    modelIndex?: number;
    model?: Float32Array;
    rteOrigin?: [number, number, number];
    chunks: Array<{ vertexBuffer: GPUBuffer; pointCount: number }>;
  }> {
    return buildPickNodeSources(this.visibleNodes());
  }

  /** CPU spatial-index snapshot for measurement snapping (#1860), with the
   * live visibility mask so hidden points cannot corrupt measurements (#1783). */
  getRayQuerySources(): Array<{
    expressId: number;
    modelIndex?: number;
    index: PointCloudSpatialIndex;
    classMask: Uint32Array;
    model?: Float32Array | Float64Array;
  }> {
    // `classMask` is a live reference — read synchronously within one
    // query, and `setOptions` replaces (never mutates in place) the array.
    return buildRayQuerySources(this.visibleNodes(), this.options.classMask);
  }

  private *visibleNodes(): IterableIterator<PointCloudNode> {
    for (const [id, node] of this.nodes) if (this.visibility.visible(id)) yield node;
  }
}
