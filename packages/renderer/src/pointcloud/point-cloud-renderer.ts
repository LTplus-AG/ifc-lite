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
import { PointRenderPipeline, POINT_UNIFORM_SIZE } from './point-pipeline.js';
import {
  appendChunkToNode,
  createNode,
  destroyNode,
  uploadAssetToGpu,
  type PointCloudChunkInput,
  type PointCloudNode,
  type PointCloudNodeMeta,
} from './point-cloud-node.js';

export interface ResolvedSectionPlane {
  normal: [number, number, number];
  distance: number;
  enabled: boolean;
  flipped?: boolean;
}

export type PointColorMode =
  | 'rgb'
  | 'classification'
  | 'intensity'
  | 'height'
  | 'fixed';

const COLOR_MODE_INDEX: Record<PointColorMode, number> = {
  rgb: 0,
  classification: 1,
  intensity: 2,
  height: 3,
  fixed: 4,
};

export interface PointCloudDrawState {
  /** column-major view-projection matrix (16 floats) */
  viewProj: Float32Array;
  /** Section plane already resolved by the main render path. */
  sectionPlane?: ResolvedSectionPlane | null;
}

export interface PointCloudRenderOptions {
  /** How to color points each frame. Defaults to 'rgb'. */
  colorMode?: PointColorMode;
  /** RGBA in 0..1, used when colorMode === 'fixed'. */
  fixedColor?: [number, number, number, number];
  /** Pixel size hint (currently unused — point-list always renders 1px). */
  pointSize?: number;
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
    pointSize: 1,
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

    for (const node of this.nodes.values()) {
      this.writeUniforms(node, state.viewProj, normal, distance, enabled, heightMin, heightMax);
      pass.setBindGroup(0, node.bindGroup);
      for (const chunk of node.chunks) {
        pass.setVertexBuffer(0, chunk.vertexBuffer);
        pass.draw(chunk.pointCount, 1, 0, 0);
      }
    }
  }

  private writeUniforms(
    node: PointCloudNode,
    viewProj: Float32Array,
    sectionNormal: [number, number, number],
    sectionDist: number,
    sectionEnabled: boolean,
    heightMin: number,
    heightMax: number,
  ): void {
    const u = this.uniformScratch;
    const uU32 = this.uniformScratchU32;

    // viewProj — bytes 0..63
    u.set(viewProj.subarray(0, 16), 0);
    // model — bytes 64..127 (identity for now; per-asset transforms can be added later)
    u.fill(0, 16, 32);
    u[16] = 1; u[21] = 1; u[26] = 1; u[31] = 1;
    // colorOverride — bytes 128..143
    u[32] = this.options.fixedColor[0];
    u[33] = this.options.fixedColor[1];
    u[34] = this.options.fixedColor[2];
    u[35] = this.options.fixedColor[3];
    // colorModeAndExtras — bytes 144..159 (mode, pointSize, heightMin, heightMax)
    u[36] = COLOR_MODE_INDEX[this.options.colorMode];
    u[37] = this.options.pointSize;
    u[38] = heightMin;
    u[39] = heightMax;
    // sectionPlane — bytes 160..175
    u[40] = sectionNormal[0];
    u[41] = sectionNormal[1];
    u[42] = sectionNormal[2];
    u[43] = sectionDist;
    // flags — bytes 176..191
    uU32[44] = 0;
    uU32[45] = sectionEnabled ? 1 : 0;
    uU32[46] = 0;
    uU32[47] = 0;

    this.device.queue.writeBuffer(node.uniformBuffer, 0, u.buffer, u.byteOffset, POINT_UNIFORM_SIZE);
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
}
