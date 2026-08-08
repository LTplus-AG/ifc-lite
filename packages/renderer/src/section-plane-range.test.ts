/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveSectionPlaneFrame, projectedBoundsRange } from './render-section-plane.js';
import type { BatchedMesh, RenderOptions, SectionPlaneAxis } from './types.js';

/**
 * The section slider's distance range on a ROTATED building (issue #2447).
 *
 * The shader clips on `dot(worldPos, normal) = distance`. `buildingRotation`
 * rotates the cardinal normal but the range used to be read off one axis of the
 * AABB, which is a different quantity the moment the normal stops being that
 * unit axis: the slider then travels a shorter span than the model occupies
 * along the direction it actually cuts, so both ends of travel leave a wedge of
 * geometry the plane can never reach.
 *
 * The oracle throughout is the issue's measured case: a 40 x 10 x 20 bbox cut
 * on `side`. At 0 degrees the true range is -20..20 (and must stay bit-identical
 * — the whole safety argument for the change); at 45 degrees it is
 * -21.213..21.213, a 2.426-unit shortfall the old code did not cover.
 */

/** The issue's measured bbox: min [-20,0,-10], max [20,10,10]. */
const BOUNDS_MIN: [number, number, number] = [-20, 0, -10];
const BOUNDS_MAX: [number, number, number] = [20, 10, 10];

function batchWithBounds(
    min: [number, number, number] = BOUNDS_MIN,
    max: [number, number, number] = BOUNDS_MAX,
): BatchedMesh {
    // Only `bounds` is read by resolveSectionPlaneFrame; the GPU handles never
    // leave the struct, so a bounds-only shell is the honest fixture here.
    return { bounds: { min, max } } as unknown as BatchedMesh;
}

interface FrameArgs {
    axis: SectionPlaneAxis;
    position: number;
    buildingRotation?: number;
    min?: number;
    max?: number;
    bounds?: { min: [number, number, number]; max: [number, number, number] };
}

function resolve(args: FrameArgs) {
    const sectionPlane: NonNullable<RenderOptions['sectionPlane']> = {
        axis: args.axis,
        position: args.position,
        enabled: true,
    };
    if (args.min !== undefined) sectionPlane.min = args.min;
    if (args.max !== undefined) sectionPlane.max = args.max;

    const options: RenderOptions = { sectionPlane };
    if (args.buildingRotation !== undefined) options.buildingRotation = args.buildingRotation;

    return resolveSectionPlaneFrame({
        options,
        batchedMeshes: [batchWithBounds(args.bounds?.min, args.bounds?.max)],
        meshes: [],
        pointCloudBounds: null,
        logSectionBounds: false,
        spendLogLatch: () => { throw new Error('latch must not be spent when logSectionBounds is false'); },
    });
}

/**
 * The quantity the plane distance has to span, computed independently of the
 * code under test: the extreme values of `dot(corner, normal)` over the eight
 * bbox corners.
 */
function trueRangeAlong(normal: readonly [number, number, number]): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const x of [BOUNDS_MIN[0], BOUNDS_MAX[0]]) {
        for (const y of [BOUNDS_MIN[1], BOUNDS_MAX[1]]) {
            for (const z of [BOUNDS_MIN[2], BOUNDS_MAX[2]]) {
                const d = x * normal[0] + y * normal[1] + z * normal[2];
                min = Math.min(min, d);
                max = Math.max(max, d);
            }
        }
    }
    return { min, max };
}

