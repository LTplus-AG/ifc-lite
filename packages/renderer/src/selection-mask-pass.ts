/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { emptyBindGroup, sectionExclusions, withSectionExclusions } from './section-exclusions.js';
/**
 * Selection/hover mask pass (#5390): draws the selected and hovered
 * meshes into two resolved targets the edge
 * pass then outlines (`edge-pass.ts`'s `fs_outline`, DRY with the geometry
 * edge detection, #5385):
 *
 *  - `maskVisible` (rg8unorm): R = selected, G = hovered, both VISIBLE only
 *    (occluded samples rejected by the shared scene depth attachment).
 *  - `maskAll` (r8unorm): R = selected, drawn regardless of occlusion, so
 *    the outline composite can tell "hidden behind something" (in `all`,
 *    not in `visible`) from "not selected at all".
 *
 * Reuses `mainShaderSource`'s `vs_main` as the vertex stage (same RTE /
 * section-plane / transform math the real highlight draw uses, so the mask
 * lands exactly where the highlighted mesh does) with a trivial constant
 * fragment stage — see that module's header for why the two mix safely.
 *
 * GPU-instanced occurrences (#5745) are drawn by `selection-mask-pipelines.ts`'s
 * instanced variant into the same targets, inside the same render passes,
 * so the outline composite cannot tell which path wrote a pixel.
 */

import { renderPassTimestampWrites } from './renderer-frame-timing.js';
import type { WebGPUDevice } from './device.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { selectionMaskFragmentSource } from './shaders/selection-mask.wgsl.js';
import {
  createMaskPipelines,
  createGeometricMaskPipelines,
  InstancedSelectionMask,
  isInstancedMaskEmpty,
  maskVertexStage,
  MASK_ALL_FORMAT,
  MASK_VISIBLE_FORMAT,
  type InstancedMaskFrame,
  type MaskKind,
  type MaskPipelines,
  type MaskVertexLayout,
} from './selection-mask-pipelines.js';
import { OPAQUE_VISIBILITY_GROUP } from './shaders/opaque-visibility.wgsl.js';

export interface SelectableMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat?: GPUIndexFormat;
  bindGroup: GPUBindGroup;
  vertexStride?: 36;
  /** A quantized colour batch drawn for the highlight (#10264 S3); its uniform names the entities kept. */
  quantized?: true;
}

function vertexLayoutOf(mesh: Pick<SelectableMesh, 'vertexStride' | 'quantized'>): MaskVertexLayout {
  return mesh.quantized ? 'quantized' : mesh.vertexStride === 36 ? 'textured' : 'flat';
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
  /** Full view of the scene depth/stencil attachment (may be multisampled). */
  depthView: GPUTextureView;
  /** Drawn into `maskAll` (selected-all) and `maskVisible.r` (selected-visible). */
  selected: readonly SelectableMesh[];
  /** Drawn into `maskVisible.g` only (hover never shows through occluders). */
  hovered: readonly HoveredMesh[];
  /** GPU-instanced occurrences to outline (#5745); absent or null when none are selected or hovered. */
  instanced?: InstancedMaskFrame | null;
  geometricVisibility?: GPUBindGroup;
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
  multisampledVisible: GPUTexture | null;
  multisampledVisibleView: GPUTextureView | null;
  /** Returned by `encode`; one object per allocation so consumers can cache by identity. */
  views: SelectionMaskViews;
}

export class SelectionMaskPass {
  private readonly device: GPUDevice;
  private readonly meshBindGroupLayout: GPUBindGroupLayout;
  private readonly sampleCount: number;
  private readonly layout: GPUPipelineLayout;
  private readonly vertexModule: GPUShaderModule;
  private readonly fragmentModule: GPUShaderModule;
  /** Per vertex layout; flat and textured built up front, quantized on its first draw. */
  private readonly pipelines = new Map<MaskVertexLayout, MaskPipelines>();
  private readonly geometricPipelines = new Map<MaskVertexLayout, MaskPipelines>();
  /** Built on the first frame with an instanced selection or hover. */
  private instanced: InstancedSelectionMask | null = null;
  private targets: MaskTargets | null = null;
  /** One owned uniform buffer + bind group per hovered piece, grown on demand. */
  private hoverUniforms: { buffer: GPUBuffer; bindGroup: GPUBindGroup }[] = [];
  private destroyed = false;

  constructor(device: WebGPUDevice, meshBindGroupLayout: GPUBindGroupLayout, sampleCount: number) {
    this.device = device.getDevice();
    sectionExclusions(this.device).retain();
    this.meshBindGroupLayout = meshBindGroupLayout;

    this.sampleCount = sampleCount;
    this.layout = this.device.createPipelineLayout({ bindGroupLayouts: withSectionExclusions(this.device, [this.meshBindGroupLayout]) });
    this.vertexModule = this.device.createShaderModule({ label: 'selection-mask-vs', code: mainShaderSource });
    this.fragmentModule = this.device.createShaderModule({
      label: 'selection-mask-fs',
      code: selectionMaskFragmentSource(),
    });
    this.plain('flat');
    this.plain('textured');
  }

  private plain(layout: MaskVertexLayout): MaskPipelines {
    let pipelines = this.pipelines.get(layout);
    if (!pipelines) {
      const label = layout === 'flat' ? 'selection-mask' : `selection-mask-${layout}`;
      pipelines = createMaskPipelines(this.device, label, this.layout, maskVertexStage(this.vertexModule, layout), this.fragmentModule, this.sampleCount);
      this.pipelines.set(layout, pipelines);
    }
    return pipelines;
  }

