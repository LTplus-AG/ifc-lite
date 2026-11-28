/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { entityClip } from './section-exclusions.js';
/**
 * RaycastEngine - raycasting, BVH management and snap detection, composed into `Renderer`.
 * Textured enumeration is optional for existing custom SceneContents adapters.
 */

import { Camera } from './camera.js';
import { isEntityVisible } from './entity-visibility.js';
import { Raycaster, type Intersection, type Ray } from './raycaster.js';
import { SnapDetector, type SnapTarget, type SnapOptions, type EdgeLockInput, type MagneticSnapResult } from './snap-detector.js';
import { RaycastFlatIndex, type RaycastScene } from './raycast-flat-index.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickClipState, PickOptions } from './types.js';
import { pointClipped } from './scene-raycaster.js';
import { ScreenCornerIndex } from './snap-screen-corners.js';
import { withScreenCorner } from './raycast-screen-corner.js';
import type { SourceSnapCurve } from './source-curve-snap.js';
import { querySourceCurves } from './raycast-source-curve-query.js';
import type { CpuGeometryVisitor } from './cpu-geometry-visit.js';
import { releasedEdgeLock, type PointCloudRayProvider } from './raycast-point-cloud-query.js';
import { withPointCloudSnap } from './raycast-point-cloud-snap.js';
export type { PointCloudRaySource, PointCloudRayProvider } from './raycast-point-cloud-query.js';
/** Below this many flat pieces a BVH costs more than testing them all. */
const BVH_THRESHOLD = 100;

export class RaycastEngine {
    private camera: Camera;
    private scene: RaycastScene;
    private canvas: HTMLCanvasElement;
    private raycaster: Raycaster;
    private snapDetector: SnapDetector;
    private flatIndex: RaycastFlatIndex;
    private readonly unsubscribeEviction: (() => void) | void;
    private screenCorners = new ScreenCornerIndex();
    private pointCloudProvider: PointCloudRayProvider | null = null;
    private sourceSnapCurves: readonly SourceSnapCurve[] = [];
    /** Flat pieces read back for released geometry (#10264); empty when unused. */
    private readbackMeshes: readonly MeshData[] = [];
    private cornerInventory: { resident: readonly MeshData[]; pieces: readonly MeshData[] } | null = null;
    /** The one ray they were prepared for: canvas point and view stamp at set time. */
    private readbackCoverage: { x: number; y: number; view: string } | null = null;
    /** Host state a ray's answer also depends on, folded into the view stamp (the renderer's pick-clip revision). */
    viewStampExtra: () => string = () => '';

    constructor(camera: Camera, scene: RaycastScene, canvas: HTMLCanvasElement) {
        this.camera = camera;
        this.scene = scene;
        this.canvas = canvas;
        this.raycaster = new Raycaster();
        this.snapDetector = new SnapDetector();
        this.flatIndex = new RaycastFlatIndex(scene, BVH_THRESHOLD);
        this.unsubscribeEviction = scene.onHostEviction?.(() => this.clearCaches());
    }

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

    private visibilityFilter(options?: PickOptions): ((piece: MeshData) => boolean) | undefined {
        const hidden = options?.hiddenIds, isolated = options?.isolatedIds;
        if ((hidden == null || hidden.size === 0) && isolated == null) return undefined;
        return piece => isEntityVisible(piece.expressId, hidden, isolated);
    }

    /** Released geometry read back for an imminent raycast or snap (#10264), under the same visibility and clip
     *  rules as flat candidates; `null` clears. The host owns their lifetime and frame (`placeAppearanceSource`). */
    setReadbackMeshes(meshes: readonly MeshData[] | null, at?: { x: number; y: number }): void {
        if (this.cornerInventory && (meshes?.length !== this.readbackMeshes.length ||
            !meshes.every((piece, i) => piece === this.readbackMeshes[i]))) {
            // Release the previous readback inventory and any pending idle build before its leases end.
            this.screenCorners.clear();
            this.cornerInventory = null;
        }
        this.readbackMeshes = meshes ?? [];
        this.readbackCoverage = meshes && at ? { x: at.x, y: at.y, view: this.readbackViewKey() } : null;
    }

    /** Whether readback pieces (a neighbourhood only: another ray could pass an unfed front surface) answer (x, y):
     *  only the prepared ray, within a 1.5 CSS px radius, under the same view stamp. */
    readbackCovers(x: number, y: number): boolean {
        const at = this.readbackCoverage; // `<= 1.5`, so a NaN distance covers nothing; the view includes the viewport size
        return at !== null && Math.hypot(at.x - x, at.y - y) <= 1.5 && at.view === this.readbackViewKey();
    }

