/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveSectionPlaneFrame } from './render-section-plane.js';
import type { BatchedMesh, RenderOptions } from './types.js';

/**
 * Non-finite explicit section planes (issue #2442).
 *
 * `SectionPlane.normal` / `.distance` are caller-supplied public `RenderOptions`
 * surface (the face-pick / arbitrary-plane path from #243). Only `distance` was
 * checked for finiteness: an `Infinity` component made `len` infinite, and
 * because `Infinity > 1e-6` is TRUE the normalisation ran anyway and produced
 * `normal = [NaN, NaN, NaN]`, `distance = 0` — written straight into the
 * shader's clip uniform AND into `_activePickSection`, so the drawn frame and
 * the GPU pick both mirrored a garbage plane.
 *
 * These assert the resolved VALUES, not that nothing threw: NaN propagates
 * perfectly quietly, so "did not throw" is exactly the assertion that cannot
 * catch this bug.
 */

const BOUNDS_MIN: [number, number, number] = [-20, 0, -10];
const BOUNDS_MAX: [number, number, number] = [20, 10, 10];

function batch(): BatchedMesh {
    return { bounds: { min: BOUNDS_MIN, max: BOUNDS_MAX } } as unknown as BatchedMesh;
}

function resolveExplicit(normal: [number, number, number], distance: number) {
    const options: RenderOptions = {
        sectionPlane: { axis: 'side', position: 50, enabled: true, normal, distance },
    };
    return resolveSectionPlaneFrame({
        options,
        batchedMeshes: [batch()],
        meshes: [],
        pointCloudBounds: null,
        logSectionBounds: false,
        spendLogLatch: () => { throw new Error('latch must not be spent'); },
    }).sectionPlaneData;
}

/** Every number the frame hands the shader must be a real number. */
function assertFinitePlane(data: { normal: [number, number, number]; distance: number } | undefined) {
    assert.ok(data, 'a plane must still be produced');
    for (const [i, c] of data!.normal.entries()) {
        assert.ok(Number.isFinite(c), `normal[${i}] reached the clip uniform as ${c}`);
    }
    assert.ok(Number.isFinite(data!.distance), `distance reached the clip uniform as ${data!.distance}`);
}

describe('an explicit plane with a non-finite normal never reaches the shader (#2442)', () => {
    it('degrades an Infinity component to the cardinal-axis preset', () => {
        const data = resolveExplicit([Infinity, 0, 0], 5);
        assertFinitePlane(data);
        // `axis: 'side'` at 50% over the -20..20 X extent.
        assert.deepStrictEqual(data!.normal, [1, 0, 0]);
        assert.strictEqual(data!.distance, 0);
    });

    it('degrades a NaN component to the same preset', () => {
        // NaN already fell through to a fallback (`NaN > 1e-6` is false), but to
        // the [0,1,0] one — a HORIZONTAL plane for a vertical `side` cut, with
        // the caller's distance kept. Rejecting the plane outright is the
        // consistent answer for both bad-input shapes.
        const data = resolveExplicit([0, NaN, 0], 5);
        assertFinitePlane(data);
        assert.deepStrictEqual(data!.normal, [1, 0, 0]);
        assert.strictEqual(data!.distance, 0);
    });

    it('degrades a non-finite distance to the preset as well', () => {
        const data = resolveExplicit([1, 0, 0], Infinity);
        assertFinitePlane(data);
        assert.deepStrictEqual(data!.normal, [1, 0, 0]);
        assert.strictEqual(data!.distance, 0);
    });

    it('degrades a finite normal whose LENGTH overflows to the [0,1,0] fallback', () => {
        // The half a component-wise finiteness check cannot cover: 1e200 is a
        // finite number, but 1e200^2 is Infinity, so `len` overflows, passes
        // `len > 1e-6`, and the normalisation yields normal [0,0,0] with
        // distance 0 — a plane with no orientation at all.
        const data = resolveExplicit([1e200, 0, 0], 5);
        assertFinitePlane(data);
        assert.deepStrictEqual(data!.normal, [0, 1, 0], 'the documented degenerate-length fallback');
        assert.strictEqual(data!.distance, 5);
    });

    it('still takes the [0,1,0] fallback for a zero-length normal', () => {
        // Unchanged behaviour, and the control that proves the length branch is
        // still reachable rather than short-circuited by the new guard.
        const data = resolveExplicit([0, 0, 0], 5);
        assert.deepStrictEqual(data!.normal, [0, 1, 0]);
        assert.strictEqual(data!.distance, 5);
    });

    it('still uses a valid explicit plane verbatim, renormalised', () => {
        // The control for every assertion above: without it, "the explicit plane
        // was rejected" would pass for a build in which explicit planes never
        // work at all.
        const data = resolveExplicit([0, 0, 2], 8);
        assert.deepStrictEqual(data!.normal, [0, 0, 1]);
        assert.strictEqual(data!.distance, 4);
    });
});
