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
import { SnapDetector, SnapType, type SnapTarget, type SnapOptions, type EdgeLockInput, type MagneticSnapResult } from './snap-detector.js';
import { RaycastFlatIndex, type RaycastScene } from './raycast-flat-index.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickClipState, PickOptions } from './types.js';
import { pointClipped } from './scene-raycaster.js';
import { ScreenCornerIndex } from './snap-screen-corners.js';
import type { SourceSnapCurve } from './source-curve-snap.js';
import { querySourceCurves } from './raycast-source-curve-query.js';
import type { CpuGeometryVisitor } from './cpu-geometry-visit.js';
import {
    queryPointClouds,
    releasedEdgeLock,
    pointCloudSnapEnabled,
    pointCloudWinsOverMeshSnap,
    pointCloudWinsOverSourceSnap,
    type PointCloudRayProvider,
    type PointCloudSnapCamera,
} from './raycast-point-cloud-query.js';
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
    private screenCorners = new ScreenCornerIndex();
    private pointCloudProvider: PointCloudRayProvider | null = null;
    private sourceSnapCurves: readonly SourceSnapCurve[] = [];
    /** Flat pieces read back for released geometry (#10264); empty when unused. */
    private readbackMeshes: readonly MeshData[] = [];
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

    /** Flat candidates near the ray, plus ray-culled instanced occurrences. */
    private meshesForRay(options: PickOptions | undefined, ray: Ray, at?: { x: number; y: number }): MeshData[] {
        const allMeshData = this.flatIndex.query(ray, this.visibilityFilter(options));
        const covered = this.readbackCoverage === null || (at !== undefined && this.readbackCovers(at.x, at.y));
        if (covered) for (const piece of this.readbackMeshes) {
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

            magneticResult = this.withScreenCorner(magneticResult, x, y, ray, viewport, options, clip, intersection?.distance ?? null);

            const source = querySourceCurves(this.sourceSnapCurves, magneticResult.snapTarget,
                this.camera, ray, x, y, viewport, options, clip);
            if (source) magneticResult = { snapTarget: source, edgeLock: releasedEdgeLock() };

            // Point-cloud snapping (#1860): search up to whatever the mesh
            // path already found (or the whole scene, if there was no mesh
            // hit at all) — a real mesh surface in front of a scan point
            // should still win the pick. Gated on the caller's snap config
            // so the measure tool's snap toggle disables scan-point
            // magnetism exactly like mesh vertex/edge magnetism.
            const snapCamera: PointCloudSnapCamera = {
                fov: cameraFov,
                canvasHeightPx: viewport.height,
                orthoHalfHeight: this.camera.getProjectionMode() === 'orthographic' ? this.camera.getOrthoSize() : null,
            };
            const maxPointDistance = intersection ? intersection.distance : Infinity;
            const pointHit = pointCloudSnapEnabled(options?.snapOptions)
                ? queryPointClouds(this.pointCloudProvider, ray, snapCamera, maxPointDistance, options, clip)
                : null;
            if (pointHit) {
                // A point-cloud hit only OVERRIDES an existing mesh snap
                // target (vertex/edge/face/...) when it's meaningfully in
                // front of the mesh surface, not just scan noise a few mm
                // nearer along the ray — otherwise a scan overlapping its
                // as-designed model would non-deterministically steal
                // intended vertex/corner snaps on most measurements over
                // scanned-over geometry (#1860 review finding 2). When the
                // mesh path found no snap target at all (bare face hit, or
                // no mesh hit), the point snap wins as before.
                const sourceTarget = magneticResult.snapTarget?.metadata?.sourceCurve ? magneticResult.snapTarget : null;
                const wins = sourceTarget
                    ? pointCloudWinsOverSourceSnap(pointHit, sourceTarget, ray, snapCamera)
                    : pointCloudWinsOverMeshSnap({
                        pointHit,
                        meshSnapTarget: magneticResult.snapTarget,
                        meshIntersectionDistance: intersection ? intersection.distance : null,
                        camera: snapCamera,
                    });
                if (wins) {
                    magneticResult = {
                        snapTarget: {
                            type: SnapType.POINT_CLOUD,
                            position: pointHit.position,
                            expressId: pointHit.expressId,
                            confidence: 1,
                        },
                        edgeLock: releasedEdgeLock(),
                    };
                }
            }

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
     * CAD-style corner snapping (#11504). With `snapOptions.screenCornerSnap` set and vertex or edge snapping on,
     * the nearest feature corner of the eligible, visible, unclipped pieces within the corner radius of the cursor
     * replaces the ray-based result, whatever the ray hit; failing that the nearest edge within the edge radius
     * replaces a face-only or empty result. An existing vertex/edge snap otherwise stands.
     */
    private withScreenCorner(
        current: MagneticSnapResult, x: number, y: number, ray: Ray, viewport: { width: number; height: number },
        options: (PickOptions & { snapOptions?: Partial<SnapOptions> }) | undefined, clip?: PickClipState | null,
        hitDistance: number | null = null,
    ): MagneticSnapResult {
        const snap = options?.snapOptions;
        const config = snap?.screenCornerSnap;
        if (!config || (snap.snapToVertices === false && snap.snapToEdges === false)) return current;
        const hit = this.screenCorners.query({
            x, y, ray, camera: this.camera, viewKey: this.readbackViewKey(), liveViewKey: () => this.readbackViewKey(), viewport,
            pieces: this.flatIndex.allPieces(), geometryFor: mesh => this.snapDetector.getGeometryCache(mesh),
            startGeometry: mesh => this.snapDetector.startGeometryCache(mesh),
            options: config, hiddenIds: options?.hiddenIds, isolatedIds: options?.isolatedIds, clip, hitDistance,
        });
        if (!hit) return current;
        const kind = current.snapTarget?.type;
        if (hit.kind === 'edge' && (kind === SnapType.VERTEX || kind === SnapType.EDGE)) return current;
        if (hit.kind === 'corner' ? snap.snapToVertices === false : snap.snapToEdges === false) return current;
        return {
            snapTarget: {
                type: hit.kind === 'corner' ? SnapType.VERTEX : SnapType.EDGE,
                position: hit.position, expressId: hit.expressId, confidence: 1,
                metadata: hit.edge ? { vertices: [hit.edge.v0, hit.edge.v1] } : undefined,
            },
            edgeLock: releasedEdgeLock(),
        };
    }

    /**
     * Invalidate BVH cache (call when geometry changes)
     */
    invalidateBVHCache(): void {
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
        this.flatIndex.dispose();
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
