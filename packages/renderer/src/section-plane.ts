/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane renderer - renders a visible plane at the section cut location
 */

import { PIPELINE_CONSTANTS } from './constants.js';

export interface SectionPlaneRenderOptions {
  axis: 'down' | 'front' | 'side';  // Semantic axis names: down (Y), front (Z), side (X)
  position: number; // 0-100 percentage
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  viewProj: Float32Array;
  flipped?: boolean; // If true, show the opposite side indicator
  isPreview?: boolean; // If true, render as preview (less opacity)
  min?: number;      // Optional override for min range value
  max?: number;      // Optional override for max range value
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

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount: number = 4) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
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
      code: `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          planeColor: vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) uv: vec2<f32>,
        }

        @vertex
        fn vs_main(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
          var output: VertexOutput;
          output.position = uniforms.viewProj * vec4<f32>(position, 1.0);
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
      size: 80, // mat4x4 (64) + vec4 (16) = 80 bytes
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

    const { axis, position, bounds, viewProj, isPreview, min: minOverride, max: maxOverride } = options;

    // Only draw section plane in preview mode - hide it during active cutting
    if (!isPreview) {
      return;
    }

    // Calculate plane vertices based on axis and bounds
    const vertices = this.calculatePlaneVertices(axis, position, bounds, 0, minOverride, maxOverride);
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

    // Update uniforms
    const uniforms = new Float32Array(20);
    uniforms.set(viewProj, 0);

    // Axis-specific colors for better identification
    // down (Y) = light blue, front (Z) = green, side (X) = orange
    if (axis === 'down') {
      uniforms[16] = 0.012; // R - #03A9F4
      uniforms[17] = 0.663; // G
      uniforms[18] = 0.957; // B
    } else if (axis === 'front') {
      uniforms[16] = 0.298; // R - #4CAF50
      uniforms[17] = 0.686; // G
      uniforms[18] = 0.314; // B
    } else {
      uniforms[16] = 1.0;   // R - #FF9800
      uniforms[17] = 0.596; // G
      uniforms[18] = 0.0;   // B
    }
    // Preview mode opacity
    uniforms[19] = 0.25;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    // Draw section plane with preview pipeline (respects depth)
    pass.setPipeline(this.previewPipeline!);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(6); // 2 triangles
  }

  private calculatePlaneVertices(
    axis: 'down' | 'front' | 'side',
    position: number,
    bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
    inset: number = 0,  // 0 = full size, 0.15 = 15% smaller on each side
    minOverride?: number,
    maxOverride?: number
  ): Float32Array {
    const { min, max } = bounds;

    // Calculate base size with 10% padding for preview
    const basePadding = 0.1;
    const effectiveScale = (1 + basePadding) * (1 - inset * 2);
    const sizeX = (max.x - min.x) * effectiveScale;
    const sizeY = (max.y - min.y) * effectiveScale;
    const sizeZ = (max.z - min.z) * effectiveScale;
    const centerX = (min.x + max.x) / 2;
    const centerY = (min.y + max.y) / 2;
    const centerZ = (min.z + max.z) / 2;

    // Calculate the plane position along the axis
    const t = position / 100;
    const axisIdx = axis === 'side' ? 'x' : axis === 'down' ? 'y' : 'z';
    const axisMin = minOverride ?? min[axisIdx];
    const axisMax = maxOverride ?? max[axisIdx];

    let vertices: number[] = [];

    if (axis === 'side') {
      // Side = X axis (YZ plane)
      const x = axisMin + t * (axisMax - axisMin);
      const halfY = sizeY / 2;
      const halfZ = sizeZ / 2;
      // Quad facing X axis (vertices in YZ plane)
      vertices = [
        // Triangle 1
        x, centerY - halfY, centerZ - halfZ, 0, 0,
        x, centerY + halfY, centerZ - halfZ, 1, 0,
        x, centerY + halfY, centerZ + halfZ, 1, 1,
        // Triangle 2
        x, centerY - halfY, centerZ - halfZ, 0, 0,
        x, centerY + halfY, centerZ + halfZ, 1, 1,
        x, centerY - halfY, centerZ + halfZ, 0, 1,
      ];
    } else if (axis === 'down') {
      // Down = Y axis (XZ plane) - horizontal cut
      const y = axisMin + t * (axisMax - axisMin);
      const halfX = sizeX / 2;
      const halfZ = sizeZ / 2;
      // Quad facing Y axis (vertices in XZ plane)
      vertices = [
        // Triangle 1
        centerX - halfX, y, centerZ - halfZ, 0, 0,
        centerX + halfX, y, centerZ - halfZ, 1, 0,
        centerX + halfX, y, centerZ + halfZ, 1, 1,
        // Triangle 2
        centerX - halfX, y, centerZ - halfZ, 0, 0,
        centerX + halfX, y, centerZ + halfZ, 1, 1,
        centerX - halfX, y, centerZ + halfZ, 0, 1,
      ];
    } else {
      // Front = Z axis (XY plane)
      const z = axisMin + t * (axisMax - axisMin);
      const halfX = sizeX / 2;
      const halfY = sizeY / 2;
      // Quad facing Z axis (vertices in XY plane)
      vertices = [
        // Triangle 1
        centerX - halfX, centerY - halfY, z, 0, 0,
        centerX + halfX, centerY - halfY, z, 1, 0,
        centerX + halfX, centerY + halfY, z, 1, 1,
        // Triangle 2
        centerX - halfX, centerY - halfY, z, 0, 0,
        centerX + halfX, centerY + halfY, z, 1, 1,
        centerX - halfX, centerY + halfY, z, 0, 1,
      ];
    }

    return new Float32Array(vertices);
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
