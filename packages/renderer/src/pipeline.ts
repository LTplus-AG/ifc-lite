/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU render pipeline setup
 */

import { WebGPUDevice } from './device.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import type { InstancedMesh } from './types.js';

export class RenderPipeline {
    private device: GPUDevice;
    private webgpuDevice: WebGPUDevice;
    private pipeline: GPURenderPipeline;
    private selectionPipeline: GPURenderPipeline;  // Pipeline for selected meshes (renders on top)
    private transparentPipeline: GPURenderPipeline;  // Pipeline for transparent meshes with alpha blending
    private overlayPipeline: GPURenderPipeline;  // Pipeline for color overlays (lens) - renders at exact same depth
    private depthTexture: GPUTexture;
    private depthTextureView: GPUTextureView;
    // depth-only view of depthTexture for sampling as texture_depth_2d in
    // post-processing. Required because depth24plus-stencil8 needs an explicit
    // aspect when bound as a depth texture.
    private depthOnlyTextureView: GPUTextureView;
    // stencil-only view — lets the cap quad read the stencil count as an
    // unsigned integer texture.
    private stencilTextureView: GPUTextureView;
    private objectIdTexture: GPUTexture;
    private objectIdTextureView: GPUTextureView;
    // depth24plus-stencil8: depth range is enough at reverse-Z precision, and
    // stencil8 lets SectionCapRenderer count back/front face intersections
    // with the clipping plane for filled cap rendering.
    private depthFormat: GPUTextureFormat = 'depth24plus-stencil8';
    private colorFormat: GPUTextureFormat;
    private objectIdFormat: GPUTextureFormat = 'rgba8unorm';
    private multisampleTexture: GPUTexture | null = null;
    private multisampleTextureView: GPUTextureView | null = null;
    private sampleCount: number = 4;  // MSAA sample count
    private uniformBuffer: GPUBuffer;
    private bindGroup: GPUBindGroup;
    private bindGroupLayout: GPUBindGroupLayout;  // Explicit layout shared between pipelines
    private currentWidth: number;
    private currentHeight: number;

