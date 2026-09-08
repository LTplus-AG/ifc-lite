/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single owner of the scene AABB that `Renderer` calls `modelBounds`
 * (issue #2425).
 *
 * The value was written from four unrelated concerns — point-cloud upload,
 * mesh load, annotation/alignment overlay upload, and the public
 * `setModelBounds` — and read by fit-to-view, `getDiagnostics()` and the
 * section-plane range. That co-ownership is what blocked the point-cloud and
 * 3D-overlay facades from moving out of `index.ts`: every bounds-mutating
 * method reached into a `Renderer` private field.
 *
 * What this class deliberately does NOT do is notify the camera. Every
 * mutating call site in `Renderer` follows the mutation with
 * `camera.setSceneBounds(...)`, but under three different policies:
 *
 *  - the point-cloud paths push unconditionally, so a scene that empties out
 *    clears the camera's bounds to `null`;
 *  - the overlay paths push only when the value is non-null, so an empty
 *    upload leaves the camera's previous bounds in place;
 *  - the public `setModelBounds()` does not push at all, and the section-plane
 *    branch of `render()` pushes a *separate* wrapper object.
 *
 * Folding the notification in here would have to pick one of those, which is a
 * behaviour change. The pairing therefore stays at the call site, and callers
 * keep it atomic themselves.
 *
 * The tracked value is handed out by reference, not copied: `getModelBounds()`
 * is a live view (`apps/viewer` holds onto it across frames) and
 * `Camera.setSceneBounds` stores the reference it is given, so in-place
 * expansion is already visible to the camera without a fresh push. Copying
 * defensively here would change what both observers see.
 */

/** World-space axis-aligned box, in the object shape `Renderer` exposes. */
export interface ModelBoundsBox {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
}

/** Tuple-shaped AABB, as produced by `PointCloudRenderer.getBounds()`. */
export interface TupleBounds {
    min: [number, number, number];
    max: [number, number, number];
}

/**
 * Where the tracker reads the scene from. Both are pulled lazily on every
 * call so the tracker can be constructed before the collaborators it reads
 * (`pointCloudRenderer` only exists after `init()`).
 */
export interface ModelBoundsSources {
    /** Aggregate AABB over batched mesh geometry, or null when there is none. */
    meshBounds(): ModelBoundsBox | null;
    /** Aggregate AABB over loaded point clouds, or null when there is none. */
    pointCloudBounds(): TupleBounds | null;
}

export class ModelBoundsTracker {
    private bounds: ModelBoundsBox | null = null;

    constructor(private readonly sources: ModelBoundsSources) {}

    /** The live tracked AABB (not a copy), or null when nothing is loaded. */
    get(): ModelBoundsBox | null {
        return this.bounds;
    }

    /** Replace the tracked AABB outright. */
    set(bounds: ModelBoundsBox): void {
        this.bounds = bounds;
    }

    /**
     * Recompute from scratch: mesh bounds as the baseline, then fold the
     * CURRENT point-cloud bounds on top.
     *
     * Folding only-up via {@link expandForPointClouds} is correct when point
     * cloud bounds grow but never shrinks them when an asset is removed,
     * leaving stale oversized extents until every point cloud is gone. Call
     * this from the remove / clear paths so bounds shrink correctly.
     */
    recompute(): void {
        const meshBounds = this.sources.meshBounds();
        const pcBounds = this.sources.pointCloudBounds();

        if (!meshBounds && !pcBounds) {
            this.bounds = null;
            return;
        }
        this.bounds = meshBounds ?? {
            min: { x: pcBounds!.min[0], y: pcBounds!.min[1], z: pcBounds!.min[2] },
            max: { x: pcBounds!.max[0], y: pcBounds!.max[1], z: pcBounds!.max[2] },
        };
        if (meshBounds && pcBounds) {
            this.expandForPointClouds();
        }
    }

    /** Grow (never shrink) the tracked AABB to cover the loaded point clouds. */
    expandForPointClouds(): void {
        const pcBounds = this.sources.pointCloudBounds();
        if (!pcBounds) return;
        if (!this.bounds) {
            this.bounds = {
                min: { x: pcBounds.min[0], y: pcBounds.min[1], z: pcBounds.min[2] },
                max: { x: pcBounds.max[0], y: pcBounds.max[1], z: pcBounds.max[2] },
            };
            return;
        }
        const m = this.bounds;
        m.min.x = Math.min(m.min.x, pcBounds.min[0]);
        m.min.y = Math.min(m.min.y, pcBounds.min[1]);
        m.min.z = Math.min(m.min.z, pcBounds.min[2]);
        m.max.x = Math.max(m.max.x, pcBounds.max[0]);
        m.max.y = Math.max(m.max.y, pcBounds.max[1]);
        m.max.z = Math.max(m.max.z, pcBounds.max[2]);
    }

    /** Fold newly loaded mesh geometry into the tracked AABB. */
    updateFromMeshes(meshes: import('@ifc-lite/geometry').MeshData[]): void {
        if (!this.bounds) {
            this.bounds = {
                min: { x: Infinity, y: Infinity, z: Infinity },
                max: { x: -Infinity, y: -Infinity, z: -Infinity }
            };
        }

        for (const mesh of meshes) {
            const positions = mesh.positions;
            // Positions are in the element's local frame (world = origin + position).
            // Model bounds are world-space, so fold the per-mesh origin. No-op when
            // origin is absent/[0,0,0]. Mirrors coordinate-handler.ts.
            const o = mesh.origin;
            const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
            for (let i = 0; i < positions.length; i += 3) {
                const x = positions[i] + ox;
                const y = positions[i + 1] + oy;
                const z = positions[i + 2] + oz;
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                    this.bounds.min.x = Math.min(this.bounds.min.x, x);
                    this.bounds.min.y = Math.min(this.bounds.min.y, y);
                    this.bounds.min.z = Math.min(this.bounds.min.z, z);
                    this.bounds.max.x = Math.max(this.bounds.max.x, x);
                    this.bounds.max.y = Math.max(this.bounds.max.y, y);
                    this.bounds.max.z = Math.max(this.bounds.max.z, z);
                }
            }
        }
    }

    /** Walks a flat `[x,y,z,x,y,z,...]` vertex buffer and either initialises
     *  or expands the tracked AABB. Used by the annotation overlay upload
     *  paths so symbolic-only models can still be framed.
     *
     *  The geometry pipeline pre-seeds a placeholder `[-100, 100]` cube on
     *  every render when there are 0 meshes (so the section-plane slider
     *  always has a workable range). For an annotation-only model that
     *  fallback drowns out the much-smaller annotation cluster and a plain
     *  "expand" would no-op. We detect the placeholder by its exact symmetric
     *  signature and replace it with the actual annotation AABB instead. */
    expandWithFlatVertices(positions: Float32Array, stride: number): void {
        if (positions.length === 0) return;
        const isPlaceholderCube = (b: ModelBoundsBox): boolean =>
            b.min.x === -100 && b.min.y === -100 && b.min.z === -100
                && b.max.x === 100 && b.max.y === 100 && b.max.z === 100;
        if (!this.bounds || isPlaceholderCube(this.bounds)) {
            this.bounds = {
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
            if (x < this.bounds.min.x) this.bounds.min.x = x;
            if (y < this.bounds.min.y) this.bounds.min.y = y;
            if (z < this.bounds.min.z) this.bounds.min.z = z;
            if (x > this.bounds.max.x) this.bounds.max.x = x;
            if (y > this.bounds.max.y) this.bounds.max.y = y;
            if (z > this.bounds.max.z) this.bounds.max.z = z;
            expanded = true;
        }
        if (!expanded) return;
        // Guarantee non-degenerate extent on every axis so camera frustums
        // don't collapse. 0.5 m margin matches what the section-plane fallback
        // uses in `Renderer`.
        for (const axis of ['x', 'y', 'z'] as const) {
            if (this.bounds.max[axis] - this.bounds.min[axis] < 1e-3) {
                this.bounds.max[axis] += 0.5;
                this.bounds.min[axis] -= 0.5;
            }
        }
    }
}
