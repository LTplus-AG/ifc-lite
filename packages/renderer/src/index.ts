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

// IfcAnnotation overlay pipelines (3D world-space). Self-contained — caller
// passes a GPUDevice + presentation format and invokes `.render(pass, viewProj)`
// from inside an RGBA-blended pass. See packages/renderer/src/symbolic-overlay-pipelines.ts.
export {
  SymbolicFillPipeline,
  SymbolicTextPipeline,
  type SymbolicFillInput,
  type SymbolicTextInput,
} from './symbolic-overlay-pipelines.js';
export { SymbolicTextAtlas } from './symbolic-text-atlas.js';

// Section cap styling (hatch pattern ids + default colours). The cap itself
// is now rendered by Section2DOverlayRenderer's fill pass; this module just
// holds the styling primitives shared with the store and UI.
export { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
export type { SectionCapStyle, HatchPatternId } from './section-cap-style.js';
export { planeBasis, nearestCardinalAxis } from './section-plane-basis.js';
export type { PlaneBasis, Vec3Tuple } from './section-plane-basis.js';
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
export type { PointPickProvider } from './picking-manager.js';
export { RaycastEngine } from './raycast-engine.js';
export { PointPicker, decodePickSample } from './point-picker.js';
export type { PointPickNode, DecodedPickSample } from './point-picker.js';
export type { PointPickSizing } from './picker.js';

// Point cloud rendering (Phase 0: IFCx inline; Phase 1+: streaming LAS/LAZ)
export { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
export type {
    PointCloudAssetHandle,
    PointCloudRenderOptions,
    PointColorMode,
    PointSizeMode,
    ResolvedSectionPlane as PointResolvedSectionPlane,
} from './pointcloud/point-cloud-renderer.js';
export { PointRenderPipeline } from './pointcloud/point-pipeline.js';
export type {
    PointCloudChunkInput,
    PointCloudNode,
    PointCloudNodeMeta,
} from './pointcloud/point-cloud-node.js';

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
import {
  SymbolicFillPipeline,
  SymbolicTextPipeline,
  type SymbolicFillInput,
  type SymbolicTextInput,
} from './symbolic-overlay-pipelines.js';
import { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
import type { InstancedGeometry } from '@ifc-lite/wasm';
import { Raycaster, type Intersection } from './raycaster.js';
import { SnapDetector, type SnapTarget, type SnapOptions, type EdgeLockInput, type MagneticSnapResult } from './snap-detector.js';
import { PickingManager } from './picking-manager.js';
import { RaycastEngine } from './raycast-engine.js';
import { PostProcessor } from './post-processor.js';
import { EdlPass } from './edl-pass.js';
import { shouldRouteMeshTransparent, shouldRouteBatchTransparent, splitVisibleIdsByPromotion } from './overlay-routing.js';
import { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { DeviationPipeline } from './deviation/deviation-pipeline.js';
import { buildTriangleBVH } from './deviation/triangle-bvh.js';

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
 * Build a deterministic fingerprint of the BVH input mesh set so
 * `Renderer.computeDeviations` can skip the rebuild when the source
 * geometry hasn't changed. Folds in expressId / modelIndex / position
 * + index lengths per mesh so two distinct mesh sets that happen to
 * share the same aggregate position-length total can't collide on the
 * same fingerprint and reuse a stale BVH.
 */
function computeBvhFingerprint(meshes: ReadonlyArray<import('@ifc-lite/geometry').MeshData>): string {
    const parts: string[] = [String(meshes.length)];
    for (const m of meshes) {
        const id = m.expressId ?? -1;
        const mi = m.modelIndex ?? -1;
        const posLen = m.positions?.length ?? 0;
        const idxLen = m.indices?.length ?? 0;
        parts.push(`${id}:${mi}:${posLen}:${idxLen}`);
    }
    return parts.join('|');
}

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
    // IfcAnnotation overlay pipelines (issue #653). Created on `init()` once
    // the device exists; nulled until then.
    private symbolicFillPipeline: SymbolicFillPipeline | null = null;
    private symbolicTextPipeline: SymbolicTextPipeline | null = null;
    private postProcessor: PostProcessor | null = null;
    private edlPass: EdlPass | null = null;
    private edlOptions: { enabled: boolean; strength: number; radiusPx: number; highQuality: boolean } = {
        enabled: false,
        strength: 1,
        radiusPx: 1,
        highQuality: true,
    };
    private pointCloudRenderer: PointCloudRenderer | null = null;
    private deviationPipeline: DeviationPipeline | null = null;
    /**
     * Cache of which mesh-set the BVH was built from. We rebuild on
     * `computeDeviations` only when the cached "fingerprint" misses,
     * so re-running deviation against the same model is a fast
     * dispatch — the BVH is multi-second on big BIMs and we don't
     * want to pay that on every slider drag.
     */
    private deviationBvhFingerprint: string | null = null;
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

    // Diagnostic counters for mobile debugging
    private _renderCallCount: number = 0;
    private _renderSkipCount: number = 0;
    private _renderErrorCount: number = 0;
    private _lastRenderError: string = '';


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
        // and clamp to the GPU's max 2D texture dimension so the initial pipeline allocations
        // can't overflow on tall/wide layouts (see render() for the per-frame clamp).
        const rect = this.canvas.getBoundingClientRect();
        const maxDim = this.device.getMaxTextureDimension();
        const rawWidth = this.canvas.width || Math.max(1, Math.floor(rect.width));
        const rawHeight = this.canvas.height || Math.max(1, Math.floor(rect.height));
        const width = Math.min(rawWidth, maxDim);
        const height = Math.min(rawHeight, maxDim);

        // Set pixel dimensions if not already set, or if we clamped them down
        if (!this.canvas.width || !this.canvas.height || this.canvas.width !== width || this.canvas.height !== height) {
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
        // IfcAnnotation overlay pipelines (issue #653). Share the device +
        // presentation format AND the MSAA sample count + objectId attachment
        // shape with the rest of the renderer so they composite into the same
        // RGBA pass without WebGPU pass-compatibility validation errors.
        this.symbolicFillPipeline = new SymbolicFillPipeline(
            this.device.getDevice(),
            this.device.getFormat(),
            this.pipeline.getSampleCount(),
        );
        this.symbolicTextPipeline = new SymbolicTextPipeline(
            this.device.getDevice(),
            this.device.getFormat(),
            this.pipeline.getSampleCount(),
        );
        // PostProcessor is optional — if it fails (e.g. mobile GPU lacking
        // depth TEXTURE_BINDING), rendering still works without post-processing.
        try {
            this.postProcessor = new PostProcessor(this.device, {
                enableContactShading: true,
                contactRadius: 1.0,
                contactIntensity: 0.3,
            }, this.pipeline.getSampleCount());
        } catch (e) {
            console.warn('[Renderer] PostProcessor init failed (post-processing disabled):', e);
            this.postProcessor = null;
        }
        this.pointCloudRenderer = new PointCloudRenderer(
            this.device.getDevice(),
            this.device.getFormat(),
            'depth24plus-stencil8',
            this.pipeline.getSampleCount(),
        );
        // Compute pipeline for the BIM↔scan deviation heatmap. Lazily
        // owns the per-triangle BVH GPU buffers; idle until the first
        // `computeDeviations` call.
        this.deviationPipeline = new DeviationPipeline(this.device.getDevice());
        this.edlPass = new EdlPass(this.device, this.pipeline.getSampleCount());
        this.camera.setAspect(width / height);

        // Update picking manager with initialized picker
        this.pickingManager.setPicker(this.picker);
        // Provide a snapshot of pickable point nodes per pick. The
        // sizing must mirror the live splat shader so click hit-testing
        // matches what the user actually sees on screen.
        this.pickingManager.setPointPickProvider(() => {
            const pcr = this.pointCloudRenderer;
            if (!pcr || !pcr.hasAssets()) return null;
            const opts = pcr.getOptions();
            const sizeMode = opts.sizeMode === 'fixed-px' ? 0 : opts.sizeMode === 'adaptive-world' ? 1 : 2;
            return {
                nodes: pcr.getPickNodes(),
                sizing: {
                    sizeMode: sizeMode as 0 | 1 | 2,
                    worldRadius: opts.worldRadius,
                    pointSizePx: opts.pointSize,
                    clickTolerancePx: 2,
                },
            };
        });
    }

    /**
     * Replace all loaded point clouds with `assets`.
     *
     * Phase 0 entry point — single-chunk inline assets from IFCx
     * (`pcd::base64`, `points::array`, `points::base64`). Future phases
     * accept streaming sources via a different overload.
     */
    setPointClouds(assets: ReadonlyArray<PointCloudAsset>): void {
        if (!this.pointCloudRenderer) {
            throw new Error('Renderer not initialized. Call init() first.');
        }
        this.pointCloudRenderer.setAssets(assets);
        // Replace, not append — bounds may have shrunk (e.g. an IFCx
        // reload with a smaller scan). `expandModelBoundsForPointClouds`
        // alone only grows; recompute from scratch to keep
        // fit-to-view + section-plane sliders accurate.
        this.recomputeModelBounds();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /** Append additional point clouds without clearing existing ones. */
    addPointClouds(assets: ReadonlyArray<PointCloudAsset>): void {
        if (!this.pointCloudRenderer) {
            throw new Error('Renderer not initialized. Call init() first.');
        }
        for (const asset of assets) {
            this.pointCloudRenderer.addAsset(asset);
        }
        this.expandModelBoundsForPointClouds();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /** Total number of point cloud assets currently uploaded. */
    getPointCloudAssetCount(): number {
        return this.pointCloudRenderer?.getNodeCount() ?? 0;
    }

    /** Total number of points across all point cloud assets. */
    getPointCloudPointCount(): number {
        return this.pointCloudRenderer?.getPointCount() ?? 0;
    }

    /** Drop all point cloud GPU resources. */
    clearPointClouds(): void {
        this.pointCloudRenderer?.clear();
        this.recomputeModelBounds();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /**
     * Streaming entry: open an empty asset that will receive chunks via
     * `appendPointCloudChunk`. Call `endPointCloudStream` when no more
     * chunks will arrive (currently a no-op but kept for symmetry).
     */
    beginPointCloudStream(meta: { expressId: number; ifcType?: string; modelIndex?: number }): import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle {
        if (!this.pointCloudRenderer) {
            throw new Error('Renderer not initialized. Call init() first.');
        }
        return this.pointCloudRenderer.beginAsset(meta);
    }

    appendPointCloudChunk(
        handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle,
        chunk: import('./pointcloud/point-cloud-node.js').PointCloudChunkInput,
    ): void {
        if (!this.pointCloudRenderer) return;
        this.pointCloudRenderer.appendChunk(handle, chunk);
        this.expandModelBoundsForPointClouds();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    endPointCloudStream(handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle): void {
        this.pointCloudRenderer?.endAsset(handle);
        this.requestRender();
    }

    removePointCloudAsset(handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle): void {
        this.pointCloudRenderer?.removeAsset(handle);
        // Bounds may have shrunk — recompute from scratch so fit-to-view
        // and section-plane sliders see fresh extents.
        this.recomputeModelBounds();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /**
     * Reassign a streamed point-cloud's expressId after upload. Use
     * this when the federation registry assigns a new model offset and
     * the renderer needs to emit the post-offset globalId in picking
     * outputs. The change takes effect on the next render — no GPU
     * buffer rewrite needed.
     */
    relabelPointCloudAsset(
        handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle,
        newExpressId: number,
    ): void {
        this.pointCloudRenderer?.relabelAsset(handle, newExpressId);
        this.requestRender();
    }

    /**
     * Compute model bounds from triangle meshes + remaining point clouds.
     * Called from removeAsset / clear paths so bounds shrink correctly.
     * Triangle meshes still drive the bounds when present (existing
     * Scene-driven path), so this only re-folds in the point cloud
     * extents over whatever the mesh path left.
     */
    private recomputeModelBounds(): void {
        // Always recompute from scratch: take mesh bounds as the
        // baseline, then fold in the CURRENT point-cloud bounds on
        // top. Folding only-up via expandModelBoundsForPointClouds()
        // is correct when pc bounds grow but never shrinks them when
        // an asset is removed, leaving stale oversized extents until
        // every point cloud is gone.
        const meshBounds = this.computeMeshBounds();
        const pcBounds = this.pointCloudRenderer?.getBounds() ?? null;

        if (!meshBounds && !pcBounds) {
            this.modelBounds = null;
            return;
        }
        this.modelBounds = meshBounds ?? {
            min: { x: pcBounds!.min[0], y: pcBounds!.min[1], z: pcBounds!.min[2] },
            max: { x: pcBounds!.max[0], y: pcBounds!.max[1], z: pcBounds!.max[2] },
        };
        if (meshBounds && pcBounds) {
            this.expandModelBoundsForPointClouds();
        }
    }

    /** Aggregate bounds across all batched + individual meshes. Returns
     *  null if the scene has no mesh geometry. */
    private computeMeshBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let any = false;
        for (const batch of this.scene.getBatchedMeshes()) {
            if (!batch.bounds) continue;
            any = true;
            if (batch.bounds.min[0] < minX) minX = batch.bounds.min[0];
            if (batch.bounds.min[1] < minY) minY = batch.bounds.min[1];
            if (batch.bounds.min[2] < minZ) minZ = batch.bounds.min[2];
            if (batch.bounds.max[0] > maxX) maxX = batch.bounds.max[0];
            if (batch.bounds.max[1] > maxY) maxY = batch.bounds.max[1];
            if (batch.bounds.max[2] > maxZ) maxZ = batch.bounds.max[2];
        }
        if (!any) return null;
        return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
    }

    /** Apply rendering options (color mode, fixed override, point size). */
    setPointCloudOptions(opts: import('./pointcloud/point-cloud-renderer.js').PointCloudRenderOptions): void {
        this.pointCloudRenderer?.setOptions(opts);
        this.requestRender();
    }

    /**
     * Compute BIM ↔ scan deviation for every loaded point cloud asset.
     *
     * Walks every triangle in the scene (individual + batched meshes,
     * regardless of which IFC ingest path produced them — STEP, IFCx,
     * GLB, or federated combinations), builds a per-triangle BVH on
     * the GPU, then runs a closest-point compute pass per chunk that
     * writes signed distance into each chunk's deviation buffer.
     *
     * Returns metadata so the UI can populate a histogram + auto-range:
     * the per-asset point count, the suggested ±range from the 95th
     * percentile, and the bbox the BVH was built from.
     *
     * Idempotent: re-running with the same mesh set reuses the GPU
     * BVH (the BVH build dominates wall time on big BIMs). Pass
     * `forceRebuild: true` to invalidate.
     */
    async computeDeviations(opts: {
        /** Clip range applied during compute. 0 → no clip. Default 1m. */
        maxRange?: number;
        forceRebuild?: boolean;
    } = {}): Promise<{
        bvhTriangles: number;
        bvhNodes: number;
        chunksProcessed: number;
        pointsProcessed: number;
        bounds: { min: [number, number, number]; max: [number, number, number] } | null;
        suggestedHalfRange: number;
    }> {
        if (!this.deviationPipeline || !this.pointCloudRenderer) {
            throw new Error('Renderer not initialised — call init() first.');
        }
        const meshes = this.collectAllSceneMeshes();
        // Fingerprint folds in per-mesh expressId / modelIndex /
        // positions length / triangle count, so two distinct meshes
        // that happen to share an aggregate position-length total
        // can't alias each other. A federation reload that swaps one
        // model for another with the same total triangle count would
        // otherwise reuse the previous BVH and report wrong distances.
        const fingerprint = computeBvhFingerprint(meshes);
        if (opts.forceRebuild || fingerprint !== this.deviationBvhFingerprint) {
            const bvh = buildTriangleBVH(meshes);
            this.deviationPipeline.uploadBvh(bvh);
            this.deviationBvhFingerprint = fingerprint;
        }
        const stats = this.deviationPipeline.getBvhStats();
        const maxRange = opts.maxRange ?? 1.0;

        // Encode every chunk into a single command submit so the GPU
        // can pipeline the dispatches without a CPU round-trip per
        // chunk. Histogram readback is a follow-up — for v1 we emit
        // the deviation buffers and let the splat shader visualise.
        const encoder = this.device.getDevice().createCommandEncoder({ label: 'pointcloud-deviation' });
        let chunksProcessed = 0;
        let pointsProcessed = 0;
        const nodes = this.pointCloudRenderer.getInternalNodes();
        for (const node of nodes) {
            for (const chunk of node.chunks) {
                const ok = this.deviationPipeline.dispatch(encoder, {
                    positionsBuffer: chunk.vertexBuffer,
                    deviationsBuffer: chunk.deviationBuffer,
                    pointCount: chunk.pointCount,
                    maxRange,
                });
                if (ok) {
                    chunksProcessed++;
                    pointsProcessed += chunk.pointCount;
                }
            }
        }
        this.device.getDevice().queue.submit([encoder.finish()]);
        // Wait until the GPU finishes the dispatches before resolving.
        // Otherwise the caller's "compute done" callback fires before
        // the deviation buffers are actually populated.
        await this.device.getDevice().queue.onSubmittedWorkDone();
        this.requestRender();

        // Suggest a default half-range = max(0.01m, max-extent / 1000).
        // Tighter than the maxRange clip; gives the user a reasonable
        // starting slider position without a histogram readback.
        const bb = stats.bounds;
        const suggestedHalfRange = bb
            ? Math.max(0.01, Math.max(
                bb.max[0] - bb.min[0],
                bb.max[1] - bb.min[1],
                bb.max[2] - bb.min[2],
              ) / 1000)
            : 0.05;

        return {
            bvhTriangles: stats.triangleCount,
            bvhNodes: stats.nodeCount,
            chunksProcessed,
            pointsProcessed,
            bounds: stats.bounds,
            suggestedHalfRange,
        };
    }

    /**
     * Aggregate every triangle source the scene exposes — individual
     * meshes (created on demand by picking / highlights) AND batched
     * meshes (the streaming geometry path's compact GPU buffers).
     * Both formats arrive as `MeshData`; the BVH builder doesn't care
     * which source they came from.
     */
    private collectAllSceneMeshes(): import('@ifc-lite/geometry').MeshData[] {
        // The Scene keeps every CPU-side MeshData regardless of which
        // ingest path produced it (STEP / IFCx / GLB). One iteration
        // covers individual + batched + multi-piece + multi-model.
        // `forEachMeshData` deduplicates by identity so a colour-merged
        // batch is only added once even if it's indexed under multiple
        // contributor expressIds.
        const out: import('@ifc-lite/geometry').MeshData[] = [];
        this.scene.forEachMeshData((md) => {
            if (md.positions && md.positions.length > 0) out.push(md);
        });
        return out;
    }

    /**
     * Toggle Eye-Dome Lighting and tune its strength.
     *
     * EDL adds depth perception to point clouds (and meshes) via screen-
     * space depth gradient — silhouette pixels get a soft black halo.
     * Cheap: ~9 texture taps per pixel. Only runs when point clouds are
     * loaded.
     */
    setEdlOptions(opts: { enabled?: boolean; strength?: number; radiusPx?: number; highQuality?: boolean }): void {
        if (opts.enabled !== undefined) this.edlOptions.enabled = opts.enabled;
        if (opts.strength !== undefined) this.edlOptions.strength = Math.max(0, Math.min(3, opts.strength));
        if (opts.radiusPx !== undefined) this.edlOptions.radiusPx = Math.max(1, Math.min(4, opts.radiusPx));
        if (opts.highQuality !== undefined) this.edlOptions.highQuality = opts.highQuality;
        this.requestRender();
    }

    private expandModelBoundsForPointClouds(): void {
        const pcBounds = this.pointCloudRenderer?.getBounds();
        if (!pcBounds) return;
        if (!this.modelBounds) {
            this.modelBounds = {
                min: { x: pcBounds.min[0], y: pcBounds.min[1], z: pcBounds.min[2] },
                max: { x: pcBounds.max[0], y: pcBounds.max[1], z: pcBounds.max[2] },
            };
            return;
        }
        const m = this.modelBounds;
        m.min.x = Math.min(m.min.x, pcBounds.min[0]);
        m.min.y = Math.min(m.min.y, pcBounds.min[1]);
        m.min.z = Math.min(m.min.z, pcBounds.min[2]);
        m.max.x = Math.max(m.max.x, pcBounds.max[0]);
        m.max.y = Math.max(m.max.y, pcBounds.max[1]);
        m.max.z = Math.max(m.max.z, pcBounds.max[2]);
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
    /** Get diagnostic info for mobile debugging */
    getDiagnostics(): {
        calls: number; skips: number; errors: number; lastError: string;
        batches: number; meshes: number; contextOk: boolean;
        gpuErrors: number; lastGpuError: string;
        camPos: string; camTgt: string; bounds: string;
    } {
        const pos = this.camera.getPosition();
        const tgt = this.camera.getTarget();
        const b = this.modelBounds;
        return {
            calls: this._renderCallCount,
            skips: this._renderSkipCount,
            errors: this._renderErrorCount,
            lastError: this._lastRenderError,
            batches: this.scene.getBatchedMeshes().length,
            meshes: this.scene.getMeshes().length,
            contextOk: this.device.isInitialized(),
            gpuErrors: this.device._uncapturedErrorCount,
            lastGpuError: this.device._lastUncapturedError ?? '',
            camPos: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
            camTgt: `${tgt.x.toFixed(1)},${tgt.y.toFixed(1)},${tgt.z.toFixed(1)}`,
            bounds: b ? `${b.min.x.toFixed(0)}..${b.max.x.toFixed(0)} ${b.min.y.toFixed(0)}..${b.max.y.toFixed(0)} ${b.min.z.toFixed(0)}..${b.max.z.toFixed(0)}` : 'none',
        };
    }

    render(options: RenderOptions = {}): void {
        this._renderCallCount++;
        if (!this.device.isInitialized() || !this.pipeline) {
            this._renderSkipCount++;
            return;
        }

        // Validate canvas dimensions
        // Align width to 64 pixels for WebGPU texture row alignment (256 bytes / 4 bytes per pixel)
        // and clamp both axes to the GPU's max 2D texture dimension. Some hosts (e.g. tall iframes
        // on high-DPR displays) can produce canvas dimensions that exceed 8192 and would otherwise
        // make every depth/colour texture allocation a validation error.
        const rect = this.canvas.getBoundingClientRect();
        const maxDim = this.device.getMaxTextureDimension();
        const rawWidth = Math.max(1, Math.floor(rect.width));
        const widthAligned = Math.max(64, Math.floor(rawWidth / 64) * 64);
        const width = Math.min(widthAligned, Math.floor(maxDim / 64) * 64);
        const rawHeight = Math.max(1, Math.floor(rect.height));
        const height = Math.min(rawHeight, maxDim);

        // Skip rendering if canvas is too small
        if (width < 64 || height < 10) { this._renderSkipCount++; return; }

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
        if (this.canvas.width === 0 || this.canvas.height === 0) { this._renderSkipCount++; return; }

        // Ensure context is valid before rendering (handles HMR, focus changes, etc.)
        if (!this.device.ensureContext()) {
            this._renderSkipCount++;
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

        // Build the selected-id set once per frame so the X-Ray override paths
        // can keep highlighted entities at full alpha without per-site checks.
        const selectedId = options.selectedId;
        const selectedIds = options.selectedIds;
        const selectedModelIndex = options.selectedModelIndex;
        const selectedExpressIds = new Set<number>();
        if (selectedId !== undefined && selectedId !== null) {
            selectedExpressIds.add(selectedId);
        }
        if (selectedIds) {
            for (const id of selectedIds) {
                selectedExpressIds.add(id);
            }
        }
        const hasSelected = selectedExpressIds.size > 0;

        // Per-frame alpha overrides for X-Ray mode. See RenderOptions.transparencyOverrides.
        // Snapshot the caller's map so mid-frame mutation can't desync classification
        // and uniform-write decisions for the same batch/mesh.
        const txOverridesSrc = options.transparencyOverrides;
        const hasTxOverrides = txOverridesSrc != null && txOverridesSrc.size > 0;
        const txOverrides = hasTxOverrides ? new Map(txOverridesSrc) : null;
        const alphaForMesh = (expressId: number, fallback: number): number => {
            if (!hasTxOverrides) return fallback;
            // Selected meshes are exempt — the highlight pass renders them last,
            // but exempting here also keeps mesh classification + uniform writes
            // consistent so a selected mesh never enters the transparent pipeline
            // because of its own override entry.
            if (hasSelected && selectedExpressIds.has(expressId)) return fallback;
            const a = txOverrides!.get(expressId);
            return a !== undefined ? a : fallback;
        };
        // Cache resolved batch alpha for the frame: classification needs it
        // (opaque vs transparent routing) and renderBatch needs it for the
        // uniform write. Without the cache we'd walk batch.expressIds twice
        // per batch per frame, which becomes the dominant JS cost in X-Ray.
        const batchAlphaCache = hasTxOverrides
            ? new WeakMap<{ expressIds: number[]; color: [number, number, number, number] }, number>()
            : null;
        const alphaForBatch = (
            batch: { expressIds: number[]; color: [number, number, number, number] },
            fallback: number,
        ): number => {
            if (!hasTxOverrides) return fallback;
            const cached = batchAlphaCache!.get(batch);
            if (cached !== undefined) return cached;
            let minAlpha = Infinity;
            for (const eid of batch.expressIds) {
                // Selected ids never drag down a batch's alpha — the highlight
                // pass redraws them on top, but excluding here also means a
                // batch made entirely of selected entities stays opaque.
                if (hasSelected && selectedExpressIds.has(eid)) continue;
                const a = txOverrides!.get(eid);
                if (a !== undefined && a < minAlpha) minAlpha = a;
            }
            const resolved = minAlpha === Infinity ? fallback : minAlpha;
            batchAlphaCache!.set(batch, resolved);
            return resolved;
        };

        // Lens / Pset color overrides: when an entity has an override, force
        // its base draw through the opaque pipeline so it writes depth. The
        // overlay paint pass uses depthCompare 'equal' and otherwise silently
        // drops fragments belonging to entities whose default pipeline is
        // transparent (IfcSpace, IfcOpeningElement, glass, …). See issue #677.
        // Pure routing decision lives in overlay-routing.ts and is unit-tested
        // there.
        const colorOverrides = this.scene.getColorOverrides();

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

        // Push a validation error scope to capture the EXACT error (for mobile debugging)
        // Only do this for the first few renders to avoid performance overhead
        const captureGpuError = this._renderCallCount <= 5;
        if (captureGpuError) {
            device.pushErrorScope('validation');
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
                const alpha = alphaForMesh(mesh.expressId, mesh.color[3]);
                const transparency = mesh.material?.transparency ?? 0.0;
                const isTransparent = shouldRouteMeshTransparent(
                    alpha,
                    transparency,
                    mesh.expressId,
                    colorOverrides,
                );

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
                // Fold in point-cloud bounds too — without this, a
                // pure point-cloud scene falls through to the default
                // [-100,100], and a mixed scene clips against a
                // smaller mesh-only range while the point pipeline
                // (which honours the same sectionPlaneData) keeps
                // drawing points outside the slider's reach.
                const pcBoundsForSection = this.pointCloudRenderer?.getBounds();
                if (pcBoundsForSection) {
                    boundsMin.x = Math.min(boundsMin.x, pcBoundsForSection.min[0]);
                    boundsMin.y = Math.min(boundsMin.y, pcBoundsForSection.min[1]);
                    boundsMin.z = Math.min(boundsMin.z, pcBoundsForSection.min[2]);
                    boundsMax.x = Math.max(boundsMax.x, pcBoundsForSection.max[0]);
                    boundsMax.y = Math.max(boundsMax.y, pcBoundsForSection.max[1]);
                    boundsMax.z = Math.max(boundsMax.z, pcBoundsForSection.max[2]);
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
                    // Explicit normal + distance override (face-pick / arbitrary
                    // plane, issue #243). Used verbatim: no axis mapping, no
                    // position slider, no building rotation — the caller already
                    // has the plane in world space.
                    const explicitNormal   = options.sectionPlane.normal;
                    const explicitDistance = options.sectionPlane.distance;
                    const hasExplicitPlane =
                        explicitNormal !== undefined &&
                        explicitDistance !== undefined &&
                        Number.isFinite(explicitDistance);

                    let normal: [number, number, number];
                    let distance: number;

                    if (hasExplicitPlane) {
                        // Defensive renormalisation in case the caller passed a
                        // non-unit vector (e.g. mesh face normals quantised by
                        // the geometry pipeline).
                        const nx = explicitNormal![0];
                        const ny = explicitNormal![1];
                        const nz = explicitNormal![2];
                        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                        if (len > 1e-6) {
                            normal = [nx / len, ny / len, nz / len];
                            distance = explicitDistance! / len;
                        } else {
                            normal = [0, 1, 0];
                            distance = explicitDistance!;
                        }
                    } else {
                        // Cardinal-axis preset path (unchanged behaviour).
                        // down = Y axis (horizontal cut), front = Z axis, side = X axis
                        normal = [0, 0, 0];
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
                            const rlen = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
                            if (rlen > 0.0001) {
                                normal[0] /= rlen;
                                normal[1] /= rlen;
                                normal[2] /= rlen;
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
                        distance = minVal + (options.sectionPlane.position / 100) * range;
                    }

                    sectionPlaneData = { normal, distance, enabled: true };

                    // One-shot diagnostic: when section first becomes active,
                    // log the exact bounds + plane the shader will use. This
                    // is the fastest way to confirm "bounds mismatch" / "plane
                    // off-screen" bugs without asking the user to run a
                    // debugger. The custom-plane branch logs `mode: 'explicit'`
                    // so reports against tilted planes are easy to spot.
                    if (!this._loggedSectionBounds) {
                        this._loggedSectionBounds = true;
                        console.info('[Section] Y-up bounds used for clip:', {
                            mode: hasExplicitPlane ? 'explicit' : 'axis-aligned',
                            axis: options.sectionPlane.axis,
                            bounds: {
                                min: { x: boundsMin.x, y: boundsMin.y, z: boundsMin.z },
                                max: { x: boundsMax.x, y: boundsMax.y, z: boundsMax.z },
                            },
                            normal,
                            distance,
                            position: options.sectionPlane.position,
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
                    // Selected meshes always keep their own alpha so highlights stay opaque
                    meshBuf[35] = isSelected ? mesh.color[3] : alphaForMesh(mesh.expressId, mesh.color[3]);
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

            // Build color attachments — skip objectId in single-target mode
            const colorAttachments: GPURenderPassColorAttachment[] = [
                {
                    // If MSAA enabled: render to multisample texture, resolve to swap chain
                    // If MSAA disabled: render directly to swap chain
                    view: useMSAA ? msaaView : textureView,
                    resolveTarget: useMSAA ? textureView : undefined,
                    loadOp: 'clear' as const,
                    clearValue: clearColor,
                    storeOp: (useMSAA ? 'discard' : 'store') as GPUStoreOp,
                },
            ];
            colorAttachments.push({
                view: objectIdView,
                loadOp: 'clear' as const,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp: (needsObjectIdPass ? 'store' : 'discard') as GPUStoreOp,
            });

            const pass = encoder.beginRenderPass({
                colorAttachments,
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

                // Push a partial sub-batch entry, splitting by promotion when needed.
                // For transparent parent batches with mixed override membership, this
                // emits two entries (`:promoted` and `:remaining`) so non-overridden
                // batchmates keep their native transparent routing instead of getting
                // dragged opaque alongside the overridden ones.
                const pushVisibleAsPartial = (
                    sourceBatch: typeof allBatchedMeshes[number],
                    visibleIds: Set<number>,
                    isTransparent: boolean,
                ) => {
                    const baseKey = `${sourceBatch.colorKey}:${sourceBatch.id}`;
                    if (!isTransparent) {
                        partiallyVisibleBatches.push({
                            sourceBatchKey: baseKey,
                            colorKey: sourceBatch.colorKey,
                            visibleIds,
                            color: sourceBatch.color,
                        });
                        return;
                    }
                    const split = splitVisibleIdsByPromotion(visibleIds, colorOverrides);
                    // No promotion or every visible id promoted → single sub-batch,
                    // classifier downstream routes via shouldRouteBatchTransparent.
                    if (split == null || split.remaining.size === 0) {
                        partiallyVisibleBatches.push({
                            sourceBatchKey: baseKey,
                            colorKey: sourceBatch.colorKey,
                            visibleIds,
                            color: sourceBatch.color,
                        });
                        return;
                    }
                    // Mixed — emit one promoted (opaque-routed) and one remaining
                    // (transparent-routed) sub-batch. Distinct sourceBatchKeys so the
                    // partial-batch cache can hold both simultaneously.
                    partiallyVisibleBatches.push({
                        sourceBatchKey: `${baseKey}:promoted`,
                        colorKey: sourceBatch.colorKey,
                        visibleIds: split.promoted,
                        color: sourceBatch.color,
                    });
                    partiallyVisibleBatches.push({
                        sourceBatchKey: `${baseKey}:remaining`,
                        colorKey: sourceBatch.colorKey,
                        visibleIds: split.remaining,
                        color: sourceBatch.color,
                    });
                };

                for (const batch of allBatchedMeshes) {
                    // Frustum culling: skip batches entirely outside the camera view
                    if (batch.bounds) {
                        const batchAABB = { min: batch.bounds.min, max: batch.bounds.max };
                        if (!FrustumUtils.isAABBVisible(frustum, batchAABB)) {
                            continue; // Entire batch is off-screen
                        }
                    }

                    const alpha = alphaForBatch(batch, batch.color[3]);
                    const nativelyTransparent = alpha < 0.99;

                    // Check visibility
                    if (hasVisibilityFiltering) {
                        const vis = batchVisibility.get(batch);
                        if (!vis || !vis.visible) continue; // Skip completely hidden batches

                        // Handle partially visible batches - create sub-batches instead of individual meshes
                        if (!vis.fullyVisible) {
                            const visibleIds = new Set<number>();
                            for (const expressId of batch.expressIds) {
                                const isHidden = options.hiddenIds?.has(expressId) ?? false;
                                const isIsolated = !hasIsolatedFilter || options.isolatedIds!.has(expressId);
                                if (!isHidden && isIsolated) visibleIds.add(expressId);
                            }
                            if (visibleIds.size > 0) {
                                pushVisibleAsPartial(batch, visibleIds, nativelyTransparent);
                            }
                            continue; // Don't add batch to render list
                        }
                    }

                    // Fully visible (or no filtering). Transparent batches with mixed
                    // override membership must be split so non-overridden batchmates
                    // stay transparent — see splitVisibleIdsByPromotion / issue #677.
                    if (nativelyTransparent) {
                        const split = splitVisibleIdsByPromotion(batch.expressIds, colorOverrides);
                        if (split != null && split.remaining.size > 0) {
                            // Mixed promotion — re-route through the partial-batch path
                            // with distinct sourceBatchKeys for each subset.
                            pushVisibleAsPartial(batch, new Set(batch.expressIds), true);
                            continue;
                        }
                    }

                    if (shouldRouteBatchTransparent(alpha, batch.expressIds, colorOverrides)) {
                        transparentBatches.push(batch);
                    } else {
                        opaqueBatches.push(batch);
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
                    tpl[35] = alphaForBatch(batch, batch.color[3]);

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
                            // Use opaque or transparent pipeline based on resolved alpha
                            // (not the parent batch's color[3] — that ignores transparencyOverrides).
                            // Promote to opaque if any expressId in the sub-batch carries a
                            // lens/Pset colour override, so the overlay paint pass finds depth.
                            const isTransparent = shouldRouteBatchTransparent(
                                alphaForBatch(subBatch, color[3]),
                                subBatch.expressIds,
                                colorOverrides,
                            );
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
                //
                // flags.x bit 1 = overlay: tells the shader to preserve baseColor.a
                // (the overlay pipeline now has src-alpha blending so low-alpha ghost
                // tints composite correctly against the opaque pass) AND skip the
                // glass-fresnel branch (which is meant for real glass materials and
                // would whiten low-alpha colour overrides at grazing angles).
                const overrideBatches = this.scene.getOverrideBatches();
                if (overrideBatches.length > 0) {
                    pass.setPipeline(this.pipeline.getOverlayPipeline());
                    tplFlags[0] = 2;  // set overlay bit for the duration of these draws
                    for (const batch of overrideBatches) {
                        renderBatch(batch);
                    }
                    tplFlags[0] = 0;  // restore for any downstream use of the template
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
                        tpl[34] = mesh.color[2]; tpl[35] = alphaForMesh(mesh.expressId, mesh.color[3]);
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

            // Draw point clouds (IFCx inline + streamed LAS/LAZ).
            // Shares the depth buffer + section plane state with the mesh pipeline so
            // points occlude triangles and vice versa. The splat shader needs the
            // viewport size to convert pixel sizes into clip-space offsets.
            if (this.pointCloudRenderer && this.pointCloudRenderer.hasAssets()) {
                this.pointCloudRenderer.draw(pass, {
                    viewProj,
                    sectionPlane: sectionPlaneData
                        ? { ...sectionPlaneData, flipped: options.sectionPlane?.flipped === true }
                        : null,
                    viewport: { width: this.canvas.width, height: this.canvas.height },
                });
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
                        // Custom-plane gizmo override (issue #243). When both
                        // are set the gizmo bypasses the cardinal path; see
                        // SectionPlaneRenderer.calculatePlaneVerticesFromNormal.
                        normal: options.sectionPlane.normal,
                        distance: options.sectionPlane.distance,
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

                // Standalone IFC annotation overlay (issue #653). The line
                // vertices were pre-lifted to world space at upload time, so
                // this draw happens regardless of whether a section plane is
                // active — annotations are a free-floating "drawing layer"
                // that sits at each annotation's storey elevation.
                // Order: fills (background) → lines (outlines on top) →
                // texts (labels above everything).
                if (this.symbolicFillPipeline?.hasGeometry()) {
                    this.symbolicFillPipeline.render(pass, viewProj);
                }
                if (this.section2DOverlayRenderer?.hasAnnotationLines3D()) {
                    this.section2DOverlayRenderer.drawAnnotationLines3D(pass, viewProj);
                }
                if (this.symbolicTextPipeline?.hasGeometry()) {
                    this.symbolicTextPipeline.render(pass, viewProj);
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

            // Eye-Dome Lighting — runs AFTER contact/separation so it darkens
            // every layer uniformly. Cheap (~9 depth taps), only active when
            // there are point clouds in the scene and the user has enabled it.
            if (
                this.edlPass
                && this.edlOptions.enabled
                && this.pointCloudRenderer?.hasAssets()
            ) {
                this.edlPass.apply(
                    encoder,
                    {
                        targetView: textureView,
                        depthView: this.pipeline.getDepthOnlyTextureView(),
                    },
                    {
                        strength: this.edlOptions.strength,
                        radiusPx: this.edlOptions.radiusPx,
                        highQuality: this.edlOptions.highQuality,
                    },
                );
            }

            device.queue.submit([encoder.finish()]);

            // Pop validation error scope and capture the exact error
            if (captureGpuError) {
                device.popErrorScope().then((error) => {
                    if (error) {
                        const msg = error.message || String(error);
                        console.error('[WebGPU] Validation error in render pass:', msg);
                        this.device._lastUncapturedError = `VALIDATION: ${msg}`;
                        this.device._uncapturedErrorCount++;
                    }
                });
            }
        } catch (error) {
            this._renderErrorCount++;
            this._lastRenderError = error instanceof Error ? error.message : String(error);
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
     * GPU-based rectangle pick. Drag-select returns the set of
     * `expressId`s touched by any pixel inside `[x0,y0]..[x1,y1]`
     * (CSS pixels, canvas-relative). Both meshes and point clouds
     * participate.
     *
     * See `PickingManager.pickRect` for the visibility-filter +
     * limitation notes.
     */
    async pickRect(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        options?: PickOptions,
    ): Promise<Set<number>> {
        return this.pickingManager.pickRect(x0, y0, x1, y1, options);
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
     * Upload 2D section drawing data for 3D overlay rendering.
     *
     * Cardinal-axis call site: pass `axis` + `position` percentage and the
     * upload computes the plane offset along the cardinal axis using the
     * model bounds (or `sectionRange` override). 2D points are then lifted
     * to 3D via the cardinal-axis swap.
     *
     * Custom-plane call site (issue #243): pass `customPlane = { origin,
     * tangent, bitangent }`. The 2D points are lifted via the explicit
     * basis, exactly inverting the projection `SectionCutter` applied when
     * generating the polygons. Without this the cap silhouette lands off
     * the actual cutting plane (the bug PR #581 hid by suppressing the
     * cap entirely for non-cardinal planes).
     */
    uploadSection2DOverlay(
        polygons: CutPolygon2D[],
        lines: DrawingLine2D[],
        axis: 'down' | 'front' | 'side',
        position: number,  // 0-100 percentage
        sectionRange?: { min?: number; max?: number },  // Same storey-based range as section plane
        flipped: boolean = false,
        customPlane?: {
            origin:    [number, number, number];
            tangent:   [number, number, number];
            bitangent: [number, number, number];
        },
    ): void {
        if (!this.section2DOverlayRenderer) return;

        if (customPlane) {
            // Custom-plane path: planePosition / axis are unused — the
            // basis the cap shader needs travels in `customPlane`. We pass
            // 0 for `planePosition` and the existing `axis` so the cardinal
            // shader code path that callers depend on (e.g. legacy SVG
            // export) keeps working when customPlane is omitted.
            this.section2DOverlayRenderer.uploadDrawing(
                polygons, lines, axis, 0, flipped, customPlane,
            );
            return;
        }

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
     * Upload pre-lifted 3D line-list vertices for the standalone annotation
     * overlay. Each segment is `[x1, y1, z1, x2, y2, z2]` in world space.
     * The overlay is drawn regardless of whether a section plane is active.
     * Pass an empty Float32Array to clear.
     */
    uploadAnnotationLines3D(vertices: Float32Array): void {
        if (!this.section2DOverlayRenderer) return;
        this.section2DOverlayRenderer.uploadAnnotationLines3D(vertices);
        // Contribute annotation extents to modelBounds + camera sceneBounds
        // so an annotation-only model (no IfcProduct meshes — common for
        // separate "annotation sheets") gets framed by Home / fit-to-view
        // AND has correct near/far clipping. Without sceneBounds the camera
        // frustum doesn't include the annotation cluster and they're clipped
        // away even when the camera is pointed at them. Mirror the
        // point-cloud upload path (`addPointClouds`, `setPointClouds`) which
        // does the same thing.
        this.expandModelBoundsWithFlatVertices(vertices, 3);
        if (this.modelBounds) this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /** Walks a flat `[x,y,z,x,y,z,...]` vertex buffer and either initialises
     *  or expands the cached `modelBounds` AABB. Used by the annotation
     *  overlay upload paths so symbolic-only models can still be framed.
     *
     *  The geometry pipeline pre-seeds a placeholder `[-100, 100]` cube on
     *  every render when there are 0 meshes (so the section-plane slider
     *  always has a workable range). For an annotation-only model that
     *  fallback drowns out the much-smaller annotation cluster and a plain
     *  "expand" would no-op. We detect the placeholder by its exact symmetric
     *  signature and replace it with the actual annotation AABB instead. */
    private expandModelBoundsWithFlatVertices(positions: Float32Array, stride: number): void {
        if (positions.length === 0) return;
        const isPlaceholderCube = (b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): boolean =>
            b.min.x === -100 && b.min.y === -100 && b.min.z === -100
                && b.max.x === 100 && b.max.y === 100 && b.max.z === 100;
        if (!this.modelBounds || isPlaceholderCube(this.modelBounds)) {
            this.modelBounds = {
                min: { x: Infinity, y: Infinity, z: Infinity },
                max: { x: -Infinity, y: -Infinity, z: -Infinity },
            };
        }
        let expanded = false;
        for (let i = 0; i + 2 < positions.length; i += stride) {
            const x = positions[i];
            const y = positions[i + 1];
            const z = positions[i + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            if (x < this.modelBounds.min.x) this.modelBounds.min.x = x;
            if (y < this.modelBounds.min.y) this.modelBounds.min.y = y;
            if (z < this.modelBounds.min.z) this.modelBounds.min.z = z;
            if (x > this.modelBounds.max.x) this.modelBounds.max.x = x;
            if (y > this.modelBounds.max.y) this.modelBounds.max.y = y;
            if (z > this.modelBounds.max.z) this.modelBounds.max.z = z;
            expanded = true;
        }
        if (!expanded) return;
        // Guarantee non-degenerate extent on every axis so camera frustums
        // don't collapse. 0.5 m margin matches what the section-plane fallback
        // uses elsewhere in this file.
        for (const axis of ['x', 'y', 'z'] as const) {
            if (this.modelBounds.max[axis] - this.modelBounds.min[axis] < 1e-3) {
                this.modelBounds.max[axis] += 0.5;
                this.modelBounds.min[axis] -= 0.5;
            }
        }
    }

    /**
     * Clear the standalone annotation line overlay.
     */
    clearAnnotationLines3D(): void {
        if (this.section2DOverlayRenderer) {
            this.section2DOverlayRenderer.clearAnnotationLines3D();
            this.requestRender();
        }
    }

    /**
     * Upload filled IfcAnnotation regions for the symbolic overlay
     * (issue #653). Pass an empty array to clear.
     */
    uploadAnnotationFills3D(fills: readonly SymbolicFillInput[]): void {
        if (!this.symbolicFillPipeline) return;
        this.symbolicFillPipeline.upload(fills);
        // Contribute fill extents to modelBounds — see uploadAnnotationLines3D.
        for (const fill of fills) {
            const pts = fill.points;
            if (pts.length === 0) continue;
            // points are flat [x,z,x,z,...]; lift to (x, fill.worldY, z) per
            // vertex so we expand bounds in the same world space the renderer draws in.
            const lifted = new Float32Array((pts.length / 2) * 3);
            for (let i = 0, j = 0; i < pts.length; i += 2, j += 3) {
                lifted[j] = pts[i];
                lifted[j + 1] = fill.worldY;
                lifted[j + 2] = pts[i + 1];
            }
            this.expandModelBoundsWithFlatVertices(lifted, 3);
        }
        if (this.modelBounds) this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /**
     * Upload IfcAnnotation text labels for the symbolic overlay
     * (issue #653). Pass an empty array to clear.
     */
    uploadAnnotationTexts3D(texts: readonly SymbolicTextInput[]): void {
        if (!this.symbolicTextPipeline) return;
        this.symbolicTextPipeline.upload(texts);
        // Text origins are single points; pack them into a flat buffer and
        // expand bounds. Glyph extents are small enough that origin-only
        // suffices for framing.
        if (texts.length > 0) {
            const buf = new Float32Array(texts.length * 3);
            for (let i = 0; i < texts.length; i++) {
                buf[i * 3 + 0] = texts[i].worldPos[0];
                buf[i * 3 + 1] = texts[i].worldPos[1];
                buf[i * 3 + 2] = texts[i].worldPos[2];
            }
            this.expandModelBoundsWithFlatVertices(buf, 3);
            if (this.modelBounds) this.camera.setSceneBounds(this.modelBounds);
        }
        this.requestRender();
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
        this.edlPass?.destroy();
        this.edlPass = null;

        // Section-plane renderers
        this.sectionPlaneRenderer?.destroy();
        this.sectionPlaneRenderer = null;
        this.section2DOverlayRenderer?.dispose();
        this.section2DOverlayRenderer = null;

        // Point cloud GPU resources
        this.pointCloudRenderer?.clear();
        this.pointCloudRenderer = null;

        // BIM ↔ scan deviation pipeline + cached BVH GPU buffers.
        // Done before queue.destroy() so the GPU calls inside
        // `destroy()` still have a valid device.
        this.deviationPipeline?.destroy();
        this.deviationPipeline = null;
        this.deviationBvhFingerprint = null;

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
