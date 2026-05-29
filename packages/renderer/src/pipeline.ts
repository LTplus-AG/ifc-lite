/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU render pipeline setup
 */

import { WebGPUDevice } from './device.js';
import { mainShaderSource } from './shaders/main.wgsl.js';

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

        // Belt-and-suspenders clamp: callers are expected to clamp upstream, but
        // texture creation must never exceed maxTextureDimension2D or every frame fails.
        const maxDim = this.device.limits.maxTextureDimension2D;
        width = Math.min(width, maxDim);
        height = Math.min(height, maxDim);

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
