/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { SectionPlaneRenderer } from './section-plane.js';

/**
 * The face-picked section gizmo's quad is the SECOND consumer of
 * `RenderOptions.sectionPlane.normal`, and it never got the guard the first
 * one did (#2489).
 *
 * #2442 closed the non-finite normal for the clip uniform, but it did so in
 * `resolveSectionPlaneFrame`. `drawSectionOverlays` does not read that
 * resolved frame — it forwards `options.sectionPlane.normal` raw to
 * `SectionPlaneRenderer.draw`, whose own length check was `nlen < 1e-6`. That
 * is false for a NaN length AND for an infinite one, so a non-finite
 * component fell through to `nx /= nlen` and every one of the 30 floats
 * written into the gizmo's vertex buffer came out NaN.
 *
 * The asymmetry is worth naming: `draw()` already screens the sibling field
 * with `Number.isFinite(distance)` before taking this branch at all, which is
 * why `distance` needs no guard here and gets no test here — a second check
 * would be a guard no mutation of could fail. `normal` had no such screen
 * anywhere on this path.
 *
 * These assert the floats. The renderer never validates a vertex buffer, so
 * "did not throw" cannot catch this: the quad simply vanishes, or the driver
 * draws something arbitrary.
 */

const BOUNDS = { min: { x: -20, y: 0, z: -10 }, max: { x: 20, y: 10, z: 10 } };

/**
 * `calculatePlaneVerticesFromNormal` is a pure function of its three
 * arguments — it touches no GPU object and no instance field — so it can be
 * exercised on a bare prototype. Reaching it through `draw()` instead would
 * need a `GPUDevice`, three pipelines and a render pass, none of which
 * participate in the arithmetic under test.
 */
function quadFor(normal: [number, number, number], distance = 5): Float32Array {
    const bare = Object.create(SectionPlaneRenderer.prototype) as {
        calculatePlaneVerticesFromNormal(
            normal: [number, number, number],
            distance: number,
            bounds: typeof BOUNDS,
        ): Float32Array;
    };
    return bare.calculatePlaneVerticesFromNormal(normal, distance, BOUNDS);
}

/** Six vertices of five floats: x, y, z, u, v. */
const QUAD_FLOATS = 30;

describe('the section gizmo quad never carries a non-finite vertex (#2489)', () => {
    it('drops the quad for an Infinity component instead of writing NaN', () => {
        const quad = quadFor([Infinity, 0, 0]);
        assert.strictEqual(quad.length, QUAD_FLOATS);
        assert.deepStrictEqual(Array.from(quad), new Array(QUAD_FLOATS).fill(0));
    });

    it('drops the quad for a NaN component', () => {
        assert.deepStrictEqual(
            Array.from(quadFor([0, NaN, 0])),
            new Array(QUAD_FLOATS).fill(0),
        );
    });

    it('drops the quad for a finite normal whose magnitude overflows', () => {
        assert.deepStrictEqual(
            Array.from(quadFor([1.7e308, 1.7e308, 0])),
            new Array(QUAD_FLOATS).fill(0),
        );
    });

    it('still draws a real quad for an ordinary picked face', () => {
        // Anti-mutation: the guard rejects unusable normals, not small ones.
        // A floor widened past the caller's magnitudes would silently blank
        // the violet preview quad on every face pick, and this is what catches
        // it. `1e-6` is the smallest length the guard still accepts.
        for (const normal of [
            [0, 1, 0],
            [0.6, 0.5, 0.62],
            [1e-6, 0, 0],
        ] as Array<[number, number, number]>) {
            const quad = quadFor(normal);
            assert.ok(
                Array.from(quad).some((v) => v !== 0),
                `normal ${normal.join(',')} must still produce a quad`,
            );
            for (const v of quad) {
                assert.ok(Number.isFinite(v), `vertex float reached the buffer as ${v}`);
            }
        }
    });
});
