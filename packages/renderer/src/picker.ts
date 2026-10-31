/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sectionExclusions, withSectionExclusions } from './section-exclusions.js';
/**
 * GPU-based object picking
 */

import { WebGPUDevice } from './device.js';
import type { Mesh, PickResult, PickClipState } from './types.js';
import { resolvePickSample, resolvePickedExpressId } from './pick-resolve.js';
import type { InstancedTemplateGPU } from './scene.js';
import { PointPicker, decodePickSample, type PointPickNode } from './point-picker.js';
import type { RelativeToEyeSnapshot } from './relative-to-eye.js';
import { restoreRtePickWorld, unprojectPickSample } from './pick-world-position.js';
import {
  writeFlatPickUniform,
  writeInstancedPickUniforms,
  writePickUniforms,
} from './picker-rte-uniforms.js';
import { isReadbackAbort, PickerReadbackOwner } from './picker-readbacks.js';
import { PickDepthSample } from './picker-depth-sample.js';
import { drawInstanceRuns, uploadInstancedRteDeltas } from './instanced-rte.js';
import { INSTANCED_RTE_DELTA_SLOT, INSTANCED_VERTEX_BUFFERS } from './instanced-vertex-layout.js';
import { EXTRA_CLIP_BYTES, EXTRA_CLIP_FLOATS, packExtraClip } from './extra-clip-planes.js';
import { flatPickShaderWgsl, instancedPickShaderWgsl } from './picker-shaders.js';

/** Point-pick sizing parameters forwarded to the GPU pipeline. */
export interface PointPickSizing {
  sizeMode: 0 | 1 | 2; // matches PointCloudRenderer's SIZE_MODE_INDEX
  worldRadius: number;
  pointSizePx: number;
  /** Extra pixels added to the splat radius for click tolerance. Default 2. */
  clickTolerancePx?: number;
}

/** Smallest per-mesh slot allocation (64 KB of uniforms), so small models never regrow. */
const MIN_PICK_MESH_SLOTS = 256;

export class Picker {
  private device: GPUDevice;
  private webgpuDevice: WebGPUDevice;
  private pipeline: GPURenderPipeline;
  private instancedPickPipeline: GPURenderPipeline | null = null;  // GPU-instancing: pick pass for instanced occurrences; null if the backend rejected it
  private instancedPickBindGroup: GPUBindGroup | null = null;
  private instancedUniformBuffer: GPUBuffer;
  /** Extra cutting planes (#7545), one block shared by every pick draw; rewritten per pass. */
  private extraClipBuffer: GPUBuffer;
  private readonly extraClipScratch = new Float32Array(EXTRA_CLIP_FLOATS);
  private depthSample: PickDepthSample;
  /**
   * The id/depth targets and the per-mesh slots are allocated on the first GPU
   * pick and sized to it, not at init: a session that never GPU-picks (large
   * models pick on the CPU) holds none of the canvas-sized pair, and the slot
   * buffers grow with the meshes actually drawn instead of reserving 100K
   * 256-byte slots (25.6 MB) up front.
   */
  private targets: { color: GPUTexture; depth: GPUTexture } | null = null;
  private meshSlots: { uniform: GPUBuffer; expressIds: GPUBuffer; bindGroup: GPUBindGroup; capacity: number } | null = null;
  /** Set by `destroy()`; makes it idempotent and turns `pick`/`pickRect` into no-ops. */
  private destroyed = false;
  private readonly readbacks: PickerReadbackOwner;
  private pointPicker: PointPicker | null = null;
  // Flat meshes each bind a dynamic 256-byte slot: RTE view projection +
  // model linear transform + clip state + split drawable origin. A single
  // uniform rewritten in a loop would make every draw observe the last mesh.
  private readonly uniformScratch = new Float32Array(64);
  private readonly clipFlags = new Uint32Array(this.uniformScratch.buffer, 44 * 4, 4);
  private readonly instancedUniformScratch = new Float32Array(40);
  private readonly instancedClipFlags = new Uint32Array(this.instancedUniformScratch.buffer, 112, 4);

