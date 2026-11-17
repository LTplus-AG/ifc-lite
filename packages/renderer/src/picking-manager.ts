/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PickingManager - Handles GPU-based object picking at screen coordinates.
 * Extracted from the Renderer class to use composition pattern.
 */

import { resolveAnnotationPick, type AnnotationPickProvider } from './annotation-picking.js';
import { Camera } from './camera.js';
import { isEntityVisible } from './entity-visibility.js';
import { Scene } from './scene.js';
import { Picker, type PointPickSizing } from './picker.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { Mesh, PickOptions, PickResult, PickClipState } from './types.js';
import type { PointPickNode } from './point-picker.js';
import type { GpuUploadOutcome } from './gpu-upload-guard.js';
import { capturePointRteSnapshot, isPointRteSnapshotCurrent, isPointRteFrameAvailable, pointRteInvalidationEpoch } from './pick-rte-snapshot.js';
import { computeDrawingBufferSize } from './renderer-viewport.js';
import { hydratePickMeshes, planPickMeshHydration } from './pick-mesh-budget.js';
import { collectLaneDraws, laneRouteMeshes, refineLaneHit, type Ray } from './pick-lane-route.js';
import type { LanePickInput } from './lane-pick-pass.js';
import type { RelativeToEyeSnapshot } from './relative-to-eye.js';

/**
 * Supplied by the renderer when point clouds are loaded — returns the
 * snapshot of pickable nodes and the sizing to use for the splat picker.
 * Returning empty / null disables point-pick for this frame.
 */
export type PointPickProvider = (filter?: PickOptions) =>
  | { nodes: ReadonlyArray<PointPickNode>; sizing: PointPickSizing }
  | null;

/**
 * How one pick reaches its answer:
 * - `gpu`: individual pick meshes, hydrated from CPU pieces (small models);
 * - `lanes`: the colour batches drawn whole, entity from the vertex lane
 *   (#10264 S1; models over the pick-mesh budget, or without CPU pieces);
 * - `cpu`: the CPU raycast, when neither GPU route can answer for everything.
 */
type PickRoute = 'gpu' | 'lanes' | 'cpu';

/** What the GPU pass draws on the `gpu` or `lanes` route. */
interface GpuPickPlan { meshes: Mesh[]; lanes?: LanePickInput }

interface PickViewport {
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
}

export class PickingManager {
    private camera: Camera;
    private scene: Scene;
    private picker: Picker | null;
    private pickerEpoch = 0;
    private canvas: HTMLCanvasElement;
    private createMeshFromDataFn: (meshData: MeshData) => GpuUploadOutcome<void>;
    private annotationPickProvider: AnnotationPickProvider | null = null;
    setAnnotationPickProvider(provider: AnnotationPickProvider): void { this.annotationPickProvider = provider; }

    private pointPickProvider: PointPickProvider | null = null;

    constructor(
        camera: Camera,
        scene: Scene,
        picker: Picker | null,
        canvas: HTMLCanvasElement,
        createMeshFromDataFn: (meshData: MeshData) => GpuUploadOutcome<void>
    ) {
        this.camera = camera;
        this.scene = scene;
        this.picker = picker;
        this.canvas = canvas;
        this.createMeshFromDataFn = createMeshFromDataFn;
    }

    /**
     * The pick target size and CSS-px to texel scale. The pick pass renders at
     * the canvas's CSS size, not the device-pixel buffer (#5383): pointer input
     * resolves CSS px, and splat pick sizes stay in the draw's space. The
     * point readback samples only its selected ID/depth texel (#6881).
     * Clamped to 8192, the WebGPU-guaranteed `maxTextureDimension2D`.
     */
    private pickViewport(): PickViewport | null {
        const rect = this.canvas.getBoundingClientRect();
        const size = computeDrawingBufferSize(rect.width, rect.height, 1, 8192);
        if (!size) return null;
        return { width: size.width, height: size.height, scaleX: size.width / rect.width, scaleY: size.height / rect.height };
    }

    /** A readback belongs to its picker installation and CSS mapping (#6881/#6882). */
    private isPickRequestCurrent(viewport: PickViewport, pickerEpoch: number, invalidationEpoch: number | undefined): boolean {
        const current = this.pickViewport();
        return isPointRteFrameAvailable(this.camera)
            && pointRteInvalidationEpoch(this.camera) === invalidationEpoch
            && this.pickerEpoch === pickerEpoch && current !== null
            && current.width === viewport.width && current.height === viewport.height
            && current.scaleX === viewport.scaleX && current.scaleY === viewport.scaleY;
    }