  private geometric(layout: MaskVertexLayout): MaskPipelines {
    let pipelines = this.geometricPipelines.get(layout);
    if (!pipelines) {
      pipelines = createGeometricMaskPipelines(this.device, this.meshBindGroupLayout, this.sampleCount, undefined, layout);
      this.geometricPipelines.set(layout, pipelines);
    }
    return pipelines;
  }

  /** Nothing to draw this frame: caller skips the pass and the outline composite entirely. */
  static isEmpty(frame: Pick<SelectionMaskFrame, 'selected' | 'hovered' | 'instanced'>): boolean {
    return frame.selected.length === 0 && frame.hovered.length === 0 && isInstancedMaskEmpty(frame.instanced);
  }

  encode(frame: SelectionMaskFrame): SelectionMaskViews {
    const targets = this.ensureTargets(frame.width, frame.height);

    const instancedFrame = frame.instanced && !isInstancedMaskEmpty(frame.instanced) ? frame.instanced : null;
    const instanced = instancedFrame ? this.ensureInstanced() : null;
    if (instanced && instancedFrame) instanced.prepare(instancedFrame);

    // The selected-visible and hover passes share `visibleView` (channels r
    // and g): only the FIRST pass into a target may clear it, or the hover
    // pass wipes the selection's visible mask (#5390, seen in a real frame).
    const cleared = new Set<GPUTextureView>();
    const draw = (view: GPUTextureView, kind: MaskKind, meshes: readonly SelectableMesh[]) => {
      const loadOp: GPULoadOp = cleared.has(view) ? 'load' : 'clear';
      cleared.add(view);
      const visible = kind !== 'selectedAll';
      const pass = frame.encoder.beginRenderPass({
        timestampWrites: renderPassTimestampWrites(frame.encoder, `selection-${kind}`),
        colorAttachments: [{
          view: visible ? targets.multisampledVisibleView ?? view : view,
          ...(visible && targets.multisampledVisibleView ? { resolveTarget: view } : {}),
          loadOp, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
        ...(visible ? { depthStencilAttachment: { view: frame.depthView, depthReadOnly: true, stencilReadOnly: true } } : {}),
      });
      // Group 1 is padding in both mesh mask layouts; group 2 is padding unless geometric (#9060).
      pass.setBindGroup(1, emptyBindGroup(this.device));
      const geometric = visible ? frame.geometricVisibility : undefined;
      if (geometric) {
        pass.setPipeline(this.geometric('flat')[kind]); pass.setBindGroup(OPAQUE_VISIBILITY_GROUP, geometric);
      } else { pass.setPipeline(this.plain('flat')[kind]); pass.setBindGroup(OPAQUE_VISIBILITY_GROUP, emptyBindGroup(this.device)); }
      for (const mesh of meshes) {
        const layout = vertexLayoutOf(mesh);
        pass.setPipeline((geometric ? this.geometric(layout) : this.plain(layout))[kind]);
        pass.setBindGroup(3, sectionExclusions(this.device).bindGroup);
        pass.setBindGroup(0, mesh.bindGroup);
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat ?? 'uint32');
        pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
      }
      if (instanced && instancedFrame) {
        instanced.draw(pass, kind, kind === 'hoverVisible' ? instancedFrame.hovered : instancedFrame.selected, frame.geometricVisibility);
      }
      pass.end();
    };

    draw(targets.visibleView, 'selectedVisible', frame.selected);
    if (frame.hovered.length > 0 || (instancedFrame?.hovered.length ?? 0) > 0) {
      draw(targets.visibleView, 'hoverVisible', frame.hovered.map((h, i) => ({
        vertexBuffer: h.vertexBuffer, indexBuffer: h.indexBuffer, indexCount: h.indexCount, ...(h.indexFormat ? { indexFormat: h.indexFormat } : {}), bindGroup: this.hoverGroup(h, i), vertexStride: h.vertexStride, quantized: h.quantized,
      })));
    }
    draw(targets.allView, 'selectedAll', frame.selected);

    return targets.views;
  }

  private ensureInstanced(): InstancedSelectionMask {
    this.instanced ??= new InstancedSelectionMask(this.device, this.meshBindGroupLayout, this.sampleCount);
    return this.instanced;
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
    const make = (label: string, format: GPUTextureFormat, sampleCount = 1) => this.device.createTexture({
      label,
      size: { width, height },
      format, sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const visible = make('selection-mask-visible', MASK_VISIBLE_FORMAT);
    const all = make('selection-mask-all', MASK_ALL_FORMAT);
    const multisampledVisible = this.sampleCount > 1 ? make('selection-mask-visible-msaa', MASK_VISIBLE_FORMAT, this.sampleCount) : null;
    const multisampledVisibleView = multisampledVisible?.createView() ?? null;
    const visibleView = visible.createView();
    const allView = all.createView();
    this.targets = { width, height, visible, all, visibleView, allView, multisampledVisible, multisampledVisibleView, views: { visibleView, allView } };
    return this.targets;
  }

  /** The mask targets while allocated, for render-target telemetry. */
  renderTargets(): (GPUTexture | null)[] {
    const t = this.targets;
    return [t?.visible ?? null, t?.all ?? null, t?.multisampledVisible ?? null];
  }

  /**
   * Free the screen-sized mask targets (the next `encode` reallocates them).
   * The post-pass chain calls this once nothing has been selected or hovered
   * for a while, so an outline used once does not pin them for the session.
   */
  releaseTargets(): void {
    this.targets?.visible.destroy();
    this.targets?.all.destroy();
    this.targets?.multisampledVisible?.destroy();
    this.targets = null;
  }

  /** Release every GPU resource. Idempotent; the pass is unusable afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseTargets();
    for (const entry of this.hoverUniforms) entry.buffer.destroy();
    this.hoverUniforms = [];
    this.instanced?.destroy();
    this.instanced = null;
    sectionExclusions(this.device).release();
  }
}
