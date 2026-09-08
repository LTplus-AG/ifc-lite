/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU rectangle selection against bounding-box data.
 *
 * The rect analogue of `raycastBoundingBoxes` in `scene-raycaster.ts`, and it
 * exists for the same reason: on a batched model the GPU pick pass only sees
 * individually hydrated meshes, and hydrating every visible piece is too
 * expensive past a few hundred entities. `pick()` has always had a CPU escape
 * hatch for that case; rectangle select had none, which is why it returned an
 * empty set on batched models (#1904).
 *
 * Granularity: bounding box, not triangle. A box whose screen-space AABB
 * overlaps the rect counts as selected, so this over-selects relative to the
 * pixel-exact GPU path — an entity can be picked when the rect covers only
 * empty space inside its bounds. That granularity is the same one the
 * released-geometry raycast path already has (`raycastBoundingBoxes` also tests
 * boxes, not triangles), and over-selection is recoverable by the user in a way
 * that selecting nothing is not.
 *
 * Two further gaps are NOT shared with that path, and both over-select. There is
 * no depth test at all here, so an entity fully occluded by another is still
 * selected, whereas the raycast keeps only the nearest box (`tNear <
 * closestDistance`). And section-plane / crop-box filtering is whole-box: the
 * `boxFullyClipped` call below skips an entity only when nothing of its box
 * could be visible, so a rect over the sectioned-away half of a box still
 * selects it — the raycast measures entry into the *visible* part of the box
 * (`clippedBoxEntryDistance`), and the pick shader discards per fragment.
 */

import { clipIsActive, boxFullyClipped, type BoundingBox } from './scene-raycaster.js';
import type { PickClipState } from './types.js';

/**
 * The 12 AABB edges as pairs of corner indices, flat. A corner index encodes
 * which extreme it takes per axis: bit 0 = x, bit 1 = y, bit 2 = z, matching the
 * `corner & 1 / & 2 / & 4` decode below. An edge joins two corners that differ
 * in exactly one axis bit.
 */
const EDGE_CORNERS = new Uint8Array([
    // along x
    0, 1, 2, 3, 4, 5, 6, 7,
    // along y
    0, 2, 1, 3, 4, 6, 5, 7,
    // along z
    0, 4, 1, 5, 2, 6, 3, 7,
]);

/** Selection rectangle in canvas (device) pixels. Corners may be in any order. */
export interface ScreenRect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/**
 * Every entity whose bounding box projects onto the given screen rect.
 *
 * @param boundingBoxes  World-space AABB per expressId
 * @param viewProj       Camera view-projection, column-major (see below)
 * @param rect           Selection rect in canvas pixels
 * @param viewportWidth  Canvas width in pixels
 * @param viewportHeight Canvas height in pixels
 * @param hiddenIds      Skipped entirely
 * @param isolatedIds    When non-null, only these ids are considered
 * @param clip           Active section plane / crop box, so selection matches
 *                       what is visible (same contract as the raycast paths)
 */
export function selectBoundingBoxesInRect(
    boundingBoxes: Map<number, BoundingBox>,
    viewProj: Float32Array,
    rect: ScreenRect,
    viewportWidth: number,
    viewportHeight: number,
    hiddenIds?: Set<number>,
    isolatedIds?: Set<number> | null,
    clip?: PickClipState | null,
): Set<number> {
    const hits = new Set<number>();
    // A zero-sized canvas would divide the whole scene onto one texel.
    if (!(viewportWidth > 0) || !(viewportHeight > 0)) return hits;

    const rx0 = Math.min(rect.x0, rect.x1);
    const rx1 = Math.max(rect.x0, rect.x1);
    const ry0 = Math.min(rect.y0, rect.y1);
    const ry1 = Math.max(rect.y0, rect.y1);
    const hasClip = clipIsActive(clip);
    const m = viewProj;

    // Per-corner clip-space scratch, allocated once per call and refilled per
    // entity so the hot loop stays allocation-free.
    const cwArr = new Float64Array(8);
    const cxArr = new Float64Array(8);
    const cyArr = new Float64Array(8);
    // Signed distances to the two depth-clip half-spaces, >= 0 meaning inside.
    const dNear = new Float64Array(8);
    const dFar = new Float64Array(8);

    for (const [expressId, bbox] of boundingBoxes) {
        if (hiddenIds?.has(expressId)) continue;
        if (isolatedIds !== null && isolatedIds !== undefined && !isolatedIds.has(expressId)) continue;
        if (hasClip && boxFullyClipped(clip, bbox)) continue;

        let allInside = true;

        for (let corner = 0; corner < 8; corner++) {
            const x = (corner & 1) ? bbox.max.x : bbox.min.x;
            const y = (corner & 2) ? bbox.max.y : bbox.min.y;
            const z = (corner & 4) ? bbox.max.z : bbox.min.z;

            // Column-major mat4 * vec4, matching what the pick shader does with
            // the same matrix: `uniforms.viewProj * vec4<f32>(position, 1.0)`.
            const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
            const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
            cwArr[corner] = cw;
            cxArr[corner] = m[0] * x + m[4] * y + m[8] * z + m[12];
            cyArr[corner] = m[1] * x + m[5] * y + m[9] * z + m[13];

            // This renderer projects reverse-Z into the WebGPU depth range: a
            // rasterised fragment has ndc z = cz/cw in [0, 1], 1 at the near
            // plane and 0 at the far plane (MathUtils.perspectiveReverseZ /
            // orthographicReverseZ). The clip-space form of those two bounds —
            // what the GPU itself clips against, before any divide — is
            // cz <= cw and cz >= 0. Both are linear in the world position, so
            // they are ordinary half-spaces and the box can be clipped against
            // them here too.
            const near = cw - cz;
            dNear[corner] = near;
            dFar[corner] = cz;
            if (near < 0 || cz < 0) allInside = false;
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let projected = false;

        if (allInside) {
            // Whole box inside the depth range — every corner divides safely, so
            // the screen AABB is just the AABB of the eight projected corners.
            for (let corner = 0; corner < 8; corner++) {
                const cw = cwArr[corner];
                if (!(cw > 1e-6)) continue;
                // NDC -> canvas pixels. Y flips: NDC is up-positive, screen is down-positive.
                const sx = ((cxArr[corner] / cw) * 0.5 + 0.5) * viewportWidth;
                const sy = (0.5 - (cyArr[corner] / cw) * 0.5) * viewportHeight;
                if (sx < minX) minX = sx;
                if (sx > maxX) maxX = sx;
                if (sy < minY) minY = sy;
                if (sy > maxY) maxY = sy;
                projected = true;
            }
        } else {
            // The box crosses a depth-clip plane, so the min/max of its projected
            // corners is not its screen extent: corners with cw <= 0 project to
            // garbage and corners outside the slab were never drawn. Clip first.
            //
            // The visible region is the box intersected with the depth slab
            // (near and far are parallel planes, so the slab has no edges of its
            // own). Every vertex of that intersection therefore lies on a box
            // edge, and inside the slab cw > 0 holds throughout, so the
            // perspective divide is a projective map and the screen extent is
            // the AABB of the projected vertices. Clipping each of the 12 edges
            // to the slab and projecting the surviving endpoints enumerates
            // exactly those vertices.
            for (let e = 0; e < EDGE_CORNERS.length; e += 2) {
                const a = EDGE_CORNERS[e];
                const b = EDGE_CORNERS[e + 1];

                // Narrow the edge parameter t to where both half-space distances,
                // which are linear along the edge, are >= 0.
                let t0 = 0, t1 = 1;
                let outside = false;
                for (let plane = 0; plane < 2 && !outside; plane++) {
                    const d = plane === 0 ? dNear : dFar;
                    const dA = d[a];
                    const delta = d[b] - dA;
                    if (delta === 0) {
                        // Constant along the edge: either wholly in or wholly out.
                        if (dA < 0) outside = true;
                    } else if (delta > 0) {
                        const t = -dA / delta; // distance crosses zero here, rising
                        if (t > t0) t0 = t;
                    } else {
                        const t = -dA / delta; // ... falling
                        if (t < t1) t1 = t;
                    }
                }
                if (outside || t0 > t1) continue;

                for (let end = 0; end < 2; end++) {
                    const t = end === 0 ? t0 : t1;
                    const cw = cwArr[a] + (cwArr[b] - cwArr[a]) * t;
                    if (!(cw > 1e-6)) continue;
                    const cx = cxArr[a] + (cxArr[b] - cxArr[a]) * t;
                    const cy = cyArr[a] + (cyArr[b] - cyArr[a]) * t;
                    const sx = ((cx / cw) * 0.5 + 0.5) * viewportWidth;
                    const sy = (0.5 - (cy / cw) * 0.5) * viewportHeight;
                    if (sx < minX) minX = sx;
                    if (sx > maxX) maxX = sx;
                    if (sy < minY) minY = sy;
                    if (sy > maxY) maxY = sy;
                    projected = true;
                }
            }
        }

        // Nothing survived the depth clip: behind the camera, nearer than the
        // near plane, or beyond the far plane — the GPU rect pass never saw it.
        if (!projected) continue;

        if (maxX < rx0 || minX > rx1 || maxY < ry0 || minY > ry1) continue;
        hits.add(expressId);
    }

    return hits;
}