    constructor(device: WebGPUDevice, width: number = 1, height: number = 1) {
        this.currentWidth = width;
        this.currentHeight = height;
        this.webgpuDevice = device;
        this.device = device.getDevice();
        this.colorFormat = device.getFormat();

        // Check MSAA support and adjust sample count
        // 4x MSAA provides good anti-aliasing for thin geometry
        const maxSampleCount = (this.device.limits as unknown as Record<string, number>)?.maxSampleCount ?? 4;
        this.sampleCount = Math.min(4, maxSampleCount);

        // Create depth texture with MSAA support
        this.depthTexture = this.device.createTexture({
            size: { width, height },
            format: this.depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount: this.sampleCount > 1 ? this.sampleCount : 1,
        });
        this.depthTextureView = this.depthTexture.createView();
        this.depthOnlyTextureView = this.depthTexture.createView({ aspect: 'depth-only' });
        this.stencilTextureView = this.depthTexture.createView({ aspect: 'stencil-only' });
        this.objectIdTexture = this.device.createTexture({
            size: { width, height },
            format: this.objectIdFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount: this.sampleCount > 1 ? this.sampleCount : 1,
        });
        this.objectIdTextureView = this.objectIdTexture.createView();

        // Create multisample color texture for MSAA
        if (this.sampleCount > 1) {
            this.multisampleTexture = this.device.createTexture({
                size: { width, height },
                format: this.colorFormat,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
                sampleCount: this.sampleCount,
            });
            this.multisampleTextureView = this.multisampleTexture.createView();
        }

        // Create uniform buffer for camera matrices, PBR material, and section plane
        // Layout: viewProj (64 bytes) + model (64 bytes) + baseColor (16 bytes) + metallicRoughness (8 bytes) +
        //         sectionPlane (16 bytes: vec3 normal + float position) + flags (16 bytes: u32 isSelected + u32 sectionEnabled + padding) = 192 bytes
        // WebGPU requires uniform buffers to be aligned to 16 bytes
        this.uniformBuffer = this.device.createBuffer({
            size: 192, // 12 * 16 bytes = properly aligned
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create explicit bind group layout (shared between main and selection pipelines)
        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        // Create shader module with PBR lighting, section plane clipping, and selection outline
        const shaderModule = this.device.createShaderModule({
            code: mainShaderSource,
        });

        // Create explicit pipeline layout (shared between main and selection pipelines)
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        // Create render pipeline descriptor
        const pipelineDescriptor: GPURenderPipelineDescriptor = {
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 28, // 7 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
                            { shaderLocation: 2, offset: 24, format: 'uint32' }, // expressId
                        ],
                    },
                ],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.colorFormat }, { format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none', // Disable culling to debug - IFC winding order varies
            },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: true,
                depthCompare: 'greater',  // Reverse-Z: greater instead of less
                // The old stencil-based cap needed a "below-plane geometry
                // was drawn here" marker in bit 1; the 2D-polygon-driven cap
                // uses exact silhouettes from SectionCutter instead, so no
                // stencil state is required on the main pipeline.
            },
            // MSAA configuration - must match render pass attachment sample count
            multisample: {
                count: this.sampleCount,
            },
        } as GPURenderPipelineDescriptor;

        this.pipeline = this.device.createRenderPipeline(pipelineDescriptor);

        // Create selection pipeline descriptor
        const selectionPipelineDescriptor: GPURenderPipelineDescriptor = {
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 28,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                            { shaderLocation: 1, offset: 12, format: 'float32x3' },
                            { shaderLocation: 2, offset: 24, format: 'uint32' },
                        ],
                    },
                ],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.colorFormat }, { format: 'rgba8unorm' }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: false,  // Don't overwrite depth - selected objects render on top of existing depth
                depthCompare: 'greater-equal',  // Allow rendering at same depth, but still respect objects in front
                depthBias: 0,
                depthBiasSlopeScale: 0,
            },
            // MSAA configuration - must match render pass attachment sample count
            multisample: {
                count: this.sampleCount,
            },
        } as GPURenderPipelineDescriptor;

        this.selectionPipeline = this.device.createRenderPipeline(selectionPipelineDescriptor);

        // Create transparent pipeline descriptor (same shader, but with alpha blending)
        const transparentPipelineDescriptor: GPURenderPipelineDescriptor = {
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 28,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                            { shaderLocation: 1, offset: 12, format: 'float32x3' },
                            { shaderLocation: 2, offset: 24, format: 'uint32' },
                        ],
                    },
                ],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.colorFormat,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                        },
                    },
                }, { format: this.objectIdFormat }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: false,  // Don't write depth for transparent objects
                depthCompare: 'greater',   // Still test depth to respect opaque objects
            },
            // MSAA configuration - must match render pass attachment sample count
            multisample: {
                count: this.sampleCount,
            },
        } as GPURenderPipelineDescriptor;

        this.transparentPipeline = this.device.createRenderPipeline(transparentPipelineDescriptor);

        // Create overlay pipeline for lens color overrides
        // Uses depthCompare 'equal' so it ONLY renders where original geometry already wrote depth.
        // This prevents hidden entities from "leaking through" overlay batches.
        // depthWriteEnabled: false — don't disturb the depth buffer for subsequent passes.
        //
        // Src-alpha blending on the COLOR target only — the second target is the
        // objectId buffer used for GPU picking and must stay unblended so low-alpha
        // ghosts don't corrupt picks. With srcFactor=src-alpha, alpha=1.0 callers
        // (lens, active-phase paints) still composite fully opaque, so this is
        // backward-compatible for every caller that doesn't set alpha < 1.
        const overlayPipelineDescriptor: GPURenderPipelineDescriptor = {
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 28,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                            { shaderLocation: 1, offset: 12, format: 'float32x3' },
                            { shaderLocation: 2, offset: 24, format: 'uint32' },
                        ],
                    },
                ],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [
                    {
                        format: this.colorFormat,
                        blend: {
                            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                        },
                    },
                    { format: 'rgba8unorm' },
                ],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: false,
                depthCompare: 'equal',  // Only draw where depth matches exactly (same geometry)
            },
            multisample: {
                count: this.sampleCount,
            },
        } as GPURenderPipelineDescriptor;

        this.overlayPipeline = this.device.createRenderPipeline(overlayPipelineDescriptor);

        // Create bind group using the explicit bind group layout
        this.bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.uniformBuffer },
                },
            ],
        });
    }

    /**
     * Update uniform buffer with camera matrices, PBR material, section plane, and selection state
     */
    updateUniforms(
        viewProj: Float32Array,
        model: Float32Array,
        color?: [number, number, number, number],
        material?: { metallic?: number; roughness?: number },
        sectionPlane?: { normal: [number, number, number]; distance: number; enabled: boolean; flipped?: boolean },
        isSelected?: boolean
    ): void {
        // Create buffer with proper alignment:
        // viewProj (16 floats) + model (16 floats) + baseColor (4 floats) + metallicRoughness (2 floats) + padding (2 floats)
        // + sectionPlane (4 floats) + flags (4 u32) = 48 floats = 192 bytes
        const buffer = new Float32Array(48);
        const flagBuffer = new Uint32Array(buffer.buffer, 176, 4); // flags at byte 176

        // viewProj: mat4x4<f32> at offset 0 (16 floats)
        buffer.set(viewProj, 0);

        // model: mat4x4<f32> at offset 16 (16 floats)
        buffer.set(model, 16);

        // baseColor: vec4<f32> at offset 32 (4 floats)
        if (color) {
            buffer.set(color, 32);
        } else {
            // Default white color
            buffer.set([1.0, 1.0, 1.0, 1.0], 32);
        }

        // metallicRoughness: vec2<f32> at offset 36 (2 floats)
        const metallic = material?.metallic ?? 0.0;
        const roughness = material?.roughness ?? 0.6;
        buffer[36] = metallic;
        buffer[37] = roughness;

        // padding at offset 38-39 (2 floats)

        // sectionPlane: vec4<f32> at offset 40 (4 floats - normal xyz + distance w)
        if (sectionPlane) {
            buffer[40] = sectionPlane.normal[0];
            buffer[41] = sectionPlane.normal[1];
            buffer[42] = sectionPlane.normal[2];
            buffer[43] = sectionPlane.distance;
        }

        // flags: vec4<u32> at offset 44 (4 u32 - using flagBuffer view)
        // flags.y packs: bit 0 = sectionEnabled, bit 1 = sectionFlipped.
        flagBuffer[0] = isSelected ? 1 : 0;
        flagBuffer[1] =
            (sectionPlane?.enabled ? 1 : 0) |
            (sectionPlane?.flipped ? 2 : 0);
        flagBuffer[2] = 0;                             // reserved (edgeEnabled written by Renderer)
        flagBuffer[3] = 0;                             // reserved (edgeIntensity written by Renderer)

        // Write the buffer
        this.device.queue.writeBuffer(this.uniformBuffer, 0, buffer);
    }

    /**
     * Check if resize is needed
     */
    needsResize(width: number, height: number): boolean {
        return this.currentWidth !== width || this.currentHeight !== height;
    }

    /**
     * Resize depth texture
     */
    resize(width: number, height: number): void {
        if (width <= 0 || height <= 0) return;

        this.currentWidth = width;
        this.currentHeight = height;

        this.depthTexture.destroy();
        this.objectIdTexture.destroy();
        this.depthTexture = this.device.createTexture({
            size: { width, height },
            format: this.depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount: this.sampleCount > 1 ? this.sampleCount : 1,
        });
        this.depthTextureView = this.depthTexture.createView();
        this.depthOnlyTextureView = this.depthTexture.createView({ aspect: 'depth-only' });
        this.stencilTextureView = this.depthTexture.createView({ aspect: 'stencil-only' });
        this.objectIdTexture = this.device.createTexture({
            size: { width, height },
            format: this.objectIdFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount: this.sampleCount > 1 ? this.sampleCount : 1,
        });
        this.objectIdTextureView = this.objectIdTexture.createView();

        // Recreate multisample texture
        if (this.multisampleTexture) {
            this.multisampleTexture.destroy();
        }
        if (this.sampleCount > 1) {
            this.multisampleTexture = this.device.createTexture({
                size: { width, height },
                format: this.colorFormat,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
                sampleCount: this.sampleCount,
            });
            this.multisampleTextureView = this.multisampleTexture.createView();
        } else {
            this.multisampleTexture = null;
            this.multisampleTextureView = null;
        }
    }

    getPipeline(): GPURenderPipeline {
        return this.pipeline;
    }

    getSelectionPipeline(): GPURenderPipeline {
        return this.selectionPipeline;
    }

    getTransparentPipeline(): GPURenderPipeline {
        return this.transparentPipeline;
    }

    getOverlayPipeline(): GPURenderPipeline {
        return this.overlayPipeline;
    }

    getDepthTextureView(): GPUTextureView {
        return this.depthTextureView;
    }

    /** Depth-only view (for sampling as texture_depth_* in shaders). */
    getDepthOnlyTextureView(): GPUTextureView {
        return this.depthOnlyTextureView;
    }

    /** Stencil-only view (for sampling stencil in the cap fill pass). */
    getStencilTextureView(): GPUTextureView {
        return this.stencilTextureView;
    }

    getDepthFormat(): GPUTextureFormat {
        return this.depthFormat;
    }

    getObjectIdTextureView(): GPUTextureView {
        return this.objectIdTextureView;
    }

    /**
     * Get multisample texture view (for MSAA rendering)
     */
    getMultisampleTextureView(): GPUTextureView | null {
        return this.multisampleTextureView;
    }

    /**
     * Get sample count
     */
    getSampleCount(): number {
        return this.sampleCount;
    }

    getBindGroup(): GPUBindGroup {
        return this.bindGroup;
    }

    getBindGroupLayout(): GPUBindGroupLayout {
        return this.bindGroupLayout;
    }

    getUniformBufferSize(): number {
        return 192; // 48 floats * 4 bytes
    }

    private destroyed = false;

    /**
     * Destroy all GPU resources held by this pipeline.
     * After calling this method the pipeline is no longer usable.
     * Safe to call multiple times.
     */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.depthTexture.destroy();
        this.objectIdTexture.destroy();
        this.multisampleTexture?.destroy();
        this.multisampleTexture = null;
        this.multisampleTextureView = null;
        this.uniformBuffer.destroy();
    }
}

