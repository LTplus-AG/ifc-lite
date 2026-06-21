/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * RaycastEngine - Handles raycasting, BVH management, and snap detection.
 * Extracted from the Renderer class to use composition pattern.
 */

import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { Raycaster, type Intersection, type Ray } from './raycaster.js';
import { SnapDetector, type SnapTarget, type SnapOptions, type EdgeLockInput, type MagneticSnapResult } from './snap-detector.js';
import { BVH } from './bvh.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickOptions } from './types.js';

/**
 * Cheap order-sensitive 32-bit signature of a mesh set, used to detect when the
 * raycast BVH must rebuild because the SET changed (not just its size). Mixes
 * each mesh's express id + vertex count via a rolling hash — O(n) integer ops,
 * no allocation. Different sets of the same length differ with high probability.
 */
function computeMeshSetSignature(meshData: readonly MeshData[]): number {
    let sig = meshData.length | 0;
    for (let i = 0; i < meshData.length; i++) {
        const m = meshData[i];
        sig = (Math.imul(sig, 31) + (m.expressId | 0)) | 0;
        sig = (Math.imul(sig, 31) + (m.positions.length | 0)) | 0;
    }
    return sig;
}

export class RaycastEngine {
    private camera: Camera;
    private scene: Scene;
    private canvas: HTMLCanvasElement;
    private raycaster: Raycaster;
    private snapDetector: SnapDetector;
    private bvh: BVH;

    // BVH cache
    private bvhCache: {
        meshCount: number;
        /** Cheap content signature of the built mesh set (#1238): catches a
         *  same-COUNT but different-MEMBERS set — e.g. two rays materializing
         *  different instanced pieces — which a count-only check would miss,
         *  leaving the BVH stale and raycasts wrong. */
        signature: number;
        meshData: MeshData[];
        isBuilt: boolean;
    } | null = null;

    // Performance constants
    private readonly BVH_THRESHOLD = 100;

    constructor(camera: Camera, scene: Scene, canvas: HTMLCanvasElement) {
        this.camera = camera;
        this.scene = scene;
        this.canvas = canvas;
        this.raycaster = new Raycaster();
        this.snapDetector = new SnapDetector();
        this.bvh = new BVH();
    }