    /** Coverage's view stamp: the f64 ray inputs (pose, projection), the matrix, CSS viewport size and host extras. */
    readbackViewKey(): string {
        const v = this.cssViewport(), c = this.camera, at = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
        return [at(c.getPosition()), at(c.getTarget()), at(c.getUp()), c.getProjectionMode(), c.getFOV(), c.getOrthoSize(),
            Array.from(c.getViewProjMatrix().m).join(','), `${v?.width ?? 0}x${v?.height ?? 0}`, this.viewStampExtra()].join('|');
    }

    private readbackForRay(at?: { x: number; y: number }): readonly MeshData[] {
        return this.readbackCoverage === null || (at && this.readbackCovers(at.x, at.y)) ? this.readbackMeshes : [];
    }

    private piecesForCorners(x: number, y: number): readonly MeshData[] {
        const resident = this.flatIndex.allPieces();
        const readback = this.readbackForRay({ x, y });
        if (!readback.length) return resident;
        if (this.cornerInventory?.resident !== resident) {
            const pieces = resident.length ? Array.from(new Set([...resident, ...readback])) : readback;
            this.cornerInventory = { resident, pieces };
        }
        return this.cornerInventory.pieces;
    }

    /** Flat candidates near the ray, plus ray-culled instanced occurrences. */
    private meshesForRay(options: PickOptions | undefined, ray: Ray, at?: { x: number; y: number }): MeshData[] {
        const allMeshData = this.flatIndex.query(ray, this.visibilityFilter(options));
        for (const piece of this.readbackForRay(at)) {
            if (isEntityVisible(piece.expressId, options?.hiddenIds, options?.isolatedIds)) allMeshData.push(piece);
        }
        const seenInstancedKeys = new Set<string>();

        // GPU-instanced occurrences live only in the shard, not meshDataMap. Materialize
        // their per-occurrence triangles ON DEMAND so measure-snap / section-face-pick
        // work over them — but only for occurrences whose world AABB the ray actually
        // hits, so we never expand the whole instanced population per ray.
        for (const eid of this.scene.getInstancedEntityIds()) {
            if (!isEntityVisible(eid, options?.hiddenIds, options?.isolatedIds)) continue;
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
                if (seenInstancedKeys.has(key)) continue;
                seenInstancedKeys.add(key);
                allMeshData.push(piece);
            }
        }

