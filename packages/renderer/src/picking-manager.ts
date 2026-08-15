/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PickingManager - Handles GPU-based object picking at screen coordinates.
 * Extracted from the Renderer class to use composition pattern.
 */

import { Camera } from './camera.js';
import { isEntityVisible } from './entity-visibility.js';
import { Scene } from './scene.js';
import { Picker, type PointPickSizing } from './picker.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickOptions, PickResult, PickClipState } from './types.js';
import type { PointPickNode } from './point-picker.js';

/**
 * Supplied by the renderer when point clouds are loaded — returns the
 * snapshot of pickable nodes and the sizing to use for the splat picker.
 * Returning empty / null disables point-pick for this frame.
 */
export type PointPickProvider = () =>
  | { nodes: ReadonlyArray<PointPickNode>; sizing: PointPickSizing }
  | null;

export class PickingManager {
    private camera: Camera;
    private scene: Scene;
    private picker: Picker | null;
    private canvas: HTMLCanvasElement;
    private createMeshFromDataFn: (meshData: MeshData) => void;
    private pointPickProvider: PointPickProvider | null = null;

    constructor(
        camera: Camera,
        scene: Scene,
        picker: Picker | null,
        canvas: HTMLCanvasElement,
        createMeshFromDataFn: (meshData: MeshData) => void
    ) {
        this.camera = camera;
        this.scene = scene;
        this.picker = picker;
        this.canvas = canvas;
        this.createMeshFromDataFn = createMeshFromDataFn;
    }

    /** Renderer wires this on init so the manager can fetch point nodes lazily. */
    setPointPickProvider(provider: PointPickProvider | null): void {
        this.pointPickProvider = provider;
    }

    /**
     * Update the picker reference (e.g., after init)
     */
    setPicker(picker: Picker | null): void {
        this.picker = picker;
    }

    /**
     * Prepare batched geometry for a GPU pick pass, shared by `pick()` and
     * `pickRect()`.
     *
     * Returns `'cpu'` when the caller must fall back to a CPU test — either JS
     * geometry data was released, or hydrating an individual mesh per visible
     * piece would exceed the pick-mesh budget. Returns `'gpu'` after hydrating
     * whatever was missing, so a following `scene.getMeshes()` covers every
     * visible entity.
     *
     * Both pick paths MUST route through this. `pickRect` used to read
     * `scene.getMeshes()` directly, which on a batched model is empty or
     * partial, so rectangle select returned an empty set no matter how many
     * elements the rect covered (#1904).
     */
    private prepareBatchedPick(options?: PickOptions): 'cpu' | 'gpu' {
        const batchedMeshes = this.scene.getBatchedMeshes();
        // Nothing batched: every mesh is already individually hydrated.
        if (batchedMeshes.length === 0) return 'gpu';

        if (this.scene.isGeometryDataReleased()) return 'cpu';

        // Collect every pickable expressId. We use the scene's authoritative
        // mesh-data id set rather than each batch's `expressIds`, because a batch
        // only records the PRIMARY expressId of each merged piece. When a door or
        // window is colour-fused into a batch keyed by its host wall / opening,
        // the filler's id lives only in the per-vertex entityIds (registered in
        // meshDataMap by Scene.addMeshData). Reading batch.expressIds alone would
        // skip the filler, so under isolation its mesh is never hydrated and
        // pick() returns null (#1358).
        const expressIds = new Set<number>(this.scene.getAllMeshDataExpressIds());

        // Track how many individual mesh pieces already exist for each (expressId:modelIndex).
        // Multi-piece elements (windows/doors with submeshes) need all pieces for reliable picking.
        const existingPieceCounts = new Map<string, number>();
        for (const mesh of this.scene.getMeshes()) {
            const key = `${mesh.expressId}:${mesh.modelIndex ?? 'any'}`;
            existingPieceCounts.set(key, (existingPieceCounts.get(key) ?? 0) + 1);
        }

        // Build required piece counts from MeshData for all visible entities.
        const requiredPieceCounts = new Map<string, number>();
        const visibleExpressIds: number[] = [];
        for (const expressId of expressIds) {
            if (!isEntityVisible(expressId, options?.hiddenIds, options?.isolatedIds)) continue;
            visibleExpressIds.push(expressId);

            const pieces = this.scene.getMeshDataPieces(expressId);
            if (!pieces) continue;
            for (const piece of pieces) {
                const key = `${piece.expressId}:${piece.modelIndex ?? 'any'}`;
                requiredPieceCounts.set(key, (requiredPieceCounts.get(key) ?? 0) + 1);
            }
        }

        // Count how many meshes we'd need to create for full GPU picking
        // For multi-model and multi-piece elements, count missing piece instances per key.
        let toCreate = 0;
        for (const [key, requiredCount] of requiredPieceCounts) {
            const existingCount = existingPieceCounts.get(key) ?? 0;
            if (requiredCount > existingCount) {
                toCreate += requiredCount - existingCount;
            }
        }

        // PERFORMANCE: fall back to CPU for large models instead of creating GPU meshes.
        // GPU picking requires individual mesh buffers; for 60K+ elements this is too slow.
        // The CPU paths use bounding boxes - no GPU buffers needed.
        const MAX_PICK_MESH_CREATION = 500;
        if (toCreate > MAX_PICK_MESH_CREATION || (visibleExpressIds.length > 0 && requiredPieceCounts.size === 0)) {
            return 'cpu';
        }

        // For smaller models, create GPU meshes for picking
        // Only create meshes for VISIBLE elements (not hidden, and either no isolation or in isolated set)
        // For multi-model support: create meshes for ALL (expressId, modelIndex) pairs
        const baselineExistingCounts = new Map(existingPieceCounts);
        const seenOrdinalsByKey = new Map<string, number>();
        for (const expressId of visibleExpressIds) {
            const pieces = this.scene.getMeshDataPieces(expressId);
            if (pieces) {
                for (const piece of pieces) {
                    const meshKey = `${piece.expressId}:${piece.modelIndex ?? 'any'}`;
                    const ordinal = seenOrdinalsByKey.get(meshKey) ?? 0;
                    seenOrdinalsByKey.set(meshKey, ordinal + 1);
                    const baselineExisting = baselineExistingCounts.get(meshKey) ?? 0;

                    // Assume existing pieces correspond to the first N pieces in stable order.
                    if (ordinal < baselineExisting) continue;

                    this.createMeshFromDataFn(piece);
                }
            }
        }

        return 'gpu';
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
        if (!this.picker) {
            return null;
        }

        // Scale CSS pixel coordinates to canvas pixel coordinates
        // The canvas.width may differ from CSS width due to 64-pixel alignment for WebGPU
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return null;
        }
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const scaledX = x * scaleX;
        const scaledY = y * scaleY;

