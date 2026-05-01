/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
import { PointRenderPipeline, POINT_QUAD_VERTS, POINT_UNIFORM_SIZE } from './point-pipeline.js';
import {
  appendChunkToNode,
  createNode,
  destroyNode,
  uploadAssetToGpu,
  type PointCloudChunkInput,
  type PointCloudNode,
  type PointCloudNodeMeta,
} from './point-cloud-node.js';
import {
  writePointCloudUniforms,
  type PointColorMode,
  type PointSizeMode,
} from './point-cloud-uniforms.js';

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
  /** Section plane already resolved by the main render path. */
  sectionPlane?: ResolvedSectionPlane | null;
  /** Viewport size in pixels — needed by the splat shader to convert
   *  pixel sizes into clip-space offsets. */
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
}

export interface PointCloudAssetHandle {
  readonly id: number;
}

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
  private nodes = new Map<number, PointCloudNode>();
  private nodeOwners = new Map<number, NodeOwner>();
  private nextHandleId = 1;
  private uniformScratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
  private uniformScratchU32 = new Uint32Array(this.uniformScratch.buffer);
  private options: Required<PointCloudRenderOptions> = {
    colorMode: 'rgb',
    fixedColor: [1, 1, 1, 1],
    pointSize: 4,
    sizeMode: 'attenuated',
    worldRadius: 0.02,
    roundShape: true,
  };

  constructor(
    device: GPUDevice,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    sampleCount: number,
  ) {
    this.device = device;
    this.pipeline = new PointRenderPipeline(device, colorFormat, depthFormat, sampleCount);
  }

  setOptions(opts: PointCloudRenderOptions): void {
    if (opts.colorMode !== undefined) this.options.colorMode = opts.colorMode;
    if (opts.fixedColor !== undefined) this.options.fixedColor = opts.fixedColor;
    if (opts.pointSize !== undefined) this.options.pointSize = opts.pointSize;
    if (opts.sizeMode !== undefined) this.options.sizeMode = opts.sizeMode;
    if (opts.worldRadius !== undefined) this.options.worldRadius = opts.worldRadius;
    if (opts.roundShape !== undefined) this.options.roundShape = opts.roundShape;
  }

  getOptions(): Readonly<Required<PointCloudRenderOptions>> {
    return this.options;
  }

  // ─── one-shot API (IFCx) ──────────────────────────────────────────────────

  /**
   * Replace every IFCx-owned asset with `assets`. Streamed assets are
   * untouched. Use this from the viewer's IFCx sync hook.
   */
  setAssets(assets: ReadonlyArray<PointCloudAsset>): void {
    this.clearOwner('ifcx');
    for (const asset of assets) {
      this.addAsset(asset);
    }
  }

  addAsset(asset: PointCloudAsset): PointCloudAssetHandle {
    const node = uploadAssetToGpu(this.device, this.pipeline, asset);
    const id = this.nextHandleId++;
    this.nodes.set(id, node);
    this.nodeOwners.set(id, 'ifcx');
    return { id };
  }

  // ─── streaming API (LAS / LAZ) ────────────────────────────────────────────

  /** Open an empty asset that chunks will be appended to. */
  beginAsset(meta: PointCloudNodeMeta): PointCloudAssetHandle {
    const node = createNode(this.device, this.pipeline, meta);
    const id = this.nextHandleId++;
    this.nodes.set(id, node);
    this.nodeOwners.set(id, 'streamed');
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

  // ─── lifecycle / queries ─────────────────────────────────────────────────

  clear(): void {
    for (const node of this.nodes.values()) {
      destroyNode(node);
    }
    this.nodes.clear();
    this.nodeOwners.clear();
  }

  private clearOwner(owner: NodeOwner): void {
    for (const [id, ownerKind] of this.nodeOwners.entries()) {
      if (ownerKind !== owner) continue;
      const node = this.nodes.get(id);
      if (node) destroyNode(node);
      this.nodes.delete(id);
      this.nodeOwners.delete(id);
    }
  }

  hasAssets(): boolean {
    return this.nodes.size > 0;
  }

  getNodeCount(): number {
    return this.nodes.size;
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
    if (this.nodes.size === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let any = false;
    for (const node of this.nodes.values()) {
      if (!Number.isFinite(node.bounds.min[0])) continue;
      any = true;
      if (node.bounds.min[0] < minX) minX = node.bounds.min[0];
      if (node.bounds.min[1] < minY) minY = node.bounds.min[1];
      if (node.bounds.min[2] < minZ) minZ = node.bounds.min[2];
      if (node.bounds.max[0] > maxX) maxX = node.bounds.max[0];
      if (node.bounds.max[1] > maxY) maxY = node.bounds.max[1];
      if (node.bounds.max[2] > maxZ) maxZ = node.bounds.max[2];
    }
    if (!any) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
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
    // Default to 1×1 if the caller didn't supply a viewport — keeps the
    // shader from dividing by zero in adaptive-world mode and degrades
    // gracefully to "all points the same fixed-px size".
    const viewportW = Math.max(1, state.viewport?.width ?? 1);
    const viewportH = Math.max(1, state.viewport?.height ?? 1);

    for (const node of this.nodes.values()) {
      writePointCloudUniforms(
        this.device,
        this.uniformScratch,
        this.uniformScratchU32,
        node,
        {
          viewProj: state.viewProj,
          fixedColor: this.options.fixedColor,
          colorMode: this.options.colorMode,
          sizeMode: this.options.sizeMode,
          pointSize: this.options.pointSize,
          worldRadius: this.options.worldRadius,
          roundShape: this.options.roundShape,
          sectionNormal: normal,
          sectionDist: distance,
          sectionEnabled: enabled,
          heightMin,
          heightMax,
          viewportW,
          viewportH,
        },
      );
      pass.setBindGroup(0, node.bindGroup);
      for (const chunk of node.chunks) {
        pass.setVertexBuffer(0, chunk.vertexBuffer);
        // Six verts per splat, one instance per source point.
        pass.draw(POINT_QUAD_VERTS, chunk.pointCount, 0, 0);
      }
    }
  }

  /**
   * Resolve a packed objectId rgba8 sample back to the asset that owns it.
   * Returns null when the sample doesn't match any asset's expressId.
   */
  resolvePick(expressId: number): { handle: PointCloudAssetHandle; meta: PointCloudNodeMeta } | null {
    for (const [id, node] of this.nodes.entries()) {
      if ((node.meta.expressId >>> 0) === (expressId >>> 0)) {
        return { handle: { id }, meta: node.meta };
      }
    }
    return null;
  }

  /**
   * Snapshot of nodes shaped for the picker — only the data the GPU
   * picking pass actually needs (expressId, modelIndex, chunk vertex
   * buffers + counts). Returns a fresh array; callers may iterate
   * freely without worrying about mutation during a pick.
   */
  getPickNodes(): Array<{
    expressId: number;
    modelIndex?: number;
    chunks: Array<{ vertexBuffer: GPUBuffer; pointCount: number }>;
  }> {
    const out: Array<{ expressId: number; modelIndex?: number; chunks: Array<{ vertexBuffer: GPUBuffer; pointCount: number }> }> = [];
    for (const node of this.nodes.values()) {
      if (node.pointCount === 0) continue;
      out.push({
        expressId: node.meta.expressId,
        modelIndex: node.meta.modelIndex,
        chunks: node.chunks.map((c) => ({ vertexBuffer: c.vertexBuffer, pointCount: c.pointCount })),
      });
    }
    return out;
  }
}
