/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud picker — sibling pipeline to `Picker` that draws splats
 * into the same r32uint object-id target so points and meshes occlude
 * each other correctly during a pick.
 *
 * Disambiguation: points emit `0x80000000 | (expressId & 0x7FFFFFFF)`,
 * meshes emit `meshIndex+1` (always under 100K). The reader checks bit
 * 31 to know which path produced the hit.
 *
 * Click tolerance: the picker pipeline inflates each splat by an extra
 * ~2 px over its on-screen size. This makes picking forgiving even for
 * sub-pixel splats (adaptive-world mode, dense scans) without changing
 * the rendered look.
 */

import type { WebGPUDevice } from './device.js';
import { POINT_QUAD_VERTS, POINT_VERTEX_BYTES } from './pointcloud/point-pipeline.js';

export interface PointPickNode {
  expressId: number;
  modelIndex?: number;
  chunks: ReadonlyArray<{ vertexBuffer: GPUBuffer; pointCount: number }>;
}

const POINT_PICK_MARKER = 0x80000000;
const POINT_PICK_MASK = 0x7fffffff;
/** bit 30 marks a GPU-instanced occurrence; the express id is in the low 30 bits.
 *  Checked AFTER the point marker (bit 31), so a point's express-id that happens
 *  to set bit 30 still decodes as a point. The instanced picker shader writes
 *  `INSTANCED_PICK_MARKER | (entityId & INSTANCED_PICK_MASK)`. */
export const INSTANCED_PICK_MARKER = 0x40000000;
export const INSTANCED_PICK_MASK = 0x3fffffff;

/** Decode a r32uint sample from the picker target. */
export interface DecodedPickSample {
  /** Mesh index (1-based) when bits 30-31 clear and value > 0; 0 = no hit. */
  meshIndexPlusOne: number;
  /** Federated expressId when bit 31 is set; 0 otherwise. */
  pointExpressId: number;
  /** Express id when bit 30 is set (GPU-instanced occurrence); 0 otherwise. */
  instanceExpressId: number;
  /** Convenience: which discipline produced the hit. */
  kind: 'mesh' | 'point' | 'instanced' | 'none';
}

export function decodePickSample(value: number): DecodedPickSample {
  if (value === 0) {
    return { meshIndexPlusOne: 0, pointExpressId: 0, instanceExpressId: 0, kind: 'none' };
  }
  if ((value & POINT_PICK_MARKER) !== 0) {
    return {
      meshIndexPlusOne: 0,
      pointExpressId: value & POINT_PICK_MASK,
      instanceExpressId: 0,
      kind: 'point',
    };
  }
  if ((value & INSTANCED_PICK_MARKER) !== 0) {
    return {
      meshIndexPlusOne: 0,
      pointExpressId: 0,
      instanceExpressId: value & INSTANCED_PICK_MASK,
      kind: 'instanced',
    };
  }
  return { meshIndexPlusOne: value, pointExpressId: 0, instanceExpressId: 0, kind: 'mesh' };
}

// mat4x4 (64) + vec4 viewport (16) + vec4 sizing (16) + vec4 entityIdOverride (16) + vec4 section (16)
const UNIFORM_BYTES = 128;

export class PointPicker {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private bindGroupLayout: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private uniformScratch = new Float32Array(UNIFORM_BYTES / 4);
  private uniformU32 = new Uint32Array(this.uniformScratch.buffer);
  private destroyed = false;

