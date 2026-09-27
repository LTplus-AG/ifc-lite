/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane renderer - renders a visible plane at the section cut location
 */

import { PIPELINE_CONSTANTS } from './constants.js';
import { RTE_FRAME_FLOATS, RTE_ORIGIN_FLOATS, type RelativeToEyeFrame } from './relative-to-eye.js';
import { relativeToEyeWgsl } from './shaders/relative-to-eye.wgsl.js';
import {
  calculateSectionPlaneVertices,
  calculateSectionPlaneVerticesFromNormal,
  type SectionPlaneAxis,
  type SectionPlaneBounds,
} from './section-plane-geometry.js';

/** Float offsets matching the WGSL `Uniforms` record below. */
export const SECTION_PLANE_UNIFORM_SLOTS = {
  rteViewProj: 0,
  planeColor: RTE_FRAME_FLOATS,
  drawableDelta: RTE_FRAME_FLOATS + 4,
} as const;
export const SECTION_PLANE_UNIFORM_FLOATS = RTE_FRAME_FLOATS + 4 + RTE_ORIGIN_FLOATS;

export interface SectionPlaneRenderOptions {
  axis: SectionPlaneAxis;  // Semantic axis names: down (Y), front (Z), side (X)
  position: number; // 0-100 percentage
  bounds: SectionPlaneBounds;
  /**
   * The camera-owned translation-free frame. Its f64 camera coordinate is
   * used to form the drawable delta before either value reaches the GPU.
   * When omitted, `viewProj` preserves the legacy absolute-world preview path.
   */
  relativeToEyeFrame?: RelativeToEyeFrame;
  /**
   * Legacy world-space view-projection. Required when `relativeToEyeFrame` is
   * omitted; the resulting f32 preview intentionally has the pre-RTE precision
   * characteristics, while keeping established callers renderable.
   */
  viewProj?: Float32Array;
  /**
   * Declared but never read. `SectionPlaneRenderer.render()` never consults
   * it, so the gizmo quad looks identical either way — this field cannot
   * "show the opposite side indicator". Note that the actual GPU clip plane
   * is flipped correctly elsewhere (`scene-raycaster.ts` and `point-picker.ts`
   * read a `flipped` off their own section-plane state), so cutting behaviour
   * is unaffected; only this gizmo option is inert. Slated for removal; see
   * issue #2731.
   *
   * @deprecated Ignored by the gizmo renderer — see above.
   */
  flipped?: boolean;
  isPreview?: boolean; // If true, render as preview (less opacity)
  min?: number;      // Optional override for min range value
  max?: number;      // Optional override for max range value
  /**
   * Optional explicit plane normal (unit vector) and signed distance from
   * origin. When both are provided, the gizmo is placed on that world-space
   * plane and its quad is built from the deterministic in-plane basis
   * (`planeBasis(normal)`) shared with the cap renderer — `axis` /
   * `position` / `min` / `max` are ignored on this path.
   */
  normal?: [number, number, number];
  distance?: number;
}

