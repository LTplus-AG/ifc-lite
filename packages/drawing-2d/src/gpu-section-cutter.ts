/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU Section Cutter - WebGPU compute shader for fast section cutting
 *
 * Accelerates triangle-plane intersection using parallel GPU computation.
 * Falls back to CPU implementation when WebGPU is not available.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { CutSegment, SectionPlaneConfig, Point2D, Vec3 } from './types.js';
import { getAxisNormal, getProjectionAxes } from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// SHADER CODE
// ═══════════════════════════════════════════════════════════════════════════

const SECTION_CUT_SHADER = /* wgsl */ `
  struct Triangle {
    v0: vec3<f32>,
    v1: vec3<f32>,
    v2: vec3<f32>,
    entityId: u32,
  }

  struct Plane {
    normal: vec3<f32>,
    distance: f32,
    // Projection axes for 2D output
    axisU: u32,  // 0=x, 1=y, 2=z
    axisV: u32,
    flipU: f32,  // 1.0 or -1.0
    _padding: f32,
  }

  struct Segment {
    p0_3d: vec3<f32>,
    _pad0: f32,
    p1_3d: vec3<f32>,
    _pad1: f32,
    p0_2d: vec2<f32>,
    p1_2d: vec2<f32>,
    entityId: u32,
    valid: u32,
  }

  @group(0) @binding(0) var<storage, read> triangles: array<Triangle>;
  @group(0) @binding(1) var<uniform> plane: Plane;
  @group(0) @binding(2) var<storage, read_write> segments: array<Segment>;
  @group(0) @binding(3) var<storage, read_write> segmentCount: atomic<u32>;

  const EPSILON: f32 = 1e-7;

  fn signedDistance(point: vec3<f32>) -> f32 {
    return dot(point, plane.normal) - plane.distance;
  }

  fn edgeIntersection(v0: vec3<f32>, v1: vec3<f32>, d0: f32, d1: f32) -> vec3<f32> {
    let t = d0 / (d0 - d1);
    return mix(v0, v1, t);
  }

  fn projectTo2D(p: vec3<f32>) -> vec2<f32> {
    var coords: array<f32, 3>;
    coords[0] = p.x;
    coords[1] = p.y;
    coords[2] = p.z;

    let u = coords[plane.axisU] * plane.flipU;
    let v = coords[plane.axisV];
    return vec2<f32>(u, v);
  }

  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let triIdx = id.x;
    if (triIdx >= arrayLength(&triangles)) {
      return;
    }

    let tri = triangles[triIdx];

    // Signed distances from plane
    let d0 = signedDistance(tri.v0);
    let d1 = signedDistance(tri.v1);
    let d2 = signedDistance(tri.v2);

    // Check for intersection
    let pos = u32(d0 > EPSILON) + u32(d1 > EPSILON) + u32(d2 > EPSILON);
    let neg = u32(d0 < -EPSILON) + u32(d1 < -EPSILON) + u32(d2 < -EPSILON);

    // No intersection if all on same side
    if (pos == 3u || neg == 3u || (pos == 0u && neg == 0u)) {
      return;
    }

    // Find intersection points
    var points: array<vec3<f32>, 2>;
    var count: u32 = 0u;

    // Edge v0-v1
    if ((d0 > EPSILON) != (d1 > EPSILON)) {
      points[count] = edgeIntersection(tri.v0, tri.v1, d0, d1);
      count = count + 1u;
    } else if (abs(d0) < EPSILON) {
      points[count] = tri.v0;
      count = count + 1u;
    }

    // Edge v1-v2
    if ((d1 > EPSILON) != (d2 > EPSILON)) {
      points[count] = edgeIntersection(tri.v1, tri.v2, d1, d2);
      count = count + 1u;
    } else if (abs(d1) < EPSILON && count < 2u) {
      points[count] = tri.v1;
      count = count + 1u;
    }

    // Edge v2-v0
    if (count < 2u) {
      if ((d2 > EPSILON) != (d0 > EPSILON)) {
        points[count] = edgeIntersection(tri.v2, tri.v0, d2, d0);
        count = count + 1u;
      } else if (abs(d2) < EPSILON && count < 2u) {
        points[count] = tri.v2;
        count = count + 1u;
      }
    }

    if (count >= 2u) {
      // Project to 2D
      let p0_2d = projectTo2D(points[0]);
      let p1_2d = projectTo2D(points[1]);

      // Skip degenerate segments
      let diff = p1_2d - p0_2d;
      if (dot(diff, diff) < EPSILON * EPSILON) {
        return;
      }

      // Atomically allocate output slot
      let outIdx = atomicAdd(&segmentCount, 1u);

      segments[outIdx].p0_3d = points[0];
      segments[outIdx].p1_3d = points[1];
      segments[outIdx].p0_2d = p0_2d;
      segments[outIdx].p1_2d = p1_2d;
      segments[outIdx].entityId = tri.entityId;
      segments[outIdx].valid = 1u;
    }
  }
`;