        // Skip picker during streaming for consistent performance
        // Picking during streaming would be slow and incomplete anyway
        if (options?.isStreaming) {
            return null;
        }

        if (this.prepareBatchedPick(options) === 'cpu') {
            const ray = this.camera.unprojectToRay(scaledX, scaledY, this.canvas.width, this.canvas.height);
            const hit = this.scene.raycast(ray.origin, ray.direction, options?.hiddenIds, options?.isolatedIds, clip);
            if (!hit) return null;
            // CPU raycasting returns expressId and modelIndex
            return {
                expressId: hit.expressId,
                modelIndex: hit.modelIndex,
            };
        }

        let meshes = this.scene.getMeshes();

        // Apply visibility filtering to meshes before picking, with the same
        // rule the draw paths use — users can only select what they can see.
        meshes = meshes.filter(mesh => isEntityVisible(mesh.expressId, options?.hiddenIds, options?.isolatedIds));

        const viewProj = this.camera.getViewProjMatrix().m;
        const pointSnap = this.pointPickProvider?.() ?? null;
        // Skip point picking when isolation excludes everything to keep
        // existing visibility semantics (caller already filtered meshes
        // accordingly; we don't filter point nodes here because per-asset
        // visibility is binary and assets are tiny in count).
        const pointNodes = pointSnap?.nodes ?? undefined;
        const pointSizing = pointSnap?.sizing ?? undefined;
        const result = await this.picker.pick(
            scaledX,
            scaledY,
            this.canvas.width,
            this.canvas.height,
            meshes,
            viewProj,
            pointNodes,
            pointSizing,
            this.scene.getInstancedTemplates(),
            clip,
        );
        return result;
    }

    /**
     * GPU-based rectangle pick. Renders the same pick pass as `pick()`,
     * then reads back every texel inside the rect and dedupes the hit
     * set. Point splats and mesh triangles both participate.
     *
     * Rect coordinates are in CSS pixels; we scale to canvas pixels
     * the same way `pick()` does. Visibility filters from `options`
     * are applied to meshes before the pass; point nodes are not
     * filtered (per-asset visibility is binary and the asset count is
     * tiny).
     *
     * Batched models take the same route as `pick()`: hydrate the
     * missing individual meshes when that is affordable, otherwise fall
     * back to `Scene.selectRect`, which over-selects relative to the
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
        if (!this.picker) return new Set();
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return new Set();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const sx0 = x0 * scaleX, sy0 = y0 * scaleY;
        const sx1 = x1 * scaleX, sy1 = y1 * scaleY;
        if (options?.isStreaming) return new Set();

        if (this.prepareBatchedPick(options) === 'cpu') {
            const boxHits = this.scene.selectRect(
                sx0, sy0, sx1, sy1,
                this.canvas.width, this.canvas.height,
                this.camera.getViewProjMatrix().m,
                options?.hiddenIds,
                options?.isolatedIds,
                clip,
            );
            const cpuPointSnap = this.pointPickProvider?.() ?? null;
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
                pointHits = await this.picker.pickRect(
                    sx0, sy0, sx1, sy1,
                    this.canvas.width, this.canvas.height,
                    [],
                    this.camera.getViewProjMatrix().m,
                    cpuPointSnap.nodes,
                    cpuPointSnap.sizing,
                    undefined,
                    clip,
                );
            } catch (err) {
                // `picker.pickRect` rethrows any readback failure that is not a
                // device-loss abort. The box hits are already computed and this
                // branch could not throw at all before the point pass was added,
                // so degrade to them instead of failing the whole rectangle select.
                console.warn('[PickingManager] point-cloud rect pick failed; returning bounding-box hits only:', err);
                return boxHits;
            }
            for (const id of pointHits) boxHits.add(id);
            return boxHits;
        }

        let meshes = this.scene.getMeshes();
        meshes = meshes.filter((m) => isEntityVisible(m.expressId, options?.hiddenIds, options?.isolatedIds));
        const viewProj = this.camera.getViewProjMatrix().m;
        const pointSnap = this.pointPickProvider?.() ?? null;
        return this.picker.pickRect(
            sx0, sy0, sx1, sy1,
            this.canvas.width, this.canvas.height,
            meshes,
            viewProj,
            pointSnap?.nodes ?? undefined,
            pointSnap?.sizing ?? undefined,
            this.scene.getInstancedTemplates(),
            clip,
        );
    }
}
