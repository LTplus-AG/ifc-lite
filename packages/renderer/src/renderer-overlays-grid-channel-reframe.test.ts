/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3359, consequence 2: "and then it reframes the camera".
 *
 * `renderer-overlays-line-channels.test.ts` already pins that
 * `RendererOverlays.setLineOverlay` applies the RIGHT policy for whichever
 * channel it is told (`annotation`/`alignment` expand the scene bounds and
 * re-sync the camera, `grid`/`dxf` do not). That part of the pipeline is not
 * broken. The bug is upstream: `apps/viewer/src/hooks/useSymbolicAnnotations.ts`
 * used to lift BOTH IfcAnnotation and IfcGridAxis content into one buffer
 * fed to `renderer.setLineOverlay('annotation', …)`, so with annotations off
 * and the grid on, grid-only content reached a channel whose policy is
 * "this content defines the model's extent" — exactly wrong for grid axes,
 * which routinely extend far past the model envelope (issue #967, the same
 * reason `CHANNEL_EXPANDS_MODEL_BOUNDS.grid` is `false`).
 *
 * This test wires a REAL `Camera` + `ModelBoundsTracker` behind
 * `RendererOverlays` (no fakes for those two) and shows the mechanism this
 * misrouting triggers: `camera.getSceneBounds()` — the exact value
 * `apps/viewer/src/components/viewer/useMouseControls.ts` (`anchorBounds ??
 * camera.getSceneBounds()`, ~line 542) and `useTouchControls.ts` (~line 112)
 * fall back to for the orbit pivot when an empty-space drag has no raycast
 * hit, no selection and no robust anchor — swings from the model's own
 * centre to a point dragged toward the far-away grid, silently changing what
 * the next orbit gesture frames around. `useMouseControls.ts`'s own comment
 * on that fallback (~line 536) names the visible symptom directly:
 * "orbiting then swings the model out of frame".
 *
 * The camera starts at a pose distinct from both the real model's centre and
 * the origin, so a pivot that silently snaps to either would be observable
 * here — a fixture already sitting at the framing target cannot see this
 * bug.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Camera } from './camera.js';
import { ModelBoundsTracker } from './model-bounds-tracker.js';
import { RendererOverlays, type OverlayHost } from './renderer-overlays.js';

function centroid(b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) {
  return {
    x: (b.min.x + b.max.x) / 2,
    y: (b.min.y + b.max.y) / 2,
    z: (b.min.z + b.max.z) / 2,
  };
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

/** Real model geometry: a compact 10x10x10 box centred at (5, 0, 5). */
const REAL_MODEL_BOUNDS = { min: { x: 0, y: -5, z: 0 }, max: { x: 10, y: 5, z: 10 } };

/** A grid axis line that — per the issue — "routinely extends well past the
 *  model envelope": entirely outside REAL_MODEL_BOUNDS, and off to one side
 *  (not straddling the model's centre) so folding it in visibly drags the
 *  combined centroid rather than leaving it coincidentally unchanged. */
const GRID_ONLY_VERTS = new Float32Array([1000, 500, 5, 1500, 500, 5]);

function makeHarness() {
    const camera = new Camera();
    // A pose distinct from both the model's centre (5, 0, 5) and the origin,
    // so a pivot silently snapping to either is observable.
    camera.setPosition(-300, 120, 900);
    camera.setTarget(40, 15, -60);

    const modelBoundsTracker = new ModelBoundsTracker({
        meshBounds: () => REAL_MODEL_BOUNDS,
        pointCloudBounds: () => null,
    });
    modelBoundsTracker.recompute();
    // Seed the camera's scene bounds the way `Renderer` does on mesh load,
    // BEFORE any overlay upload — this is the "real model already framed"
    // starting state the bug then disturbs.
    camera.setSceneBounds(modelBoundsTracker.get());

    const host: OverlayHost = {
        getModelBounds: () => modelBoundsTracker.get(),
        expandModelBoundsWithFlatVertices: (positions, stride) =>
            modelBoundsTracker.expandWithFlatVertices(positions, stride),
        syncCameraSceneBounds: () => {
            const b = modelBoundsTracker.get();
            if (b) camera.setSceneBounds(b);
        },
        requestRender: () => { /* no-op */ },
    };

    const overlays = new RendererOverlays(host);
    const fakeRenderer = {
        setLineOverlay() { /* no-op: this test only cares about bounds/camera fallout */ },
        setOverlayLineColor() { /* no-op */ },
    };
    (overlays as unknown as Record<string, unknown>)['section2DOverlayRenderer'] = fakeRenderer;

    return { camera, overlays };
}

describe('grid-only content reaching the wrong channel reframes the camera (issue #3359)', () => {
    it('BUG: routed to "annotation" (today\'s wiring), grid-only content drags the orbit-pivot fallback off the real model, toward the grid', () => {
        const { camera, overlays } = makeHarness();
        const before = camera.getSceneBounds();
        assert.ok(before, 'precondition: the real model already seeded scene bounds');
        const pivotBefore = centroid(before!);
        assert.deepStrictEqual(pivotBefore, { x: 5, y: 0, z: 5 }, 'precondition: pivot starts at the real model centre');

        // Today's wiring: `useSymbolicAnnotations` puts grid content on the
        // SAME buffer as annotations, uploaded to the 'annotation' channel.
        overlays.setLineOverlay('annotation', GRID_ONLY_VERTS);

        const after = camera.getSceneBounds();
        assert.ok(after);
        const pivotAfter = centroid(after!);

        // The grid line's own X range is [-500, 500], centred on 0 — the
        // scene bounds fold the model's [0,10] into it, so the combined
        // centroid lands far from the model's own (5, 0, 5).
        assert.ok(
            dist(pivotBefore, pivotAfter) > 100,
            `the empty-space orbit-pivot fallback (camera.getSceneBounds() centroid) moved from ` +
            `(${pivotBefore.x}, ${pivotBefore.y}, ${pivotBefore.z}) to ` +
            `(${pivotAfter.x}, ${pivotAfter.y}, ${pivotAfter.z}) — a grid-only upload on the ` +
            `'annotation' channel reframes empty-space orbit around the grid instead of the model`,
        );
    });

    it('FIXED: routed to "grid", the same content leaves the orbit-pivot fallback exactly on the real model', () => {
        const { camera, overlays } = makeHarness();
        const before = centroid(camera.getSceneBounds()!);

        // The fix: `useSymbolicAnnotations` returns `{ annotation, grid }`
        // separately, and the grid buffer is uploaded to the 'grid' channel.
        overlays.setLineOverlay('grid', GRID_ONLY_VERTS);

        const after = centroid(camera.getSceneBounds()!);
        assert.deepStrictEqual(
            after,
            before,
            'the grid channel must not move the orbit-pivot fallback at all (CHANNEL_EXPANDS_MODEL_BOUNDS.grid is false)',
        );
    });
});