// ═══════════════════════════════════════════════════════════════════════════
// GPU SECTION CUTTER CLASS
// ═══════════════════════════════════════════════════════════════════════════

interface GPUResources {
  pipeline: GPUComputePipeline;
  triangleBuffer: GPUBuffer;
  planeBuffer: GPUBuffer;
  segmentBuffer: GPUBuffer;
  countBuffer: GPUBuffer;
  readbackBuffer: GPUBuffer;
  countReadbackBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  maxTriangles: number;
  maxSegments: number;
}

export class GPUSectionCutter {
  private device: GPUDevice;
  private resources: GPUResources | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Initialize GPU resources for a given maximum triangle count
   */
  async initialize(maxTriangles: number): Promise<void> {
    const maxSegments = maxTriangles; // At most one segment per triangle

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      code: SECTION_CUT_SHADER,
    });

    // Create compute pipeline
    const pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    // Triangle buffer (input)
    // Each triangle: 3 vec3 (36 bytes) + entityId (4 bytes) = 40 bytes, padded to 48
    const triangleBufferSize = maxTriangles * 48;
    const triangleBuffer = this.device.createBuffer({
      size: triangleBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Plane uniform buffer
    const planeBuffer = this.device.createBuffer({
      size: 32, // 4 floats normal + 1 distance + 2 axes + 1 flip + 1 padding = 8 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Segment buffer (output)
    // Each segment: 2 vec3 + 2 vec2 + 2 u32 = 64 bytes
    const segmentBufferSize = maxSegments * 64;
    const segmentBuffer = this.device.createBuffer({
      size: segmentBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Atomic counter buffer
    const countBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Readback buffers
    const readbackBuffer = this.device.createBuffer({
      size: segmentBufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const countReadbackBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: triangleBuffer } },
        { binding: 1, resource: { buffer: planeBuffer } },
        { binding: 2, resource: { buffer: segmentBuffer } },
        { binding: 3, resource: { buffer: countBuffer } },
      ],
    });

    this.resources = {
      pipeline,
      triangleBuffer,
      planeBuffer,
      segmentBuffer,
      countBuffer,
      readbackBuffer,
      countReadbackBuffer,
      bindGroup,
      maxTriangles,
      maxSegments,
    };
  }

  /**
   * Cut meshes using GPU compute shader
   */
  async cutMeshes(
    meshes: MeshData[],
    config: SectionPlaneConfig
  ): Promise<CutSegment[]> {
    if (!this.resources) {
      throw new Error('GPU resources not initialized. Call initialize() first.');
    }

    // Collect all triangles with entity info
    const triangleData = this.collectTriangles(meshes);
    const triangleCount = triangleData.count;

    if (triangleCount === 0) {
      return [];
    }

    // Ensure we have enough buffer space
    if (triangleCount > this.resources.maxTriangles) {
      await this.initialize(triangleCount * 2);
    }

    // Capture resources reference after potential reinitialization to avoid race conditions
    const resources = this.resources;
    if (!resources) {
      throw new Error('GPU resources became unavailable after initialization');
    }

    // Upload triangle data
    this.device.queue.writeBuffer(
      resources.triangleBuffer,
      0,
      triangleData.buffer.buffer as ArrayBuffer,
      triangleData.buffer.byteOffset,
      triangleData.buffer.byteLength
    );

    // Upload plane data
    const planeData = this.createPlaneData(config);
    this.device.queue.writeBuffer(
      resources.planeBuffer,
      0,
      planeData.buffer as ArrayBuffer,
      planeData.byteOffset,
      planeData.byteLength
    );

    // Reset counter
    this.device.queue.writeBuffer(
      resources.countBuffer,
      0,
      new Uint32Array([0])
    );

    // Dispatch compute shader
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(resources.pipeline);
    pass.setBindGroup(0, resources.bindGroup);

    const workgroupCount = Math.ceil(triangleCount / 64);
    pass.dispatchWorkgroups(workgroupCount);
    pass.end();

    // Copy results to readback buffers
    encoder.copyBufferToBuffer(
      resources.countBuffer,
      0,
      resources.countReadbackBuffer,
      0,
      4
    );

    this.device.queue.submit([encoder.finish()]);

    // Read back count first
    await resources.countReadbackBuffer.mapAsync(GPUMapMode.READ);
    const countData = new Uint32Array(
      resources.countReadbackBuffer.getMappedRange()
    );
    const segmentCount = countData[0];
    resources.countReadbackBuffer.unmap();

    if (segmentCount === 0) {
      return [];
    }

    // Copy and read back segments
    const encoder2 = this.device.createCommandEncoder();
    encoder2.copyBufferToBuffer(
      resources.segmentBuffer,
      0,
      resources.readbackBuffer,
      0,
      segmentCount * 64
    );
    this.device.queue.submit([encoder2.finish()]);

    await resources.readbackBuffer.mapAsync(GPUMapMode.READ);
    const segmentData = new Float32Array(
      resources.readbackBuffer.getMappedRange(0, segmentCount * 64)
    );

    // Parse segments
    const segments = this.parseSegments(segmentData, segmentCount, triangleData.entityMap);

    resources.readbackBuffer.unmap();

    return segments;
  }

  /**
   * Collect triangles from meshes into a flat buffer
   */
  private collectTriangles(meshes: MeshData[]): {
    buffer: Float32Array;
    count: number;
    entityMap: Map<number, { entityId: number; ifcType: string; modelIndex: number }>;
  } {
    // Count total triangles
    let totalTriangles = 0;
    for (const mesh of meshes) {
      totalTriangles += mesh.indices.length / 3;
    }

    // 12 floats per triangle (3 vertices * 3 coords + 3 padding for alignment)
    const buffer = new Float32Array(totalTriangles * 12);
    const entityMap = new Map<number, { entityId: number; ifcType: string; modelIndex: number }>();

    let triIdx = 0;
    let entityCounter = 0;

    for (const mesh of meshes) {
      const { positions, indices, expressId, ifcType, modelIndex } = mesh;
      const triangleCount = indices.length / 3;

      // Map entity counter to mesh info
      entityMap.set(entityCounter, {
        entityId: expressId,
        ifcType: ifcType || 'Unknown',
        modelIndex: modelIndex || 0,
      });

      for (let t = 0; t < triangleCount; t++) {
        const i0 = indices[t * 3];
        const i1 = indices[t * 3 + 1];
        const i2 = indices[t * 3 + 2];

        const base = triIdx * 12;

        // v0
        buffer[base + 0] = positions[i0 * 3];
        buffer[base + 1] = positions[i0 * 3 + 1];
        buffer[base + 2] = positions[i0 * 3 + 2];
        // v1
        buffer[base + 3] = positions[i1 * 3];
        buffer[base + 4] = positions[i1 * 3 + 1];
        buffer[base + 5] = positions[i1 * 3 + 2];
        // v2
        buffer[base + 6] = positions[i2 * 3];
        buffer[base + 7] = positions[i2 * 3 + 1];
        buffer[base + 8] = positions[i2 * 3 + 2];
        // entityId (as float, will be reinterpreted)
        const entityView = new DataView(buffer.buffer, (base + 9) * 4, 4);
        entityView.setUint32(0, entityCounter, true);
        // Padding
        buffer[base + 10] = 0;
        buffer[base + 11] = 0;

        triIdx++;
      }

      entityCounter++;
    }

    return { buffer, count: totalTriangles, entityMap };
  }

  /**
   * Create plane uniform data
   */
  private createPlaneData(config: SectionPlaneConfig): Float32Array {
    const normal = getAxisNormal(config.axis, config.flipped);
    const axes = getProjectionAxes(config.axis);

    const axisToIndex = { x: 0, y: 1, z: 2 };

    const data = new Float32Array(8);
    data[0] = normal.x;
    data[1] = normal.y;
    data[2] = normal.z;
    data[3] = config.position;

    // Store axis indices as float (will be cast to u32 in shader)
    const view = new DataView(data.buffer);
    view.setUint32(16, axisToIndex[axes.u], true); // axisU
    view.setUint32(20, axisToIndex[axes.v], true); // axisV
    data[6] = config.flipped ? -1.0 : 1.0; // flipU
    data[7] = 0; // padding

    return data;
  }

  /**
   * Parse GPU output into CutSegment array
   */
  private parseSegments(
    data: Float32Array,
    count: number,
    entityMap: Map<number, { entityId: number; ifcType: string; modelIndex: number }>
  ): CutSegment[] {
    const segments: CutSegment[] = [];

    for (let i = 0; i < count; i++) {
      const base = i * 16; // 64 bytes = 16 floats

      const valid = new DataView(data.buffer, (base + 14) * 4, 4).getUint32(0, true);
      if (valid !== 1) continue;

      const entityIdx = new DataView(data.buffer, (base + 13) * 4, 4).getUint32(0, true);
      const entityInfo = entityMap.get(entityIdx) || {
        entityId: 0,
        ifcType: 'Unknown',
        modelIndex: 0,
      };

      segments.push({
        p0: { x: data[base + 0], y: data[base + 1], z: data[base + 2] },
        p1: { x: data[base + 4], y: data[base + 5], z: data[base + 6] },
        p0_2d: { x: data[base + 8], y: data[base + 9] },
        p1_2d: { x: data[base + 10], y: data[base + 11] },
        entityId: entityInfo.entityId,
        ifcType: entityInfo.ifcType,
        modelIndex: entityInfo.modelIndex,
      });
    }

    return segments;
  }

  /**
   * Release GPU resources
   */
  destroy(): void {
    if (this.resources) {
      this.resources.triangleBuffer.destroy();
      this.resources.planeBuffer.destroy();
      this.resources.segmentBuffer.destroy();
      this.resources.countBuffer.destroy();
      this.resources.readbackBuffer.destroy();
      this.resources.countReadbackBuffer.destroy();
      this.resources = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GPU AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if WebGPU compute shaders are available
 */
export function isGPUComputeAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
