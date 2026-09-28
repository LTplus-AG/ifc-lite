/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selection/hover mask pipelines (#5390), and the instanced variant that
 * outlines GPU-instanced occurrences (#5745): repeated windows, doors,
 * furniture and fasteners, whose "selected" flag lives in the per-instance
 * record rather than in a mesh uniform.
 *
 * Both variants write the same three outputs into the same targets, so
 * `edge-pass.ts`'s `encodeOutline` sees one mask whatever drew it. The
 * instanced one differs only in its vertex stage (`vs_instanced` over
 * `INSTANCED_VERTEX_BUFFERS`, exactly as the main instanced draw, so the
 * mask lands where the occurrence was drawn) and in a per-occurrence filter
 * in the fragment stage (`selection-mask.wgsl.ts`). One draw per template
 * covers every occurrence; the fragment keeps the selected ones, or the
 * hovered id's.
 */

import { INSTANCED_VERTEX_BUFFERS } from './instanced-vertex-layout.js';
import type { InstancedTemplateGPU } from './scene-instance-types.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import {
  SELECTION_MASK_DEPTH_GROUP,
  SELECTION_MASK_HOVER_GROUP,
  selectionMaskFragmentSource,
} from './shaders/selection-mask.wgsl.js';

export const MASK_VISIBLE_FORMAT: GPUTextureFormat = 'rg8unorm';
export const MASK_ALL_FORMAT: GPUTextureFormat = 'r8unorm';

/** Additive blend: two draws to the same target OR their channels together (binary flags, unorm-clamped). */
const ADDITIVE_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one' },
  alpha: { srcFactor: 'one', dstFactor: 'one' },
};

/** Which mask output a draw writes. */
export type MaskKind = 'selectedVisible' | 'hoverVisible' | 'selectedAll';

export type MaskPipelines = Record<MaskKind, GPURenderPipeline>;

const MASK_OUTPUTS: Record<MaskKind, { label: string; entryPoint: string; format: GPUTextureFormat }> = {
  selectedVisible: { label: 'selected-visible', entryPoint: 'fs_mask_selected_visible', format: MASK_VISIBLE_FORMAT },
  hoverVisible: { label: 'hover-visible', entryPoint: 'fs_mask_hover_visible', format: MASK_VISIBLE_FORMAT },
  selectedAll: { label: 'selected-all', entryPoint: 'fs_mask_selected_all', format: MASK_ALL_FORMAT },
};

