/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU render pipeline setup
 */

import { WebGPUDevice } from './device.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { texturedShaderSource } from './shaders/textured.wgsl.js';
import {
    ENVIRONMENT_UNIFORM_SIZE,
    packEnvironmentUniforms,
    resolveEnvironment,
    type LightingEnvironment,
} from './environment.js';

export class RenderPipeline {
    private device: GPUDevice;
    private webgpuDevice: WebGPUDevice;
    private pipeline: GPURenderPipeline;
    private culledPipeline!: GPURenderPipeline;  // Opaque pipeline with backface culling — material-layer slices only (their winding is reliable)
    private instancedPipeline!: GPURenderPipeline;  // GPU-instancing: template (slot 0) + per-instance buffer (slot 1)
    private instancedTransparentPipeline: GPURenderPipeline | null = null;  // instanced pipeline with alpha blend (lens/x-ray/compare overlays); lazily built, null if unbuilt/rejected
    private makeInstancedTransparentPipeline: (() => GPURenderPipeline) | null = null;  // deferred factory (see constructor)
    private instancedTransparentPipelineTried = false;  // built-or-failed once; don't retry a rejecting backend every frame
    private selectionPipeline: GPURenderPipeline;  // Pipeline for selected meshes (renders on top)
    private transparentPipeline: GPURenderPipeline;  // Pipeline for transparent meshes with alpha blending
    private overlayPipeline: GPURenderPipeline;  // Pipeline for color overlays (lens) - renders at exact same depth
    private texturedPipeline: GPURenderPipeline;  // Pipeline for textured meshes (#961): UV lane + albedo texture/sampler
    private texturedBindGroupLayout: GPUBindGroupLayout;  // group(0): uniform + texture + sampler
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
    // Global lighting environment at group(1): one small uniform buffer,
    // bound once per pass, shared by every pipeline derived from the main
    // shader (opaque/selection/transparent/overlay/textured).
    private environmentBuffer: GPUBuffer;
    private environmentBindGroup: GPUBindGroup;
    private environmentBindGroupLayout: GPUBindGroupLayout;
    private environmentScratch = new Float32Array(ENVIRONMENT_UNIFORM_SIZE / 4);
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

