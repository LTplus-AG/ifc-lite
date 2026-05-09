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
import type { QuantizedRaycaster } from './quantized-raycaster.js';

export class RaycastEngine {
    private camera: Camera;
    private scene: Scene;
    private canvas: HTMLCanvasElement;
    private raycaster: Raycaster;
    private snapDetector: SnapDetector;
    private bvh: BVH;
    /**
     * Quantised-scene raycaster, set by `Renderer.loadQuantizedScene`. When
     * non-null, `raycastScene()` consults it first; the legacy
     * `MeshData[]`-based path remains as a fallback for non-quantised content
     * (point clouds, headless tooling).
     */
    private quantizedRaycaster: QuantizedRaycaster | null = null;

    // BVH cache
    private bvhCache: {
        meshCount: number;
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
     * Attach (or detach) a quantised-scene raycaster. Called by the renderer
     * when `loadQuantizedScene` runs / unloads. The quantised raycaster reads
     * vertex data on demand (lazy dequantisation) and operates on the same
     * `Intersection` shape, so callers don't need to branch.
     */
    setQuantizedRaycaster(raycaster: QuantizedRaycaster | null): void {
        this.quantizedRaycaster = raycaster;
    }

    /**
     * Collect all visible mesh data from the scene, applying visibility filters.
     */
    private collectVisibleMeshData(options?: PickOptions): MeshData[] {
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

        // Check if BVH needs rebuilding
        const needsRebuild =
            !this.bvhCache ||
            !this.bvhCache.isBuilt ||
            this.bvhCache.meshCount !== allMeshData.length;

        if (needsRebuild) {
            // Build BVH only when needed
            this.bvh.build(allMeshData);
            this.bvhCache = {
                meshCount: allMeshData.length,
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

            // Quantised path takes priority when a scene is loaded — the
            // legacy `Scene.getMeshes()` is empty in that mode (the loader
            // stores `geometryResult.meshes = []` deliberately), so the
            // fallback below would return `null` for every click.
            if (this.quantizedRaycaster) {
                const intersection = this.quantizedRaycaster.raycast(ray);
                if (!intersection) return null;
                // Snap detection across quantised geometry needs lazy
                // dequantisation of nearby instances; not implemented yet.
                // Return the hit without snap so measurement / placement
                // tools at least get a precise 3-D point.
                return { intersection };
            }

            // Get all mesh data from scene
            const allMeshData = this.collectVisibleMeshData(options);

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

            // Quantised path: skip BVH/MeshData[] entirely; lazy dequantise
            // only the triangles the ray actually hits. Snap edge-lock can't
            // run without `MeshData[]` yet, so we report no edge — magnetic
            // dragging degrades to plain raycast for now.
            if (this.quantizedRaycaster) {
                const intersection = this.quantizedRaycaster.raycast(ray);
                return {
                    intersection,
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

            // Get all mesh data from scene
            const allMeshData = this.collectVisibleMeshData(options);

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