    /**
     * Collect all visible mesh data from the scene, applying visibility filters.
     */
    /** Slab ray-AABB test, used to cull instanced occurrences before materializing
     *  their (lazy) triangles. */
    private rayHitsBounds(ray: Ray, b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): boolean {
        const o = [ray.origin.x, ray.origin.y, ray.origin.z];
        const d = [ray.direction.x, ray.direction.y, ray.direction.z];
        const mn = [b.min.x, b.min.y, b.min.z];
        const mx = [b.max.x, b.max.y, b.max.z];
        let tmin = -Infinity, tmax = Infinity;
        for (let i = 0; i < 3; i++) {
            if (Math.abs(d[i]) < 1e-12) {
                if (o[i] < mn[i] || o[i] > mx[i]) return false;
            } else {
                const inv = 1 / d[i];
                let t1 = (mn[i] - o[i]) * inv;
                let t2 = (mx[i] - o[i]) * inv;
                if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tmin) tmin = t1;
                if (t2 < tmax) tmax = t2;
                if (tmin > tmax) return false;
            }
        }
        return tmax >= Math.max(tmin, 0);
    }

    private collectVisibleMeshData(options?: PickOptions, ray?: Ray): MeshData[] {
        const allMeshData: MeshData[] = [];
        const meshes = this.scene.getMeshes();
        const batchedMeshes = this.scene.getBatchedMeshes();
        const seenKeys = new Set<string>();

        const pushVisiblePieces = (expressId: number, modelIndex?: number) => {
            const pieces = this.scene.getMeshDataPieces(expressId, modelIndex);
            if (!pieces) return;

            for (const piece of pieces) {
                // Apply visibility filtering
                if (options?.hiddenIds?.has(piece.expressId)) continue;
                if (
                    options?.isolatedIds !== null &&
                    options?.isolatedIds !== undefined &&
                    !options.isolatedIds.has(piece.expressId)
                ) {
                    continue;
                }

                // Avoid duplicates when a piece is reachable from both regular and batched passes
                const key = `${piece.expressId}:${piece.modelIndex ?? 'any'}:${piece.positions.length}:${piece.indices.length}`;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                allMeshData.push(piece);
            }
        };

        // Collect mesh data from regular meshes
        for (const mesh of meshes) {
            pushVisiblePieces(mesh.expressId, mesh.modelIndex);
        }

        // Collect mesh data from batched meshes
        for (const batch of batchedMeshes) {
            for (const expressId of batch.expressIds) {
                pushVisiblePieces(expressId);
            }
        }

        // GPU-instanced occurrences live only in the shard, not meshDataMap. Materialize
        // their per-occurrence triangles ON DEMAND so measure-snap / section-face-pick
        // work over them — but only for occurrences whose world AABB the ray actually
        // hits, so we never expand the whole instanced population per ray. When no ray
        // is supplied (defensive) we skip instanced rather than expand everything.
        if (ray) {
            for (const eid of this.scene.getInstancedEntityIds()) {
                if (options?.hiddenIds?.has(eid)) continue;
                if (
                    options?.isolatedIds !== null &&
                    options?.isolatedIds !== undefined &&
                    !options.isolatedIds.has(eid)
                ) {
                    continue;
                }
                const bounds = this.scene.getInstancedEntityBounds(eid);
                if (!bounds || !this.rayHitsBounds(ray, bounds)) continue;
                const pieces = this.scene.getInstancedMeshDataPieces(eid);
                if (!pieces) continue;
                // Key by piece INDEX, not buffer sizes: an entity can have several
                // sub-pieces with identical position/index lengths, which a
                // size-based key would collide → the later piece dropped → raycast
                // / snap silently misses part of the instance. (#1238 review)
                for (let p = 0; p < pieces.length; p++) {
                    const piece = pieces[p];
                    const key = `${piece.expressId}:inst:${p}`;
                    if (seenKeys.has(key)) continue;
                    seenKeys.add(key);
                    allMeshData.push(piece);
                }
            }
        }

        return allMeshData;
    }

    /**
     * Filter meshes using BVH acceleration structure if beneficial.
     * Rebuilds BVH if the mesh count has changed.
     */
    private filterWithBVH(allMeshData: MeshData[], ray: Ray): MeshData[] {
        if (allMeshData.length <= this.BVH_THRESHOLD) {
            return allMeshData;
        }

        // Check if BVH needs rebuilding. Compare a content signature, not just the
        // count: instanced pieces are materialized per-ray (only AABB-hit
        // occurrences), so two rays can yield the SAME count over DIFFERENT
        // geometry — a count-only check would reuse a stale BVH. (#1238 review)
        const signature = computeMeshSetSignature(allMeshData);
        const needsRebuild =
            !this.bvhCache ||
            !this.bvhCache.isBuilt ||
            this.bvhCache.meshCount !== allMeshData.length ||
            this.bvhCache.signature !== signature;

        if (needsRebuild) {
            // Build BVH only when needed
            this.bvh.build(allMeshData);
            this.bvhCache = {
                meshCount: allMeshData.length,
                signature,
                meshData: allMeshData,
                isBuilt: true,
            };
        }

        // Use BVH to filter meshes
        const meshIndices = this.bvh.getMeshesForRay(ray, allMeshData);
        return meshIndices.map(i => allMeshData[i]);
    }

    /**
     * Scale CSS pixel coordinates to canvas pixel coordinates.
     * Returns null if the canvas rect has zero dimensions.
     */
    private scaleCoordinates(x: number, y: number): { scaledX: number; scaledY: number } | null {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return null;
        }
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        return {
            scaledX: x * scaleX,
            scaledY: y * scaleY,
        };
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
        try {
            const scaled = this.scaleCoordinates(x, y);
            if (!scaled) return null;

            // Create ray from screen coordinates
            const ray = this.camera.unprojectToRay(scaled.scaledX, scaled.scaledY, this.canvas.width, this.canvas.height);

            // Get all mesh data from scene
            const allMeshData = this.collectVisibleMeshData(options, ray);

            if (allMeshData.length === 0) {
                return null;
            }

            // Use BVH for performance if we have many meshes
            const meshesToTest = this.filterWithBVH(allMeshData, ray);

            // Perform raycasting
            const intersection = this.raycaster.raycast(ray, meshesToTest);

            if (!intersection) {
                return null;
            }

            // Detect snap targets if requested
            // Pass meshes near the ray to detect edges even when partially occluded
            let snapTarget: SnapTarget | undefined;
            if (options?.snapOptions) {
                const cameraPos = this.camera.getPosition();
                const cameraFov = this.camera.getFOV();

                // Pass meshes that are near the ray (from BVH or all meshes if BVH not used)
                // This allows detecting edges even when they're behind other objects
                snapTarget = this.snapDetector.detectSnapTarget(
                    ray,
                    meshesToTest, // Pass all meshes near the ray
                    intersection,
                    { position: cameraPos, fov: cameraFov },
                    this.canvas.height,
                    options.snapOptions
                ) || undefined;
            }

            return {
                intersection,
                snap: snapTarget,
            };
        } catch (error) {
            console.error('Raycast error:', error);
            return null;
        }
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
        try {
            const scaled = this.scaleCoordinates(x, y);
            if (!scaled) {
                return {
                    intersection: null,
                    snapTarget: null,
                    edgeLock: {
                        edge: null,
                        meshExpressId: null,
                        edgeT: 0,
                        shouldLock: false,
                        shouldRelease: true,
                        isCorner: false,
                        cornerValence: 0,
                    },
                };
            }

            // Create ray from screen coordinates
            const ray = this.camera.unprojectToRay(scaled.scaledX, scaled.scaledY, this.canvas.width, this.canvas.height);

            // Get all mesh data from scene
            const allMeshData = this.collectVisibleMeshData(options, ray);

            if (allMeshData.length === 0) {
                return {
                    intersection: null,
                    snapTarget: null,
                    edgeLock: {
                        edge: null,
                        meshExpressId: null,
                        edgeT: 0,
                        shouldLock: false,
                        shouldRelease: true,
                        isCorner: false,
                        cornerValence: 0,
                    },
                };
            }

            // Use BVH for performance if we have many meshes
            const meshesToTest = this.filterWithBVH(allMeshData, ray);

            // Perform raycasting
            const intersection = this.raycaster.raycast(ray, meshesToTest);

            // Use magnetic snap detection
            const cameraPos = this.camera.getPosition();
            const cameraFov = this.camera.getFOV();

            const magneticResult = this.snapDetector.detectMagneticSnap(
                ray,
                meshesToTest,
                intersection,
                { position: cameraPos, fov: cameraFov },
                this.canvas.height,
                currentEdgeLock,
                options?.snapOptions || {}
            );

            return {
                intersection,
                ...magneticResult,
            };
        } catch (error) {
            console.error('Magnetic raycast error:', error);
            return {
                intersection: null,
                snapTarget: null,
                edgeLock: {
                    edge: null,
                    meshExpressId: null,
                    edgeT: 0,
                    shouldLock: false,
                    shouldRelease: true,
                    isCorner: false,
                    cornerValence: 0,
                },
            };
        }
    }

    /**
     * Invalidate BVH cache (call when geometry changes)
     */
    invalidateBVHCache(): void {
        this.bvhCache = null;
    }

    /**
     * Get the raycaster instance (for advanced usage)
     */
    getRaycaster(): Raycaster {
        return this.raycaster;
    }

    /**
     * Get the snap detector instance (for advanced usage)
     */
    getSnapDetector(): SnapDetector {
        return this.snapDetector;
    }

    /**
     * Clear all caches (call when geometry changes)
     */
    clearCaches(): void {
        this.invalidateBVHCache();
        this.snapDetector.clearCache();
    }
}
