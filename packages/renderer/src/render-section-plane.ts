/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-frame section-plane resolution, lifted verbatim out of
 * `Renderer.renderFrame()` (issue #2425).
 *
 * This is the "what does this frame clip against, and over what range" half of
 * the section feature: it aggregates the bounds the slider is expressed in,
 * turns `RenderOptions.sectionPlane` (or `terrainClipY`) into the world-space
 * normal + distance the shader uniform carries, and reports the one-shot
 * diagnostic log. It touches no GPU object and no `Renderer` field, which is
 * why it can live here: everything it needs arrives as an argument. The bounds
 * it computed come back in the return value for the caller to apply; the
 * one-shot log latch is committed through the injected `spendLogLatch` so it
 * still lands BEFORE the log, exactly as it did inline.
 */

import type { BatchedMesh, Mesh, RenderOptions } from './types.js';

/** World-space AABB in the renderer's Y-up frame. */
interface SectionFrameBounds {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
}

/**
 * The distance range an AABB spans along `normal`: the min and max of
 * `dot(corner, normal)` over the eight corners (issue #2447).
 *
 * This is the quantity a section slider has to travel over, because the plane
 * the shader clips against is `dot(worldPos, normal) = distance`. Reading the
 * range off one axis of the AABB instead is only the same quantity when
 * `normal` IS that unit axis; on a rotated building it is short by up to
 * `(1 - cos45) * extent` at each end, so the slider's 0-100% cannot reach the
 * model's extremes (a 40 x 20 footprint cut on `side` at 45 degrees spans 40
 * units where the true extent along the normal is 42.426).
 *
 * When `normal` IS a unit axis the loop collapses to that axis's extent
 * bit-for-bit (`x * 1 + y * 0 + z * 0 === x` for finite inputs), so unrotated
 * models are unaffected.
 *
 * Exported so the 2D cap upload can share the one formula instead of carrying
 * a second copy — see `RendererOverlays.uploadSection2DOverlay`, which passes
 * the un-rotated axis normal on purpose.
 */
export function projectedBoundsRange(
    boundsMin: { x: number; y: number; z: number },
    boundsMax: { x: number; y: number; z: number },
    normal: readonly [number, number, number],
): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const x of [boundsMin.x, boundsMax.x]) {
        for (const y of [boundsMin.y, boundsMax.y]) {
            for (const z of [boundsMin.z, boundsMax.z]) {
                const d = x * normal[0] + y * normal[1] + z * normal[2];
                if (d < min) min = d;
                if (d > max) max = d;
            }
        }
    }
    return { min, max };
}

/** The clip plane a frame hands to the mesh / point / instanced shaders. */
interface SectionPlaneFrameData {
    normal: [number, number, number];
    distance: number;
    enabled: boolean;
}

export interface SectionPlaneFrameInput {
    options: RenderOptions;
    /**
     * `Scene.getBatchedMeshes()`. The primary bounds source — individual
     * meshes are deliberately excluded, see the comment on the aggregation.
     */
    batchedMeshes: ReadonlyArray<BatchedMesh>;
    /**
     * The frame's individual-mesh list, used only as the streaming/degenerate
     * bounds fallback. NOT raw `Scene.getMeshes()`: the call site passes the
     * list *after* frustum culling and the hidden/isolated filters, which is
     * what the pre-extraction code aggregated. Passing an unfiltered list would
     * silently widen the fallback bounds, and with them the section slider's
     * range, whenever the batched path has no bounds yet.
     */
    meshes: ReadonlyArray<Mesh>;
    /** `PointCloudRenderer.getBounds()`, or null when no points are loaded. */
    pointCloudBounds: { min: [number, number, number]; max: [number, number, number] } | null;
    /**
     * Whether the one-shot "Y-up bounds used for clip" diagnostic has still to
     * fire. The renderer owns the latch (`_loggedSectionBounds`, re-armed by
     * `destroy()` for the next model).
     */
    logSectionBounds: boolean;
    /**
     * Commit the renderer's one-shot latch. Called immediately BEFORE the
     * diagnostic is emitted, not after this function returns.
     *
     * The ordering is load-bearing and matches the pre-extraction code
     * (`this._loggedSectionBounds = true;` then `console.info(...)`). Spending
     * the latch afterwards would leave it unspent if `console.info` threw — a
     * monkey-patched console is the only realistic way that happens — and this
     * runs inside `renderFrame`'s encode `try`, so every later section-enabled
     * frame would throw again and be contained as a degraded frame, eventually
     * firing `onPersistentRenderDegradation`. The original cost one contained
     * frame, ever.
     */
    spendLogLatch: () => void;
}

export interface SectionPlaneFrameResult {
    /** Undefined when nothing clips this frame. */
    sectionPlaneData: SectionPlaneFrameData | undefined;
    /**
     * The bounds the section slider was resolved against, or null when
     * `options.sectionPlane` was absent (in which case the renderer's cached
     * model bounds are left alone).
     */
    bounds: SectionFrameBounds | null;
}

/**
 * Resolve this frame's clip plane and the bounds it is expressed in.
 *
 * Pure apart from the one-shot diagnostic, which is gated by
 * `input.logSectionBounds` and commits its latch through
 * `input.spendLogLatch` before logging.
 */
