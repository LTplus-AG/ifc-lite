/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PickingManager - Handles GPU-based object picking at screen coordinates.
 * Extracted from the Renderer class to use composition pattern.
 */

import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { Picker, type PointPickSizing } from './picker.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickOptions, PickResult } from './types.js';
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
     * Pick object at screen coordinates
     * Respects visibility filtering so users can only select visible elements
     * Returns PickResult with expressId and modelIndex for multi-model support
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    async pick(x: number, y: number, options?: PickOptions): Promise<PickResult | null> {
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

        let meshes = this.scene.getMeshes();
        const batchedMeshes = this.scene.getBatchedMeshes();

        // If we have batched meshes, check if we need CPU raycasting
        // This handles the case where we have SOME individual meshes (e.g., from highlighting)
        // but not enough for full GPU picking coverage
        if (batchedMeshes.length > 0) {
            if (this.scene.isGeometryDataReleased()) {
                const ray = this.camera.unprojectToRay(scaledX, scaledY, this.canvas.width, this.canvas.height);
                const hit = this.scene.raycast(ray.origin, ray.direction, options?.hiddenIds, options?.isolatedIds);
                if (!hit) return null;
                return {
                    expressId: hit.expressId,
                    modelIndex: hit.modelIndex,
                };
            }

            // Collect all expressIds from batched meshes
            const expressIds = new Set<number>();
            for (const batch of batchedMeshes) {
                for (const expressId of batch.expressIds) {
                    expressIds.add(expressId);
                }
            }

            // Track how many individual mesh pieces already exist for each (expressId:modelIndex).
            // Multi-piece elements (windows/doors with submeshes) need all pieces for reliable picking.
            const existingPieceCounts = new Map<string, number>();
            for (const mesh of meshes) {
                const key = `${mesh.expressId}:${mesh.modelIndex ?? 'any'}`;
                existingPieceCounts.set(key, (existingPieceCounts.get(key) ?? 0) + 1);
            }

            // Build required piece counts from MeshData for all visible entities.
            const requiredPieceCounts = new Map<string, number>();
            const visibleExpressIds: number[] = [];
            for (const expressId of expressIds) {
                if (options?.hiddenIds?.has(expressId)) continue;
                if (options?.isolatedIds !== null && options?.isolatedIds !== undefined && !options.isolatedIds.has(expressId)) continue;
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

            // PERFORMANCE FIX: Use CPU raycasting for large models instead of creating GPU meshes
            // GPU picking requires individual mesh buffers; for 60K+ elements this is too slow
            // CPU raycasting uses bounding box filtering + triangle tests - no GPU buffers needed
            const MAX_PICK_MESH_CREATION = 500;
            if (toCreate > MAX_PICK_MESH_CREATION || (visibleExpressIds.length > 0 && requiredPieceCounts.size === 0)) {
                // Use CPU raycasting fallback - works regardless of how many individual meshes exist
                const ray = this.camera.unprojectToRay(scaledX, scaledY, this.canvas.width, this.canvas.height);
                const hit = this.scene.raycast(ray.origin, ray.direction, options?.hiddenIds, options?.isolatedIds);
                if (!hit) return null;
                // CPU raycasting returns expressId and modelIndex
                return {
                    expressId: hit.expressId,
                    modelIndex: hit.modelIndex,
                };
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

            // Get updated meshes list (includes newly created ones)
            meshes = this.scene.getMeshes();
        }

        // Apply visibility filtering to meshes before picking
        // This ensures users can only select elements that are actually visible
        if (options?.hiddenIds && options.hiddenIds.size > 0) {
            meshes = meshes.filter(mesh => !options.hiddenIds!.has(mesh.expressId));
        }
        if (options?.isolatedIds !== null && options?.isolatedIds !== undefined) {
            meshes = meshes.filter(mesh => options.isolatedIds!.has(mesh.expressId));
        }

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
     * Limitations: skips the CPU-raycast and dynamic-mesh-creation
     * fallbacks that `pick()` uses for very large batched models, so
     * rect pick may miss entities whose individual meshes haven't been
     * hydrated. Acceptable for an MVP — rect select is a power-user
     * tool and the user can fall back to single-click pick.
     */
    async pickRect(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        options?: PickOptions,
    ): Promise<Set<number>> {
        if (!this.picker) return new Set();
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return new Set();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const sx0 = x0 * scaleX, sy0 = y0 * scaleY;
        const sx1 = x1 * scaleX, sy1 = y1 * scaleY;
        if (options?.isStreaming) return new Set();

        let meshes = this.scene.getMeshes();
        if (options?.hiddenIds && options.hiddenIds.size > 0) {
            meshes = meshes.filter((m) => !options.hiddenIds!.has(m.expressId));
        }
        if (options?.isolatedIds !== null && options?.isolatedIds !== undefined) {
            meshes = meshes.filter((m) => options.isolatedIds!.has(m.expressId));
        }
        const viewProj = this.camera.getViewProjMatrix().m;
        const pointSnap = this.pointPickProvider?.() ?? null;
        return this.picker.pickRect(
            sx0, sy0, sx1, sy1,
            this.canvas.width, this.canvas.height,
            meshes,
            viewProj,
            pointSnap?.nodes ?? undefined,
            pointSnap?.sizing ?? undefined,
        );
    }
}