  /** `width`/`height` are accepted for compatibility; targets follow the first pick's size. */
  constructor(device: WebGPUDevice, _width: number = 1, _height: number = 1) {
    this.webgpuDevice = device;
    this.device = device.getDevice();
    this.readbacks = new PickerReadbackOwner(this.device);
    this.depthSample = new PickDepthSample(this.device);
    sectionExclusions(this.device).retain();

    this.extraClipBuffer = this.device.createBuffer({
      size: EXTRA_CLIP_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.instancedUniformBuffer = this.device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create picker shader that uses storage buffer for per-object expressId
    const shaderModule = this.device.createShaderModule({
      code: flatPickShaderWgsl,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: withSectionExclusions(this.device, [this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 224 } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: EXTRA_CLIP_BYTES } },
        ],
      })]) }),
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

    // ── Instanced pick pipeline ──
    // Draws scene.getInstancedTemplates() into the SAME r32uint + depth32float
    // pick target, applying the per-instance mat4 (slot 1, 88B stride) and
    // writing the express id WITH bit 30 set so the decoder distinguishes it
    // from a flat mesh-index (bit 30 clear) or a point (bit 31). No expressId
    // storage buffer — the id rides the instance buffer per occurrence.
    const instancedPickModule = this.device.createShaderModule({
      code: instancedPickShaderWgsl,
    });
    // NON-FATAL: the instanced pick pipeline is an add-on (instanced occurrences are
    // also resolvable via the GPU/CPU flat paths). A degraded WebGPU backend (e.g.
    // CI's SwiftShader) rejecting it must NOT abort the Picker — and therefore the
    // whole renderer init — and blank the canvas. On failure we leave it null and
    // renderPickPass skips the instanced pick draw.
    try {
      this.instancedPickPipeline = this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: withSectionExclusions(this.device, [this.device.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ] })]) }),
        vertex: {
          module: instancedPickModule,
          entryPoint: 'vs_main',
          // The shared instanced layout (#6393): the shader reads position, the
          // matrix, entity id, flags and the slot-2 camera-relative deltas.
          buffers: INSTANCED_VERTEX_BUFFERS,
        },
        fragment: { module: instancedPickModule, entryPoint: 'fs_main', targets: [{ format: 'r32uint' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
      this.instancedPickBindGroup = this.device.createBindGroup({
        layout: this.instancedPickPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.instancedUniformBuffer } },
          { binding: 1, resource: { buffer: this.extraClipBuffer } },
        ],
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
   *
   * Returns null after picker teardown or device loss, including loss between
   * successful mapping and consumption of the mapped range (#6881).
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
    clip?: PickClipState | null,
    pointRteSnapshot?: RelativeToEyeSnapshot,
  ): Promise<PickResult | null> {
    if (this.destroyed || this.readbacks.deviceLost) return null;
    const { encoder, targets } = this.renderPickPass(
      width, height, meshes, viewProj, pointNodes, pointSizing, instancedTemplates, clip, pointRteSnapshot,
    );

    // Border clicks and pointer-captured drags use the same clamped ID/depth texel.
    const sampleX = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const sampleY = Math.max(0, Math.min(height - 1, Math.floor(y)));

    // Read pixel at click position. WebGPU requires bytesPerRow to be a
    // multiple of 256 for copyTextureToBuffer, even for a 1×1 read.
    const BYTES_PER_ROW = 256;
    const readBuffer = this.device.createBuffer({
      size: BYTES_PER_ROW,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // The compute sample and ID copy share the render submission and staging
    // buffer. Each pick owns its coordinates and output until mapping finishes.
    this.readbacks.track(readBuffer);
    let depthResources: readonly GPUBuffer[] = [];
    let sample: number;
    let depth: number;
    try {
      encoder.copyTextureToBuffer(
        {
          texture: targets.color,
          origin: { x: sampleX, y: sampleY, z: 0 },
        },
        { buffer: readBuffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: 1 },
        { width: 1, height: 1 },
      );
      depthResources = this.depthSample.encode(
        encoder, targets.depth, sampleX, sampleY, readBuffer, 4,
      );
      this.readbacks.track(...depthResources);
      this.device.queue.submit([encoder.finish()]);
      await readBuffer.mapAsync(GPUMapMode.READ);
      if (this.destroyed || this.readbacks.deviceLost) return null;
      const bytes = readBuffer.getMappedRange();
      sample = new Uint32Array(bytes, 0, 1)[0];
      depth = new Float32Array(bytes, 4, 1)[0];
    } catch (err) {
      if (!this.readbacks.deviceLost && !isReadbackAbort(err)) throw err;
      return null;
    } finally {
      this.readbacks.release(readBuffer, ...depthResources);
    }

    const decoded = decodePickSample(sample);
    if (decoded.kind === 'none') return null;

    // Decode reverse-Z depth with the immutable RTE projection used to rasterise.
    const rteDecoded = decoded.kind === 'mesh' || decoded.kind === 'point' || decoded.kind === 'instanced';
    const projectedWorld = unprojectPickSample(
      rteDecoded && pointRteSnapshot ? pointRteSnapshot.getViewProjection().m : viewProj,
      sampleX,
      sampleY,
      width,
      height,
      depth,
    );
    const worldXYZ = rteDecoded && pointRteSnapshot
      ? restoreRtePickWorld(projectedWorld, pointRteSnapshot)
      : projectedWorld;

    // Which entity (and which representation item) the sample landed on is a
    // pure lookup — see resolvePickSample.
    return resolvePickSample(decoded, meshes, pointNodes, worldXYZ);
  }

  updateUniforms(viewProj: Float32Array, clip?: PickClipState | null): void {
    writePickUniforms(this.device, this.ensureMeshSlots(1).uniform, this.uniformScratch, this.clipFlags, viewProj, clip);
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
   *
   * Returns an empty set once `destroy()` has run — or if the device dies
   * mid-readback — for the same reasons {@link Picker.pick} returns null.
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
    clip?: PickClipState | null,
    pointRteSnapshot?: RelativeToEyeSnapshot,
  ): Promise<Set<number>> {
    if (this.destroyed || this.readbacks.deviceLost) return new Set();
    // Normalise + clip rect to texture bounds.
    const lx = Math.max(0, Math.floor(Math.min(x0, x1)));
    const ly = Math.max(0, Math.floor(Math.min(y0, y1)));
    const hx = Math.min(width - 1, Math.floor(Math.max(x0, x1)));
    const hy = Math.min(height - 1, Math.floor(Math.max(y0, y1)));
    const rectW = hx - lx + 1;
    const rectH = hy - ly + 1;
    if (rectW <= 0 || rectH <= 0) return new Set();

    const { encoder, targets } = this.renderPickPass(
      width, height, meshes, viewProj, pointNodes, pointSizing, instancedTemplates, clip, pointRteSnapshot,
    );

    // copyTextureToBuffer requires bytesPerRow to be a multiple of 256.
    // r32uint = 4 bytes per texel. Round up to nearest 256.
    const rawRowBytes = rectW * 4;
    const rowStride = Math.ceil(rawRowBytes / 256) * 256;
    const readBuffer = this.device.createBuffer({
      size: rowStride * rectH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.readbacks.track(readBuffer);
    try {
      encoder.copyTextureToBuffer(
        {
          texture: targets.color,
          origin: { x: lx, y: ly, z: 0 },
        },
        { buffer: readBuffer, bytesPerRow: rowStride, rowsPerImage: rectH },
        { width: rectW, height: rectH },
      );
      this.device.queue.submit([encoder.finish()]);
      await readBuffer.mapAsync(1);
      if (this.destroyed || this.readbacks.deviceLost) return new Set();
      const view = new Uint32Array(readBuffer.getMappedRange());
      const ids = new Set<number>();
      const stridePx = rowStride / 4;
      for (let y = 0; y < rectH; y++) {
        const row = y * stridePx;
        for (let x = 0; x < rectW; x++) {
          const sample = view[row + x];
          if (sample === 0) continue;
          // Same three-way decode single-click uses — including the instanced
          // case (the shader writes the express id straight into the sample) and
          // the mesh case's (index + 1) offset. Both live in pick-resolve.ts and
          // must not be re-implemented here.
          //
          // The bare id, not a PickResult: this returns a Set<expressId>, which
          // has no room for a per-item result — a marquee that hits three panes
          // of one curtain wall is one entry — and allocating a result per
          // non-zero texel just to read `.expressId` off it dominated the rect.
          // Single-click pick is the per-item surface.
          //
          // modelIndex is dropped for the same reason, which is why a point
          // sample's owning asset (a linear scan, once per texel) is not resolved.
          const expressId = resolvePickedExpressId(decodePickSample(sample), meshes);
          if (expressId !== null) ids.add(expressId);
        }
      }
      return ids;
    } catch (err) {
      if (!this.readbacks.deviceLost && !isReadbackAbort(err)) throw err;
      return new Set();
    } finally {
      this.readbacks.release(readBuffer);
    }
  }

  /**
   * Render the picker pass into the lazily allocated id + depth targets and
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
    clip?: PickClipState | null,
    pointRteSnapshot?: RelativeToEyeSnapshot,
  ): { encoder: GPUCommandEncoder; targets: { color: GPUTexture; depth: GPUTexture } } {
    const targets = this.ensureTargets(width, height);
    // WebGPU texture views can't be reused after submit, so build fresh ones.
    const colorView = targets.color.createView();
    const depthView = targets.depth.createView();

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

    const slots = this.ensureMeshSlots(meshes.length);
    const meshIndexArray = new Uint32Array(meshes.length);
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i]) meshIndexArray[i] = i + 1;  // +1 so 0 means no hit
    }
    this.device.queue.writeBuffer(slots.expressIds, 0, meshIndexArray);

    // One block for every draw of this pass: the cutting planes beyond the first,
    // in the frame the pass rasterises (eye-relative when an RTE snapshot drives it).
    packExtraClip(clip?.extraPlanes, pointRteSnapshot?.getCameraWorld() ?? null, this.extraClipScratch, 0);
    this.device.queue.writeBuffer(this.extraClipBuffer, 0, this.extraClipScratch);

    sectionExclusions(this.device).update(clip?.sectionExcludedIds);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(3, sectionExclusions(this.device).bindGroup);
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      if (!mesh) continue;
      if (pointRteSnapshot) {
        const drawable = writeFlatPickUniform(
          this.device,
          slots.uniform,
          this.uniformScratch,
          this.clipFlags,
          mesh,
          pointRteSnapshot,
          clip,
          i,
        );
        if (!drawable) continue;
      } else {
        // Compatibility for direct Picker callers that predate RTE snapshots.
        // Renderer/PickingManager always supplies one so production draws use
        // the per-mesh immutable RTE slots above.
        writePickUniforms(this.device, slots.uniform, this.uniformScratch, this.clipFlags, viewProj, clip, mesh.expressId, i);
      }
      pass.setBindGroup(0, slots.bindGroup, [i * 256]);
      pass.setVertexBuffer(0, mesh.vertexBuffer);
      pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
      pass.drawIndexed(mesh.indexCount, 1, 0, 0, i);
    }

    // GPU-instanced occurrences — drawn into the SAME r32uint + depth target so
    // occlusion is shared with flat meshes/points. The shader writes
    // (bit30 | express id) per occurrence; the decoder returns the entity.
    if (instancedTemplates && instancedTemplates.length > 0 && this.instancedPickPipeline && this.instancedPickBindGroup && pointRteSnapshot) {
      const instanceRuns = uploadInstancedRteDeltas(this.device, instancedTemplates, pointRteSnapshot.getCameraWorld());
      writeInstancedPickUniforms(
        this.device,
        this.instancedUniformBuffer,
        this.instancedUniformScratch,
        this.instancedClipFlags,
        pointRteSnapshot,
        clip,
      );
      pass.setPipeline(this.instancedPickPipeline);
      pass.setBindGroup(3, sectionExclusions(this.device).bindGroup);
      pass.setBindGroup(0, this.instancedPickBindGroup);
      for (const [i, it] of instancedTemplates.entries()) {
        pass.setVertexBuffer(0, it.vertexBuffer);
        pass.setVertexBuffer(1, it.instanceBuffer);
        pass.setVertexBuffer(INSTANCED_RTE_DELTA_SLOT, it.rteDeltas.buffer);
        pass.setIndexBuffer(it.indexBuffer, 'uint32');
        drawInstanceRuns(pass, it.indexCount, instanceRuns[i]!);
      }
    }

    if (pointNodes && pointNodes.length > 0) {
      if (!this.pointPicker) {
        this.pointPicker = new PointPicker(this.webgpuDevice);
      }
      const sz = pointSizing ?? { sizeMode: 0, worldRadius: 0.02, pointSizePx: 4 };
      // Point clouds share both RTE section and crop discards with their colour pass.
      this.pointPicker.drawIntoPass(pass, pointNodes, viewProj, { width, height }, {
        sizeMode: sz.sizeMode,
        worldRadius: sz.worldRadius,
        pointSizePx: sz.pointSizePx,
        clickTolerancePx: sz.clickTolerancePx ?? 2,
      }, clip?.sectionPlane ?? null, pointRteSnapshot, clip?.clipBox ?? null, clip?.extraPlanes ?? null);
    }
    pass.end();
    return { encoder, targets };
  }

  /** The id/depth pair at the pick's size, (re)allocated on first use or resize. */
  private ensureTargets(width: number, height: number): { color: GPUTexture; depth: GPUTexture } {
    const current = this.targets;
    if (current && current.color.width === width && current.color.height === height) return current;
    current?.color.destroy();
    current?.depth.destroy();
    this.targets = {
      color: this.device.createTexture({ label: 'pick-id', size: { width, height }, format: 'r32uint', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }),
      depth: this.device.createTexture({ label: 'pick-depth', size: { width, height }, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }),
    };
    return this.targets;
  }

  /** The id/depth targets while allocated, for render-target telemetry. */
  renderTargets(): (GPUTexture | null)[] {
    return [this.targets?.color ?? null, this.targets?.depth ?? null];
  }

  /**
   * One dynamically-offset 256-byte uniform slot and one expressId lane per
   * flat mesh, so the encoder binds each draw's immutable payload after every
   * queue write. Grown with 50% headroom when a pick draws more meshes.
   */
  private ensureMeshSlots(count: number): { uniform: GPUBuffer; expressIds: GPUBuffer; bindGroup: GPUBindGroup } {
    const current = this.meshSlots;
    if (current && count <= current.capacity) return current;
    current?.uniform.destroy();
    current?.expressIds.destroy();
    const capacity = Math.max(MIN_PICK_MESH_SLOTS, Math.ceil(count * 1.5));
    const uniform = this.device.createBuffer({ label: 'pick-mesh-uniforms', size: capacity * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const expressIds = this.device.createBuffer({ label: 'pick-mesh-ids', size: capacity * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform, size: 224 } },
        { binding: 1, resource: { buffer: expressIds } },
        { binding: 2, resource: { buffer: this.extraClipBuffer } },
      ],
    });
    this.meshSlots = { uniform, expressIds, bindGroup, capacity };
    return this.meshSlots;
  }

  /**
   * Destroy all GPU resources held by this picker.
   * After calling this method the picker is no longer usable.
   * Safe to call multiple times.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.readbacks.destroy();
    sectionExclusions(this.device).release();
    this.targets?.color.destroy();
    this.targets?.depth.destroy();
    this.targets = null;
    this.meshSlots?.uniform.destroy();
    this.meshSlots?.expressIds.destroy();
    this.meshSlots = null;
    this.instancedUniformBuffer.destroy();
    this.extraClipBuffer.destroy();
    this.pointPicker?.destroy();
    this.pointPicker = null;
  }
}