describe('section slider range on a rotated building (#2447)', () => {
    it('spans -20..20 for an unrotated side cut, exactly as before', () => {
        // The regression guard on the fix itself: unrotated models must be
        // bit-identical, which is what makes the projection a safe swap.
        const atZero = resolve({ axis: 'side', position: 0 });
        const atFull = resolve({ axis: 'side', position: 100 });

        assert.deepStrictEqual(atZero.sectionPlaneData?.normal, [1, 0, 0]);
        assert.strictEqual(atZero.sectionPlaneData?.distance, -20);
        assert.strictEqual(atFull.sectionPlaneData?.distance, 20);
    });

    it('spans the PROJECTED -21.213..21.213 for a 45-degree side cut', () => {
        // The measured defect. Before the fix both ends read -20 / 20 — short by
        // 1.213 at each end, so the model kept a wedge that never clipped.
        const rot = Math.PI / 4;
        const atZero = resolve({ axis: 'side', position: 0, buildingRotation: rot });
        const atFull = resolve({ axis: 'side', position: 100, buildingRotation: rot });

        const normal = atZero.sectionPlaneData!.normal;
        assert.ok(Math.abs(normal[0] - Math.SQRT1_2) < 1e-12, 'precondition: the normal really is rotated');
        assert.ok(Math.abs(normal[2] - Math.SQRT1_2) < 1e-12);

        assert.ok(
            Math.abs(atZero.sectionPlaneData!.distance - -21.213203435596427) < 1e-9,
            `slider 0% must reach -21.2132, got ${atZero.sectionPlaneData!.distance}`,
        );
        assert.ok(
            Math.abs(atFull.sectionPlaneData!.distance - 21.213203435596427) < 1e-9,
            `slider 100% must reach 21.2132, got ${atFull.sectionPlaneData!.distance}`,
        );
    });

    it('reaches every corner of the model at both ends of travel, at any rotation', () => {
        // The user-visible property, stated as an invariant rather than a
        // number: at 0% no corner may sit below the plane and at 100% none
        // above it, or the slider cannot fully clear / fully reveal the model.
        for (const deg of [0, 15, 30, 45, 60, 90, 137, 200, 315]) {
            const rot = (deg * Math.PI) / 180;
            const atZero = resolve({ axis: 'side', position: 0, buildingRotation: rot });
            const atFull = resolve({ axis: 'side', position: 100, buildingRotation: rot });
            const expected = trueRangeAlong(atZero.sectionPlaneData!.normal);

            assert.ok(
                Math.abs(atZero.sectionPlaneData!.distance - expected.min) < 1e-9,
                `at ${deg} degrees the slider's 0% must sit at the model's near extreme`,
            );
            assert.ok(
                Math.abs(atFull.sectionPlaneData!.distance - expected.max) < 1e-9,
                `at ${deg} degrees the slider's 100% must sit at the model's far extreme`,
            );
        }
    });

    it('leaves a horizontal (down) cut on the Y extent at any rotation', () => {
        // A Y-axis building rotation leaves [0,1,0] fixed, so the projection has
        // to collapse back to the plain Y extent — the control that proves the
        // projection is not just "always bigger".
        const atZero = resolve({ axis: 'down', position: 0, buildingRotation: Math.PI / 4 });
        const atFull = resolve({ axis: 'down', position: 100, buildingRotation: Math.PI / 4 });
        assert.deepStrictEqual(atZero.sectionPlaneData?.normal, [0, 1, 0]);
        assert.strictEqual(atZero.sectionPlaneData?.distance, 0);
        assert.strictEqual(atFull.sectionPlaneData?.distance, 10);
    });
});

describe('the storey override keeps its axis-aligned units (#2447)', () => {
    it('still honours a valid override on an unrotated model', () => {
        // Unchanged behaviour, and the control for the carve-out below: without
        // it, "the override was skipped" could pass because overrides never work.
        const r = resolve({ axis: 'down', position: 0, min: 3, max: 7 });
        assert.strictEqual(r.sectionPlaneData?.distance, 3);
        const mid = resolve({ axis: 'down', position: 50, min: 3, max: 7 });
        assert.strictEqual(mid.sectionPlaneData?.distance, 5);
    });

    it('honours it for a horizontal cut even when the building is rotated', () => {
        // `axis: 'down'` keeps normal [0,1,0] under a Y rotation, so a
        // storey elevation IS the plane distance and the override is meaningful.
        const r = resolve({ axis: 'down', position: 100, min: 3, max: 7, buildingRotation: Math.PI / 4 });
        assert.strictEqual(r.sectionPlaneData?.distance, 7);
    });

    it('skips it for a rotated vertical cut rather than mixing units', () => {
        // -18..18 lies inside the projected -21.213..21.213 range, so the old
        // containment check would accept it — and then interpolate a
        // Y-up-elevation-flavoured number as a distance along a tilted normal.
        // The full projected range must stand instead.
        const rot = Math.PI / 4;
        const atFull = resolve({ axis: 'side', position: 100, min: -18, max: 18, buildingRotation: rot });
        assert.ok(
            Math.abs(atFull.sectionPlaneData!.distance - 21.213203435596427) < 1e-9,
            `an override in the wrong units must be ignored, got ${atFull.sectionPlaneData!.distance}`,
        );
    });
});

describe('projectedBoundsRange (#2447)', () => {
    it('collapses to the plain axis extent for each unit axis', () => {
        const min = { x: -20, y: 0, z: -10 };
        const max = { x: 20, y: 10, z: 10 };
        assert.deepStrictEqual(projectedBoundsRange(min, max, [1, 0, 0]), { min: -20, max: 20 });
        assert.deepStrictEqual(projectedBoundsRange(min, max, [0, 1, 0]), { min: 0, max: 10 });
        assert.deepStrictEqual(projectedBoundsRange(min, max, [0, 0, 1]), { min: -10, max: 10 });
    });

    it('reports the diagonal extent for a 45-degree normal', () => {
        const r = projectedBoundsRange(
            { x: -20, y: 0, z: -10 },
            { x: 20, y: 10, z: 10 },
            [Math.SQRT1_2, 0, Math.SQRT1_2],
        );
        assert.ok(Math.abs(r.max - r.min - 42.42640687119285) < 1e-9, `expected 42.4264 span, got ${r.max - r.min}`);
    });
});
