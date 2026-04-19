/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 2D Overlay Renderer
 *
 * Renders 2D section drawings (cut polygons, outlines, hatching) as a 3D overlay
 * on the section plane in the WebGPU viewport. This provides an integrated view
 * where the architectural drawing appears directly on the section cut surface.
 */

export interface Section2DOverlayOptions {
  axis: 'down' | 'front' | 'side';  // Semantic axis: down (Y), front (Z), side (X)
  position: number; // 0-100 percentage
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  viewProj: Float32Array;
  flipped?: boolean;
  min?: number;  // Optional override for min range
  max?: number;  // Optional override for max range
}

export interface CutPolygon2D {
  polygon: {
    outer: Array<{ x: number; y: number }>;
    holes: Array<Array<{ x: number; y: number }>>;
  };
  ifcType: string;
  expressId: number;
}

export interface DrawingLine2D {
  line: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  category: string;
}

// Fill colors by IFC type (architectural convention)
const IFC_TYPE_FILL_COLORS: Record<string, [number, number, number, number]> = {
  IfcWall: [0.69, 0.69, 0.69, 0.95],
  IfcWallStandardCase: [0.69, 0.69, 0.69, 0.95],
  IfcColumn: [0.56, 0.56, 0.56, 0.95],
  IfcBeam: [0.56, 0.56, 0.56, 0.95],
  IfcSlab: [0.78, 0.78, 0.78, 0.95],
  IfcRoof: [0.82, 0.82, 0.82, 0.95],
  IfcFooting: [0.50, 0.50, 0.50, 0.95],
  IfcPile: [0.44, 0.44, 0.44, 0.95],
  IfcWindow: [0.91, 0.96, 0.99, 0.7],
  IfcDoor: [0.96, 0.90, 0.83, 0.95],
  IfcStair: [0.85, 0.85, 0.85, 0.95],
  IfcStairFlight: [0.85, 0.85, 0.85, 0.95],
  IfcRailing: [0.75, 0.75, 0.75, 0.95],
  IfcPipeSegment: [0.63, 0.82, 1.0, 0.95],
  IfcDuctSegment: [0.75, 1.0, 0.75, 0.95],
  IfcFurnishingElement: [1.0, 0.88, 0.75, 0.95],
  IfcSpace: [0.94, 0.94, 0.94, 0.5],
  default: [0.82, 0.82, 0.82, 0.95],
};

function getFillColor(ifcType: string): [number, number, number, number] {
  return IFC_TYPE_FILL_COLORS[ifcType] || IFC_TYPE_FILL_COLORS.default;
}

export class Section2DOverlayRenderer {
  private device: GPUDevice;
  private fillPipeline: GPURenderPipeline | null = null;
  private linePipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private format: GPUTextureFormat;
  private sampleCount: number;
  private initialized = false;