/** The three mask pipelines over one vertex stage and one fragment module. */
export function createMaskPipelines(
  device: GPUDevice,
  labelPrefix: string,
  layout: GPUPipelineLayout,
  vertex: GPUVertexState,
  fragmentModule: GPUShaderModule,
): MaskPipelines {
  const make = (kind: MaskKind) => {
    const out = MASK_OUTPUTS[kind];
    return device.createRenderPipeline({
      label: `${labelPrefix}-${out.label}`,
      layout,
      vertex,
      fragment: { module: fragmentModule, entryPoint: out.entryPoint, targets: [{ format: out.format, blend: ADDITIVE_BLEND }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
  };
  return { selectedVisible: make('selectedVisible'), hoverVisible: make('hoverVisible'), selectedAll: make('selectedAll') };
}

/** What the instanced mask draws of a template: its geometry and its instance records. */
export type InstancedMaskTemplate = Pick<
  InstancedTemplateGPU,
  'vertexBuffer' | 'indexBuffer' | 'indexCount' | 'instanceBuffer' | 'instanceCount'
>;

export interface InstancedMaskFrame {
  /**
   * Packed mesh uniform for `vs_instanced` and the section/clip cut: the
   * frame's RTE view-projection, section plane, clip box and flags, as the
   * main instanced draw sees them (`selection-outline-frame.ts`).
   */
  uniforms: Float32Array;
  /** Templates holding at least one selected occurrence. */
  selected: readonly InstancedMaskTemplate[];
  /** Templates holding an occurrence of `hoveredId`; empty when nothing is hovered. */
  hovered: readonly InstancedMaskTemplate[];
  hoveredId: number;
}

/** True when the instanced frame has nothing to draw. */
export function isInstancedMaskEmpty(frame: InstancedMaskFrame | null | undefined): boolean {
  return !frame || (frame.selected.length === 0 && frame.hovered.length === 0);
}

/**
 * The instanced mask pipelines plus the two small uniforms they read: the
 * mesh uniform (group 0, owned so no other draw's write can race it) and the
 * hovered entity id (group `SELECTION_MASK_HOVER_GROUP`). Built on the first
 * frame that has an instanced selection or hover.
 */
export class InstancedSelectionMask {
  private readonly device: GPUDevice;
  private readonly pipelines: MaskPipelines;
  private readonly meshBindGroupLayout: GPUBindGroupLayout;
  private meshUniform: { buffer: GPUBuffer; bindGroup: GPUBindGroup } | null = null;
  private readonly hoverBuffer: GPUBuffer;
  private readonly hoverBindGroup: GPUBindGroup;
  private readonly hoverScratch = new Uint32Array(4);

  constructor(device: GPUDevice, meshBindGroupLayout: GPUBindGroupLayout, depthLayout: GPUBindGroupLayout, multisampled: boolean) {
    this.device = device;
    this.meshBindGroupLayout = meshBindGroupLayout;
    const hoverLayout = device.createBindGroupLayout({
      label: 'selection-mask-instanced-hover-bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const groups: GPUBindGroupLayout[] = [];
    groups[0] = meshBindGroupLayout;
    groups[SELECTION_MASK_DEPTH_GROUP] = depthLayout;
    groups[SELECTION_MASK_HOVER_GROUP] = hoverLayout;
    const layout = device.createPipelineLayout({ label: 'selection-mask-instanced-layout', bindGroupLayouts: groups });
    const vertex: GPUVertexState = {
      module: device.createShaderModule({ label: 'selection-mask-instanced-vs', code: mainShaderSource }),
      entryPoint: 'vs_instanced',
      buffers: INSTANCED_VERTEX_BUFFERS,
    };
    const fragmentModule = device.createShaderModule({
      label: 'selection-mask-instanced-fs',
      code: selectionMaskFragmentSource(multisampled, true),
    });
    this.pipelines = createMaskPipelines(device, 'selection-mask-instanced', layout, vertex, fragmentModule);

    this.hoverBuffer = device.createBuffer({
      label: 'selection-mask-instanced-hover',
      size: this.hoverScratch.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.hoverBindGroup = device.createBindGroup({
      layout: hoverLayout,
      entries: [{ binding: 0, resource: { buffer: this.hoverBuffer } }],
    });
  }

  /** Upload this frame's uniforms. Call once per frame, before `draw`. */
  prepare(frame: InstancedMaskFrame): void {
    const { uniforms } = frame;
    if (!this.meshUniform || this.meshUniform.buffer.size < uniforms.byteLength) {
      this.meshUniform?.buffer.destroy();
      const buffer = this.device.createBuffer({
        label: 'selection-mask-instanced-uniforms',
        size: uniforms.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = this.device.createBindGroup({
        layout: this.meshBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer } }],
      });
      this.meshUniform = { buffer, bindGroup };
    }
    this.device.queue.writeBuffer(this.meshUniform.buffer, 0, uniforms);
    this.hoverScratch[0] = frame.hoveredId >>> 0;
    this.device.queue.writeBuffer(this.hoverBuffer, 0, this.hoverScratch);
  }

  /** Draw `templates` into the open mask pass, one instanced draw each. */
  draw(pass: GPURenderPassEncoder, kind: MaskKind, depthGroup: GPUBindGroup, templates: readonly InstancedMaskTemplate[]): void {
    if (templates.length === 0 || !this.meshUniform) return;
    pass.setPipeline(this.pipelines[kind]);
    pass.setBindGroup(0, this.meshUniform.bindGroup);
    pass.setBindGroup(SELECTION_MASK_DEPTH_GROUP, depthGroup);
    pass.setBindGroup(SELECTION_MASK_HOVER_GROUP, this.hoverBindGroup);
    for (const t of templates) {
      pass.setVertexBuffer(0, t.vertexBuffer);
      pass.setVertexBuffer(1, t.instanceBuffer);
      pass.setIndexBuffer(t.indexBuffer, 'uint32');
      pass.drawIndexed(t.indexCount, t.instanceCount);
    }
  }

  destroy(): void {
    this.meshUniform?.buffer.destroy();
    this.meshUniform = null;
    this.hoverBuffer.destroy();
  }
}