        // Lighting environment at group(1) — written once per frame from
        // RenderOptions.environment, initialized to the legacy default look.
        this.environmentBindGroupLayout = this.device.createBindGroupLayout({
            label: 'environment-bgl',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });
        this.environmentBuffer = this.device.createBuffer({
            label: 'environment-uniforms',
            size: ENVIRONMENT_UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.environmentBindGroup = this.device.createBindGroup({
            layout: this.environmentBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.environmentBuffer } }],
        });
        this.updateEnvironment();

        // Create shader module with PBR lighting, section plane clipping, and selection outline
        const shaderModule = this.device.createShaderModule({
            code: mainShaderSource,
        });

        // Create explicit pipeline layout (shared between main and selection pipelines)
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout, this.environmentBindGroupLayout],
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

        // GPU-instancing pipeline: same fragment/targets/depth/MSAA as the opaque
        // pipeline, but vs_instanced + a SECOND vertex buffer (slot 1, stepMode
        // 'instance') carrying the per-occurrence mat4 (4 column vec4s) + entityId
        // + rgba. Slot 0 stays the template's 28-byte vertex (pos+norm+entityId);
        // the per-vertex entityId there is unused (vs_instanced reads the
        // per-instance id) but kept so slot 0 matches the flat layout exactly.
        // Shared vertex stage for both instanced pipelines (opaque + transparent):
        // template vertex (slot 0) + per-occurrence buffer (slot 1).
        const instancedVertex: GPUVertexState = {
            module: shaderModule,
            entryPoint: 'vs_instanced',
            buffers: [
                {
                    arrayStride: 28,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                        { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
                        { shaderLocation: 2, offset: 24, format: 'uint32' }, // entityId (unused here)
                    ],
                },
                {
                    arrayStride: 88, // mat4(64) + entityId(4) + rgba(16) + flags(4) — INSTANCE_STRIDE_BYTES
                    stepMode: 'instance',
                    attributes: [
                        { shaderLocation: 3, offset: 0, format: 'float32x4' }, // instMat col0
                        { shaderLocation: 4, offset: 16, format: 'float32x4' }, // col1
                        { shaderLocation: 5, offset: 32, format: 'float32x4' }, // col2
                        { shaderLocation: 6, offset: 48, format: 'float32x4' }, // col3
                        { shaderLocation: 7, offset: 64, format: 'uint32' }, // entityId
                        { shaderLocation: 8, offset: 68, format: 'float32x4' }, // rgba
                        { shaderLocation: 9, offset: 84, format: 'uint32' }, // flags (bit 0 = selected, bit 1 = hidden)
                    ],
                },
            ],
        };

        this.instancedPipeline = this.device.createRenderPipeline({
            ...pipelineDescriptor,
            vertex: instancedVertex,
        } as GPURenderPipelineDescriptor);
        // Stash the instanced vertex stage so the transparent instanced pipeline
        // (built after transparentPipelineDescriptor below) reuses it verbatim.
        const instancedVertexStage = instancedVertex;

        // Backface-culled clone of the opaque pipeline, used ONLY for material-
        // layer slices. Those are thin watertight outward-wound solids stacked
        // with coincident interface caps; drawn double-sided (cullMode 'none')
        // the back-facing cap of each pair z-fights its neighbour into a hollow-
        // looking shimmer. Their winding is reliable (positive signed volume), so
        // culling back faces (default frontFace 'ccw') drops the interior caps
        // and the build-up reads as a clean solid. General IFC geometry stays on
        // the non-culled `pipeline` because its winding is not reliable.
        this.culledPipeline = this.device.createRenderPipeline({
            ...pipelineDescriptor,
            primitive: { topology: 'triangle-list', cullMode: 'back' },
        } as GPURenderPipelineDescriptor);

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
                // No depth bias: the highlight mesh's VBO is built to be
                // BIT-IDENTICAL to how its source surface renders (same shared
                // origin + same f32 relativization — see createMeshFromData), so
                // it sits exactly coincident and 'greater-equal' draws it on top
                // without a bias. A bias here would x-ray the highlight through
                // neighbouring geometry and spike at grazing angles.
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

        // Transparent instanced pipeline: the transparent descriptor (src-alpha blend,
        // no depth write) but with the instanced vertex stage. Drives the second
        // instanced sub-pass that draws occurrences whose per-instance alpha dropped
        // below the cutoff (lens-ghost / x-ray / compare overlays) — the opaque
        // instanced pipeline ignores alpha, so without this they'd render solid.
        //
        // Created LAZILY on first use (never on a plain load), NOT at init. CI's
        // SwiftShader-Vulkan WebGPU is fragile: an extra createRenderPipeline at init
        // drops its error scope and loses the whole device, so the canvas never mounts.
        // Deferring it keeps init at the minimal pipeline set that backend tolerates;
        // real WebGPU builds it on demand when an overlay first needs it. A creation
        // failure leaves it null and the renderer skips the transparent instanced pass.
        this.makeInstancedTransparentPipeline = () =>
            this.device.createRenderPipeline({
                ...transparentPipelineDescriptor,
                vertex: instancedVertexStage,
            } as GPURenderPipelineDescriptor);

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

        // ── Textured pipeline (#961) ──
        // A separate pipeline for meshes carrying an IFC surface texture. It
        // adds a UV vertex lane and an albedo texture+sampler at group(0)
        // bindings 1 & 2; everything else (depth, MSAA, both colour targets incl.
        // the object-id picking target, flat-normal shading, section clip) mirrors
        // the main opaque pipeline so picking/section/z-fight behave identically.
        // Textured meshes are rare (a handful per model), so they draw
        // per-mesh — the 28-byte hot path for the other ~all meshes is untouched.
        this.texturedBindGroupLayout = this.device.createBindGroupLayout({
            label: 'textured-bgl',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });
        const texturedModule = this.device.createShaderModule({
            label: 'textured-shader',
            code: texturedShaderSource,
        });
        this.texturedPipeline = this.device.createRenderPipeline({
            label: 'textured-pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.texturedBindGroupLayout, this.environmentBindGroupLayout],
            }),
            vertex: {
                module: texturedModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        // position(3f) + normal(3f) + entityId(u32) + uv(2f) = 36 bytes
                        arrayStride: 36,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                            { shaderLocation: 1, offset: 12, format: 'float32x3' },
                            { shaderLocation: 2, offset: 24, format: 'uint32' },
                            // uv at @location(10): main.wgsl's vs_instanced/InstanceInput
                            // occupy vertex-input @location 3..9 in this derived module,
                            // so the textured uv lane moves clear of them (see
                            // textured.wgsl.ts). Byte offset (28) is unchanged.
                            { shaderLocation: 10, offset: 28, format: 'float32x2' },
                        ],
                    },
                ],
            },
            fragment: {
                module: texturedModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.colorFormat }, { format: this.objectIdFormat }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: true,
                depthCompare: 'greater', // Reverse-Z, matches the opaque pipeline
            },
            multisample: { count: this.sampleCount },
        } as GPURenderPipelineDescriptor);

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
     * Write a raw 48-float (192-byte) uniform block into the SHARED uniform
     * buffer, whose bind group is `getBindGroup()`. Used by the GPU-instancing
     * pass, which reuses the frame's viewProj + section + flags from the
     * renderer's prebuilt template (model + baseColor are unused — vs_instanced
     * takes the transform + colour per-occurrence from the instance buffer).
     */
    writeRawUniforms(data: Float32Array, extraFlagsX = 0): void {
        this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
        // OR extra bits into flags.x (u32 at byte 176) WITHOUT mutating the caller's
        // shared template buffer. Used to mark the instanced passes: bit 2 = instanced
        // pass, bit 3 = transparent instanced sub-pass (the shader routes per-instance
        // opacity off these).
        if (extraFlagsX !== 0) {
            const baseFlagsX = new Uint32Array(data.buffer, data.byteOffset + 176, 1)[0];
            this.device.queue.writeBuffer(
                this.uniformBuffer,
                176,
                new Uint32Array([baseFlagsX | extraFlagsX]),
            );
        }
    }

    /**
     * Write the global lighting environment uniform buffer. Cheap (80 bytes);
     * called once per frame with the resolved `RenderOptions.environment`.
     */
    updateEnvironment(env?: LightingEnvironment): void {
        packEnvironmentUniforms(resolveEnvironment(env), this.environmentScratch);
        this.device.queue.writeBuffer(this.environmentBuffer, 0, this.environmentScratch);
    }

    /** Lighting-environment bind group — set at group(1) once per render pass. */
    getEnvironmentBindGroup(): GPUBindGroup {
        return this.environmentBindGroup;
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

    /** Backface-culled opaque pipeline — material-layer slices only. */
    getCulledPipeline(): GPURenderPipeline {
        return this.culledPipeline;
    }

    /** GPU-instancing pipeline (template vertex buffer at slot 0 + per-instance buffer at slot 1). */
    getInstancedPipeline(): GPURenderPipeline {
        return this.instancedPipeline;
    }

    getInstancedTransparentPipeline(): GPURenderPipeline | null {
        // Lazy build on first request (when an overlay first makes an instanced
        // occurrence translucent). Kept off the init path so a fragile backend that
        // can't build it doesn't lose the device at startup. Tried once.
        if (
            !this.instancedTransparentPipeline &&
            !this.instancedTransparentPipelineTried &&
            this.makeInstancedTransparentPipeline
        ) {
            this.instancedTransparentPipelineTried = true;
            // WebGPU reports pipeline *validation* errors asynchronously via an
            // error scope, NOT as a synchronous throw — the try/catch alone only
            // catches device-loss / OOM-style failures. Wrap the build in a
            // validation scope so a pipeline that fails validation is nulled
            // instead of being used (broken) for instanced blending. (#1238 review)
            this.device.pushErrorScope('validation');
            try {
                this.instancedTransparentPipeline = this.makeInstancedTransparentPipeline();
            } catch (err) {
                console.warn('[RenderPipeline] transparent instanced pipeline unavailable; instanced overlays will not blend:', err);
                this.instancedTransparentPipeline = null;
            }
            this.device.popErrorScope().then((error) => {
                if (error) {
                    console.warn('[RenderPipeline] transparent instanced pipeline failed validation; instanced overlays will not blend:', error.message);
                    this.instancedTransparentPipeline = null;
                }
            }).catch(() => { /* device lost while popping the scope — pipeline is already unusable */ });
        }
        return this.instancedTransparentPipeline;
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

    /** Textured-mesh pipeline (#961). */
    getTexturedPipeline(): GPURenderPipeline {
        return this.texturedPipeline;
    }

    /**
     * Create a bind group for a textured mesh (#961): the mesh's own uniform
     * buffer at binding 0, plus its albedo texture view + sampler at 1 & 2.
     */
    createTexturedBindGroup(
        uniformBuffer: GPUBuffer,
        textureView: GPUTextureView,
        sampler: GPUSampler,
    ): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.texturedBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: textureView },
                { binding: 2, resource: sampler },
            ],
        });
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
        this.environmentBuffer.destroy();
    }
}
