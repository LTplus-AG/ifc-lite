/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How one `SectionPlane` becomes the world-space plane the shaders clip on,
 * lifted out of `resolveSectionPlaneFrame` so the primary plane and the cutting
 * planes beyond it (#7545) are resolved by the very same code: a cardinal
 * plane's slider range, the building rotation and the explicit-normal guards
 * are not written twice.
 */

import type { ExtraClipPlane } from './clip-types.js';
import type { SectionPlane } from './types.js';

type Xyz = { x: number; y: number; z: number };

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

/**
 * The normal and distance one section plane clips on. `explicit` reports that
 * the caller's own `normal` + `distance` were used (a face pick) rather than the
 * cardinal axis and slider position.
 */
export function resolveSectionPlaneGeometry(
    plane: SectionPlane,
    boundsMin: Xyz,
    boundsMax: Xyz,
    buildingRotation: number | undefined,
): { normal: [number, number, number]; distance: number; explicit: boolean } {
    const explicitNormal   = plane.normal;
    const explicitDistance = plane.distance;
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
        if (plane.axis === 'side') normal[0] = 1;        // X axis
        else if (plane.axis === 'down') normal[1] = 1;   // Y axis (horizontal)
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
            buildingRotation !== undefined &&
            buildingRotation !== 0 &&
            Number.isFinite(buildingRotation)
        ) {
            const cosR = Math.cos(buildingRotation);
            const sinR = Math.sin(buildingRotation);
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
        // `input.worldPos` in the shader. `plane.min/max`
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
        const axisComponent = plane.axis === 'side' ? 0 : plane.axis === 'down' ? 1 : 2;
        const overrideUnitsMatch =
            Math.abs(normal[axisComponent] - 1) <= 1e-6 &&
            Math.abs(normal[(axisComponent + 1) % 3]) <= 1e-6 &&
            Math.abs(normal[(axisComponent + 2) % 3]) <= 1e-6;
        const uiMin = plane.min;
        const uiMax = plane.max;
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
        distance = minVal + (plane.position / 100) * range;
    }

    return { normal, distance, explicit: hasExplicitPlane };
}

/**
 * Every ENABLED plane of `planes` as an `ExtraClipPlane`, resolved against the
 * same bounds and rotation as the primary plane; at most `limit` of them.
 */
export function resolveExtraSectionPlanes(
    planes: readonly SectionPlane[] | undefined,
    boundsMin: Xyz,
    boundsMax: Xyz,
    buildingRotation: number | undefined,
    limit: number,
): ExtraClipPlane[] {
    const out: ExtraClipPlane[] = [];
    for (const plane of planes ?? []) {
        if (!plane.enabled) continue;
        if (out.length >= limit) break;
        const { normal, distance } = resolveSectionPlaneGeometry(plane, boundsMin, boundsMax, buildingRotation);
        out.push({ normal, distance, flipped: plane.flipped === true, ...(plane.id !== undefined ? { id: plane.id } : {}) });
    }
    return out;
}
