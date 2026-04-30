/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manages point cloud assets in the renderer.
 *
 * Owns the pipeline, the per-asset GPU resources, and the per-frame draw
 * call. Designed to slot into the existing `Renderer.render()` so points
 * share the depth buffer and section-plane state with triangle meshes.
 */

import type { PointCloudAsset } from '@ifc-lite/geometry';
import { PointRenderPipeline, POINT_UNIFORM_SIZE } from './point-pipeline.js';
import {
  uploadAssetToGpu,
  destroyNode,
  type PointCloudNode,
} from './point-cloud-node.js';

export interface ResolvedSectionPlane {
  normal: [number, number, number];
  distance: number;
  enabled: boolean;
  flipped?: boolean;
}

export interface PointCloudDrawState {
  /** column-major view-projection matrix (16 floats) */
  viewProj: Float32Array;
  /** Section plane already resolved by the main render path. */
  sectionPlane?: ResolvedSectionPlane | null;
}

export class PointCloudRenderer {
  private device: GPUDevice;
  private pipeline: PointRenderPipeline;
  private nodes: PointCloudNode[] = [];
  private uniformScratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
  private uniformScratchU32 = new Uint32Array(this.uniformScratch.buffer);

  constructor(
    device: GPUDevice,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    sampleCount: number,
  ) {
    this.device = device;
    this.pipeline = new PointRenderPipeline(device, colorFormat, depthFormat, sampleCount);
  }

  /** Add or replace point clouds. Existing GPU resources are released first. */
  setAssets(assets: ReadonlyArray<PointCloudAsset>): void {
    this.clear();
    for (const asset of assets) {
      this.addAsset(asset);
    }
  }

  addAsset(asset: PointCloudAsset): PointCloudNode {
    const node = uploadAssetToGpu(this.device, this.pipeline, asset);
    this.nodes.push(node);
    return node;
  }

  clear(): void {
    for (const node of this.nodes) {
      destroyNode(node);
    }
    this.nodes = [];
  }

  hasAssets(): boolean {
    return this.nodes.length > 0;
  }

  getNodeCount(): number {
    return this.nodes.length;
  }

  /** Aggregate world bounds across all uploaded assets, or null if empty. */
  getBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    if (this.nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const node of this.nodes) {
      if (node.bounds.min[0] < minX) minX = node.bounds.min[0];
      if (node.bounds.min[1] < minY) minY = node.bounds.min[1];
      if (node.bounds.min[2] < minZ) minZ = node.bounds.min[2];
      if (node.bounds.max[0] > maxX) maxX = node.bounds.max[0];
      if (node.bounds.max[1] > maxY) maxY = node.bounds.max[1];
      if (node.bounds.max[2] > maxZ) maxZ = node.bounds.max[2];
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  /**
   * Issue draw calls into an already-open render pass. The caller owns
   * the encoder/pass and is responsible for the depth attachment.
   */
  draw(pass: GPURenderPassEncoder, state: PointCloudDrawState): void {
    if (this.nodes.length === 0) return;

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

    for (const node of this.nodes) {
      this.writeUniforms(node, state.viewProj, normal, distance, enabled);
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
  ): void {
    const u = this.uniformScratch;
    const uU32 = this.uniformScratchU32;

    // viewProj — bytes 0..63
    u.set(viewProj.subarray(0, 16), 0);
    // model — bytes 64..127 (identity for Phase 0; per-asset transforms come later)
    u.fill(0, 16, 32);
    u[16] = 1; u[21] = 1; u[26] = 1; u[31] = 1;
    // colorOverride — bytes 128..143 (alpha=0 → use per-vertex color)
    u[32] = 0; u[33] = 0; u[34] = 0; u[35] = 0;
    // pointSize + pad — bytes 144..159
    u[36] = 1.0; u[37] = 0; u[38] = 0; u[39] = 0;
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
}
