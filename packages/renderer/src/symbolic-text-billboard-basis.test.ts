/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import { SymbolicOverlays } from './renderer-symbolic-overlays.js';
import { viewBasis } from './math.js';

/**
 * The billboard basis the world-space text labels (grid bubble tags) are
 * oriented by must come from `viewBasis` — the same derivation the frame's
 * view matrix is built from (#2489, closing the drift #2467 closed for the
 * unprojection ray).
 *
 * The copy that used to live inline in `SymbolicOverlays.drawTexts` computed
 * `cross(forward, up)` itself and guarded only its two DIVISORS, with
 * `Math.hypot(...) || 1`. That leaves two whole classes of pose broken:
 *
 *   • A non-finite coordinate anywhere in the pose poisoned the NUMERATORS,
 *     so `right`/`up` came out all-NaN and went into the text pipeline's
 *     uniform. `camera.setPosition/setTarget/setUp` take their arguments
 *     verbatim on purpose (the pose is raw public state that BCF viewpoint
 *     restore writes), so this is reachable through the public API.
 *   • `eye === target`, and an `up` parallel to the view direction (a plan
 *     pose, or a restored viewpoint), are perfectly FINITE degeneracies that
 *     the `|| 1` guard let through as a zero-length `right`/`up` — which
 *     collapses every glyph quad to a point. A finiteness assertion alone
 *     would not catch these; the length assertions below do.
 *
 * Every case asserts the VALUES handed to the pipeline. "Did not throw" is
 * exactly the assertion that cannot catch either failure: NaN and zero-length
 * axes both draw quietly.
 */

type Axis = readonly [number, number, number];

/** Captures the two axes `drawTexts` hands the text pipeline. */
function captureBillboardAxes(camera: Camera): { right: Axis; up: Axis } {
    let captured: { right: Axis; up: Axis } | null = null;
    const overlays = new SymbolicOverlays({
        expandModelBoundsWithFlatVertices: () => {},
        syncCameraSceneBounds: () => {},
        requestRender: () => {},
    });
    // The pipeline is a pure sink here: it owns GPU objects this test has no
    // device for, and the only thing under test is what it is handed.
    (overlays as unknown as { textPipeline: unknown }).textPipeline = {
        hasGeometry: () => true,
        render: (
            _pass: unknown,
            _viewProj: Float32Array,
            _w: number,
            _h: number,
            right: Axis,
            up: Axis,
        ) => { captured = { right, up }; },
    };
    overlays.drawTexts(
        null as unknown as GPURenderPassEncoder,
        new Float32Array(16),
        800,
        600,
        camera,
    );
    assert.ok(captured, 'drawTexts must have reached the text pipeline');
    return captured!;
}

function poseCamera(
    position: [number, number, number],
    target: [number, number, number],
    up: [number, number, number],
): Camera {
    const camera = new Camera();
    camera.setPosition(...position);
    camera.setTarget(...target);
    camera.setUp(...up);
    return camera;
}

function assertUnit(axis: Axis, label: string): void {
    for (const [i, c] of axis.entries()) {
        assert.ok(Number.isFinite(c), `${label}[${i}] reached the uniform as ${c}`);
    }
    const len = Math.hypot(axis[0], axis[1], axis[2]);
    assert.ok(
        Math.abs(len - 1) < 1e-9,
        `${label} must be unit length so the glyph quad has extent, got |${label}| = ${len}`,
    );
}

/** The axes must be the ones the view matrix was built from, not merely valid. */
function assertMatchesViewBasis(camera: Camera, axes: { right: Axis; up: Axis }): void {
    const basis = viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp());
    assert.deepStrictEqual(
        [axes.right[0] + 0, axes.right[1] + 0, axes.right[2] + 0],
        [basis.right.x + 0, basis.right.y + 0, basis.right.z + 0],
    );
    assert.deepStrictEqual(
        [axes.up[0] + 0, axes.up[1] + 0, axes.up[2] + 0],
        [basis.up.x + 0, basis.up.y + 0, basis.up.z + 0],
    );
}

describe('the symbolic text billboard basis comes from viewBasis (#2489)', () => {
    it('is the view basis for an ordinary pose', () => {
        const camera = poseCamera([50, 50, 100], [0, 0, 0], [0, 1, 0]);
        const axes = captureBillboardAxes(camera);
        assertUnit(axes.right, 'right');
        assertUnit(axes.up, 'up');
        assertMatchesViewBasis(camera, axes);
    });

    it('survives an Infinity in the camera position', () => {
        const camera = poseCamera([Infinity, 10, 10], [0, 0, 0], [0, 1, 0]);
        const axes = captureBillboardAxes(camera);
        assertUnit(axes.right, 'right');
        assertUnit(axes.up, 'up');
        assertMatchesViewBasis(camera, axes);
    });

    it('survives a NaN in the camera target', () => {
        const camera = poseCamera([10, 10, 10], [NaN, 0, 0], [0, 1, 0]);
        const axes = captureBillboardAxes(camera);
        assertUnit(axes.right, 'right');
        assertUnit(axes.up, 'up');
    });

    it('survives an Infinity in the up vector', () => {
        const camera = poseCamera([10, 10, 10], [0, 0, 0], [0, Infinity, 0]);
        const axes = captureBillboardAxes(camera);
        assertUnit(axes.right, 'right');
        assertUnit(axes.up, 'up');
    });

    it('gives a plan pose real axes instead of collapsing the glyphs', () => {
        // `up` parallel to the view direction: finite, so no finiteness guard
        // would have caught it, and the old `|| 1` divisor guard returned
        // `right = up = [0,0,0]`.
        const camera = poseCamera([0, 10, 0], [0, 0, 0], [0, 1, 0]);
        const axes = captureBillboardAxes(camera);
        assertUnit(axes.right, 'right');
        assertUnit(axes.up, 'up');
        assertMatchesViewBasis(camera, axes);
    });

    it('gives an eye-equals-target pose real axes', () => {
        const camera = poseCamera([7, 7, 7], [7, 7, 7], [0, 1, 0]);
        const axes = captureBillboardAxes(camera);
        assertUnit(axes.right, 'right');
        assertUnit(axes.up, 'up');
        assertMatchesViewBasis(camera, axes);
    });

    it('keeps right, up and the view direction mutually orthogonal', () => {
        // Anti-mutation: a guard that simply substituted a constant pair for
        // every "suspicious" pose would satisfy the finiteness and unit-length
        // assertions above while silently ignoring the camera. These pin the
        // axes to the actual pose.
        const camera = poseCamera([30, 20, 40], [1, 2, 3], [0.1, 0.9, 0.2]);
        const { right, up } = captureBillboardAxes(camera);
        const basis = viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp());
        const dot = (a: Axis, b: readonly [number, number, number]) =>
            a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const fwd = [basis.forward.x, basis.forward.y, basis.forward.z] as const;
        assert.ok(Math.abs(dot(right, up)) < 1e-12, 'right . up');
        assert.ok(Math.abs(dot(right, fwd)) < 1e-12, 'right . forward');
        assert.ok(Math.abs(dot(up, fwd)) < 1e-12, 'up . forward');
        // Looking down -X/-Z from above, screen-right runs +X/-Z. A constant
        // substitute (or a swapped right/up) would not land here.
        assert.ok(right[0] > 0.5 && right[2] < -0.5,
            `right must follow the pose, got ${right.join(',')}`);
        assert.ok(up[1] > 0.5, `up must follow the pose, got ${up.join(',')}`);
    });
});
