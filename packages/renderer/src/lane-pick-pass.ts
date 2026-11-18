/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GPU pick pass for colour batches and textured meshes (#10264 S1): draws
 * the scene's existing vertex buffers into the picker's id/depth targets and
 * reads the entity from each vertex's lane, instead of building one pick mesh
 * per visible piece from the CPU copy of the geometry.
 *
 * Owned by `Picker`, which encodes it into the same render pass as flat
 * meshes, instanced occurrences and point splats, so occlusion is shared.
 */

import type { RelativeToEyeSnapshot } from './relative-to-eye.js';
import type { PickClipState } from './pick-types.js';
import type { PickResult } from './pick-resolve.js';
import { bindSectionExclusions, sectionExclusions, withSectionExclusions } from './section-exclusions.js';
import { EXTRA_CLIP_BYTES } from './extra-clip-planes.js';
import { writeFlatPickUniform } from './picker-rte-uniforms.js';
import { lanePickShaderWgsl } from './picker-shaders.js';
import { EntityVisibilityCache } from './entity-visibility-table.js';

/** Vertex layouts that carry the entity lane: 28-byte flat, 36-byte textured, 12-byte quantized. */
export type LanePickLayout = 'flat' | 'textured' | 'quantized';

/** One whole drawable whose per-vertex lane names its entities. */
export interface LanePickDraw {
  layout: LanePickLayout;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  /** World = origin + vertex position. */
  origin: readonly [number, number, number];
  /** Full id the lane's low 24 bits are resolved under (`batchEntityIdAnchor`). */
  anchor: number;
  quantized?: { readonly min: readonly [number, number, number]; readonly step: number };
}

/** What a pick asks the batch pass to draw, and how to finish an entity sample. */
export interface LanePickInput {
  draws: readonly LanePickDraw[];
  hiddenIds?: ReadonlySet<number>;
  isolatedIds?: ReadonlySet<number> | null;
  /**
   * Completes a single-click hit whose sample named its entity directly (a
   * batch lane or an instanced occurrence): model and representation item.
   */
  refine?: (hit: PickResult) => PickResult;
}

const SLOT_BYTES = 256;
const MIN_SLOTS = 64;
const IDENTITY = { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };

export class LanePickPass {
  private readonly pipelines: Record<LanePickLayout, GPURenderPipeline>;
  private readonly layout: GPUBindGroupLayout;
  private slots: { buffer: GPUBuffer; capacity: number } | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private readonly visibilityCache = new EntityVisibilityCache();
  private readonly scratch = new Float32Array(SLOT_BYTES / 4);
  private readonly clipFlags = new Uint32Array(this.scratch.buffer, 44 * 4, 4);

  /**
   * True once WebGPU confirmed every pipeline is valid. A rejected pipeline is
   * not an exception: `createRenderPipeline` returns an invalid object and
   * reports through an error scope, so until the scope settles cleanly the
   * pass stays off and large models keep the CPU raycast.
   */
  private validated = false;
  get ready(): boolean { return this.validated; }

  /** Throws when pipeline creation throws; `Picker` then leaves the pass off. */
  constructor(private readonly device: GPUDevice, private readonly extraClipBuffer: GPUBuffer) {
    device.pushErrorScope('internal');
    device.pushErrorScope('validation');
    const settle = () => Promise.all([device.popErrorScope(), device.popErrorScope()]);
    try {
      this.layout = device.createBindGroupLayout({
        label: 'lane-pick-bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SLOT_BYTES } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: EXTRA_CLIP_BYTES } },
        ],
      });
      const module = device.createShaderModule({ label: 'lane-pick', code: lanePickShaderWgsl });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: withSectionExclusions(device, [this.layout]) });
      const make = (entryPoint: string, buffer: GPUVertexBufferLayout): GPURenderPipeline => device.createRenderPipeline({
        label: `lane-pick-${entryPoint}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint, buffers: [buffer] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'r32uint' }] },
        // cullMode and reverse-Z depth match the flat pick pipeline.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
      const f32 = (arrayStride: number): GPUVertexBufferLayout => ({
        arrayStride,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'uint32' },
        ],
      });
      this.pipelines = {
        flat: make('vs_lane', f32(28)),
        textured: make('vs_lane', f32(36)),
        quantized: make('vs_lane_quantized', {
          arrayStride: 12,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'uint16x4' },
            { shaderLocation: 2, offset: 8, format: 'uint32' },
          ],
        }),
      };
    } catch (err) {
      // Keep the error scopes balanced; the caller logs and leaves the pass off.
      void settle().catch((scopeError: unknown) => console.warn('[LanePickPass] error scope cleanup failed:', scopeError));
      throw err;
    }
    void settle().then(([validation, internal]) => {
      const error = validation ?? internal;
      if (error) console.warn('[LanePickPass] batch pick pipelines rejected; large models keep the CPU raycast:', error.message);
      else this.validated = true;
    }, (err: unknown) => console.warn('[LanePickPass] could not confirm the batch pick pipelines; large models keep the CPU raycast:', err));
  }

  /**
   * Write this pick's hide/isolate image into the shared table. False when the
   * table cannot hold it yet: a larger table may be pending
   * (`visibilityPending`), so `Picker` awaits that before encoding.
   */
  writeVisibility(input: LanePickInput): boolean {
    return sectionExclusions(this.device).writeVisibility(this.visibilityCache.resolve(input.hiddenIds, input.isolatedIds));
  }

  /** Write shared storage before any bind group referencing it enters the pick pass. */
  prepareVisibility(input: LanePickInput): void {
    if (!this.writeVisibility(input)) throw new RangeError('Pick visibility ids exceed the GPU visibility table (storage limit or rejected allocation)');
  }

  /**
   * Encode every draw of `input` into `pass`. Returns the number drawn. A draw
   * outside the snapshot's camera-relative envelope is skipped, exactly as the
   * colour pass skips it, so the pick never sees what the frame cannot show.
   */
  encode(
    pass: GPURenderPassEncoder,
    input: LanePickInput,
    snapshot: RelativeToEyeSnapshot,
    clip: PickClipState | null | undefined,
  ): number {
    if (input.draws.length === 0) return 0;
    const slots = this.ensureSlots(input.draws.length);
    const bindGroup = this.ensureBindGroup(slots);
    let current: LanePickLayout | null = null;
    let drawn = 0;
    for (let i = 0; i < input.draws.length; i++) {
      const draw = input.draws[i]!;
      const rteOrigin: [number, number, number] = [draw.origin[0], draw.origin[1], draw.origin[2]];
      const mesh = { transform: IDENTITY, rteOrigin, expressId: draw.anchor };
      if (!writeFlatPickUniform(this.device, slots, this.scratch, this.clipFlags, mesh, snapshot, clip, i, draw.quantized)) continue;
      if (draw.layout !== current) {
        current = draw.layout;
        pass.setPipeline(this.pipelines[current]);
        bindSectionExclusions(pass, this.device, 1);
      }
      pass.setBindGroup(0, bindGroup, [i * SLOT_BYTES]);
      pass.setVertexBuffer(0, draw.vertexBuffer);
      pass.setIndexBuffer(draw.indexBuffer, 'uint32');
      pass.drawIndexed(draw.indexCount);
      drawn++;
    }
    return drawn;
  }

  private ensureSlots(count: number): GPUBuffer {
    if (this.slots && count <= this.slots.capacity) return this.slots.buffer;
    this.slots?.buffer.destroy();
    const capacity = Math.max(MIN_SLOTS, Math.ceil(count * 1.5));
    const buffer = this.device.createBuffer({ label: 'lane-pick-uniforms', size: capacity * SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.slots = { buffer, capacity };
    this.bindGroup = null;
    return buffer;
  }

  private ensureBindGroup(slots: GPUBuffer): GPUBindGroup {
    this.bindGroup ??= this.device.createBindGroup({
      label: 'lane-pick-bind-group',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: slots, size: SLOT_BYTES } },
        { binding: 2, resource: { buffer: this.extraClipBuffer } },
      ],
    });
    return this.bindGroup;
  }

  destroy(): void {
    this.slots?.buffer.destroy();
    this.slots = null;
    this.bindGroup = null;
  }
}
