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
 * empty space inside its bounds. That matches the precedent already set by the
 * released-geometry raycast path, and over-selection is recoverable by the
 * user in a way that selecting nothing is not.
 */

import { clipIsActive, boxFullyClipped, type BoundingBox } from './scene-raycaster.js';
import type { PickClipState } from './types.js';

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

    for (const [expressId, bbox] of boundingBoxes) {
        if (hiddenIds?.has(expressId)) continue;
        if (isolatedIds !== null && isolatedIds !== undefined && !isolatedIds.has(expressId)) continue;
        if (hasClip && boxFullyClipped(clip, bbox)) continue;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let projected = 0;
        let straddlesCamera = false;

        for (let corner = 0; corner < 8; corner++) {
            const x = (corner & 1) ? bbox.max.x : bbox.min.x;
            const y = (corner & 2) ? bbox.max.y : bbox.min.y;
            const z = (corner & 4) ? bbox.max.z : bbox.min.z;

            // Column-major mat4 * vec4, matching what the pick shader does with
            // the same matrix: `uniforms.viewProj * vec4<f32>(position, 1.0)`.
            const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
            // Behind (or on) the camera plane — the perspective divide is
            // meaningless here, so this corner contributes no screen extent.
            if (!(cw > 1e-6)) {
                straddlesCamera = true;
                continue;
            }
            const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
            const cy = m[1] * x + m[5] * y + m[9] * z + m[13];

            // NDC -> canvas pixels. Y flips: NDC is up-positive, screen is down-positive.
            const sx = ((cx / cw) * 0.5 + 0.5) * viewportWidth;
            const sy = (0.5 - (cy / cw) * 0.5) * viewportHeight;

            if (sx < minX) minX = sx;
            if (sx > maxX) maxX = sx;
            if (sy < minY) minY = sy;
            if (sy > maxY) maxY = sy;
            projected += 1;
        }

        // Entirely behind the camera.
        if (projected === 0) continue;

        // A box crossing the camera plane has no meaningful screen AABB — the
        // corners that did project understate its true extent, so the overlap
        // test below would reject a box the user is standing inside. Count it.
        if (straddlesCamera) {
            hits.add(expressId);
            continue;
        }

        if (maxX < rx0 || minX > rx1 || maxY < ry0 || minY > ry1) continue;
        hits.add(expressId);
    }

    return hits;
}