export class SectionPlaneRenderer {
  private device: GPUDevice;
  private bindGroupLayout: GPUBindGroupLayout | null = null;  // Shared layout for both pipelines
  private previewPipeline: GPURenderPipeline | null = null;   // With depth test (respects geometry)
  private cutPipeline: GPURenderPipeline | null = null;       // No depth test (always visible)
  private vertexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private format: GPUTextureFormat;
  private sampleCount: number;
  private initialized = false;
  // One accent tint for every axis and for face-picked planes (#5484):
  // set by `Renderer.setOverlayTheme`. Reproduces the historic "down"-axis
  // colour (#03A9F4) until a theme is pushed, so a caller that never calls
  // `setOverlayTheme` sees no visual change.
  private planeColor: readonly [number, number, number, number] = [0.012, 0.663, 0.957, 1];

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount: number = 4) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
  }

  /** Set the accent tint used for the preview plane, every axis alike (#5484). RGBA 0..1. */
  setPlaneColor(color: readonly [number, number, number, number]): void {
    this.planeColor = color;
  }

  private init(): void {
    if (this.initialized) return;

    // Create explicit bind group layout (shared between both pipelines)
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Create pipeline layout using the shared bind group layout
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Create shader for section plane rendering
    const shaderModule = this.device.createShaderModule({
      code: `${relativeToEyeWgsl}
        struct Uniforms {
          rteFrame: RteFrameUniform,
          planeColor: vec4<f32>,
          drawable: RteDrawableUniform,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) uv: vec2<f32>,
        }

        @vertex
        fn vs_main(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
          var output: VertexOutput;
          output.position = uniforms.rteFrame.viewProj * rteWorldPosition(position, uniforms.drawable);
          output.uv = uv;
          return output;
        }

        // Two outputs so the pipeline matches the main pass's two colour
        // attachments. objectId is masked off at the pipeline level.
        struct FragOut {
          @location(0) color:    vec4<f32>,
          @location(1) objectId: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragOut {
          // Create fine grid pattern
          let gridSize = 0.01;           // Fine grid cells (100 divisions)
          let lineWidth = 0.001;         // Very thin lines
          let majorGridSize = 0.1;       // Major grid every 10 cells
          let majorLineWidth = 0.002;    // Slightly thicker major lines

          // Minor grid
          let gridX = abs(fract(input.uv.x / gridSize + 0.5) - 0.5);
          let gridY = abs(fract(input.uv.y / gridSize + 0.5) - 0.5);
          let isMinorGridLine = min(gridX, gridY) < lineWidth;

          // Major grid (every 10 cells)
          let majorX = abs(fract(input.uv.x / majorGridSize + 0.5) - 0.5);
          let majorY = abs(fract(input.uv.y / majorGridSize + 0.5) - 0.5);
          let isMajorGridLine = min(majorX, majorY) < majorLineWidth;

          // Soft edge fade
          let edgeDist = min(input.uv.x, min(input.uv.y, min(1.0 - input.uv.x, 1.0 - input.uv.y)));
          let edgeFade = smoothstep(0.0, 0.08, edgeDist);

          // Subtle border
          let borderGlow = 1.0 - smoothstep(0.0, 0.03, edgeDist);

          var color = uniforms.planeColor;

          // Layered rendering: base fill + minor grid + major grid + border
          if (isMajorGridLine) {
            // Major grid lines - subtle white
            color = vec4<f32>(1.0, 1.0, 1.0, color.a * 1.5);
          } else if (isMinorGridLine) {
            // Minor grid lines - slightly brighter
            color = vec4<f32>(color.rgb * 1.3, color.a * 1.2);
          }

          // Add subtle border
          color = vec4<f32>(
            mix(color.rgb, vec3<f32>(1.0, 1.0, 1.0), borderGlow * 0.3),
            color.a + borderGlow * 0.2
          );

          // Apply edge fade
          color.a *= edgeFade;

          // Clamp alpha
          color.a = min(color.a, 0.5);

          var out: FragOut;
          out.color    = color;
          out.objectId = vec4<f32>(0.0, 0.0, 0.0, 0.0);
          return out;
        }
      `,
    });

    // Shared pipeline config (now using explicit layout)
    const pipelineBase = {
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 20, // 3 position + 2 uv = 5 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
              { shaderLocation: 1, offset: 12, format: 'float32x2' as const },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        // The main render pass has two colour attachments (main colour +
        // the picker's objectId texture). WebGPU requires every pipeline
        // used inside a pass to declare exactly the same target count and
        // formats. The preview plane only paints into the main colour
        // target — the objectId target is declared with writeMask 0 so
        // cap-less picking IDs underneath are preserved. Without this,
        // `setPipeline` raises "Incompatible color attachments at
        // indices []: RenderPass uses formats [Bgra8Unorm, Rgba8Unorm]
        // but RenderPipeline uses formats [Bgra8Unorm]" and the whole
        // frame is dropped.
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
              alpha: {
                srcFactor: 'one' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
            },
          },
          { format: 'rgba8unorm' as const, writeMask: 0 },
        ],
      },
      primitive: {
        topology: 'triangle-list' as const,
        cullMode: 'none' as const,
      },
      multisample: {
        count: this.sampleCount,
      },
    };

    // Preview pipeline: only draw where there's NO geometry (behind/around building)
    this.previewPipeline = this.device.createRenderPipeline({
      ...pipelineBase,
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: 'greater',  // Only draw where plane is behind geometry (empty space)
      },
    });

    // Cut pipeline: always visible (shows where the cut is)
    this.cutPipeline = this.device.createRenderPipeline({
      ...pipelineBase,
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: 'always',  // Always draw on top
      },
    });

    // Create vertex buffer (6 vertices for 2 triangles)
    this.vertexBuffer = this.device.createBuffer({
      size: 6 * 5 * 4, // 6 vertices * 5 floats * 4 bytes
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Create uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: SECTION_PLANE_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group using explicit layout (compatible with both pipelines)
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
      ],
    });

    this.initialized = true;
  }

  /**
   * Draw section plane into an existing render pass (preferred - avoids MSAA mismatch)
   */
  draw(
    pass: GPURenderPassEncoder,
    options: SectionPlaneRenderOptions
  ): void {
    this.init();

    if (!this.previewPipeline || !this.cutPipeline || !this.vertexBuffer || !this.uniformBuffer || !this.bindGroup) {
      return;
    }

    const { axis, position, bounds, relativeToEyeFrame, viewProj, isPreview, min: minOverride, max: maxOverride, normal, distance } = options;

    // Only draw section plane in preview mode - hide it during active cutting
    if (!isPreview || (!relativeToEyeFrame && !viewProj)) {
      return;
    }

    const hasExplicitPlane =
      normal !== undefined &&
      distance !== undefined &&
      Number.isFinite(distance);

    // Calculate plane vertices based on axis and bounds, OR from an
    // arbitrary normal+distance when face-pick has provided one.
    const vertices = hasExplicitPlane
      ? calculateSectionPlaneVerticesFromNormal(normal!, distance!, bounds)
      : calculateSectionPlaneVertices(axis, position, bounds, minOverride, maxOverride);
    const origin: [number, number, number] = [vertices[0], vertices[1], vertices[2]];
    const vertexData = new Float32Array(vertices.length);
    if (relativeToEyeFrame) {
      for (let i = 0; i < vertices.length; i += 5) {
        vertexData[i] = vertices[i] - origin[0]; vertexData[i + 1] = vertices[i + 1] - origin[1]; vertexData[i + 2] = vertices[i + 2] - origin[2];
        vertexData[i + 3] = vertices[i + 3]; vertexData[i + 4] = vertices[i + 4];
      }
    } else {
      // The pre-RTE API supplied a world-space viewProj and world-space f32
      // vertices. Keep that contract for callers that have not adopted a
      // camera frame; new renderer paths always take the branch above.
      vertexData.set(vertices);
    }
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertexData);

    // Update uniforms
    const uniforms = new Float32Array(SECTION_PLANE_UNIFORM_FLOATS);
    if (relativeToEyeFrame) {
      relativeToEyeFrame.packUniforms(uniforms, SECTION_PLANE_UNIFORM_SLOTS.rteViewProj);
      // Outside this camera's RTE envelope: not rasterisable this frame (#6128).
      if (!relativeToEyeFrame.tryPackDrawableOrigin(origin, uniforms, SECTION_PLANE_UNIFORM_SLOTS.drawableDelta)) return;
    } else {
      uniforms.set(viewProj!, SECTION_PLANE_UNIFORM_SLOTS.rteViewProj);
    }

    // One accent tint for every axis, and for face-picked (custom) planes
    // alike (#5484) — set by `Renderer.setOverlayTheme`, no more per-axis
    // Material colours or the custom violet.
    uniforms[SECTION_PLANE_UNIFORM_SLOTS.planeColor] = this.planeColor[0];
    uniforms[SECTION_PLANE_UNIFORM_SLOTS.planeColor + 1] = this.planeColor[1];
    uniforms[SECTION_PLANE_UNIFORM_SLOTS.planeColor + 2] = this.planeColor[2];
    // Preview mode opacity
    uniforms[SECTION_PLANE_UNIFORM_SLOTS.planeColor + 3] = 0.25;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    // Draw section plane with preview pipeline (respects depth)
    pass.setPipeline(this.previewPipeline!);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(6); // 2 triangles
  }

  /**
   * Destroy all GPU resources held by this section-plane renderer.
   * After calling this method the renderer is no longer usable.
   * Safe to call multiple times.
   */
  destroy(): void {
    this.vertexBuffer?.destroy();
    this.vertexBuffer = null;
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.initialized = false;
  }
}
