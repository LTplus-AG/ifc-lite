/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/renderer - WebGPU renderer
 */

export { WebGPUDevice } from './device.js';
export { RenderPipeline, InstancedRenderPipeline } from './pipeline.js';
export { Camera } from './camera.js';
export type { ProjectionMode } from './camera-controls.js';
export { Scene } from './scene.js';
export { Picker } from './picker.js';
export { MathUtils } from './math.js';
export { SectionPlaneRenderer } from './section-plane.js';
export { Section2DOverlayRenderer } from './section-2d-overlay.js';
// Section cap styling (hatch pattern ids + default colours). The cap itself
// is now rendered by Section2DOverlayRenderer's fill pass; this module just
// holds the styling primitives shared with the store and UI.
export { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
export type { SectionCapStyle, HatchPatternId } from './section-cap-style.js';
export type { Section2DOverlayOptions, Section2DOverlayCapStyle, CutPolygon2D, DrawingLine2D } from './section-2d-overlay.js';
export { Raycaster } from './raycaster.js';
export { SnapDetector, SnapType } from './snap-detector.js';
export { BVH } from './bvh.js';
export { FederationRegistry, federationRegistry } from './federation-registry.js';
export type { ModelRange, GlobalIdLookup } from './federation-registry.js';
export * from './types.js';
export type { Ray, Vec3, Intersection } from './raycaster.js';
export type { SnapTarget, SnapOptions, EdgeLockInput, MagneticSnapResult } from './snap-detector.js';

// Zero-copy GPU upload (new - faster, less memory)
export {
    ZeroCopyGpuUploader,
    createZeroCopyUploader,
    type WasmMemoryHandle,
    type GpuGeometryData,
    type GpuInstancedGeometryData,
    type ZeroCopyMeshMetadata,
    type ZeroCopyUploadResult,
    type ZeroCopyInstancedUploadResult,
} from './zero-copy-uploader.js';

// Extracted manager classes
export { PickingManager } from './picking-manager.js';
export { RaycastEngine } from './raycast-engine.js';

import { WebGPUDevice } from './device.js';
import { RenderPipeline, InstancedRenderPipeline } from './pipeline.js';
import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { Picker } from './picker.js';
import { MathUtils } from './math.js';
import { FrustumUtils } from '@ifc-lite/spatial';
import { deduplicateMeshes } from '@ifc-lite/geometry';
import type { MeshData } from '@ifc-lite/geometry';
import type {
    RenderOptions,
    PickOptions,
    PickResult,
    Mesh,
    InstancedMesh,
    VisualEnhancementOptions,
    ContactShadingQuality,
    SeparationLinesQuality,
} from './types.js';
import { SectionPlaneRenderer } from './section-plane.js';
import { Section2DOverlayRenderer, type CutPolygon2D, type DrawingLine2D } from './section-2d-overlay.js';
import { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
import type { InstancedGeometry } from '@ifc-lite/wasm';
import { Raycaster, type Intersection } from './raycaster.js';
import { SnapDetector, type SnapTarget, type SnapOptions, type EdgeLockInput, type MagneticSnapResult } from './snap-detector.js';
import { PickingManager } from './picking-manager.js';
import { RaycastEngine } from './raycast-engine.js';
import { PostProcessor } from './post-processor.js';

const MAX_ENCODED_ENTITY_ID = 0xFFFFFF;
let warnedEntityIdRange = false;

type ResolvedVisualEnhancement = {
    enabled: boolean;
    edgeContrast: {
        enabled: boolean;
        intensity: number;
    };
    contactShading: {
        quality: ContactShadingQuality;
        intensity: number;
        radius: number;
    };
    separationLines: {
        enabled: boolean;
        quality: SeparationLinesQuality;
        intensity: number;
        radius: number;
    };
};

/**
 * Main renderer class
 */
export class Renderer {
    private device: WebGPUDevice;
    private pipeline: RenderPipeline | null = null;
    private instancedPipeline: InstancedRenderPipeline | null = null;
    private camera: Camera;
    private scene: Scene;
    private picker: Picker | null = null;
    private canvas: HTMLCanvasElement;
    private sectionPlaneRenderer: SectionPlaneRenderer | null = null;
    private section2DOverlayRenderer: Section2DOverlayRenderer | null = null;
    private postProcessor: PostProcessor | null = null;
    private visualEnhancementState: ResolvedVisualEnhancement = {
        enabled: true,
        edgeContrast: { enabled: true, intensity: 1.0 },
        contactShading: { quality: 'off', intensity: 0.3, radius: 1.0 },
        separationLines: { enabled: true, quality: 'low', intensity: 0.5, radius: 1.0 },
    };

    // Model bounds for fitToView, section planes, camera
    private modelBounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null = null;

    // Composition: delegate to extracted managers
    private pickingManager: PickingManager;
    private raycastEngine: RaycastEngine;

    // Error rate limiting (log at most once per second)
    private lastRenderErrorTime: number = 0;
    private readonly RENDER_ERROR_THROTTLE_MS = 1000;


    // Dirty flag: set by requestRender(), consumed by the animation loop.
    // Centralises all render scheduling — callers never call render() directly.
    private _renderRequested: boolean = false;

    // One-shot log guard — prints Y-up clip bounds on first section-enable so
    // users can confirm the slider is operating on the intended range.
    private _loggedSectionBounds: boolean = false;

    // Pooled per-frame buffers to avoid GC pressure from per-batch Float32Array allocations
    // A single 192-byte uniform buffer (48 floats) is reused for all batches/meshes within a frame
    private readonly uniformScratch = new Float32Array(48);
    private readonly uniformScratchU32 = new Uint32Array(this.uniformScratch.buffer, 176, 4);

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.device = new WebGPUDevice();
        this.camera = new Camera();
        this.scene = new Scene();

        // Create composition managers
        this.pickingManager = new PickingManager(this.camera, this.scene, null, this.canvas, (meshData: MeshData) => this.createMeshFromData(meshData));
        this.raycastEngine = new RaycastEngine(this.camera, this.scene, this.canvas);
    }

    /**
     * Initialize renderer
     */
    async init(): Promise<void> {
        await this.device.init(this.canvas);

        // Get canvas dimensions (use pixel dimensions if set, otherwise use CSS dimensions)
        const rect = this.canvas.getBoundingClientRect();
        const width = this.canvas.width || Math.max(1, Math.floor(rect.width));
        const height = this.canvas.height || Math.max(1, Math.floor(rect.height));

        // Set pixel dimensions if not already set
        if (!this.canvas.width || !this.canvas.height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        this.pipeline = new RenderPipeline(this.device, width, height);
        this.instancedPipeline = new InstancedRenderPipeline(this.device, width, height);
        this.picker = new Picker(this.device, width, height);
        this.sectionPlaneRenderer = new SectionPlaneRenderer(
            this.device.getDevice(),
            this.device.getFormat(),
            this.pipeline.getSampleCount()
        );
        this.section2DOverlayRenderer = new Section2DOverlayRenderer(
            this.device.getDevice(),
            this.device.getFormat(),
            this.pipeline.getSampleCount()
        );
        this.postProcessor = new PostProcessor(this.device, {
            enableContactShading: true,
            contactRadius: 1.0,
            contactIntensity: 0.3,
        }, this.pipeline.getSampleCount());
        this.camera.setAspect(width / height);

        // Update picking manager with initialized picker
        this.pickingManager.setPicker(this.picker);
    }

    /**
     * Load geometry from GeometryResult or MeshData array
     * This is the main entry point for loading IFC geometry into the renderer
     *
     * @param geometry - Either a GeometryResult from geometry.process() or an array of MeshData
     */
    loadGeometry(geometry: import('@ifc-lite/geometry').GeometryResult | import('@ifc-lite/geometry').MeshData[]): void {
        if (!this.device.isInitialized() || !this.pipeline) {
            throw new Error('Renderer not initialized. Call init() first.');
        }

        const meshes = Array.isArray(geometry) ? geometry : geometry.meshes;

        if (meshes.length === 0) {
            console.warn('[Renderer] loadGeometry called with empty mesh array');
            return;
        }

        // Use batched rendering for optimal performance
        const device = this.device.getDevice();
        this.scene.appendToBatches(meshes, device, this.pipeline, false);

        // Calculate and store model bounds for fitToView
        this.updateModelBounds(meshes);

        console.log(`[Renderer] Loaded ${meshes.length} meshes`);

        // Update camera scene bounds for tight orthographic near/far planes
        this.camera.setSceneBounds(this.modelBounds);
    }

    /**
     * Add multiple meshes to the scene (convenience method for streaming)
     *
     * @param meshes - Array of MeshData to add
     * @param isStreaming - If true, throttles batch rebuilding for better streaming performance
     */
    addMeshes(meshes: import('@ifc-lite/geometry').MeshData[], isStreaming: boolean = false): void {
        if (!this.device.isInitialized() || !this.pipeline) {
            throw new Error('Renderer not initialized. Call init() first.');
        }

        if (meshes.length === 0) return;

        const device = this.device.getDevice();
        this.scene.appendToBatches(meshes, device, this.pipeline, isStreaming);

        // Update model bounds incrementally
        this.updateModelBounds(meshes);

        // Update camera scene bounds for tight orthographic near/far planes
        this.camera.setSceneBounds(this.modelBounds);
    }

    /**
     * Fit camera to view all loaded geometry
     */
    fitToView(): void {
        if (!this.modelBounds) {
            console.warn('[Renderer] fitToView called but no geometry loaded');
            return;
        }

        const { min, max } = this.modelBounds;

        // Calculate center and size
        const center = {
            x: (min.x + max.x) / 2,
            y: (min.y + max.y) / 2,
            z: (min.z + max.z) / 2
        };

        const size = Math.max(
            max.x - min.x,
            max.y - min.y,
            max.z - min.z
        );

        // Position camera to see entire model
        const distance = size * 1.5;
        this.camera.setPosition(
            center.x + distance * 0.5,
            center.y + distance * 0.5,
            center.z + distance
        );
        this.camera.setTarget(center.x, center.y, center.z);
    }

    /**
     * Add mesh to scene with per-mesh GPU resources for unique colors
     */
    addMesh(mesh: Mesh): void {
        if (!this.pipeline) return;

        // Create per-mesh uniform buffer and bind group if not already created
        if (!mesh.uniformBuffer && this.device.isInitialized()) {
            const device = this.device.getDevice();

            // Create uniform buffer for this mesh
            mesh.uniformBuffer = device.createBuffer({
                size: this.pipeline.getUniformBufferSize(),
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            // Create bind group for this mesh
            mesh.bindGroup = device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(),
                entries: [
                    {
                        binding: 0,
                        resource: { buffer: mesh.uniformBuffer },
                    },
                ],
            });
        }

        this.scene.addMesh(mesh);
    }

    /**
     * Add instanced geometry to scene
     * Converts InstancedGeometry from geometry package to InstancedMesh for rendering
     */
    addInstancedGeometry(geometry: InstancedGeometry): void {
        if (!this.instancedPipeline || !this.device.isInitialized()) {
            throw new Error('Renderer not initialized. Call init() first.');
        }

        const device = this.device.getDevice();

        // Upload positions and normals interleaved
        const vertexCount = geometry.positions.length / 3;
        const vertexData = new Float32Array(vertexCount * 6);
        for (let i = 0; i < vertexCount; i++) {
            vertexData[i * 6 + 0] = geometry.positions[i * 3 + 0];
            vertexData[i * 6 + 1] = geometry.positions[i * 3 + 1];
            vertexData[i * 6 + 2] = geometry.positions[i * 3 + 2];
            vertexData[i * 6 + 3] = geometry.normals[i * 3 + 0];
            vertexData[i * 6 + 4] = geometry.normals[i * 3 + 1];
            vertexData[i * 6 + 5] = geometry.normals[i * 3 + 2];
        }

        // Create vertex buffer with exact size needed (ensure it matches data size)
        const vertexBufferSize = vertexData.byteLength;
        const vertexBuffer = device.createBuffer({
            size: vertexBufferSize,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, vertexData);

        // Create index buffer
        const indexBuffer = device.createBuffer({
            size: geometry.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(indexBuffer, 0, geometry.indices);

        // Create instance buffer: each instance is 80 bytes (20 floats: 16 for transform + 4 for color)
        const instanceCount = geometry.instance_count;
        const instanceData = new Float32Array(instanceCount * 20);
        const expressIdToInstanceIndex = new Map<number, number>();

        for (let i = 0; i < instanceCount; i++) {
            const instance = geometry.get_instance(i);
            if (!instance) continue;

            const baseIdx = i * 20;

            // Copy transform (16 floats)
            instanceData.set(instance.transform, baseIdx);

            // Copy color (4 floats)
            instanceData[baseIdx + 16] = instance.color[0];
            instanceData[baseIdx + 17] = instance.color[1];
            instanceData[baseIdx + 18] = instance.color[2];
            instanceData[baseIdx + 19] = instance.color[3];

            expressIdToInstanceIndex.set(instance.expressId, i);
        }

        const instanceBuffer = device.createBuffer({
            size: instanceData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(instanceBuffer, 0, instanceData);

        // Create and cache bind group to avoid per-frame allocation
        const bindGroup = this.instancedPipeline.createInstanceBindGroup(instanceBuffer);

        const instancedMesh: InstancedMesh = {
            geometryId: Number(geometry.geometryId),
            vertexBuffer,
            indexBuffer,
            indexCount: geometry.indices.length,
            instanceBuffer,
            instanceCount: instanceCount,
            expressIdToInstanceIndex,
            bindGroup,
        };

        this.scene.addInstancedMesh(instancedMesh);
    }

    /**
     * Convert MeshData array to instanced meshes for optimized rendering
     * Groups identical geometries and creates GPU instanced draw calls
     * Call this in background after initial streaming completes
     */
    convertToInstanced(meshDataArray: import('@ifc-lite/geometry').MeshData[]): void {
        if (!this.instancedPipeline || !this.device.isInitialized()) {
            console.warn('[Renderer] Cannot convert to instanced: renderer not initialized');
            return;
        }

        const instancedData = deduplicateMeshes(meshDataArray);
        const device = this.device.getDevice();
        let totalInstances = 0;

        for (const group of instancedData) {
            const vertexCount = group.positions.length / 3;
            const vertexData = new Float32Array(vertexCount * 6);
            for (let i = 0; i < vertexCount; i++) {
                vertexData[i * 6 + 0] = group.positions[i * 3 + 0];
                vertexData[i * 6 + 1] = group.positions[i * 3 + 1];
                vertexData[i * 6 + 2] = group.positions[i * 3 + 2];
                vertexData[i * 6 + 3] = group.normals[i * 3 + 0];
                vertexData[i * 6 + 4] = group.normals[i * 3 + 1];
                vertexData[i * 6 + 5] = group.normals[i * 3 + 2];
            }

            const vertexBuffer = device.createBuffer({
                size: vertexData.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(vertexBuffer, 0, vertexData);

            const indexBuffer = device.createBuffer({
                size: group.indices.byteLength,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(indexBuffer, 0, group.indices);

            const instanceCount = group.instances.length;
            const instanceData = new Float32Array(instanceCount * 20);
            const expressIdToInstanceIndex = new Map<number, number>();
            const identityTransform = new Float32Array([
                1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
            ]);

            for (let i = 0; i < instanceCount; i++) {
                const instance = group.instances[i];
                const baseIdx = i * 20;
                instanceData.set(identityTransform, baseIdx);
                instanceData[baseIdx + 16] = instance.color[0];
                instanceData[baseIdx + 17] = instance.color[1];
                instanceData[baseIdx + 18] = instance.color[2];
                instanceData[baseIdx + 19] = instance.color[3];
                expressIdToInstanceIndex.set(instance.expressId, i);
            }

            const instanceBuffer = device.createBuffer({
                size: instanceData.byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(instanceBuffer, 0, instanceData);

            const bindGroup = this.instancedPipeline.createInstanceBindGroup(instanceBuffer);
            let geometryHash = 0;
            for (let i = 0; i < group.geometryHash.length; i++) {
                geometryHash = ((geometryHash << 5) - geometryHash) + group.geometryHash.charCodeAt(i);
                geometryHash = geometryHash & geometryHash;
            }

            this.scene.addInstancedMesh({
                geometryId: Math.abs(geometryHash),
                vertexBuffer,
                indexBuffer,
                indexCount: group.indices.length,
                instanceBuffer,
                instanceCount,
                expressIdToInstanceIndex,
                bindGroup,
            });
            totalInstances += instanceCount;
        }

        const regularMeshCount = this.scene.getMeshes().length;
        this.scene.clearRegularMeshes();

        console.log(
            `[Renderer] Converted ${meshDataArray.length} meshes to ${instancedData.length} instanced geometries ` +
            `(${totalInstances} total instances, ${(totalInstances / instancedData.length).toFixed(1)}x deduplication). ` +
            `Cleared ${regularMeshCount} regular meshes.`
        );
    }

    /**
     * Ensure all meshes have GPU resources (call after adding meshes if pipeline wasn't ready)
     */
    ensureMeshResources(): void {
        if (!this.pipeline || !this.device.isInitialized()) return;

        const device = this.device.getDevice();
        for (const mesh of this.scene.getMeshes()) {
            if (!mesh.uniformBuffer) {
                mesh.uniformBuffer = device.createBuffer({
                    size: this.pipeline.getUniformBufferSize(),
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                mesh.bindGroup = device.createBindGroup({
                    layout: this.pipeline.getBindGroupLayout(),
                    entries: [{
                        binding: 0,
                        resource: { buffer: mesh.uniformBuffer },
                    }],
                });
            }
        }
    }

    /**
     * Get model bounds (used for section planes, fitToView, etc.)
     */
    getModelBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
        return this.modelBounds;
    }

    /**
     * Set model bounds (used when computing bounds from batches)
     */
    setModelBounds(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): void {
        this.modelBounds = bounds;
    }

    /**
     * Update model bounds from mesh data
     */
    private updateModelBounds(meshes: import('@ifc-lite/geometry').MeshData[]): void {
        if (!this.modelBounds) {
            this.modelBounds = {
                min: { x: Infinity, y: Infinity, z: Infinity },
                max: { x: -Infinity, y: -Infinity, z: -Infinity }
            };
        }

        for (const mesh of meshes) {
            const positions = mesh.positions;
            for (let i = 0; i < positions.length; i += 3) {
                const x = positions[i];
                const y = positions[i + 1];
                const z = positions[i + 2];
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                    this.modelBounds.min.x = Math.min(this.modelBounds.min.x, x);
                    this.modelBounds.min.y = Math.min(this.modelBounds.min.y, y);
                    this.modelBounds.min.z = Math.min(this.modelBounds.min.z, z);
                    this.modelBounds.max.x = Math.max(this.modelBounds.max.x, x);
                    this.modelBounds.max.y = Math.max(this.modelBounds.max.y, y);
                    this.modelBounds.max.z = Math.max(this.modelBounds.max.z, z);
                }
            }
        }
    }

    /**
     * Create a GPU Mesh from MeshData (lazy creation for selection highlighting)
     * This is called on-demand when a mesh is selected, avoiding 2x buffer creation during streaming
     */
    createMeshFromData(meshData: MeshData): void {
        if (!this.device.isInitialized()) return;

        const device = this.device.getDevice();
        const vertexCount = meshData.positions.length / 3;
        const interleavedRaw = new ArrayBuffer(vertexCount * 7 * 4);
        const interleaved = new Float32Array(interleavedRaw);
        const interleavedU32 = new Uint32Array(interleavedRaw);

        for (let i = 0; i < vertexCount; i++) {
            const base = i * 7;
            const posBase = i * 3;
            interleaved[base] = meshData.positions[posBase];
            interleaved[base + 1] = meshData.positions[posBase + 1];
            interleaved[base + 2] = meshData.positions[posBase + 2];
            const hasNormals = meshData.normals.length > 0;
            interleaved[base + 3] = hasNormals ? meshData.normals[posBase] : 0;
            interleaved[base + 4] = hasNormals ? meshData.normals[posBase + 1] : 0;
            interleaved[base + 5] = hasNormals ? meshData.normals[posBase + 2] : 0;
            let encodedId = meshData.expressId >>> 0;
            if (encodedId > MAX_ENCODED_ENTITY_ID) {
                if (!warnedEntityIdRange) {
                    warnedEntityIdRange = true;
                    console.warn('[Renderer] expressId exceeds 24-bit seam-ID encoding range; seam lines may collide.');
                }
                encodedId = encodedId & MAX_ENCODED_ENTITY_ID;
            }
            interleavedU32[base + 6] = encodedId;
        }

        const vertexBuffer = device.createBuffer({
            size: interleaved.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, interleaved);

        const indexBuffer = device.createBuffer({
            size: meshData.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(indexBuffer, 0, meshData.indices);

        // Add to scene with identity transform (positions already in world space)
        this.scene.addMesh({
            expressId: meshData.expressId,
            modelIndex: meshData.modelIndex,  // Preserve modelIndex for multi-model selection
            vertexBuffer,
            indexBuffer,
            indexCount: meshData.indices.length,
            transform: MathUtils.identity(),
            color: meshData.color,
        });
    }

    private resolveVisualEnhancement(options?: VisualEnhancementOptions): ResolvedVisualEnhancement {
        if (!options) {
            return this.visualEnhancementState;
        }
        const merged: ResolvedVisualEnhancement = {
            enabled: options.enabled ?? this.visualEnhancementState.enabled,
            edgeContrast: {
                enabled: options.edgeContrast?.enabled ?? this.visualEnhancementState.edgeContrast.enabled,
                intensity: options.edgeContrast?.intensity ?? this.visualEnhancementState.edgeContrast.intensity,
            },
            contactShading: {
                quality: options.contactShading?.quality ?? this.visualEnhancementState.contactShading.quality,
                intensity: options.contactShading?.intensity ?? this.visualEnhancementState.contactShading.intensity,
                radius: options.contactShading?.radius ?? this.visualEnhancementState.contactShading.radius,
            },
            separationLines: {
                enabled: options.separationLines?.enabled ?? this.visualEnhancementState.separationLines.enabled,
                quality: options.separationLines?.quality ?? this.visualEnhancementState.separationLines.quality,
                intensity: options.separationLines?.intensity ?? this.visualEnhancementState.separationLines.intensity,
                radius: options.separationLines?.radius ?? this.visualEnhancementState.separationLines.radius,
            },
        };
        this.visualEnhancementState = merged;
        return merged;
    }

    /**
     * Render frame
     */
    render(options: RenderOptions = {}): void {
        if (!this.device.isInitialized() || !this.pipeline) return;

        // Validate canvas dimensions
        // Align width to 64 pixels for WebGPU texture row alignment (256 bytes / 4 bytes per pixel)
        const rect = this.canvas.getBoundingClientRect();
        const rawWidth = Math.max(1, Math.floor(rect.width));
        const width = Math.max(64, Math.floor(rawWidth / 64) * 64);
        const height = Math.max(1, Math.floor(rect.height));

        // Skip rendering if canvas is too small
        if (width < 64 || height < 10) return;

        // Update canvas pixel dimensions if needed
        const dimensionsChanged = this.canvas.width !== width || this.canvas.height !== height;
        if (dimensionsChanged) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.camera.setAspect(width / height);
            // Force reconfigure when dimensions change
            this.device.configureContext();
            // Also resize the depth texture immediately
            this.pipeline.resize(width, height);
            if (this.instancedPipeline) {
                this.instancedPipeline.resize(width, height);
            }
        }

        // Skip rendering if canvas is invalid
        if (this.canvas.width === 0 || this.canvas.height === 0) return;

        // Ensure context is valid before rendering (handles HMR, focus changes, etc.)
        if (!this.device.ensureContext()) {
            return; // Skip this frame, context will be ready next frame
        }

        const device = this.device.getDevice();
        const viewProj = this.camera.getViewProjMatrix().m;
        const visualEnhancement = this.resolveVisualEnhancement(options.visualEnhancement);
        // Skip expensive visual effects during interaction (orbit/pan/zoom)
        // to keep frame times low on integrated GPUs (MacBook Air etc.)
        const interacting = options.isInteracting === true;
        const edgeEnabled = !interacting && visualEnhancement.enabled && visualEnhancement.edgeContrast.enabled;
        const edgeIntensity = Math.min(3.0, Math.max(0.0, visualEnhancement.edgeContrast.intensity));
        const edgeEnabledU32 = edgeEnabled ? 1 : 0;
        const edgeIntensityMilliU32 = Math.round(edgeIntensity * 1000);
        const contactEnabled = !interacting && visualEnhancement.enabled && visualEnhancement.contactShading.quality !== 'off';
        const separationEnabled = !interacting && visualEnhancement.enabled
            && visualEnhancement.separationLines.enabled
            && visualEnhancement.separationLines.quality !== 'off';
        const needsObjectIdPass = contactEnabled || separationEnabled;

        let meshes = this.scene.getMeshes();

        // Check if visibility filtering is active
        const hasHiddenFilter = options.hiddenIds && options.hiddenIds.size > 0;
        const hasIsolatedFilter = options.isolatedIds !== null && options.isolatedIds !== undefined;
        const hasVisibilityFiltering = hasHiddenFilter || hasIsolatedFilter;

        // PERFORMANCE FIX: Use batch-level visibility filtering instead of creating individual meshes
        // Only create individual meshes for selected elements (for highlighting)
        // Batches are filtered at render time - fully visible batches render normally,
        // partially visible batches are skipped (their visible elements will be in other batches or individual meshes)

        // Ensure all existing meshes have GPU resources
        this.ensureMeshResources();


        // Frustum culling (if enabled and spatial index available)
        if (options.enableFrustumCulling && options.spatialIndex) {
            try {
                const frustum = FrustumUtils.fromViewProjMatrix(viewProj);
                const visibleIds = new Set(options.spatialIndex.queryFrustum(frustum));
                meshes = meshes.filter(mesh => visibleIds.has(mesh.expressId));
            } catch (error) {
                // Fallback: render all meshes if frustum culling fails
                console.warn('Frustum culling failed:', error);
            }
        }

        // Visibility filtering
        if (options.hiddenIds && options.hiddenIds.size > 0) {
            meshes = meshes.filter(mesh => !options.hiddenIds!.has(mesh.expressId));
        }
        if (options.isolatedIds !== null && options.isolatedIds !== undefined) {
            meshes = meshes.filter(mesh => options.isolatedIds!.has(mesh.expressId));
        }

        // Resize depth texture if needed
        if (this.pipeline.needsResize(this.canvas.width, this.canvas.height)) {
            this.pipeline.resize(this.canvas.width, this.canvas.height);
        }
        if (this.instancedPipeline?.needsResize(this.canvas.width, this.canvas.height)) {
            this.instancedPipeline.resize(this.canvas.width, this.canvas.height);
        }

        // Get current texture safely - may return null if context needs reconfiguration
        const currentTexture = this.device.getCurrentTexture();
        if (!currentTexture) {
            return; // Skip this frame, context will be reconfigured next frame
        }

        try {
            const clearColor = options.clearColor
                ? (Array.isArray(options.clearColor)
                    ? { r: options.clearColor[0], g: options.clearColor[1], b: options.clearColor[2], a: options.clearColor[3] }
                    : options.clearColor)
                : { r: 0.1, g: 0.1, b: 0.1, a: 1 };

            const textureView = currentTexture.createView();
            const objectIdView = this.pipeline.getObjectIdTextureView();

            // Separate meshes into opaque and transparent
            const opaqueMeshes: typeof meshes = [];
            const transparentMeshes: typeof meshes = [];

            for (const mesh of meshes) {
                const alpha = mesh.color[3];
                const transparency = mesh.material?.transparency ?? 0.0;
                const isTransparent = alpha < 0.99 || transparency > 0.01;

                if (isTransparent) {
                    transparentMeshes.push(mesh);
                } else {
                    opaqueMeshes.push(mesh);
                }
            }

            // Sort transparent meshes back-to-front for proper blending
            if (transparentMeshes.length > 0) {
                transparentMeshes.sort((a, b) => {
                    return b.expressId - a.expressId; // Back to front (simplified)
                });
            }

            // Write uniform data to each mesh's buffer BEFORE recording commands
            // This ensures each mesh has its own color data
            const allMeshes = [...opaqueMeshes, ...transparentMeshes];
            const selectedId = options.selectedId;
            const selectedIds = options.selectedIds;
            const selectedModelIndex = options.selectedModelIndex;

            // Calculate section plane parameters and model bounds
            // Always calculate bounds when sectionPlane is provided (for preview and active mode)
            let sectionPlaneData: { normal: [number, number, number]; distance: number; enabled: boolean } | undefined;

            // Terrain clip: when Cesium overlay is active, clip model below terrain.
            // Normal (0,-1,0) + distance (-clipY) clips where worldPos.y < clipY.
            if (options.terrainClipY !== undefined && !options.sectionPlane?.enabled) {
                sectionPlaneData = {
                    normal: [0, -1, 0],
                    distance: -options.terrainClipY,
                    enabled: true,
                };
            }

            if (options.sectionPlane) {
                // Get model bounds from batched meshes. We deliberately EXCLUDE
                // individual meshes (`this.scene.getMeshes()`) here: those are
                // created lazily for selection highlighting and can live at
                // unexpected world positions (e.g. legacy transforms, overlay
                // helpers), which would inflate the bounds range and make
                // "1% of the slider" span the entire real model — producing
                // the reported symptom where the model pops from fully visible
                // to fully invisible across a tiny slider range.
                const boundsMin = { x: Infinity, y: Infinity, z: Infinity };
                const boundsMax = { x: -Infinity, y: -Infinity, z: -Infinity };

                const batchedMeshes = this.scene.getBatchedMeshes();
                for (const batch of batchedMeshes) {
                    if (batch.bounds) {
                        boundsMin.x = Math.min(boundsMin.x, batch.bounds.min[0]);
                        boundsMin.y = Math.min(boundsMin.y, batch.bounds.min[1]);
                        boundsMin.z = Math.min(boundsMin.z, batch.bounds.min[2]);
                        boundsMax.x = Math.max(boundsMax.x, batch.bounds.max[0]);
                        boundsMax.y = Math.max(boundsMax.y, batch.bounds.max[1]);
                        boundsMax.z = Math.max(boundsMax.z, batch.bounds.max[2]);
                    }
                }

                // If no batched meshes have bounds yet (streaming, degenerate
                // models), fall back to individual meshes so at least the
                // slider has a workable range.
                if (!Number.isFinite(boundsMin.x)) {
                    for (const mesh of meshes) {
                        if (mesh.bounds) {
                            boundsMin.x = Math.min(boundsMin.x, mesh.bounds.min[0]);
                            boundsMin.y = Math.min(boundsMin.y, mesh.bounds.min[1]);
                            boundsMin.z = Math.min(boundsMin.z, mesh.bounds.min[2]);
                            boundsMax.x = Math.max(boundsMax.x, mesh.bounds.max[0]);
                            boundsMax.y = Math.max(boundsMax.y, mesh.bounds.max[1]);
                            boundsMax.z = Math.max(boundsMax.z, mesh.bounds.max[2]);
                        }
                    }
                }

                // Fallback if no bounds found
                if (!Number.isFinite(boundsMin.x)) {
                    boundsMin.x = boundsMin.y = boundsMin.z = -100;
                    boundsMax.x = boundsMax.y = boundsMax.z = 100;
                }

                // Store bounds for section plane visual and camera near/far
                this.setModelBounds({ min: boundsMin, max: boundsMax });
                this.camera.setSceneBounds({ min: boundsMin, max: boundsMax });

                // Only calculate clipping data if section is enabled
                // Terrain clip: when no section plane is active, use terrainClipY
                // to clip fragments below terrain height. Normal (0,-1,0) with
                // distance = -clipY clips worldPos.y < clipY.
                if (!options.sectionPlane?.enabled && options.terrainClipY !== undefined) {
                    sectionPlaneData = {
                        normal: [0, -1, 0],
                        distance: -options.terrainClipY,
                        enabled: true,
                    };
                }

                if (options.sectionPlane.enabled) {
                    // Calculate plane normal based on semantic axis
                    // down = Y axis (horizontal cut), front = Z axis, side = X axis
                    let normal: [number, number, number] = [0, 0, 0];
                    if (options.sectionPlane.axis === 'side') normal[0] = 1;        // X axis
                    else if (options.sectionPlane.axis === 'down') normal[1] = 1;   // Y axis (horizontal)
                    else normal[2] = 1;                                              // Z axis (front)

                    // Apply building rotation if present (rotate normal around Y axis)
                    // Building rotation is in X-Y plane (Z is up in IFC, Y is up in WebGL)
                    if (options.buildingRotation !== undefined && options.buildingRotation !== 0) {
                        const cosR = Math.cos(options.buildingRotation);
                        const sinR = Math.sin(options.buildingRotation);
                        // Rotate normal vector around Y axis (vertical)
                        // For X-Z plane rotation: x' = x*cos - z*sin, z' = x*sin + z*cos, y' = y
                        const x = normal[0];
                        const z = normal[2];
                        normal[0] = x * cosR - z * sinR;
                        normal[2] = x * sinR + z * cosR;
                        // Normalize to maintain unit length
                        const len = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
                        if (len > 0.0001) {
                            normal[0] /= len;
                            normal[1] /= len;
                            normal[2] /= len;
                        }
                    }

                    // Get axis-specific range. The renderer's own `boundsMin/Max`
                    // are computed from the GPU vertex buffers this frame, so
                    // they are guaranteed to be in the same Y-up world space as
                    // `input.worldPos` in the shader. `options.sectionPlane.min/max`
                    // comes from the UI via `coordinateInfo.shiftedBounds` and can
                    // be stale during streaming or outright wrong during model
                    // load (initialised to {0,0,0} before the first bounds update)
                    // — using those directly was the cause of the "slider moves
                    // 1% and the whole model disappears" bug.
                    //
                    // Policy: always use the renderer's own bounds for the Y-up
                    // range. Only honour the UI override when it is a valid,
                    // non-degenerate range that lies INSIDE the actual mesh
                    // bounds (e.g. storey filtering from the level picker).
                    const axisIdx = options.sectionPlane.axis === 'side' ? 'x' : options.sectionPlane.axis === 'down' ? 'y' : 'z';
                    let minVal = boundsMin[axisIdx];
                    let maxVal = boundsMax[axisIdx];
                    const uiMin = options.sectionPlane.min;
                    const uiMax = options.sectionPlane.max;
                    if (
                        Number.isFinite(uiMin) &&
                        Number.isFinite(uiMax) &&
                        (uiMax as number) - (uiMin as number) > 1e-6 &&
                        (uiMin as number) >= minVal - 1e-3 &&
                        (uiMax as number) <= maxVal + 1e-3
                    ) {
                        minVal = uiMin as number;
                        maxVal = uiMax as number;
                    }

                    // Calculate plane distance from position percentage
                    const range = maxVal - minVal;
                    const distance = minVal + (options.sectionPlane.position / 100) * range;

                    sectionPlaneData = { normal, distance, enabled: true };

                    // One-shot diagnostic: when section first becomes active,
                    // log the exact bounds + distance the shader will use.
                    // This is the fastest way to confirm "bounds mismatch" bugs
                    // without asking the user to run a debugger.
                    if (!this._loggedSectionBounds) {
                        this._loggedSectionBounds = true;
                        console.info('[Section] Y-up bounds used for clip:', {
                            axis: options.sectionPlane.axis,
                            axisIdx,
                            bounds: {
                                min: { x: boundsMin.x, y: boundsMin.y, z: boundsMin.z },
                                max: { x: boundsMax.x, y: boundsMax.y, z: boundsMax.z },
                            },
                            uiOverride: { min: uiMin, max: uiMax },
                            used: { min: minVal, max: maxVal },
                            position: options.sectionPlane.position,
                            distance,
                            batchedMeshCount: this.scene.getBatchedMeshes().length,
                        });
                    }
                }
            }

            // Reuse pooled scratch buffer for per-mesh uniform writes
            const meshBuf = this.uniformScratch;
            const meshFlags = this.uniformScratchU32;
            for (const mesh of allMeshes) {
                if (mesh.uniformBuffer) {
                    meshBuf.set(viewProj, 0);
                    meshBuf.set(mesh.transform.m, 16);

                    // Check if mesh is selected (single or multi-selection)
                    // For multi-model support: also check modelIndex if provided
                    const expressIdMatch = mesh.expressId === selectedId;
                    const modelIndexMatch = selectedModelIndex === undefined || mesh.modelIndex === selectedModelIndex;
                    const isSelected = (selectedId !== undefined && selectedId !== null && expressIdMatch && modelIndexMatch)
                        || (selectedIds !== undefined && selectedIds.has(mesh.expressId));

                    meshBuf[32] = mesh.color[0];
                    meshBuf[33] = mesh.color[1];
                    meshBuf[34] = mesh.color[2];
                    meshBuf[35] = mesh.color[3];
                    meshBuf[36] = mesh.material?.metallic ?? 0.0;
                    meshBuf[37] = mesh.material?.roughness ?? 0.6;
                    meshBuf[38] = 0; meshBuf[39] = 0;

                    // Section plane data (offset 40-43)
                    if (sectionPlaneData) {
                        meshBuf[40] = sectionPlaneData.normal[0];
                        meshBuf[41] = sectionPlaneData.normal[1];
                        meshBuf[42] = sectionPlaneData.normal[2];
                        meshBuf[43] = sectionPlaneData.distance;
                    } else {
                        meshBuf[40] = 0; meshBuf[41] = 0; meshBuf[42] = 0; meshBuf[43] = 0;
                    }

                    // Flags (offset 44-47 as u32)
                    // flags.y packs: bit 0 = sectionEnabled, bit 1 = flipped
                    meshFlags[0] = isSelected ? 1 : 0;
                    meshFlags[1] =
                        (sectionPlaneData?.enabled ? 1 : 0) |
                        (options.sectionPlane?.flipped ? 2 : 0);
                    meshFlags[2] = edgeEnabledU32;
                    meshFlags[3] = edgeIntensityMilliU32;

                    device.queue.writeBuffer(mesh.uniformBuffer, 0, meshBuf);
                }
            }

            // Now record draw commands
            const encoder = device.createCommandEncoder();

            // Set up MSAA rendering if enabled
            const msaaView = this.pipeline.getMultisampleTextureView();
            const useMSAA = msaaView !== null && this.pipeline.getSampleCount() > 1;

            const pass = encoder.beginRenderPass({
                colorAttachments: [
                    {
                        // If MSAA enabled: render to multisample texture, resolve to swap chain
                        // If MSAA disabled: render directly to swap chain
                        view: useMSAA ? msaaView : textureView,
                        resolveTarget: useMSAA ? textureView : undefined,
                        loadOp: 'clear',
                        clearValue: clearColor,
                        storeOp: useMSAA ? 'discard' : 'store',  // Discard MSAA buffer after resolve
                    },
                    {
                        view: objectIdView,
                        loadOp: 'clear',
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                        storeOp: needsObjectIdPass ? 'store' : 'discard',
                    },
                ],
                depthStencilAttachment: {
                    view: this.pipeline.getDepthTextureView(),
                    depthClearValue: 0.0,  // Reverse-Z: clear to 0.0 (far plane)
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                    // Stencil is cleared here and preserved for the cap pass
                    // that runs right after in the same frame.
                    stencilClearValue: 0,
                    stencilLoadOp: 'clear',
                    stencilStoreOp: 'store',
                },
            });

            pass.setPipeline(this.pipeline.getPipeline());

            // Check if we have batched meshes (preferred for performance)
            const allBatchedMeshes = this.scene.getBatchedMeshes();

            // PERFORMANCE FIX: Always use batch rendering when we have batches
            // Apply visibility filtering at the BATCH level instead of creating individual meshes
            // This keeps draw calls at ~50-200 instead of 60K+
            if (allBatchedMeshes.length > 0) {
                // Frustum culling for batched meshes - skip entire batches outside the camera view
                // This is the primary performance optimization for large models (200K+ meshes)
                const frustum = FrustumUtils.fromViewProjMatrix(viewProj);

                // Pre-compute visibility for each batch (only when filtering is active)
                // A batch is visible if ANY of its elements are visible
                // A batch is fully visible if ALL of its elements are visible
                const batchVisibility = new Map<typeof allBatchedMeshes[number], { visible: boolean; fullyVisible: boolean }>();

                if (hasVisibilityFiltering) {
                    for (const batch of allBatchedMeshes) {
                        let visibleCount = 0;
                        const total = batch.expressIds.length;

                        for (const expressId of batch.expressIds) {
                            const isHidden = options.hiddenIds?.has(expressId) ?? false;
                            const isIsolated = !hasIsolatedFilter || options.isolatedIds!.has(expressId);
                            if (!isHidden && isIsolated) {
                                visibleCount++;
                            }
                        }

                        batchVisibility.set(batch, {
                            visible: visibleCount > 0,
                            fullyVisible: visibleCount === total,
                        });
                    }
                }

                // Separate batches into opaque and transparent, filtering by visibility
                // IMPORTANT: Only render FULLY visible batches - partially visible batches
                // need individual mesh rendering to show only the visible elements
                const opaqueBatches: typeof allBatchedMeshes = [];
                const transparentBatches: typeof allBatchedMeshes = [];

                // PERFORMANCE FIX: Track partially visible batches for sub-batch rendering
                // Instead of creating 10,000+ individual meshes, we create cached sub-batches
                const partiallyVisibleBatches: Array<{
                    sourceBatchKey: string;
                    colorKey: string;
                    visibleIds: Set<number>;
                    color: [number, number, number, number];
                }> = [];

                for (const batch of allBatchedMeshes) {
                    // Frustum culling: skip batches entirely outside the camera view
                    if (batch.bounds) {
                        const batchAABB = { min: batch.bounds.min, max: batch.bounds.max };
                        if (!FrustumUtils.isAABBVisible(frustum, batchAABB)) {
                            continue; // Entire batch is off-screen
                        }
                    }

                    // Check visibility
                    if (hasVisibilityFiltering) {
                        const vis = batchVisibility.get(batch);
                        if (!vis || !vis.visible) continue; // Skip completely hidden batches

                        // Handle partially visible batches - create sub-batches instead of individual meshes
                        if (!vis.fullyVisible) {
                            // Collect the visible expressIds from this batch
                            const visibleIds = new Set<number>();
                            for (const expressId of batch.expressIds) {
                                const isHidden = options.hiddenIds?.has(expressId) ?? false;
                                const isIsolated = !hasIsolatedFilter || options.isolatedIds!.has(expressId);
                                if (!isHidden && isIsolated) {
                                    visibleIds.add(expressId);
                                }
                            }
                            if (visibleIds.size > 0) {
                                partiallyVisibleBatches.push({
                                    sourceBatchKey: `${batch.colorKey}:${batch.id}`,
                                    colorKey: batch.colorKey,
                                    visibleIds,
                                    color: batch.color,
                                });
                            }
                            continue; // Don't add batch to render list
                        }
                    }

                    const alpha = batch.color[3];
                    if (alpha < 0.99) {
                        transparentBatches.push(batch);
                    } else {
                        opaqueBatches.push(batch);
                    }
                }

                const selectedExpressIds = new Set<number>();
                if (selectedId !== undefined && selectedId !== null) {
                    selectedExpressIds.add(selectedId);
                }
                if (selectedIds) {
                    for (const id of selectedIds) {
                        selectedExpressIds.add(id);
                    }
                }

                // Build a uniform template ONCE per frame — shared across all batches.
                // Only the 4-float color (offset 32) differs per batch; everything else
                // (viewProj, identity model, material, section plane, flags) is identical.
                const tpl = this.uniformScratch;
                const tplFlags = this.uniformScratchU32;
                tpl.set(viewProj, 0);
                // Identity model matrix (positions already in world space)
                tpl[16] = 1; tpl[17] = 0; tpl[18] = 0; tpl[19] = 0;
                tpl[20] = 0; tpl[21] = 1; tpl[22] = 0; tpl[23] = 0;
                tpl[24] = 0; tpl[25] = 0; tpl[26] = 1; tpl[27] = 0;
                tpl[28] = 0; tpl[29] = 0; tpl[30] = 0; tpl[31] = 1;
                // Color placeholder — overwritten per batch
                // tpl[32..35] set per batch
                tpl[36] = 0.0; // metallic
                tpl[37] = 0.6; // roughness
                tpl[38] = 0; tpl[39] = 0; // padding
                if (sectionPlaneData) {
                    tpl[40] = sectionPlaneData.normal[0];
                    tpl[41] = sectionPlaneData.normal[1];
                    tpl[42] = sectionPlaneData.normal[2];
                    tpl[43] = sectionPlaneData.distance;
                } else {
                    tpl[40] = 0; tpl[41] = 0; tpl[42] = 0; tpl[43] = 0;
                }
                // flags layout (main shader):
                //   x = isSelected (0/1)
                //   y = sectionEnabled bitfield:
                //       bit 0 = enabled, bit 1 = flipped
                //   z = edgeEnabled (0/1)
                //   w = edgeIntensityMilli
                tplFlags[0] = 0;
                tplFlags[1] =
                    (sectionPlaneData?.enabled ? 1 : 0) |
                    (options.sectionPlane?.flipped ? 2 : 0);
                tplFlags[2] = edgeEnabledU32;
                tplFlags[3] = edgeIntensityMilliU32;

                // Helper function to render a batch — patches color into the shared template
                const renderBatch = (batch: typeof allBatchedMeshes[0]) => {
                    if (!batch.bindGroup || !batch.uniformBuffer) return;

                    // Patch only the per-batch color (4 floats at offset 32)
                    tpl[32] = batch.color[0];
                    tpl[33] = batch.color[1];
                    tpl[34] = batch.color[2];
                    tpl[35] = batch.color[3];

                    device.queue.writeBuffer(batch.uniformBuffer, 0, tpl);

                    // Single draw call for entire batch!
                    pass.setBindGroup(0, batch.bindGroup);
                    pass.setVertexBuffer(0, batch.vertexBuffer);
                    pass.setIndexBuffer(batch.indexBuffer, 'uint32');
                    pass.drawIndexed(batch.indexCount);
                };

                // Render opaque batches first with opaque pipeline
                pass.setPipeline(this.pipeline.getPipeline());
                for (const batch of opaqueBatches) {
                    renderBatch(batch);
                }

                // PERFORMANCE FIX: Render partially visible batches as sub-batches (not individual meshes!)
                // This is the key optimization: instead of 10,000+ individual draw calls,
                // we create cached sub-batches with only visible elements and render them as single draw calls.
                // We also collect resolved opaque sub-batches so the section cap pass below can
                // include them in its parity count — otherwise hidden/isolated opaque geometry
                // would show open, un-capped cut holes.
                const opaqueSubBatches: typeof allBatchedMeshes = [];
                if (partiallyVisibleBatches.length > 0) {
                    for (const { sourceBatchKey, colorKey, visibleIds, color } of partiallyVisibleBatches) {
                        // Get or create a cached sub-batch for this visibility state
                        const subBatch = this.scene.getOrCreatePartialBatch(
                            sourceBatchKey,
                            colorKey,
                            visibleIds,
                            device,
                            this.pipeline
                        );

                        if (subBatch) {
                            // Use opaque or transparent pipeline based on alpha
                            const isTransparent = color[3] < 0.99;
                            if (isTransparent) {
                                pass.setPipeline(this.pipeline.getTransparentPipeline());
                            } else {
                                pass.setPipeline(this.pipeline.getPipeline());
                                opaqueSubBatches.push(subBatch);
                            }
                            // Render the sub-batch as a single draw call
                            renderBatch(subBatch);
                        }
                    }
                    // Reset to opaque pipeline for subsequent rendering
                    pass.setPipeline(this.pipeline.getPipeline());
                }

                // Render color overlay batches (lens coloring) on top of ALL opaque geometry.
                // Placed AFTER partial batches so depth buffer is complete for both full
                // and partial batches. Uses 'equal' depth compare — only paints where
                // original geometry wrote depth, so hidden entities never leak through.
                const overrideBatches = this.scene.getOverrideBatches();
                if (overrideBatches.length > 0) {
                    pass.setPipeline(this.pipeline.getOverlayPipeline());
                    for (const batch of overrideBatches) {
                        renderBatch(batch);
                    }
                    pass.setPipeline(this.pipeline.getPipeline());
                }

                // Filled, hatched 3D cut surfaces are now rendered by
                // Section2DOverlayRenderer using the exact polygons from
                // SectionCutter (triangle-plane intersection). The old
                // stencil-parity SectionCapRenderer is no longer in the
                // render loop — parity XOR on non-manifold IFC geometry
                // leaks stencil bits into empty sky, and no amount of
                // bounded quads or second-bit gating fixed that robustly.
                // See the 2D-overlay draw call further below in this same
                // render pass, which now emits the cap.

                // Prepare selected meshes once, then render them LAST so transparent batches
                // don't overwrite highlight color (glass otherwise appears unhighlighted).
                const visibleSelectedIds = new Set<number>();
                for (const selId of selectedExpressIds) {
                    if (options.hiddenIds?.has(selId)) continue;
                    if (hasIsolatedFilter && !options.isolatedIds!.has(selId)) continue;
                    visibleSelectedIds.add(selId);
                }

                // Only build per-mesh piece counts when we actually have selected
                // elements that need individual mesh rendering. This avoids iterating
                // 200K+ meshes every frame when nothing is selected.
                if (visibleSelectedIds.size > 0) {
                    const allMeshesFromScene = this.scene.getMeshes();
                    const existingPieceCounts = new Map<string, number>();
                    for (const mesh of allMeshesFromScene) {
                        const key = `${mesh.expressId}:${mesh.modelIndex ?? 'any'}`;
                        existingPieceCounts.set(key, (existingPieceCounts.get(key) ?? 0) + 1);
                    }

                    for (const selId of visibleSelectedIds) {
                        const pieces = this.scene.getMeshDataPieces(selId, selectedModelIndex);
                        if (!pieces || pieces.length === 0) continue;

                        const seenOrdinalsByKey = new Map<string, number>();
                        for (const piece of pieces) {
                            const meshKey = `${piece.expressId}:${piece.modelIndex ?? 'any'}`;
                            const ordinal = seenOrdinalsByKey.get(meshKey) ?? 0;
                            seenOrdinalsByKey.set(meshKey, ordinal + 1);
                            const baselineExisting = existingPieceCounts.get(meshKey) ?? 0;
                            if (ordinal < baselineExisting) continue;
                            this.createMeshFromData(piece);
                        }
                    }
                }

                const selectedMeshes = visibleSelectedIds.size > 0
                    ? this.scene.getMeshes().filter(mesh => {
                        if (!visibleSelectedIds.has(mesh.expressId)) return false;
                        if (selectedModelIndex !== undefined && mesh.modelIndex !== selectedModelIndex) return false;
                        return true;
                    })
                    : [];

                // Render transparent BATCHED meshes with transparent pipeline (after opaque batches and selections)
                if (transparentBatches.length > 0) {
                    pass.setPipeline(this.pipeline.getTransparentPipeline());
                    for (const batch of transparentBatches) {
                        renderBatch(batch);
                    }
                }

                // Render transparent individual meshes with transparent pipeline
                if (transparentMeshes.length > 0) {
                    pass.setPipeline(this.pipeline.getTransparentPipeline());
                    for (const mesh of transparentMeshes) {
                        if (!mesh.bindGroup || !mesh.uniformBuffer) {
                            continue;
                        }

                        tpl.set(viewProj, 0);
                        tpl.set(mesh.transform.m, 16);
                        tpl[32] = mesh.color[0]; tpl[33] = mesh.color[1];
                        tpl[34] = mesh.color[2]; tpl[35] = mesh.color[3];
                        tpl[36] = mesh.material?.metallic ?? 0.0;
                        tpl[37] = mesh.material?.roughness ?? 0.6;
                        tpl[38] = 0; tpl[39] = 0;
                        if (sectionPlaneData) {
                            tpl[40] = sectionPlaneData.normal[0];
                            tpl[41] = sectionPlaneData.normal[1];
                            tpl[42] = sectionPlaneData.normal[2];
                            tpl[43] = sectionPlaneData.distance;
                        } else {
                            tpl[40] = 0; tpl[41] = 0; tpl[42] = 0; tpl[43] = 0;
                        }
                        tplFlags[0] = 0;
                        tplFlags[1] =
                            (sectionPlaneData?.enabled ? 1 : 0) |
                            (options.sectionPlane?.flipped ? 2 : 0);
                        tplFlags[2] = edgeEnabledU32;
                        tplFlags[3] = edgeIntensityMilliU32;

                        device.queue.writeBuffer(mesh.uniformBuffer, 0, tpl);

                        pass.setBindGroup(0, mesh.bindGroup);
                        pass.setVertexBuffer(0, mesh.vertexBuffer);
                        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                        pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                    }
                }

                // Ensure selected meshes have uniform buffers and bind groups
                for (const mesh of selectedMeshes) {
                    if (!mesh.uniformBuffer && this.pipeline) {
                        mesh.uniformBuffer = device.createBuffer({
                            size: this.pipeline.getUniformBufferSize(),
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                        });
                        mesh.bindGroup = device.createBindGroup({
                            layout: this.pipeline.getBindGroupLayout(),
                            entries: [
                                {
                                    binding: 0,
                                    resource: { buffer: mesh.uniformBuffer },
                                },
                            ],
                        });
                    }
                }

                // Render selected meshes with highlight LAST (on top of transparent geometry too)
                for (const mesh of selectedMeshes) {
                    if (!mesh.bindGroup || !mesh.uniformBuffer) {
                        continue;
                    }

                    tpl.set(viewProj, 0);
                    tpl.set(mesh.transform.m, 16);
                    tpl[32] = mesh.color[0]; tpl[33] = mesh.color[1];
                    tpl[34] = mesh.color[2]; tpl[35] = mesh.color[3];
                    tpl[36] = mesh.material?.metallic ?? 0.0;
                    tpl[37] = mesh.material?.roughness ?? 0.6;
                    tpl[38] = 0; tpl[39] = 0;
                    if (sectionPlaneData) {
                        tpl[40] = sectionPlaneData.normal[0];
                        tpl[41] = sectionPlaneData.normal[1];
                        tpl[42] = sectionPlaneData.normal[2];
                        tpl[43] = sectionPlaneData.distance;
                    } else {
                        tpl[40] = 0; tpl[41] = 0; tpl[42] = 0; tpl[43] = 0;
                    }
                    tplFlags[0] = 1; // isSelected
                    tplFlags[1] =
                        (sectionPlaneData?.enabled ? 1 : 0) |
                        (options.sectionPlane?.flipped ? 2 : 0);
                    tplFlags[2] = edgeEnabledU32;
                    tplFlags[3] = edgeIntensityMilliU32;

                    device.queue.writeBuffer(mesh.uniformBuffer, 0, tpl);

                    pass.setPipeline(this.pipeline.getSelectionPipeline());
                    pass.setBindGroup(0, mesh.bindGroup);
                    pass.setVertexBuffer(0, mesh.vertexBuffer);
                    pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                    pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                }
            } else {
                // Fallback: render individual meshes (only when no batches exist)
                // Render opaque meshes with per-mesh bind groups
                for (const mesh of opaqueMeshes) {
                    if (mesh.bindGroup) {
                        pass.setBindGroup(0, mesh.bindGroup);
                    } else {
                        pass.setBindGroup(0, this.pipeline.getBindGroup());
                    }
                    pass.setVertexBuffer(0, mesh.vertexBuffer);
                    pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                    pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                }

                // Render transparent meshes with transparent pipeline (alpha blending)
                if (transparentMeshes.length > 0) {
                    pass.setPipeline(this.pipeline.getTransparentPipeline());
                    for (const mesh of transparentMeshes) {
                        if (mesh.bindGroup) {
                            pass.setBindGroup(0, mesh.bindGroup);
                        } else {
                            pass.setBindGroup(0, this.pipeline.getBindGroup());
                        }
                        pass.setVertexBuffer(0, mesh.vertexBuffer);
                        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                        pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                    }
                }
            }

            // Render instanced meshes (much more efficient for repeated geometry)
            if (this.instancedPipeline) {
                const instancedMeshes = this.scene.getInstancedMeshes();
                if (instancedMeshes.length > 0) {
                    // Update instanced pipeline uniforms
                    this.instancedPipeline.updateUniforms(
                        viewProj,
                        sectionPlaneData
                            ? { ...sectionPlaneData, flipped: options.sectionPlane?.flipped === true }
                            : undefined,
                    );

                    // Switch to instanced pipeline
                    pass.setPipeline(this.instancedPipeline.getPipeline());

                    for (const instancedMesh of instancedMeshes) {
                        // Use cached bind group (created at mesh upload time)
                        // Falls back to creating one if missing (shouldn't happen in normal flow)
                        const bindGroup = instancedMesh.bindGroup ??
                            this.instancedPipeline.createInstanceBindGroup(instancedMesh.instanceBuffer);
                        pass.setBindGroup(0, bindGroup);
                        pass.setVertexBuffer(0, instancedMesh.vertexBuffer);
                        pass.setIndexBuffer(instancedMesh.indexBuffer, 'uint32');
                        // Draw with instancing: indexCount, instanceCount
                        pass.drawIndexed(instancedMesh.indexCount, instancedMesh.instanceCount, 0, 0, 0);
                    }
                }
            }

            // Draw section plane visual BEFORE pass.end() (within same MSAA render pass)
            // Always show plane when sectionPlane options are provided (as preview or active)
            const modelBounds = this.getModelBounds();
            if (options.sectionPlane && this.sectionPlaneRenderer && modelBounds) {
                this.sectionPlaneRenderer.draw(
                    pass,
                    {
                        axis: options.sectionPlane.axis,
                        position: options.sectionPlane.position,
                        bounds: modelBounds,
                        viewProj,
                        isPreview: !options.sectionPlane.enabled, // Preview mode when not enabled
                        min: options.sectionPlane.min,
                        max: options.sectionPlane.max,
                    }
                );

                // Draw 2D section overlay on the section plane (when section is
                // active, not preview). The overlay is also the 3D SECTION CAP:
                // its polygon fills come from `SectionCutter` (exact triangle-
                // plane intersection), and the new fill shader applies the
                // user's screen-space hatch + colour directly on those
                // polygons. This replaces the old stencil-parity cap, which
                // bled hatch into empty sky on non-manifold IFC geometry —
                // the polygons here are mathematically correct, so the cap
                // silhouette matches the 2D drawing exactly.
                if (options.sectionPlane.enabled && this.section2DOverlayRenderer?.hasGeometry()) {
                    const o = options.sectionPlane;
                    const showFills    = o.showCap !== false;
                    const showOutlines = o.showOutlines !== false;
                    const style = { ...DEFAULT_CAP_STYLE, ...(o.capStyle ?? {}) };
                    this.section2DOverlayRenderer.draw(
                        pass,
                        {
                            axis: o.axis,
                            position: o.position,
                            bounds: modelBounds,
                            viewProj,
                            min: o.min,
                            max: o.max,
                            showFills,
                            showOutlines,
                            capStyle: showFills ? {
                                fillColor:   style.fillColor,
                                strokeColor: style.strokeColor,
                                patternId:   HATCH_PATTERN_IDS[style.pattern],
                                spacingPx:   style.spacingPx,
                                angleRad:    style.angleRad,
                                widthPx:     style.widthPx,
                                secondaryAngleRad: style.secondaryAngleRad,
                            } : undefined,
                        }
                    );
                }
            }

            pass.end();

            const canRunPostPass = (contactEnabled || separationEnabled)
                && this.postProcessor !== null;
            if (canRunPostPass && this.postProcessor) {
                this.postProcessor.updateOptions({
                    enableContactShading: contactEnabled,
                    contactRadius: visualEnhancement.contactShading.radius,
                    contactIntensity: visualEnhancement.contactShading.intensity,
                });
                this.postProcessor.apply(encoder, {
                    targetView: textureView,
                    // Depth-only view required because depth24plus-stencil8
                    // cannot be sampled as texture_depth_* with aspect 'all'.
                    depthView: this.pipeline.getDepthOnlyTextureView(),
                    objectIdView: this.pipeline.getObjectIdTextureView(),
                    contactQuality: contactEnabled && visualEnhancement.contactShading.quality === 'high' ? 'high' : 'low',
                    radius: Math.min(3.0, Math.max(1.0, visualEnhancement.contactShading.radius)),
                    intensity: contactEnabled ? Math.min(1.0, Math.max(0.0, visualEnhancement.contactShading.intensity)) : 0.0,
                    separationQuality: visualEnhancement.separationLines.quality === 'high' ? 'high' : 'low',
                    separationRadius: Math.min(2.0, Math.max(1.0, visualEnhancement.separationLines.radius)),
                    separationIntensity: separationEnabled ? Math.min(1.0, Math.max(0.0, visualEnhancement.separationLines.intensity)) : 0.0,
                    enableSeparationLines: separationEnabled,
                });
            }

            device.queue.submit([encoder.finish()]);
        } catch (error) {
            // Handle WebGPU errors (e.g., device lost, invalid state)
            // Mark context as invalid so it gets reconfigured next frame
            this.device.invalidateContext();
            // Rate-limit error logging to avoid spam (max once per second)
            const now = performance.now();
            if (now - this.lastRenderErrorTime > this.RENDER_ERROR_THROTTLE_MS) {
                this.lastRenderErrorTime = now;
                console.warn('Render error (context will be reconfigured):', error);
            }
        }
    }

    /**
     * Pick object at screen coordinates
     * Respects visibility filtering so users can only select visible elements
     * Returns PickResult with expressId and modelIndex for multi-model support
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    async pick(x: number, y: number, options?: PickOptions): Promise<PickResult | null> {
        return this.pickingManager.pick(x, y, options);
    }

    /**
     * Raycast into the scene to get precise 3D intersection point
     * This is more accurate than pick() as it returns the exact surface point
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    raycastScene(
        x: number,
        y: number,
        options?: PickOptions & { snapOptions?: Partial<SnapOptions> }
    ): { intersection: Intersection; snap?: SnapTarget } | null {
        return this.raycastEngine.raycastScene(x, y, options);
    }

    /**
     * Raycast with magnetic edge snapping behavior
     * This provides the "stick and slide along edges" experience
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    raycastSceneMagnetic(
        x: number,
        y: number,
        currentEdgeLock: EdgeLockInput,
        options?: PickOptions & { snapOptions?: Partial<SnapOptions> }
    ): MagneticSnapResult & { intersection: Intersection | null } {
        return this.raycastEngine.raycastSceneMagnetic(x, y, currentEdgeLock, options);
    }

    /**
     * Invalidate BVH cache (call when geometry changes)
     */
    invalidateBVHCache(): void {
        this.raycastEngine.invalidateBVHCache();
    }

    /**
     * Get the raycaster instance (for advanced usage)
     */
    getRaycaster(): Raycaster {
        return this.raycastEngine.getRaycaster();
    }

    /**
     * Get the snap detector instance (for advanced usage)
     */
    getSnapDetector(): SnapDetector {
        return this.raycastEngine.getSnapDetector();
    }

    /**
     * Clear all caches (call when geometry changes)
     */
    clearCaches(): void {
        this.raycastEngine.clearCaches();
    }

    // ─── Dirty-flag render scheduling ────────────────────────────────────
    // The animation loop is THE render path.  Everything else (mouse, touch,
    // keyboard, streaming, visibility changes, theme changes) calls
    // requestRender() to set the dirty flag.  The loop drains scene queues,
    // resolves render options via refs, and issues a single render() call.

    /**
     * Request a render on the next animation frame.
     * Safe to call many times per frame — only one render will happen.
     */
    requestRender(): void {
        this._renderRequested = true;
    }

    /**
     * Check whether a render has been requested without clearing the flag.
     * Used by the animation loop to test the dirty flag before committing
     * to render (e.g. when throttling may skip the frame).
     */
    peekRenderRequest(): boolean {
        return this._renderRequested;
    }

    /**
     * Consume the render request flag.  Returns true (and resets the flag)
     * if a render was requested since the last call.  Used by the animation
     * loop to decide whether to render.
     */
    consumeRenderRequest(): boolean {
        if (!this._renderRequested) return false;
        this._renderRequested = false;
        return true;
    }

    /**
     * Resize canvas
     */
    resize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;
        this.camera.setAspect(width / height);
    }

    getCamera(): Camera {
        return this.camera;
    }

    getScene(): Scene {
        return this.scene;
    }

    /**
     * Upload 2D section drawing data for 3D overlay rendering
     * Call this when a 2D drawing is generated to display it on the section plane
     * Uses same position calculation as section plane: sectionRange min/max if provided, else modelBounds
     */
    uploadSection2DOverlay(
        polygons: CutPolygon2D[],
        lines: DrawingLine2D[],
        axis: 'down' | 'front' | 'side',
        position: number,  // 0-100 percentage
        sectionRange?: { min?: number; max?: number },  // Same storey-based range as section plane
        flipped: boolean = false
    ): void {
        if (!this.section2DOverlayRenderer) return;

        // Use EXACTLY same calculation as section plane in render() method:
        // minVal = options.sectionPlane.min ?? boundsMin[axisIdx]
        // maxVal = options.sectionPlane.max ?? boundsMax[axisIdx]
        const axisIdx = axis === 'side' ? 'x' : axis === 'down' ? 'y' : 'z';

        const modelBounds = this.getModelBounds();

        // Allow upload if either sectionRange has both values, or modelBounds exists as fallback
        const hasFullRange = sectionRange?.min !== undefined && sectionRange?.max !== undefined;
        if (!hasFullRange && !modelBounds) return;

        const minVal = sectionRange?.min ?? modelBounds!.min[axisIdx];
        const maxVal = sectionRange?.max ?? modelBounds!.max[axisIdx];
        const planePosition = minVal + (position / 100) * (maxVal - minVal);

        this.section2DOverlayRenderer.uploadDrawing(polygons, lines, axis, planePosition, flipped);
    }

    /**
     * Clear the 2D section overlay
     */
    clearSection2DOverlay(): void {
        if (this.section2DOverlayRenderer) {
            this.section2DOverlayRenderer.clearGeometry();
        }
    }

    /**
     * Check if 2D section overlay has geometry to render
     */
    hasSection2DOverlay(): boolean {
        return this.section2DOverlayRenderer?.hasGeometry() ?? false;
    }

    /**
     * Get render pipeline (for batching)
     */
    getPipeline(): RenderPipeline | null {
        return this.pipeline;
    }

    /**
     * Check if renderer is fully initialized and ready to use
     */
    isReady(): boolean {
        return this.device.isInitialized() && this.pipeline !== null;
    }

    /**
     * Get the GPU device (returns null if not initialized)
     */
    getGPUDevice(): GPUDevice | null {
        if (!this.device.isInitialized()) {
            return null;
        }
        return this.device.getDevice();
    }

    /**
     * Capture a screenshot of the current view
     * Waits for GPU work to complete and captures exactly what's displayed
     * @returns PNG data URL or null if capture failed
     */
    async captureScreenshot(): Promise<string | null> {
        if (!this.device.isInitialized()) {
            console.warn('[Renderer] Cannot capture screenshot: not initialized');
            return null;
        }

        try {
            // Wait for any pending GPU work to complete before capturing
            // This ensures we capture the fully rendered frame
            const device = this.device.getDevice();
            await device.queue.onSubmittedWorkDone();

            // Capture exactly what's displayed on the canvas
            const dataUrl = this.canvas.toDataURL('image/png');
            return dataUrl;
        } catch (error) {
            console.error('[Renderer] Screenshot capture failed:', error);
            return null;
        }
    }

    /**
     * Destroy the renderer and release all GPU resources.
     *
     * Cleans up scene buffers, render pipeline textures, picking resources,
     * post-processing buffers, section-plane renderers, and snap caches.
     * After calling this method the renderer is no longer usable.
     * Safe to call multiple times (idempotent).
     */
    destroy(): void {
        // Scene mesh GPU buffers
        this.scene.clear();
        // Re-arm the section-bounds diagnostic log for the next model.
        this._loggedSectionBounds = false;

        // Render pipelines (textures + uniform buffers)
        this.pipeline?.destroy();
        this.pipeline = null;
        this.instancedPipeline?.destroy();
        this.instancedPipeline = null;

        // Picker GPU resources
        this.picker?.destroy();
        this.picker = null;

        // Post-processor uniform buffer
        this.postProcessor?.destroy();
        this.postProcessor = null;

        // Section-plane renderers
        this.sectionPlaneRenderer?.destroy();
        this.sectionPlaneRenderer = null;
        this.section2DOverlayRenderer?.dispose();
        this.section2DOverlayRenderer = null;

        // Snap detector geometry cache
        this.raycastEngine.clearCaches();
    }

    /**
     * Get the canvas element
     */
    getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }
}
