/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection/hover mask pass (#5390): draws the selected and hovered
 * (non-instanced) meshes into two small single-sample targets the edge
 * pass then outlines (`edge-pass.ts`'s `fs_outline`, DRY with the geometry
 * edge detection, #5385):
 *
 *  - `maskVisible` (rg8unorm): R = selected, G = hovered, both VISIBLE only
 *    (occluded fragments discarded — see `shaders/selection-mask.wgsl.ts`).
 *  - `maskAll` (r8unorm): R = selected, drawn regardless of occlusion, so
 *    the outline composite can tell "hidden behind something" (in `all`,
 *    not in `visible`) from "not selected at all".
 *
 * Reuses `mainShaderSource`'s `vs_main` as the vertex stage (same RTE /
 * section-plane / transform math the real highlight draw uses, so the mask
 * lands exactly where the highlighted mesh does) with a trivial constant
 * fragment stage — see that module's header for why the two mix safely.
 *
 * Known limitation: only the non-instanced mesh path is covered. An
 * instanced occurrence's "selected" flag lives in its per-instance vertex
 * data, read by `main.wgsl.ts`'s `vs_instanced`/`fs_main`, which this pass
 * cannot reuse without either editing that file (out of scope, see the
 * PR) or re-deriving its RTE anchor math independently (accuracy risk for
 * a rarely-hit case). Filed as a follow-up.
 */

import type { WebGPUDevice } from './device.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { SELECTION_MASK_DEPTH_GROUP, selectionMaskFragmentSource } from './shaders/selection-mask.wgsl.js';

const MASK_VISIBLE_FORMAT: GPUTextureFormat = 'rg8unorm';
const MASK_ALL_FORMAT: GPUTextureFormat = 'r8unorm';

/** Shared by every mask pipeline: the regular (non-instanced) mesh vertex layout. */
const MESH_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [{
  arrayStride: 28,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'uint32' },
  ],
}];

/** Additive blend: two draws to the same target OR their channels together (binary flags, unorm-clamped). */
const ADDITIVE_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one' },
  alpha: { srcFactor: 'one', dstFactor: 'one' },
};

export interface SelectableMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  bindGroup: GPUBindGroup;
}

/**
 * The hovered mesh: either one the frame already bound (`bindGroup`), or a
 * packed mesh uniform (`uniforms`) the pass writes into the ONE hover
 * buffer it owns, so hovering never allocates per frame.
 */
export type HoveredMesh = Omit<SelectableMesh, 'bindGroup'> & (
  | { bindGroup: GPUBindGroup; uniforms?: undefined }
  | { bindGroup?: undefined; uniforms: Float32Array }
);

export interface SelectionMaskFrame {
  encoder: GPUCommandEncoder;
  width: number;
  height: number;
  /** Depth-only view of the scene depth attachment (may be multisampled). */
  depthView: GPUTextureView;
  /** Drawn into `maskAll` (selected-all) and `maskVisible.r` (selected-visible). */
  selected: readonly SelectableMesh[];
  /** Drawn into `maskVisible.g` only (hover never shows through occluders). */
  hovered: readonly HoveredMesh[];
}

export interface SelectionMaskViews {
  visibleView: GPUTextureView;
  allView: GPUTextureView;
}

interface MaskTargets {
  width: number;
  height: number;
  visible: GPUTexture;
  all: GPUTexture;
  visibleView: GPUTextureView;
  allView: GPUTextureView;
  /** Returned by `encode`; one object per allocation so consumers can cache by identity. */
  views: SelectionMaskViews;
}

export class SelectionMaskPass {
  private readonly device: GPUDevice;
  private readonly meshBindGroupLayout: GPUBindGroupLayout;
  private readonly depthLayout: GPUBindGroupLayout;
  private readonly selectedVisiblePipeline: GPURenderPipeline;
  private readonly hoverVisiblePipeline: GPURenderPipeline;
  private readonly selectedAllPipeline: GPURenderPipeline;
  private targets: MaskTargets | null = null;
  private cachedDepthView: GPUTextureView | null = null;
  private cachedDepthBindGroup: GPUBindGroup | null = null;
  /** One owned uniform buffer + bind group per hovered piece, grown on demand. */
  private hoverUniforms: { buffer: GPUBuffer; bindGroup: GPUBindGroup }[] = [];
  private destroyed = false;