  // Cached geometry buffers
  private fillVertexBuffer: GPUBuffer | null = null;
  private fillIndexBuffer: GPUBuffer | null = null;
  private fillIndexCount = 0;
  private lineVertexBuffer: GPUBuffer | null = null;
  private lineVertexCount = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount: number = 4) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
  }

  private init(): void {
    if (this.initialized) return;

    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Shader for filled polygons (with vertex colors)
    const fillShader = this.device.createShaderModule({
      code: `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          planeOffset: vec4<f32>,  // Small offset to render slightly in front of section plane
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) color: vec4<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) color: vec4<f32>,
        }

        @vertex
        fn vs_main(input: VertexInput) -> VertexOutput {
          var output: VertexOutput;
          let offsetPos = input.position + uniforms.planeOffset.xyz;
          output.position = uniforms.viewProj * vec4<f32>(offsetPos, 1.0);
          output.color = input.color;
          return output;
        }

        // Two outputs to match the main render pass's colour attachments.
        // Location 1 is masked off at the pipeline level so cap-less
        // picking IDs underneath are preserved.
        struct FragOut {
          @location(0) color:    vec4<f32>,
          @location(1) objectId: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragOut {
          var out: FragOut;
          out.color    = input.color;
          out.objectId = vec4<f32>(0.0, 0.0, 0.0, 0.0);
          return out;
        }
      `,
    });

    // Shader for lines (uniform color)
    const lineShader = this.device.createShaderModule({
      code: `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          planeOffset: vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexInput {
          @location(0) position: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
        }

        @vertex
        fn vs_main(input: VertexInput) -> VertexOutput {
          var output: VertexOutput;
          let offsetPos = input.position + uniforms.planeOffset.xyz;
          output.position = uniforms.viewProj * vec4<f32>(offsetPos, 1.0);
          return output;
        }

        struct FragOutLine {
          @location(0) color:    vec4<f32>,
          @location(1) objectId: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragOutLine {
          var out: FragOutLine;
          out.color    = vec4<f32>(0.0, 0.0, 0.0, 1.0);  // Black lines
          out.objectId = vec4<f32>(0.0, 0.0, 0.0, 0.0);
          return out;
        }
      `,
    });

    // Pipeline for filled polygons
    this.fillPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: fillShader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 28, // 3 position + 4 color = 7 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
              { shaderLocation: 1, offset: 12, format: 'float32x4' as const },
            ],
          },
        ],
      },
      fragment: {
        module: fillShader,
        entryPoint: 'fs_main',
        // The main render pass has two colour attachments (main colour +
        // picker objectId). Pipelines used inside that pass must declare
        // matching targets — the objectId slot writes nothing so the pass's
        // picking IDs underneath are preserved.
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
      depthStencil: {
        format: 'depth24plus-stencil8' as const,
        depthWriteEnabled: false,
        depthCompare: 'always' as const,  // Always draw - overlay is positioned with fixed offset
      },
      multisample: {
        count: this.sampleCount,
      },
    });

    // Pipeline for lines
    this.linePipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: lineShader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 12, // 3 position floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
            ],
          },
        ],
      },
      fragment: {
        module: lineShader,
        entryPoint: 'fs_main',
        targets: [
          { format: this.format },
          { format: 'rgba8unorm' as const, writeMask: 0 },
        ],
      },
      primitive: {
        topology: 'line-list' as const,
        cullMode: 'none' as const,
      },
      depthStencil: {
        format: 'depth24plus-stencil8' as const,
        depthWriteEnabled: false,
        depthCompare: 'always' as const,  // Always draw - overlay is positioned with fixed offset
      },
      multisample: {
        count: this.sampleCount,
      },
    });

    // Create uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: 80, // mat4x4 (64) + vec4 (16)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
      ],
    });

    this.initialized = true;
  }

  /**
   * Transform 2D coordinates to 3D coordinates on the section plane
   *
   * The 2D projection in drawing-2d/math.ts uses:
   * - Y axis (down): 2D (x, y) = 3D (x, z) - looking down at XZ plane
   * - Z axis (front): 2D (x, y) = 3D (x, y) - looking along Z at XY plane
   * - X axis (side): 2D (x, y) = 3D (z, y) - looking along X at ZY plane
   *
   * When flipped: x is negated in the 2D projection
   */
  private transform2Dto3D(
    x2d: number,
    y2d: number,
    axis: 'down' | 'front' | 'side',
    planePosition: number,
    flipped: boolean = false
  ): [number, number, number] {
    // Handle flipped - the 2D x coordinate was negated during projection
    const x = flipped ? -x2d : x2d;

    switch (axis) {
      case 'down': // Y axis - horizontal cut (floor plan)
        // 2D.x = 3D.x, 2D.y = 3D.z -> 3D (x, planeY, y)
        return [x, planePosition, y2d];
      case 'front': // Z axis - vertical cut (section view)
        // 2D.x = 3D.x, 2D.y = 3D.y -> 3D (x, y, planeZ)
        return [x, y2d, planePosition];
      case 'side': // X axis - vertical cut (side elevation)
        // 2D.x = 3D.z, 2D.y = 3D.y -> 3D (planeX, y, x)
        return [planePosition, y2d, x];
    }
  }

  /**
   * Upload 2D drawing data to GPU buffers
   */
  uploadDrawing(
    polygons: CutPolygon2D[],
    lines: DrawingLine2D[],
    axis: 'down' | 'front' | 'side',
    planePosition: number,
    flipped: boolean = false
  ): void {
    this.init();

    // Clean up old buffers and reset counts
    if (this.fillVertexBuffer) {
      this.fillVertexBuffer.destroy();
      this.fillVertexBuffer = null;
    }
    if (this.fillIndexBuffer) {
      this.fillIndexBuffer.destroy();
      this.fillIndexBuffer = null;
    }
    if (this.lineVertexBuffer) {
      this.lineVertexBuffer.destroy();
      this.lineVertexBuffer = null;
    }
    this.fillIndexCount = 0;
    this.lineVertexCount = 0;

    // Build fill geometry (triangulated polygons)
    const fillVertices: number[] = [];
    const fillIndices: number[] = [];
    let vertexOffset = 0;

    for (const polygon of polygons) {
      const color = getFillColor(polygon.ifcType);
      const outer = polygon.polygon.outer;

      if (outer.length < 3) continue;

      // KNOWN LIMITATION: Simple fan triangulation for convex polygons only.
      // This produces correct results for most architectural elements (walls, slabs, etc.)
      // but may render incorrectly for:
      // - Concave polygons (e.g., L-shaped openings)
      // - Polygons with holes (e.g., windows in walls)
      // For production use with complex geometry, consider implementing ear clipping
      // (e.g., using earcut library) or constrained Delaunay triangulation.
      // Note: The 2D canvas/SVG rendering in Section2DPanel handles holes correctly.
      const baseVertex = vertexOffset;

      for (const point of outer) {
        const [x3d, y3d, z3d] = this.transform2Dto3D(point.x, point.y, axis, planePosition, flipped);
        fillVertices.push(x3d, y3d, z3d, color[0], color[1], color[2], color[3]);
        vertexOffset++;
      }

      // Fan triangulation from first vertex
      for (let i = 1; i < outer.length - 1; i++) {
        fillIndices.push(baseVertex, baseVertex + i, baseVertex + i + 1);
      }
    }

    // Create fill buffers
    if (fillVertices.length > 0) {
      const fillVertexData = new Float32Array(fillVertices);
      this.fillVertexBuffer = this.device.createBuffer({
        size: fillVertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.fillVertexBuffer, 0, fillVertexData);

      const fillIndexData = new Uint32Array(fillIndices);
      this.fillIndexBuffer = this.device.createBuffer({
        size: fillIndexData.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.fillIndexBuffer, 0, fillIndexData);
      this.fillIndexCount = fillIndices.length;
    }

    // Build line geometry
    const lineVertices: number[] = [];

    // Polygon outlines
    for (const polygon of polygons) {
      const outer = polygon.polygon.outer;
      for (let i = 0; i < outer.length; i++) {
        const p1 = outer[i];
        const p2 = outer[(i + 1) % outer.length];
        const [x1, y1, z1] = this.transform2Dto3D(p1.x, p1.y, axis, planePosition, flipped);
        const [x2, y2, z2] = this.transform2Dto3D(p2.x, p2.y, axis, planePosition, flipped);
        lineVertices.push(x1, y1, z1, x2, y2, z2);
      }

      // Hole outlines
      for (const hole of polygon.polygon.holes) {
        for (let i = 0; i < hole.length; i++) {
          const p1 = hole[i];
          const p2 = hole[(i + 1) % hole.length];
          const [x1, y1, z1] = this.transform2Dto3D(p1.x, p1.y, axis, planePosition, flipped);
          const [x2, y2, z2] = this.transform2Dto3D(p2.x, p2.y, axis, planePosition, flipped);
          lineVertices.push(x1, y1, z1, x2, y2, z2);
        }
      }
    }

    // Additional drawing lines (hatching, etc.)
    for (const line of lines) {
      const [x1, y1, z1] = this.transform2Dto3D(line.line.start.x, line.line.start.y, axis, planePosition, flipped);
      const [x2, y2, z2] = this.transform2Dto3D(line.line.end.x, line.line.end.y, axis, planePosition, flipped);
      lineVertices.push(x1, y1, z1, x2, y2, z2);
    }

    // Create line buffer
    if (lineVertices.length > 0) {
      const lineVertexData = new Float32Array(lineVertices);
      this.lineVertexBuffer = this.device.createBuffer({
        size: lineVertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.lineVertexBuffer, 0, lineVertexData);
      this.lineVertexCount = lineVertices.length / 3;  // Each vertex is 3 floats
    }
  }

  /**
   * Clear uploaded geometry
   */
  clearGeometry(): void {
    if (this.fillVertexBuffer) {
      this.fillVertexBuffer.destroy();
      this.fillVertexBuffer = null;
    }
    if (this.fillIndexBuffer) {
      this.fillIndexBuffer.destroy();
      this.fillIndexBuffer = null;
    }
    if (this.lineVertexBuffer) {
      this.lineVertexBuffer.destroy();
      this.lineVertexBuffer = null;
    }
    this.fillIndexCount = 0;
    this.lineVertexCount = 0;
  }

  /**
   * Check if there is geometry to draw
   */
  hasGeometry(): boolean {
    return this.fillIndexCount > 0 || this.lineVertexCount > 0;
  }

  /**
   * Draw the 2D overlay on the section plane
   */
  draw(
    pass: GPURenderPassEncoder,
    options: Section2DOverlayOptions
  ): void {
    this.init();

    if (!this.fillPipeline || !this.linePipeline || !this.uniformBuffer || !this.bindGroup) {
      return;
    }

    if (!this.hasGeometry()) {
      return;
    }

    const { axis, viewProj } = options;

    // Fixed offset to render overlay clearly above the section plane
    // Use 0.3m offset for clear visibility at any camera angle
    const offsetAmount = 0.3;  // 0.3m offset in world units
    let offset: [number, number, number] = [0, 0, 0];

    switch (axis) {
      case 'down':
        offset = [0, offsetAmount, 0];  // Y axis
        break;
      case 'front':
        offset = [0, 0, offsetAmount];  // Z axis
        break;
      case 'side':
        offset = [offsetAmount, 0, 0];  // X axis
        break;
    }

    // Update uniforms
    const uniforms = new Float32Array(20);
    uniforms.set(viewProj, 0);
    uniforms[16] = offset[0];
    uniforms[17] = offset[1];
    uniforms[18] = offset[2];
    uniforms[19] = 0;  // padding
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    // Note: Skip filled polygons in 3D overlay - they create visual artifacts
    // The fills are rendered properly in the 2D panel canvas instead

    // Draw lines only
    if (this.lineVertexBuffer && this.lineVertexCount > 0) {
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.lineVertexBuffer);
      pass.draw(this.lineVertexCount);
    }
  }

  /**
   * Dispose of GPU resources
   */
  dispose(): void {
    this.clearGeometry();
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
  }
}