    /** Renderer wires this on init so the manager can fetch point nodes lazily. */
    setPointPickProvider(provider: PointPickProvider | null): void {
        this.pointPickProvider = provider;
    }

    /**
     * Update the picker reference (e.g., after init)
     */
    setPicker(picker: Picker | null): void {
        if (this.picker !== picker) this.pickerEpoch++;
        this.picker = picker;
    }

    /**
     * Choose the route for a pick, shared by `pick()` and `pickRect()`, and
     * hydrate the individual pick meshes when that is the route.
     *
     * Both pick paths MUST route through this. `pickRect` used to read
     * `scene.getMeshes()` directly, which on a batched model is empty or
     * partial, so rectangle select returned an empty set no matter how many
     * elements the rect covered (#1904).
     */
    private pickRoute(options?: PickOptions): PickRoute {
        // Textured draws also keep separate GPU buffers and need pick-mesh hydration.
        if (this.scene.getBatchedMeshes().length === 0 && this.scene.getTexturedMeshes().length === 0) return 'gpu';
        // No CPU pieces to hydrate from: only the batches themselves can answer.
        if (this.scene.isGeometryDataReleased()) return 'lanes';
        const plan = planPickMeshHydration(this.scene, options);
        if (plan.overBudget) return 'lanes';
        return hydratePickMeshes(this.scene, plan, this.createMeshFromDataFn) ? 'gpu' : 'cpu';
    }

    /**
     * What the GPU pass draws for `route`, or null to take the CPU route: the
     * batch pass needs its pipelines, an RTE snapshot to project in, and every
     * batch `ray` can hit (all of them for a marquee) resident and resolvable.
     */
    private gpuPickPlan(
        route: PickRoute,
        options: PickOptions | undefined,
        snapshot: RelativeToEyeSnapshot | undefined,
        ray: Ray | null,
        clip: PickClipState | null | undefined,
    ): GpuPickPlan | null {
        if (route === 'cpu') return null;
        if (route === 'gpu') {
            // Same hide/isolate rule as the draw paths: users can only select what they can see.
            return { meshes: this.scene.getMeshes().filter(mesh => isEntityVisible(mesh.expressId, options?.hiddenIds, options?.isolatedIds)) };
        }
        if (!snapshot || !this.picker?.canPickLanes(this.scene.getInstancedTemplates().length > 0)) return null;
        const draws = collectLaneDraws(this.scene, ray);
        if (!draws) return null;
        return {
            meshes: laneRouteMeshes(this.scene, options),
            lanes: {
                draws,
                hiddenIds: options?.hiddenIds,
                isolatedIds: options?.isolatedIds,
                ...(ray ? { refine: (hit: PickResult) => refineLaneHit(this.scene, hit, ray, options, clip) } : {}),
            },
        };
    }