/**
 * Instanced render pipeline for GPU instancing
 * Uses storage buffers for instance transforms and colors
 */
export class InstancedRenderPipeline {
    private device: GPUDevice;
    private pipeline: GPURenderPipeline;
    private depthTexture: GPUTexture;
    private depthTextureView: GPUTextureView;
    private uniformBuffer: GPUBuffer;
    private colorFormat: GPUTextureFormat;
    // depth24plus-stencil8 matches RenderPipeline so instanced geometry shares
    // the same depth/stencil buffer layout.
    private depthFormat: GPUTextureFormat = 'depth24plus-stencil8';
    private objectIdFormat: GPUTextureFormat = 'rgba8unorm';
    private currentHeight: number;

    constructor(device: WebGPUDevice, width: number = 1, height: number = 1) {
        this.currentHeight = height;
        this.device = device.getDevice();
        this.colorFormat = device.getFormat();

        // Create depth texture
        this.depthTexture = this.device.createTexture({
            size: { width, height },
            format: this.depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();

        // Create uniform buffer for camera matrices and section plane
        // Layout: viewProj (64 bytes) + sectionPlane (16 bytes) + flags (16 bytes) = 96 bytes
        this.uniformBuffer = this.device.createBuffer({
            size: 96, // 6 * 16 bytes = properly aligned
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const shaderModule = this.device.createShaderModule({
            code: `
        // Instance data structure: transform (16 floats) + color (4 floats) = 20 floats = 80 bytes
        struct Instance {
          transform: mat4x4<f32>,
          color: vec4<f32>,
        }

        struct Uniforms {
          viewProj: mat4x4<f32>,
          sectionPlane: vec4<f32>,      // xyz = plane normal, w = plane distance
          flags: vec4<u32>,             // x = sectionEnabled, y,z,w = reserved
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        @binding(1) @group(0) var<storage, read> instances: array<Instance>;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) normal: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) worldPos: vec3<f32>,
          @location(1) normal: vec3<f32>,
          @location(2) color: vec4<f32>,
          @location(3) @interpolate(flat) instanceId: u32,
          @location(4) viewPos: vec3<f32>,  // For edge detection
        }

        // Z-up to Y-up conversion matrix (IFC uses Z-up, WebGPU/viewer uses Y-up)
        // This swaps Y and Z, negating the new Z to maintain right-handedness
        const zToYUp = mat4x4<f32>(
          vec4<f32>(1.0, 0.0, 0.0, 0.0),
          vec4<f32>(0.0, 0.0, -1.0, 0.0),
          vec4<f32>(0.0, 1.0, 0.0, 0.0),
          vec4<f32>(0.0, 0.0, 0.0, 1.0)
        );

        @vertex
        fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          let inst = instances[instanceIndex];

          // Transform to world space (still in Z-up coordinates)
          let worldPosZUp = inst.transform * vec4<f32>(input.position, 1.0);
          let normalZUp = (inst.transform * vec4<f32>(input.normal, 0.0)).xyz;

          // Convert from Z-up to Y-up for the viewer
          let worldPos = zToYUp * worldPosZUp;
          let normalYUp = (zToYUp * vec4<f32>(normalZUp, 0.0)).xyz;

          output.position = uniforms.viewProj * worldPos;
          // Anti z-fighting: deterministic depth nudge per instance
          let zHash = (instanceIndex * 2654435761u) & 255u;
          output.position.z *= 1.0 + f32(zHash) * 1e-6;
          output.worldPos = worldPos.xyz;
          output.normal = normalize(normalYUp);
          output.color = inst.color;
          output.instanceId = instanceIndex;
          // Store view-space position for edge detection
          output.viewPos = (uniforms.viewProj * worldPos).xyz;
          return output;
        }

        fn encodeId24(id: u32) -> vec4<f32> {
          let r = f32((id >> 16u) & 255u) / 255.0;
          let g = f32((id >> 8u) & 255u) / 255.0;
          let b = f32(id & 255u) / 255.0;
          return vec4<f32>(r, g, b, 1.0);
        }

        struct FragmentOutput {
          @location(0) color: vec4<f32>,
          @location(1) objectIdEncoded: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragmentOutput {
          // Section plane clipping. flags.x packs: bit 0 = enabled, bit 1 = flipped.
          let sectionEnabled = (uniforms.flags.x & 1u) == 1u;
          if (sectionEnabled) {
            let planeNormal = uniforms.sectionPlane.xyz;
            let planeDistance = uniforms.sectionPlane.w;
            let flipped = (uniforms.flags.x & 2u) == 2u;
            let side = select(1.0, -1.0, flipped);
            let distToPlane = (dot(input.worldPos, planeNormal) - planeDistance) * side;
            if (distToPlane > 0.0) {
              discard;
            }
          }

          let N = normalize(input.normal);

          // Enhanced lighting with multiple sources
          let sunLight = normalize(vec3<f32>(0.5, 1.0, 0.3));  // Main directional light
          let fillLight = normalize(vec3<f32>(-0.5, 0.3, -0.3));  // Fill light
          let rimLight = normalize(vec3<f32>(0.0, 0.2, -1.0));  // Rim light for edge definition

          // Hemisphere ambient - reduced for less washed-out look
          let skyColor = vec3<f32>(0.3, 0.35, 0.4);  // Darker sky
          let groundColor = vec3<f32>(0.15, 0.1, 0.08);  // Darker ground
          let hemisphereFactor = N.y * 0.5 + 0.5;
          let ambient = mix(groundColor, skyColor, hemisphereFactor) * 0.25;

          // Two-sided sun light so inner faces (I-beam channels) stay visible
          let NdotL = abs(dot(N, sunLight));
          let wrap = 0.3;
          let diffuseSun = max((NdotL + wrap) / (1.0 + wrap), 0.0) * 0.55;

          // Fill light - two-sided
          let NdotFill = abs(dot(N, fillLight));
          let diffuseFill = NdotFill * 0.15;

          // Rim light for edge definition
          let NdotRim = max(dot(N, rimLight), 0.0);
          let rim = pow(NdotRim, 4.0) * 0.15;

          var baseColor = input.color.rgb;
          
          // Detect if the color is close to white/gray (low saturation)
          let baseGray = dot(baseColor, vec3<f32>(0.299, 0.587, 0.114));
          let baseSaturation = length(baseColor - vec3<f32>(baseGray)) / max(baseGray, 0.001);
          let isWhiteish = 1.0 - smoothstep(0.0, 0.3, baseSaturation);
          
          // Darken whites/grays more to reduce washed-out appearance
          baseColor = mix(baseColor, baseColor * 0.7, isWhiteish * 0.4);

          // Combine all lighting
          var color = baseColor * (ambient + diffuseSun + diffuseFill + rim);

          // Beautiful fresnel effect for transparent materials (glass)
          var finalAlpha = input.color.a;
          if (finalAlpha < 0.99) {
            // Calculate view direction for fresnel
            let V = normalize(-input.worldPos);
            let NdotV = max(dot(N, V), 0.0);
            
            // Enhanced fresnel effect - stronger at edges (grazing angles)
            // Using Schlick's approximation for realistic glass reflection
            let fresnelPower = 1.5; // Higher = softer edge reflections
            let fresnel = pow(1.0 - NdotV, fresnelPower);
            
            // Glass reflection tint (sky/environment reflection at edges)
            let reflectionTint = vec3<f32>(0.92, 0.96, 1.0);  // Cool sky reflection
            let reflectionStrength = fresnel * 0.6;  // Strong edge reflections
            
            // Mix in reflection tint at edges
            color = mix(color, color * reflectionTint, reflectionStrength);
            
            // Add realistic glass shine - brighter at edges where light reflects
            let glassShine = fresnel * 0.12;
            color += glassShine;
            
            // Slight desaturation at edges (glass reflects environment, not just color)
            let edgeDesaturation = fresnel * 0.25;
            let gray = dot(color, vec3<f32>(0.299, 0.587, 0.114));
            color = mix(color, vec3<f32>(gray), edgeDesaturation);
            
            // Make glass more transparent (reduce opacity by 30%)
            finalAlpha = finalAlpha * 0.7;
          }

          // Exposure adjustment - darken overall
          color *= 0.85;

          // Contrast enhancement
          color = (color - 0.5) * 1.15 + 0.5;
          color = max(color, vec3<f32>(0.0));

          // Saturation boost - stronger for colored surfaces, less for whites
          let gray = dot(color, vec3<f32>(0.299, 0.587, 0.114));
          let satBoost = mix(1.4, 1.1, isWhiteish);  // More saturation for colored surfaces
          color = mix(vec3<f32>(gray), color, satBoost);

          // ACES filmic tone mapping
          let a = 2.51;
          let b = 0.03;
          let c = 2.43;
          let d = 0.59;
          let e = 0.14;
          color = clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));

          // Subtle edge enhancement using screen-space derivatives
          let depthGradient = length(vec2<f32>(
            dpdx(input.viewPos.z),
            dpdy(input.viewPos.z)
          ));
          let normalGradient = length(vec2<f32>(
            length(dpdx(input.normal)),
            length(dpdy(input.normal))
          ));
          
          let edgeFactor = smoothstep(0.0, 0.1, depthGradient * 10.0 + normalGradient * 5.0);
          let edgeDarken = mix(1.0, 0.92, edgeFactor * 0.4);  // Slightly stronger edge darkening
          color *= edgeDarken;

          // Gamma correction
          color = pow(color, vec3<f32>(1.0 / 2.2));

          var out: FragmentOutput;
          out.color = vec4<f32>(color, finalAlpha);
          // Not expressId-accurate for instanced path, but still provides
          // per-instance boundaries for seam detection.
          out.objectIdEncoded = encodeId24(input.instanceId + 1u);
          return out;
        }
      `,
        });

        // Create render pipeline
        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 24, // 6 floats * 4 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
                        ],
                    },
                ],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.colorFormat }, { format: this.objectIdFormat }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: true,
                depthCompare: 'greater',  // Reverse-Z: greater instead of less
            },
        });
        // Note: bind groups are created per-instanced-mesh via createInstanceBindGroup()
        // since each mesh has its own instance buffer
    }

    /**
     * Update uniform buffer with camera matrices and section plane.
     * flags.x packs bit 0 = sectionEnabled, bit 1 = sectionFlipped.
     */
    updateUniforms(
        viewProj: Float32Array,
        sectionPlane?: {
            normal: [number, number, number];
            distance: number;
            enabled: boolean;
            flipped?: boolean;
        },
    ): void {
        const buffer = new Float32Array(24); // 6 * 4 floats
        const flagBuffer = new Uint32Array(buffer.buffer, 80, 4);

        buffer.set(viewProj, 0);

        if (sectionPlane?.enabled) {
            buffer[16] = sectionPlane.normal[0];
            buffer[17] = sectionPlane.normal[1];
            buffer[18] = sectionPlane.normal[2];
            buffer[19] = sectionPlane.distance;
            flagBuffer[0] = 1 | (sectionPlane.flipped ? 2 : 0);
        } else {
            buffer[16] = 0;
            buffer[17] = 0;
            buffer[18] = 0;
            buffer[19] = 0;
            flagBuffer[0] = 0;
        }

        this.device.queue.writeBuffer(this.uniformBuffer, 0, buffer);
    }

    /**
     * Resize depth texture
     */
    resize(width: number, height: number): void {
        if (this.currentHeight === height && this.depthTexture.width === width) {
            return;
        }

        this.currentHeight = height;
        this.depthTexture.destroy();
        this.depthTexture = this.device.createTexture({
            size: { width, height },
            format: this.depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();
    }

    /**
     * Check if resize is needed
     */
    needsResize(width: number, height: number): boolean {
        return this.depthTexture.width !== width || this.depthTexture.height !== height;
    }

    /**
     * Get render pipeline
     */
    getPipeline(): GPURenderPipeline {
        return this.pipeline;
    }

    /**
     * Get depth texture view
     */
    getDepthTextureView(): GPUTextureView {
        return this.depthTextureView;
    }

    /**
     * Get bind group layout for instance buffer binding
     */
    getBindGroupLayout(): GPUBindGroupLayout {
        return this.pipeline.getBindGroupLayout(0);
    }

    /**
     * Create bind group with instance buffer
     */
    createInstanceBindGroup(instanceBuffer: GPUBuffer): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.uniformBuffer },
                },
                {
                    binding: 1,
                    resource: { buffer: instanceBuffer },
                },
            ],
        });
    }

    private destroyed = false;

    /**
     * Destroy all GPU resources held by this pipeline.
     * After calling this method the pipeline is no longer usable.
     * Safe to call multiple times.
     */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.depthTexture.destroy();
        this.uniformBuffer.destroy();
    }
}