  constructor(device: WebGPUDevice, meshBindGroupLayout: GPUBindGroupLayout, sampleCount: number) {
    this.device = device.getDevice();
    this.meshBindGroupLayout = meshBindGroupLayout;

    this.depthLayout = this.device.createBindGroupLayout({
      label: 'selection-mask-depth-bgl',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth', viewDimension: '2d', multisampled: sampleCount > 1 },
      }],
    });
    const layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.meshBindGroupLayout, this.depthLayout],
    });

    const vertexModule = this.device.createShaderModule({ label: 'selection-mask-vs', code: mainShaderSource });
    const fragmentModule = this.device.createShaderModule({
      label: 'selection-mask-fs',
      code: selectionMaskFragmentSource(sampleCount > 1),
    });
    const vertex: GPUVertexState = { module: vertexModule, entryPoint: 'vs_main', buffers: MESH_VERTEX_BUFFERS };
    const make = (label: string, entryPoint: string, format: GPUTextureFormat) => this.device.createRenderPipeline({
      label,
      layout,
      vertex,
      fragment: { module: fragmentModule, entryPoint, targets: [{ format, blend: ADDITIVE_BLEND }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.selectedVisiblePipeline = make('selection-mask-selected-visible', 'fs_mask_selected_visible', MASK_VISIBLE_FORMAT);
    this.hoverVisiblePipeline = make('selection-mask-hover-visible', 'fs_mask_hover_visible', MASK_VISIBLE_FORMAT);
    this.selectedAllPipeline = make('selection-mask-selected-all', 'fs_mask_selected_all', MASK_ALL_FORMAT);
  }

  /** Nothing to draw this frame: caller skips the pass and the outline composite entirely. */
  static isEmpty(frame: Pick<SelectionMaskFrame, 'selected' | 'hovered'>): boolean {
    return frame.selected.length === 0 && frame.hovered.length === 0;
  }

  encode(frame: SelectionMaskFrame): SelectionMaskViews {
    const targets = this.ensureTargets(frame.width, frame.height);
    const depthGroup = this.ensureDepthBindGroup(frame.depthView);

    // The selected-visible and hover passes share `visibleView` (channels r
    // and g): only the FIRST pass into a target may clear it, or the hover
    // pass wipes the selection's visible mask (#5390, seen in a real frame).
    const cleared = new Set<GPUTextureView>();
    const draw = (view: GPUTextureView, pipeline: GPURenderPipeline, meshes: readonly SelectableMesh[]) => {
      const loadOp: GPULoadOp = cleared.has(view) ? 'load' : 'clear';
      cleared.add(view);
      const pass = frame.encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(SELECTION_MASK_DEPTH_GROUP, depthGroup);
      for (const mesh of meshes) {
        pass.setBindGroup(0, mesh.bindGroup);
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
      }
      pass.end();
    };

    draw(targets.visibleView, this.selectedVisiblePipeline, frame.selected);
    if (frame.hovered.length > 0) {
      draw(targets.visibleView, this.hoverVisiblePipeline, frame.hovered.map((h, i) => ({
        vertexBuffer: h.vertexBuffer, indexBuffer: h.indexBuffer, indexCount: h.indexCount, bindGroup: this.hoverGroup(h, i),
      })));
    }
    draw(targets.allView, this.selectedAllPipeline, frame.selected);

    return targets.views;
  }

  private hoverGroup(hovered: HoveredMesh, slot: number): GPUBindGroup {
    if (hovered.bindGroup) return hovered.bindGroup;
    const { uniforms } = hovered;
    let entry = this.hoverUniforms[slot];
    if (!entry || entry.buffer.size < uniforms.byteLength) {
      entry?.buffer.destroy();
      const buffer = this.device.createBuffer({
        label: 'selection-mask-hover-uniforms',
        size: uniforms.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = this.device.createBindGroup({
        layout: this.meshBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer } }],
      });
      entry = { buffer, bindGroup };
      this.hoverUniforms[slot] = entry;
    }
    this.device.queue.writeBuffer(entry.buffer, 0, uniforms);
    return entry.bindGroup;
  }

  private ensureTargets(width: number, height: number): MaskTargets {
    const current = this.targets;
    if (current && current.width === width && current.height === height) return current;
    this.releaseTargets();
    const make = (label: string, format: GPUTextureFormat) => this.device.createTexture({
      label,
      size: { width, height },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const visible = make('selection-mask-visible', MASK_VISIBLE_FORMAT);
    const all = make('selection-mask-all', MASK_ALL_FORMAT);
    const visibleView = visible.createView();
    const allView = all.createView();
    this.targets = { width, height, visible, all, visibleView, allView, views: { visibleView, allView } };
    return this.targets;
  }

  private ensureDepthBindGroup(depthView: GPUTextureView): GPUBindGroup {
    if (this.cachedDepthView === depthView && this.cachedDepthBindGroup) return this.cachedDepthBindGroup;
    this.cachedDepthBindGroup = this.device.createBindGroup({
      layout: this.depthLayout,
      entries: [{ binding: 0, resource: depthView }],
    });
    this.cachedDepthView = depthView;
    return this.cachedDepthBindGroup;
  }

  private releaseTargets(): void {
    this.targets?.visible.destroy();
    this.targets?.all.destroy();
    this.targets = null;
  }

  /** Release every GPU resource. Idempotent; the pass is unusable afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseTargets();
    this.cachedDepthBindGroup = null;
    this.cachedDepthView = null;
    for (const entry of this.hoverUniforms) entry.buffer.destroy();
    this.hoverUniforms = [];
  }
}