    /**
     * Pick object at screen coordinates
     * Respects visibility filtering so users can only select visible elements
     * Returns PickResult with expressId and modelIndex for multi-model support
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    async pick(x: number, y: number, options?: PickOptions, clip?: PickClipState | null): Promise<PickResult | null> {
        if (!this.picker || !isPointRteFrameAvailable(this.camera)) {
            return null;
        }

        const picker = this.picker, pickerEpoch = this.pickerEpoch;
        const invalidationEpoch = pointRteInvalidationEpoch(this.camera);
        // Scale CSS pixel coordinates to pick-texture texels (see pickViewport).
        const viewport = this.pickViewport();
        if (!viewport) {
            return null;
        }
        const scaledX = x * viewport.scaleX;
        const scaledY = y * viewport.scaleY;

        // Skip picker during streaming for consistent performance
        // Picking during streaming would be slow and incomplete anyway
        if (options?.isStreaming) {
            return null;
        }

        const annotations = this.annotationPickProvider?.(x, y, viewport.width / viewport.scaleX, viewport.height / viewport.scaleY, options, clip) ?? null;
        // The point and batch passes project in this immutable RTE frame. Never
        // decode a delayed readback with a later camera placement: that turns a
        // valid click into an absolute-coordinate jump after navigation.
        const pointRteSnapshot = capturePointRteSnapshot(this.camera);
        // The batch route culls to, and refines along, the ray through the
        // centre of the texel the picker reads (it clamps the same way).
        const texelX = Math.max(0, Math.min(viewport.width - 1, Math.floor(scaledX))) + 0.5;
        const texelY = Math.max(0, Math.min(viewport.height - 1, Math.floor(scaledY))) + 0.5;
        const route = this.pickRoute(options);
        const plan = this.gpuPickPlan(route, options, pointRteSnapshot,
            route === 'lanes' ? this.camera.unprojectToRay(texelX, texelY, viewport.width, viewport.height) : null, clip);
        if (!plan) {
            const ray = this.camera.unprojectToRay(scaledX, scaledY, viewport.width, viewport.height);
            const hit = this.scene.raycast(ray.origin, ray.direction, options?.hiddenIds, options?.isolatedIds, clip);
            if (!hit) return resolveAnnotationPick(annotations, null);
            const result = {
                expressId: hit.expressId,
                modelIndex: hit.modelIndex,
                ...(hit.geometryItemId !== undefined ? { geometryItemId: hit.geometryItemId } : {}),
            };
            return resolveAnnotationPick(annotations, result, annotations ? {
                x: ray.origin.x + hit.distance * ray.direction.x,
                y: ray.origin.y + hit.distance * ray.direction.y,
                z: ray.origin.z + hit.distance * ray.direction.z,
            } : undefined);
        }

        const viewProj = this.camera.getViewProjMatrix().m;
        // The provider drops inline clouds the same filters hide from the draw (#10215).
        const pointSnap = this.pointPickProvider?.(options) ?? null;
        // A refined batch hit reads the scene after the readback: an edit in between voids it.
        const geometryRevision = plan.lanes ? this.scene.getPickGeometryRevision() : 0;
        const result = await picker.pick(
            scaledX,
            scaledY,
            viewport.width,
            viewport.height,
            plan.meshes,
            viewProj,
            pointSnap?.nodes ?? undefined,
            pointSnap?.sizing ?? undefined,
            this.scene.getInstancedTemplates(),
            clip,
            pointRteSnapshot,
            plan.lanes,
        );
        if (!this.isPickRequestCurrent(viewport, pickerEpoch, invalidationEpoch)) return null;
        if (pointRteSnapshot
            && !isPointRteSnapshotCurrent(this.camera, pointRteSnapshot)) {
            return null;
        }
        if (plan.lanes && this.scene.getPickGeometryRevision() !== geometryRevision) return null;
        return resolveAnnotationPick(annotations, result);
    }

    /**
     * GPU-based rectangle pick. Renders the same pick pass as `pick()`,
     * then reads back every texel inside the rect and dedupes the hit
     * set. Point splats and mesh triangles both participate.
     *
     * Rect coordinates are in CSS pixels; we scale to canvas pixels
     * the same way `pick()` does. Visibility filters from `options`
     * are applied to meshes before the pass, and to inline point clouds
     * by the point provider (#10215).
     *
     * Batched models take the same route as `pick()`: hydrate the
     * missing individual meshes when that is affordable, otherwise draw
     * the colour batches whole (#10264 S1), which keeps the marquee
     * pixel-exact, depth-tested and clip-aware on large models. Only when
     * the batches cannot answer does it fall back to `Scene.selectRect`,
     * which over-selects relative to the
     * pixel-exact GPU pass in three ways: it is bounding-box granular
     * (a rect over empty space inside an element's bounds selects it),
     * it has no depth test (occluded entities are selected), and it
     * drops a section-planed or cropped entity only when the whole box
     * is clipped away, where the pick shader discards per fragment.
     * Hidden and isolation filtering do apply there. Reading
     * `scene.getMeshes()` unconditionally is what made this return an
     * empty set on every batched model (#1904).
     *
     * Point clouds never depend on mesh hydration — splats render into
     * the pick pass on their own — so the CPU branch still runs the GPU
     * pass for them and unions the two results. Skipping it would drop
     * point selection on any mixed scene big enough to miss the
     * pick-mesh budget.
     */
    async pickRect(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        options?: PickOptions,
        clip?: PickClipState | null,
    ): Promise<Set<number>> {
        if (!this.picker || !isPointRteFrameAvailable(this.camera)) return new Set();
        const picker = this.picker, pickerEpoch = this.pickerEpoch;
        const invalidationEpoch = pointRteInvalidationEpoch(this.camera);
        const viewport = this.pickViewport();
        if (!viewport) return new Set();
        const sx0 = x0 * viewport.scaleX, sy0 = y0 * viewport.scaleY;
        const sx1 = x1 * viewport.scaleX, sy1 = y1 * viewport.scaleY;
        if (options?.isStreaming) return new Set();

        const pointRteSnapshot = capturePointRteSnapshot(this.camera);
        const plan = this.gpuPickPlan(this.pickRoute(options), options, pointRteSnapshot, null, clip);
        if (!plan) {
            const boxHits = this.scene.selectRect(
                sx0, sy0, sx1, sy1,
                viewport.width, viewport.height,
                this.camera.getRelativeToEyeFrame().getViewProjection().m,
                options?.hiddenIds,
                options?.isolatedIds,
                clip,
                { cameraWorld: this.camera.getRelativeToEyeFrame().getCameraWorld() },
            );
            const cpuPointSnap = this.pointPickProvider?.(options) ?? null;
            if (!cpuPointSnap || cpuPointSnap.nodes.length === 0) return boxHits;

            // Point-only pick pass. Meshes are deliberately `[]`: this branch runs
            // precisely because the per-element pick buffers were NOT hydrated, so
            // `scene.getMeshes()` holds an arbitrary partial set (highlight meshes
            // and whatever an earlier pick left behind) whose ids `selectRect`
            // already covers.
            //
            // Instanced templates are left out for a different reason. The
            // instanced pick pass IS visibility-filtered — its fragment shader
            // discards on `instFlags` bit 1, which `Scene` sets for every
            // occurrence that is hidden or excluded by isolation — so unioning its
            // hits would not re-admit anything. It is left out because it would
            // add no ids and can only subtract. Every instanced occurrence whose
            // template has geometry folds its world AABB into
            // `Scene.boundingBoxes`, so `selectRect` above has already returned
            // those ids under the same two filters (a template with no finite
            // local box is skipped there, and rasterises nothing here either).
            // Meanwhile the instanced draw shares this pass's depth target, so an
            // occurrence in front of a splat would occlude it and drop a point hit
            // that nothing else on this path can supply — point assets have no
            // entry in `boundingBoxes` at all.
            let pointHits: Set<number>;
            try {
                pointHits = await picker.pickRect(
                    sx0, sy0, sx1, sy1,
                    viewport.width, viewport.height,
                    [],
                    this.camera.getViewProjMatrix().m,
                    cpuPointSnap.nodes,
                    cpuPointSnap.sizing,
                    undefined,
                    clip,
                    pointRteSnapshot,
                );
            } catch (err) {
                // `picker.pickRect` rethrows any readback failure that is not a
                // device-loss abort. The box hits are already computed and this
                // branch could not throw at all before the point pass was added,
                // so degrade to them instead of failing the whole rectangle select.
                console.warn('[PickingManager] point-cloud rect pick failed; returning current-viewport bounding-box hits only:', err);
                return this.isPickRequestCurrent(viewport, pickerEpoch, invalidationEpoch) ? boxHits : new Set();
            }
            if (!this.isPickRequestCurrent(viewport, pickerEpoch, invalidationEpoch)) return new Set();
            if (pointRteSnapshot && !isPointRteSnapshotCurrent(this.camera, pointRteSnapshot)) {
                return boxHits;
            }
            for (const id of pointHits) boxHits.add(id);
            return boxHits;
        }

        const viewProj = this.camera.getViewProjMatrix().m;
        const pointSnap = this.pointPickProvider?.(options) ?? null;
        const hits = await picker.pickRect(
            sx0, sy0, sx1, sy1,
            viewport.width, viewport.height,
            plan.meshes,
            viewProj,
            pointSnap?.nodes ?? undefined,
            pointSnap?.sizing ?? undefined,
            this.scene.getInstancedTemplates(),
            clip,
            pointRteSnapshot,
            plan.lanes,
        );
        return !this.isPickRequestCurrent(viewport, pickerEpoch, invalidationEpoch)
            || (pointRteSnapshot && !isPointRteSnapshotCurrent(this.camera, pointRteSnapshot))
            ? new Set()
            : hits;
    }
}