        return allMeshData;
    }

    /**
     * The canvas's CSS-pixel size, the space the caller's x/y are in. Rays,
     * snap radii and point-snap tolerances are all authored in CSS pixels, so
     * everything here stays in that space rather than the drawing buffer's
     * device pixels (#5383). Null if the canvas rect has zero dimensions.
     */
    private cssViewport(): { width: number; height: number } | null {
        const rect = this.canvas.getBoundingClientRect();
        return rect.width === 0 || rect.height === 0 ? null : { width: rect.width, height: rect.height };
    }

    /**
     * Raycast into the scene to get precise 3D intersection point
     * This is more accurate than pick() as it returns the exact surface point
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * The ray is built in that same CSS space (see cssViewport).
     */
    raycastScene(
        x: number,
        y: number,
        options?: PickOptions & { snapOptions?: Partial<SnapOptions> },
        clip?: PickClipState | null,
    ): { intersection: Intersection; snap?: SnapTarget } | null {
        try {
            const viewport = this.cssViewport();
            if (!viewport) return null;

            // Create ray from screen coordinates
            const ray = this.camera.unprojectToRay(x, y, viewport.width, viewport.height);

            // Get all mesh data from scene
            const meshesToTest = this.meshesForRay(options, ray, { x, y });
            if (meshesToTest.length === 0) {
                return null;
            }

            // Perform raycasting
            const intersection = this.raycaster.raycast(ray, meshesToTest,
                hit => !pointClipped(entityClip(clip, hit.expressId), hit.point.x, hit.point.y, hit.point.z));

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
                    viewport.height,
                    options.snapOptions, target => !pointClipped(entityClip(clip, target.expressId), target.position.x, target.position.y, target.position.z),
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
     * The ray is built in that same CSS space (see cssViewport).
     */
    raycastSceneMagnetic(
        x: number,
        y: number,
        currentEdgeLock: EdgeLockInput,
        options?: PickOptions & { snapOptions?: Partial<SnapOptions> },
        clip?: PickClipState | null,
    ): MagneticSnapResult & { intersection: Intersection | null } {
        try {
            const viewport = this.cssViewport();
            if (!viewport) {
                return {
                    intersection: null,
                    snapTarget: null,
                    edgeLock: releasedEdgeLock(),
                };
            }

            // Create ray from screen coordinates
            const ray = this.camera.unprojectToRay(x, y, viewport.width, viewport.height);

            // Get all mesh data from scene. Unlike before #1860, an empty
            // scene no longer short-circuits here — a point-cloud-only
            // model (no IFC mesh loaded at all) must still fall through
            // to the point-cloud query below instead of returning a hard
            // miss.
            const meshesToTest = this.meshesForRay(options, ray, { x, y });

            const cameraPos = this.camera.getPosition();
            const cameraFov = this.camera.getFOV();

            let intersection: Intersection | null = null;
            let magneticResult: MagneticSnapResult = { snapTarget: null, edgeLock: releasedEdgeLock() };

            if (meshesToTest.length > 0) {
                // Same clip policy as raycastScene: what the section removed cannot be hit (#8659).
                intersection = this.raycaster.raycast(ray, meshesToTest,
                    hit => !pointClipped(entityClip(clip, hit.expressId), hit.point.x, hit.point.y, hit.point.z));

                // Use magnetic snap detection
                magneticResult = this.snapDetector.detectMagneticSnap(
                    ray,
                    meshesToTest,
                    intersection,
                    { position: cameraPos, fov: cameraFov },
                    viewport.height,
                    currentEdgeLock,
                    options?.snapOptions || {},
                    clip,
                );
            }

            const ordinaryTarget = magneticResult.snapTarget;
            magneticResult = withScreenCorner(this.screenCorners,
                { camera: this.camera, viewKey: () => [this.readbackViewKey(), this.scene.getPickGeometryRevision?.(), this.scene.getInstancedEntityRevision?.()].join('|'),
                  snapOccurrences: this.scene.snapOccurrences?.bind(this.scene), getPieces: () => this.piecesForCorners(x, y), snapDetector: this.snapDetector },
                magneticResult, x, y, ray, viewport, options, clip, intersection?.distance ?? null);

            const source = querySourceCurves(this.sourceSnapCurves, magneticResult.snapTarget,
                this.camera, ray, x, y, viewport, options, clip);
            if (source) magneticResult = { snapTarget: source, edgeLock: releasedEdgeLock() };

            magneticResult = withPointCloudSnap(this.pointCloudProvider, magneticResult, {
                useTargetDepth: magneticResult.snapTarget !== ordinaryTarget || !!source,
                ray, intersection, options, clip, cameraFov, viewportHeight: viewport.height,
                orthoHalfHeight: this.camera.getProjectionMode() === 'orthographic' ? this.camera.getOrthoSize() : null,
            });

            return {
                intersection,
                ...magneticResult,
            };
        } catch (error) {
            console.error('Magnetic raycast error:', error);
            return {
                intersection: null,
                snapTarget: null,
                edgeLock: releasedEdgeLock(),
            };
        }
    }

    /**
     * Invalidate BVH cache (call when geometry changes)
     */
    invalidateBVHCache(): void {
        this.cornerInventory = null;
        this.flatIndex.invalidate();
        this.screenCorners.clear();
    }

    /** Diagnostic (#10264): CPU geometry the raycast index and its BVH still reference. */
    visitCpuGeometry(visit: CpuGeometryVisitor): void {
        this.flatIndex.visitCpuGeometry(visit);
    }

    /** True when the flat index is warm; instances can still materialize per ray. */
    isCacheWarm(): boolean {
        return this.flatIndex.isWarm();
    }

    /** Release this engine before discarding it; create a new engine to resume picking. */
    dispose(): void {
        this.unsubscribeEviction?.();
        this.cornerInventory = null;
        this.flatIndex.invalidate();
        this.snapDetector.clearCache();
        this.screenCorners.clear();
        this.pointCloudProvider = null;
        this.sourceSnapCurves = [];
    }

    /** Get the raycaster for advanced usage. */
    getRaycaster(): Raycaster {
        return this.raycaster;
    }

    /** Get the snap detector for advanced usage. */
    getSnapDetector(): SnapDetector {
        return this.snapDetector;
    }

    /**
     * Renderer wires this once point clouds are initialised so the
     * measure tool can snap to scan points (#1860). Pass null to disable.
     */
    setPointCloudProvider(provider: PointCloudRayProvider | null): void {
        this.pointCloudProvider = provider;
    }

    /** Replace the selected, visible authored curves available to magnetic picking. */
    setSourceSnapCurves(curves: readonly SourceSnapCurve[]): void { this.sourceSnapCurves = [...curves]; }
    /**
     * Clear all caches (call when geometry changes)
     */
    clearCaches(): void {
        this.invalidateBVHCache();
        this.snapDetector.clearCache();
    }
}