  constructor(device: WebGPUDevice) {
    this.device = device.getDevice();

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const shader = this.device.createShaderModule({
      code: `
struct U {
  viewProj: mat4x4<f32>,
  viewport: vec4<f32>,        // x, y = w, h; z, w = unused
  sizing: vec4<f32>,          // x = sizeMode, y = worldRadius,
                              // z = pointSizePx, w = clickToleranceExtraPx
  // x = assetExpressId override (federation-aware globalId);
  // 0 means "use the per-vertex entityId attribute".
  // y = sectionEnabled (0/1), z = sectionFlipped (0/1).
  entityIdOverride: vec4<u32>,
  section: vec4<f32>,         // xyz = plane normal, w = plane distance
}
@binding(0) @group(0) var<uniform> u: U;

struct VIn {
  @location(0) position: vec3<f32>,
  @location(1) entityId: u32,
}

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) entityId: u32,
  @location(1) quadUv: vec2<f32>,
  @location(2) worldPos: vec3<f32>,
}

@vertex
fn vs_main(input: VIn, @builtin(vertex_index) vId: u32) -> VOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
  );
  let corner = corners[vId];

  var clip = u.viewProj * vec4<f32>(input.position, 1.0);

  let sizeMode = u32(u.sizing.x);
  let worldRadius = u.sizing.y;
  let pointSizePx = u.sizing.z;
  let extraPx = u.sizing.w;
  let viewport = u.viewport.xy;

  // halfPx is the RADIUS; pointSizePx is the user-facing diameter, so /2.
  var halfPx: f32;
  if (sizeMode == 0u) {
    halfPx = max(0.5, pointSizePx * 0.5);
  } else {
    let edgePos = u.viewProj * vec4<f32>(input.position + vec3<f32>(worldRadius, 0.0, 0.0), 1.0);
    let centerNdcX = clip.x / max(abs(clip.w), 1e-6);
    let edgeNdcX = edgePos.x / max(abs(edgePos.w), 1e-6);
    let projectedPx = abs(edgeNdcX - centerNdcX) * 0.5 * viewport.x;
    if (sizeMode == 2u) {
      halfPx = clamp(projectedPx, 0.5, max(0.5, pointSizePx * 0.5));
    } else {
      halfPx = max(0.5, projectedPx);
    }
  }
  // Extra click-tolerance pixels on every side.
  halfPx = halfPx + extraPx;

  let halfClip = vec2<f32>(halfPx) / max(viewport, vec2<f32>(1.0)) * 2.0 * abs(clip.w);
  clip.x = clip.x + corner.x * halfClip.x;
  clip.y = clip.y + corner.y * halfClip.y;

  var o: VOut;
  o.pos = clip;
  o.entityId = input.entityId;
  o.quadUv = corner;
  o.worldPos = input.position;
  return o;
}

@fragment
fn fs_main(input: VOut) -> @location(0) u32 {
  // Round mask — picking ignores the corner area outside the unit disc
  // so users can't accidentally select a point by clicking 1.4 splat-
  // radii away from its centre.
  if (dot(input.quadUv, input.quadUv) > 1.0) {
    discard;
  }
  // Section plane: a point the section tool cut away is unpickable (mirrors the
  // point RENDER discard so selection matches what's visible).
  if (u.entityIdOverride.y != 0u) {
    let side = select(1.0, -1.0, u.entityIdOverride.z != 0u);
    let d = (dot(u.section.xyz, input.worldPos) - u.section.w) * side;
    if (d > 0.0) {
      discard;
    }
  }
  // Prefer the asset-level expressId override when set (federation
  // relabels apply post-stream so the per-vertex attribute can go
  // stale). Fallback to the per-vertex value when no override is set.
  let id = select(input.entityId, u.entityIdOverride.x, u.entityIdOverride.x != 0u);
  return 0x80000000u | (id & 0x7FFFFFFFu);
}
`,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: POINT_VERTEX_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              // Skip color (offset 12) and intensity (offset 16) — picker
              // doesn't need them. EntityId lives at offset 20.
              { shaderLocation: 1, offset: 20, format: 'uint32' },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [{ format: 'r32uint' }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    });
  }

  /**
   * Draw point pick splats into the (already-open) render pass. The
   * caller is responsible for clearing the color + depth attachments
   * and ending the pass.
   */
  drawIntoPass(
    pass: GPURenderPassEncoder,
    nodes: ReadonlyArray<PointPickNode>,
    viewProj: Float32Array,
    viewport: { width: number; height: number },
    sizing: { sizeMode: 0 | 1 | 2; worldRadius: number; pointSizePx: number; clickTolerancePx: number },
    section?: { normal: [number, number, number]; distance: number; flipped: boolean } | null,
  ): void {
    if (this.destroyed || nodes.length === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    // Per-node uniform write so federation-relabelled IDs surface in
    // the picker too. The per-vertex `entityId` attribute is baked at
    // upload time and goes stale once the FederationRegistry assigns
    // an idOffset to the model — the override forces the picker to
    // emit the asset's CURRENT expressId regardless.
    for (const node of nodes) {
      this.writeUniforms(viewProj, viewport, sizing, node.expressId >>> 0, section);
      for (const chunk of node.chunks) {
        if (chunk.pointCount === 0) continue;
        pass.setVertexBuffer(0, chunk.vertexBuffer);
        pass.draw(POINT_QUAD_VERTS, chunk.pointCount, 0, 0);
      }
    }
  }

  private writeUniforms(
    viewProj: Float32Array,
    viewport: { width: number; height: number },
    sizing: { sizeMode: number; worldRadius: number; pointSizePx: number; clickTolerancePx: number },
    entityIdOverride: number,
    section?: { normal: [number, number, number]; distance: number; flipped: boolean } | null,
  ): void {
    const u = this.uniformScratch;
    const u32 = this.uniformU32;
    u.set(viewProj.subarray(0, 16), 0);
    u[16] = Math.max(1, viewport.width);
    u[17] = Math.max(1, viewport.height);
    u[18] = 0;
    u[19] = 0;
    u[20] = sizing.sizeMode;
    u[21] = sizing.worldRadius;
    u[22] = sizing.pointSizePx;
    u[23] = sizing.clickTolerancePx;
    // entityIdOverride.x at u32 24 (0 = use per-vertex attribute); .y/.z carry the
    // section-enabled / flipped flags the fragment shader reads.
    u32[24] = entityIdOverride >>> 0;
    u32[25] = section ? 1 : 0;
    u32[26] = section?.flipped ? 1 : 0;
    u32[27] = 0;
    // section plane (vec4<f32>) at float offset 28..31.
    u[28] = section ? section.normal[0] : 0;
    u[29] = section ? section.normal[1] : 0;
    u[30] = section ? section.normal[2] : 0;
    u[31] = section ? section.distance : 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u.buffer, u.byteOffset, UNIFORM_BYTES);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniformBuffer.destroy();
  }
}
