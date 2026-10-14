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
import type { ExtraClipPlane } from './clip-types.js';
import { MAX_EXTRA_CLIP_PLANES } from './extra-clip-planes.js';
import { projectedBoundsRange, resolveExtraSectionPlanes, resolveSectionPlaneGeometry } from './section-plane-resolve.js';

/** World-space AABB in the renderer's Y-up frame. */
interface SectionFrameBounds {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
}

export { projectedBoundsRange };

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
    /** `options.extraSectionPlanes` resolved against the same bounds (#7545): enabled planes only. */
    extraPlanes: ExtraClipPlane[];
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

    if (!options.sectionPlane && !options.extraSectionPlanes?.length) {
        return { sectionPlaneData, bounds: null, extraPlanes: [] };
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

    if (options.sectionPlane?.enabled) {
        // Explicit normal + distance override (face-pick / arbitrary
        // plane, issue #243). Used verbatim: no axis mapping, no
        // position slider, no building rotation — the caller already
        // has the plane in world space.
        const { normal, distance, explicit: hasExplicitPlane } = resolveSectionPlaneGeometry(
            options.sectionPlane, boundsMin, boundsMax, options.buildingRotation,
        );

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
        extraPlanes: resolveExtraSectionPlanes(
            options.extraSectionPlanes, boundsMin, boundsMax, options.buildingRotation, MAX_EXTRA_CLIP_PLANES,
        ),
    };
}
