/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-based object picking
 */

import { WebGPUDevice } from './device.js';
import type { Mesh, PickResult } from './types.js';
import type { InstancedTemplateGPU } from './scene.js';
import { PointPicker, decodePickSample, type PointPickNode } from './point-picker.js';
import { MathUtils } from './math.js';

/**
 * Reproject a pick coordinate (px, depth in [0, 1]) into world space
 * using the inverse view-projection matrix.
 *
 * Reverse-Z: depth=1 is the near plane, depth=0 is far. A depth of
 * exactly 0 means the click missed every drawn primitive (depth was
 * never written, so the clear value sticks), and we return null.
 *
 * Pixel coords use the WebGPU/screen convention (origin top-left, y
 * increases downward); NDC y is inverted to match the camera's
 * projection matrix.
 */
function unprojectPickSample(
  viewProj: Float32Array,
  pickX: number,
  pickY: number,
  width: number,
  height: number,
  depth: number,
): { x: number; y: number; z: number } | null {
  if (!Number.isFinite(depth) || depth <= 0) return null;
  const ndcX = ((pickX + 0.5) / width) * 2 - 1;
  const ndcY = 1 - ((pickY + 0.5) / height) * 2;
  const inv = MathUtils.invert({ m: viewProj });
  if (!inv) return null;
  return MathUtils.transformPoint(inv, { x: ndcX, y: ndcY, z: depth });
}

/** Point-pick sizing parameters forwarded to the GPU pipeline. */
export interface PointPickSizing {
  sizeMode: 0 | 1 | 2; // matches PointCloudRenderer's SIZE_MODE_INDEX
  worldRadius: number;
  pointSizePx: number;
  /** Extra pixels added to the splat radius for click tolerance. Default 2. */
  clickTolerancePx?: number;
}

export class Picker {
  private device: GPUDevice;
  private webgpuDevice: WebGPUDevice;
  private pipeline: GPURenderPipeline;
  private instancedPickPipeline: GPURenderPipeline | null = null;  // GPU-instancing: pick pass for instanced occurrences; null if the backend rejected it
  private instancedPickBindGroup: GPUBindGroup | null = null;
  private depthTexture: GPUTexture;
  private colorTexture: GPUTexture;
  private uniformBuffer: GPUBuffer;
  private expressIdBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private maxMeshes: number = 100000; // Support up to 100K meshes (was 10K)
  private destroyed = false;
  private pointPicker: PointPicker | null = null;