export function resolveSectionPlaneFrame(input: SectionPlaneFrameInput): SectionPlaneFrameResult {
    const { options, batchedMeshes, meshes, pointCloudBounds } = input;

    // Calculate section plane parameters and model bounds
    // Always calculate bounds when sectionPlane is provided (for preview and active mode)
    let sectionPlaneData: SectionPlaneFrameData | undefined;

    // Terrain clip: when Cesium overlay is active, clip model below terrain.
    // Normal (0,-1,0) + distance (-clipY) clips where worldPos.y < clipY.
    if (options.terrainClipY !== undefined && !options.sectionPlane?.enabled) {
        sectionPlaneData = {
            normal: [0, -1, 0],
            distance: -options.terrainClipY,
            enabled: true,
        };
    }

    if (!options.sectionPlane) {
        return { sectionPlaneData, bounds: null };
    }

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
    if (pointCloudBounds) {
        boundsMin.x = Math.min(boundsMin.x, pointCloudBounds.min[0]);
        boundsMin.y = Math.min(boundsMin.y, pointCloudBounds.min[1]);
        boundsMin.z = Math.min(boundsMin.z, pointCloudBounds.min[2]);
        boundsMax.x = Math.max(boundsMax.x, pointCloudBounds.max[0]);
        boundsMax.y = Math.max(boundsMax.y, pointCloudBounds.max[1]);
        boundsMax.z = Math.max(boundsMax.z, pointCloudBounds.max[2]);
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
        // `SectionPlane.normal` / `.distance` are caller-supplied public
        // `RenderOptions` surface (the face-pick / arbitrary-plane path from
        // #243), so every component has to clear finiteness before it can reach
        // the clip uniform and `_activePickSection` (#2442). Only `distance`
        // used to be checked: an `Infinity` component then made `len` infinite,
        // `len > 1e-6` true, and `normal = [NaN, NaN, NaN]` was written straight
        // into both the draw and the GPU pick. A rejected plane degrades to the
        // cardinal-axis preset below, which is always a usable plane.
        const hasExplicitPlane =
            explicitNormal !== undefined &&
            explicitDistance !== undefined &&
            Number.isFinite(explicitDistance) &&
            Number.isFinite(explicitNormal[0]) &&
            Number.isFinite(explicitNormal[1]) &&
            Number.isFinite(explicitNormal[2]);

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
            // Finite components are not enough: `1e200` squares to `Infinity`,
            // so `len` can still overflow and `len > 1e-6` is true for it,
            // yielding `normal = [0, 0, 0]` and `distance = 0` (#2442). Both the
            // overflow and the degenerate near-zero vector take the documented
            // [0, 1, 0] fallback.
            if (Number.isFinite(len) && len > 1e-6) {
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
            //
            // The angle must also be FINITE (#2442). It is model-derived, not
            // authored by us — `rotation_angle_about_z` on the resolved IfcSite
            // placement — and a malformed placement direction whose components
            // overflow to Infinity (`IFCDIRECTION((0.,0.,1.0E400))`, which the
            // STEP tokenizer parses to `inf`) normalises to a NaN matrix, so
            // the pre-pass emits `atan2(NaN, NaN)` = NaN and nothing on the way
            // to `RenderOptions` filters it. `Math.cos` is NaN for both NaN and
            // Infinity, and the `rlen > 0.0001` guard below is FALSE for NaN,
            // so it would reach `projectedBoundsRange`, `distance` and the clip
            // uniform — the failure #2442 fixed on the explicit-plane sibling.
            // Non-finite degrades to no rotation: the cardinal preset the axis
            // already describes.
            if (
                options.buildingRotation !== undefined &&
                options.buildingRotation !== 0 &&
                Number.isFinite(options.buildingRotation)
            ) {
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

            // Get the range the slider travels over. The renderer's own `boundsMin/Max`
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
            //
            // The range must be measured along the normal the plane actually
            // cuts with, not along the cardinal axis it was derived from: the
            // shader clips on `dot(worldPos, normal)`, so on a rotated building
            // an axis-aligned extent leaves an unreachable wedge at each end of
            // the slider (#2447). `projectedBoundsRange` is the axis extent
            // exactly when the normal is still that unit axis.
            const projected = projectedBoundsRange(boundsMin, boundsMax, normal);
            let minVal = projected.min;
            let maxVal = projected.max;

            // The UI override arrives in AXIS-ALIGNED elevation units
            // (`coordinateInfo.shiftedBounds`), while the range above is a plane
            // distance. Those coincide only while the resolved normal is still
            // the positive unit axis the override is expressed along — true for
            // any unrotated model, and true for `axis: 'down'` at every rotation
            // (a Y-axis building rotation leaves [0,1,0] fixed). Outside that,
            // honouring the override would silently compare metres-along-Y
            // against a distance-along-a-tilted-normal, so it is skipped and the
            // full projected range stands (#2447).
            const axisComponent = options.sectionPlane.axis === 'side' ? 0 : options.sectionPlane.axis === 'down' ? 1 : 2;
            const overrideUnitsMatch =
                Math.abs(normal[axisComponent] - 1) <= 1e-6 &&
                Math.abs(normal[(axisComponent + 1) % 3]) <= 1e-6 &&
                Math.abs(normal[(axisComponent + 2) % 3]) <= 1e-6;
            const uiMin = options.sectionPlane.min;
            const uiMax = options.sectionPlane.max;
            if (
                overrideUnitsMatch &&
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
        if (input.logSectionBounds) {
            input.spendLogLatch();
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
                batchedMeshCount: batchedMeshes.length,
            });
        }
    }

    return {
        sectionPlaneData,
        bounds: { min: boundsMin, max: boundsMax },
    };
}