  constructor(device: WebGPUDevice, width: number = 1, height: number = 1) {
    this.webgpuDevice = device;
    this.device = device.getDevice();

    // Create textures for picking
    this.colorTexture = this.device.createTexture({
      size: { width, height },
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: 'depth32float',
      // COPY_SRC so we can read the depth texel at the click position
      // back to the CPU and unproject to recover the world-space hit
      // point for hover tooltips / measurements.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    // Create uniform buffer for viewProj matrix only (16 floats = 64 bytes)
    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create storage buffer for expressIds (one u32 per mesh, +1 encoding)
    // We'll upload all expressIds at once, then use instance_index to look them up
    this.expressIdBuffer = this.device.createBuffer({
      size: this.maxMeshes * 4, // 4 bytes per u32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create picker shader that uses storage buffer for per-object expressId
    const shaderModule = this.device.createShaderModule({
      code: `
        struct Uniforms {
          viewProj: mat4x4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        @binding(1) @group(0) var<storage, read> expressIds: array<u32>;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) normal: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) @interpolate(flat) objectId: u32,
        }

        @vertex
        fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          // Identity transform - positions are already in world space
          output.position = uniforms.viewProj * vec4<f32>(input.position, 1.0);
          // Look up expressId from storage buffer using instance index
          output.objectId = expressIds[instanceIndex];
          return output;
        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) u32 {
          return input.objectId;
        }
      `,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 28,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'r32uint' }],
      },
      primitive: {
        topology: 'triangle-list',
        // Must match the visual pipelines' cullMode: 'none' — IFC winding
        // order varies, so back-face culling can cull an object's entire
        // camera-facing surface and let whatever is behind it win the pick.
        cullMode: 'none',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater',  // Reverse-Z: greater instead of less
      },
    });

    // Create bind group using the pipeline's auto-generated layout
    // IMPORTANT: Must use getBindGroupLayout() when pipeline uses layout: 'auto'
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.expressIdBuffer },
        },
      ],
    });

    // ── Instanced pick pipeline ──
    // Draws scene.getInstancedTemplates() into the SAME r32uint + depth32float
    // pick target, applying the per-instance mat4 (slot 1, 88B stride) and
    // writing the express id WITH bit 30 set so the decoder distinguishes it
    // from a flat mesh-index (bit 30 clear) or a point (bit 31). No expressId
    // storage buffer — the id rides the instance buffer per occurrence.
    const instancedPickModule = this.device.createShaderModule({
      code: `
        struct Uniforms { viewProj: mat4x4<f32> }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        struct VertexInput { @location(0) position: vec3<f32> }
        struct InstanceInput {
          @location(3) m0: vec4<f32>,
          @location(4) m1: vec4<f32>,
          @location(5) m2: vec4<f32>,
          @location(6) m3: vec4<f32>,
          @location(7) instEntityId: u32,
          @location(8) instFlags: u32,
        }
        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) @interpolate(flat) objectId: u32,
          @location(1) @interpolate(flat) instFlags: u32,
        }
        @vertex
        fn vs_main(input: VertexInput, inst: InstanceInput) -> VertexOutput {
          var output: VertexOutput;
          let m = mat4x4<f32>(inst.m0, inst.m1, inst.m2, inst.m3);
          output.position = uniforms.viewProj * (m * vec4<f32>(input.position, 1.0));
          // bit 30 = instanced marker; express id in the low 30 bits.
          output.objectId = 0x40000000u | (inst.instEntityId & 0x3FFFFFFFu);
          output.instFlags = inst.instFlags;
          return output;
        }
        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) u32 {
          // Hidden occurrences (flags bit 1) are not pickable — mirror the render-pass
          // discard so a hidden instanced element can't be selected through the picker.
          if ((input.instFlags & 2u) != 0u) {
            discard;
          }
          return input.objectId;
        }
      `,
    });
    // NON-FATAL: the instanced pick pipeline is an add-on (instanced occurrences are
    // also resolvable via the GPU/CPU flat paths). A degraded WebGPU backend (e.g.
    // CI's SwiftShader) rejecting it must NOT abort the Picker — and therefore the
    // whole renderer init — and blank the canvas. On failure we leave it null and
    // renderPickPass skips the instanced pick draw.
    try {
      this.instancedPickPipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: instancedPickModule,
          entryPoint: 'vs_main',
          buffers: [
            // slot 0: template vertex (28B pos+norm+entityId) — only position read.
            { arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            // slot 1: per-instance (88B) — mat4 + entityId + flags (colour ignored here).
            {
              arrayStride: 88,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 3, offset: 0, format: 'float32x4' },
                { shaderLocation: 4, offset: 16, format: 'float32x4' },
                { shaderLocation: 5, offset: 32, format: 'float32x4' },
                { shaderLocation: 6, offset: 48, format: 'float32x4' },
                { shaderLocation: 7, offset: 64, format: 'uint32' },
                { shaderLocation: 8, offset: 84, format: 'uint32' },
              ],
            },
          ],
        },
        fragment: { module: instancedPickModule, entryPoint: 'fs_main', targets: [{ format: 'r32uint' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
      this.instancedPickBindGroup = this.device.createBindGroup({
        layout: this.instancedPickPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      });
    } catch (err) {
      console.warn('[Picker] instanced pick pipeline unavailable; instanced occurrences fall back to other pick paths:', err);
      this.instancedPickPipeline = null;
      this.instancedPickBindGroup = null;
    }
  }

  /**
   * Pick object at screen coordinates.
   *
   * When `pointNodes` is non-empty the picker draws point splats into
   * the same r32uint target as the meshes (sharing the depth buffer so
   * occlusion is correct). Point hits set bit 31 of the readback value;
   * the decoder distinguishes mesh vs point from that flag.
   *
   * Returns `PickResult` with `{expressId, modelIndex}` for both kinds.
   * For point hits, expressId is the federated globalId of the asset
   * (already correct for hover/selection plumbing — no remapping needed).
   */
  async pick(
    x: number,
    y: number,
    width: number,
    height: number,
    meshes: Mesh[],
    viewProj: Float32Array,
    pointNodes?: ReadonlyArray<PointPickNode>,
    pointSizing?: PointPickSizing,
    instancedTemplates?: readonly InstancedTemplateGPU[],
  ): Promise<PickResult | null> {
    const encoder = this.renderPickPass(width, height, meshes, viewProj, pointNodes, pointSizing, instancedTemplates);

    // Clamp the texel origin to the texture bounds. Math.floor(x/y) can
    // be -1 or equal to width/height on border clicks (and on
    // pointer-captured drags that leave the canvas), and either makes
    // copyTextureToBuffer reject the submit. pickRect already guards
    // this path; pick() needs the same.
    const sampleX = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const sampleY = Math.max(0, Math.min(height - 1, Math.floor(y)));

    // Read pixel at click position. WebGPU requires bytesPerRow to be a
    // multiple of 256 for copyTextureToBuffer, even for a 1×1 read.
    const BYTES_PER_ROW = 256;
    const readBuffer = this.device.createBuffer({
      size: BYTES_PER_ROW,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      {
        texture: this.colorTexture,
        origin: { x: sampleX, y: sampleY, z: 0 },
      },
      { buffer: readBuffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: 1 },
      { width: 1, height: 1 },
    );

    // Depth readback for click-to-world unprojection. WebGPU forbids
    // partial copies from depth/stencil-format textures — the copy must
    // cover the entire subresource. So we copy the whole depth image
    // and index into the buffer client-side after mapping. depth32float
    // = 4 bytes per texel; bytesPerRow must still be a multiple of 256.
    const depthBytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const depthBuffer = this.device.createBuffer({
      size: depthBytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      {
        texture: this.depthTexture,
        origin: { x: 0, y: 0, z: 0 },
        aspect: 'depth-only',
      },
      { buffer: depthBuffer, bytesPerRow: depthBytesPerRow, rowsPerImage: height },
      { width, height },
    );

    this.device.queue.submit([encoder.finish()]);
    // GPUMapMode.READ = 1 (WebGPU spec)
    await Promise.all([readBuffer.mapAsync(1), depthBuffer.mapAsync(1)]);
    const sample = new Uint32Array(readBuffer.getMappedRange())[0];
    const depthBytes = new Uint8Array(depthBuffer.getMappedRange());
    const depthOffset = sampleY * depthBytesPerRow + sampleX * 4;
    const depth = new Float32Array(
      depthBytes.buffer,
      depthBytes.byteOffset + depthOffset,
      1,
    )[0];
    readBuffer.unmap();
    depthBuffer.unmap();
    readBuffer.destroy();
    depthBuffer.destroy();

    const decoded = decodePickSample(sample);
    if (decoded.kind === 'none') return null;

    // Unproject (x, y, depth) → world space. Reverse-Z keeps depth in
    // [0, 1] (1 = near, 0 = far) — same NDC convention as the camera
    // raycaster, so MathUtils.transformPoint with the inverse viewProj
    // gives the world hit position directly.
    const worldXYZ = unprojectPickSample(viewProj, sampleX, sampleY, width, height, depth);

    if (decoded.kind === 'point') {
      // Look up the asset for modelIndex. expressId is already the
      // federated globalId (vertex shader writes it from the per-point
      // attribute, no lookup table needed).
      const node = pointNodes?.find((n) => (n.expressId >>> 0) === decoded.pointExpressId);
      return {
        expressId: decoded.pointExpressId,
        modelIndex: node?.modelIndex,
        worldXYZ: worldXYZ ?? undefined,
      };
    }

    if (decoded.kind === 'instanced') {
      // Instanced occurrence — the shader wrote the express id directly into the
      // pick value (no mesh-index lookup). modelIndex is not tracked per
      // occurrence yet (single-model instancing).
      return {
        expressId: decoded.instanceExpressId,
        modelIndex: undefined,
        worldXYZ: worldXYZ ?? undefined,
      };
    }

    // Mesh hit — meshIndex is (actual index + 1), already validated > 0.
    const mesh = meshes[decoded.meshIndexPlusOne - 1];
    if (!mesh) return null;
    return {
      expressId: mesh.expressId,
      modelIndex: mesh.modelIndex,
      worldXYZ: worldXYZ ?? undefined,
    };
  }

  updateUniforms(viewProj: Float32Array): void {
    // Update viewProj matrix only
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj);
  }

  /**
   * Rectangle pick: render the pick pass once, then read back every
   * texel inside `[x0, y0]..[x1, y1]` and dedupe the hit set. Returns
   * a `Set<expressId>` for both meshes and point clouds.
   *
   * Used by the Shift+drag rectangle-selection UI; not meant for
   * sustained use because the readback grows with rect area. A 800×600
   * rect = 480k pixels = ~2 MB transfer, fine for one-shot but we'd
   * want a GPU-side dedupe for sustained marquee selection.
   */
  async pickRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    height: number,
    meshes: Mesh[],
    viewProj: Float32Array,
    pointNodes?: ReadonlyArray<PointPickNode>,
    pointSizing?: PointPickSizing,
    instancedTemplates?: readonly InstancedTemplateGPU[],
  ): Promise<Set<number>> {
    // Normalise + clip rect to texture bounds.
    const lx = Math.max(0, Math.floor(Math.min(x0, x1)));
    const ly = Math.max(0, Math.floor(Math.min(y0, y1)));
    const hx = Math.min(width - 1, Math.floor(Math.max(x0, x1)));
    const hy = Math.min(height - 1, Math.floor(Math.max(y0, y1)));
    const rectW = hx - lx + 1;
    const rectH = hy - ly + 1;
    if (rectW <= 0 || rectH <= 0) return new Set();

    const encoder = this.renderPickPass(width, height, meshes, viewProj, pointNodes, pointSizing, instancedTemplates);

    // copyTextureToBuffer requires bytesPerRow to be a multiple of 256.
    // r32uint = 4 bytes per texel. Round up to nearest 256.
    const rawRowBytes = rectW * 4;
    const rowStride = Math.ceil(rawRowBytes / 256) * 256;
    const readBuffer = this.device.createBuffer({
      size: rowStride * rectH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      {
        texture: this.colorTexture,
        origin: { x: lx, y: ly, z: 0 },
      },
      { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: rectH },
      { width: rectW, height: rectH },
    );
    this.device.queue.submit([encoder.finish()]);
    await readBuffer.mapAsync(1);
    const view = new Uint32Array(readBuffer.getMappedRange());
    const ids = new Set<number>();
    const stridePx = rowStride / 4;
    for (let y = 0; y < rectH; y++) {
      const row = y * stridePx;
      for (let x = 0; x < rectW; x++) {
        const sample = view[row + x];
        if (sample === 0) continue;
        const decoded = decodePickSample(sample);
        if (decoded.kind === 'none') continue;
        if (decoded.kind === 'point') {
          ids.add(decoded.pointExpressId);
        } else if (decoded.kind === 'instanced') {
          // Instanced samples carry the express id directly (meshIndexPlusOne === 0),
          // so rect/shift-drag select must read it here too — not just single-click.
          ids.add(decoded.instanceExpressId);
        } else {
          const mesh = meshes[decoded.meshIndexPlusOne - 1];
          if (mesh) ids.add(mesh.expressId);
        }
      }
    }
    readBuffer.unmap();
    readBuffer.destroy();
    return ids;
  }

  /**
   * Render the picker pass into `colorTexture` + `depthTexture` and
   * return the still-open command encoder so the caller can append a
   * `copyTextureToBuffer` for either a single texel (`pick`) or a
   * whole rect (`pickRect`) before submitting.
   */
  private renderPickPass(
    width: number,
    height: number,
    meshes: Mesh[],
    viewProj: Float32Array,
    pointNodes?: ReadonlyArray<PointPickNode>,
    pointSizing?: PointPickSizing,
    instancedTemplates?: readonly InstancedTemplateGPU[],
  ): GPUCommandEncoder {
    if (this.colorTexture.width !== width || this.colorTexture.height !== height) {
      this.colorTexture.destroy();
      this.depthTexture.destroy();
      this.colorTexture = this.device.createTexture({
        size: { width, height },
        format: 'r32uint',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.depthTexture = this.device.createTexture({
        size: { width, height },
        format: 'depth32float',
        // COPY_SRC so single-pixel pick can read depth back for the
        // hover-XYZ unprojection. Rect pick doesn't sample depth but
        // costs nothing to keep the flag set.
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }
    // WebGPU texture views can't be reused after submit, so build fresh ones.
    const colorView = this.colorTexture.createView();
    const depthView = this.depthTexture.createView();

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0.0,  // Reverse-Z: clear to 0.0 (far plane)
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (meshes.length > this.maxMeshes) {
      this.resizeExpressIdBuffer(meshes.length);
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj);
    const meshIndexArray = new Uint32Array(meshes.length);
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i]) meshIndexArray[i] = i + 1;  // +1 so 0 means no hit
    }
    this.device.queue.writeBuffer(this.expressIdBuffer, 0, meshIndexArray);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (!mesh) continue;
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
      pass.drawIndexed(mesh.indexCount, 1, 0, 0, i);
    }

    // GPU-instanced occurrences — drawn into the SAME r32uint + depth target so
    // occlusion is shared with flat meshes/points. The shader writes
    // (bit30 | express id) per occurrence; the decoder returns the entity.
    if (instancedTemplates && instancedTemplates.length > 0 && this.instancedPickPipeline && this.instancedPickBindGroup) {
      pass.setPipeline(this.instancedPickPipeline);
      pass.setBindGroup(0, this.instancedPickBindGroup);
      for (const it of instancedTemplates) {
        pass.setVertexBuffer(0, it.vertexBuffer);
        pass.setVertexBuffer(1, it.instanceBuffer);
        pass.setIndexBuffer(it.indexBuffer, 'uint32');
        pass.drawIndexed(it.indexCount, it.instanceCount);
      }
    }

    if (pointNodes && pointNodes.length > 0) {
      if (!this.pointPicker) {
        this.pointPicker = new PointPicker(this.webgpuDevice);
      }
      const sz = pointSizing ?? { sizeMode: 0, worldRadius: 0.02, pointSizePx: 4 };
      this.pointPicker.drawIntoPass(pass, pointNodes, viewProj, { width, height }, {
        sizeMode: sz.sizeMode,
        worldRadius: sz.worldRadius,
        pointSizePx: sz.pointSizePx,
        clickTolerancePx: sz.clickTolerancePx ?? 2,
      });
    }
    pass.end();
    return encoder;
  }

  /**
   * Resize expressId buffer to accommodate more meshes
   */
  private resizeExpressIdBuffer(newSize: number): void {
    // Destroy old buffer
    this.expressIdBuffer.destroy();

    // Increase maxMeshes with 50% headroom for future growth
    this.maxMeshes = Math.ceil(newSize * 1.5);

    // Create new buffer
    this.expressIdBuffer = this.device.createBuffer({
      size: this.maxMeshes * 4, // 4 bytes per u32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Recreate bind group with new buffer
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.expressIdBuffer },
        },
      ],
    });
  }

  /**
   * Destroy all GPU resources held by this picker.
   * After calling this method the picker is no longer usable.
   * Safe to call multiple times.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.colorTexture.destroy();
    this.depthTexture.destroy();
    this.uniformBuffer.destroy();
    this.expressIdBuffer.destroy();
    this.pointPicker?.destroy();
    this.pointPicker = null;
  }
}
