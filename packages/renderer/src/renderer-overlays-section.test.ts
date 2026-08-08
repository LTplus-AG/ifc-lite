/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RendererOverlays, type OverlayHost } from './renderer-overlays.js';

/**
 * The 2D section cap's plane placement (issue #2447).
 *
 * `uploadSection2DOverlay` carried a second copy of the section slider's range
 * formula. #2447 changed the clip plane's copy to project the bbox onto the
 * ROTATED normal; this file pins what the cap's copy does about that, because
 * "the same formula" and "the same quantity" are not the same claim here.
 *
 * The cap's `planePosition` is a world AXIS COORDINATE, not a plane distance:
 * `Section2DOverlayRenderer.transform2Dto3D` lifts a cardinal drawing to
 * `[planePosition, y, x]` (side) / `[x, planePosition, z]` (down), and the
 * polygons it lifts were cut on that same axis-aligned plane upstream. So the
 * two sites share ONE function and differ only in the normal they pass — the
 * cap passes the un-rotated axis normal on purpose. A future "consistency" fix
 * that hands the cap the rotated distance would slide the drawing off the
 * geometry it was cut from; these tests are what stops that.
 */

interface Upload {
    axis: string;
    planePosition: number;
    flipped: boolean;
    customPlane: unknown;
}

interface Harness {
    overlays: RendererOverlays;
    uploads: Upload[];
    clears: number;
    renderRequests(): number;
}

const MODEL_BOUNDS = {
    min: { x: -20, y: 0, z: -10 },
    max: { x: 20, y: 10, z: 10 },
};

function makeHarness(modelBounds: typeof MODEL_BOUNDS | null = MODEL_BOUNDS): Harness {
    const uploads: Upload[] = [];
    let renders = 0;
    let clears = 0;

    const host: OverlayHost = {
        getModelBounds: () => modelBounds,
        expandModelBoundsWithFlatVertices: () => { /* not exercised here */ },
        syncCameraSceneBounds: () => { /* not exercised here */ },
        requestRender: () => { renders++; },
    };

    const overlays = new RendererOverlays(host);

    // `init()` needs a real GPUDevice, so wire the one collaborator this facade
    // touches by hand — the same shape the renderer's other lifecycle tests use.
    const fakeRenderer = {
        uploadDrawing(
            _polygons: unknown,
            _lines: unknown,
            axis: string,
            planePosition: number,
            flipped = false,
            customPlane?: unknown,
        ) {
            uploads.push({ axis, planePosition, flipped, customPlane });
        },
        clearGeometry() { clears++; },
        setOverlayLineColor() { /* no-op */ },
    };
    (overlays as unknown as Record<string, unknown>)['section2DOverlayRenderer'] = fakeRenderer;

    return {
        overlays,
        uploads,
        get clears() { return clears; },
        renderRequests: () => renders,
    };
}

describe('the 2D section cap keeps axis-aligned units (#2447)', () => {
    it('places a side cap at the world X coordinate the slider maps to', () => {
        const h = makeHarness();
        h.overlays.uploadSection2DOverlay([], [], 'side', 25);
        // -20 + 0.25 * 40
        assert.strictEqual(h.uploads.length, 1);
        assert.strictEqual(h.uploads[0].planePosition, -10);
    });

    it('places a down cap at the world Y coordinate, not the X extent', () => {
        const h = makeHarness();
        h.overlays.uploadSection2DOverlay([], [], 'down', 50);
        assert.strictEqual(h.uploads[0].planePosition, 5);
    });

    it('does NOT widen to the projected 45-degree range', () => {
        // The cap has no `buildingRotation` input by design. If a future change
        // routed the rotated plane distance here, a side cut at 100% would land
        // at 21.213 — off the axis-aligned plane the polygons were cut on.
        const h = makeHarness();
        h.overlays.uploadSection2DOverlay([], [], 'side', 100);
        assert.strictEqual(
            h.uploads[0].planePosition,
            20,
            'the cap lifts onto an axis-aligned plane; its position must stay an axis coordinate',
        );
    });

    it('prefers an explicit storey range over the model bounds', () => {
        const h = makeHarness();
        h.overlays.uploadSection2DOverlay([], [], 'down', 50, { min: 3, max: 7 });
        assert.strictEqual(h.uploads[0].planePosition, 5);
    });

    it('uploads nothing when there is neither a range nor model bounds', () => {
        const h = makeHarness(null);
        h.overlays.uploadSection2DOverlay([], [], 'side', 50);
        assert.strictEqual(h.uploads.length, 0);
    });

    it('bypasses the cardinal range entirely for a custom plane', () => {
        const h = makeHarness();
        const customPlane = {
            origin: [1, 2, 3] as [number, number, number],
            tangent: [1, 0, 0] as [number, number, number],
            bitangent: [0, 1, 0] as [number, number, number],
        };
        h.overlays.uploadSection2DOverlay([], [], 'side', 75, undefined, false, customPlane);
        assert.strictEqual(h.uploads[0].planePosition, 0, 'the basis travels in customPlane, not in planePosition');
        assert.strictEqual(h.uploads[0].customPlane, customPlane);
    });
});

/**
 * The section overlay's missing render requests (issue #2442).
 *
 * Rendering is dirty-flag gated: `requestRender()` sets the flag and the rAF
 * loop drains it. `uploadSection2DOverlay` and `clearSection2DOverlay` changed
 * or dropped overlay GPU geometry and returned without setting it, alone among
 * every sibling on this facade (`setOverlayLineColor`, `uploadAnnotationLines3D`,
 * `uploadGridLines3D`, `uploadDxfLines3D`, `setClashOverlapBox`, ... and all the
 * matching `clear*`). A section drawing uploaded or cleared while nothing else
 * dirtied the frame did not appear or disappear until some unrelated
 * interaction happened to drive one.
 *
 * The assertions count requests rather than observing pixels, which is the
 * property the dirty-gated loop actually consumes.
 */
describe('the section overlay requests a frame when it changes geometry (#2442)', () => {
    it('requests a render after a cardinal upload', () => {
        const h = makeHarness();
        assert.strictEqual(h.renderRequests(), 0, 'precondition: nothing has asked for a frame');
        h.overlays.uploadSection2DOverlay([], [], 'side', 25);
        assert.strictEqual(h.uploads.length, 1, 'precondition: the upload actually happened');
        assert.strictEqual(h.renderRequests(), 1, 'new overlay geometry must dirty the viewport');
    });

    it('requests a render after a custom-plane upload', () => {
        // The early-return path, which is the one most likely to be missed.
        const h = makeHarness();
        h.overlays.uploadSection2DOverlay([], [], 'side', 25, undefined, false, {
            origin: [0, 0, 0],
            tangent: [1, 0, 0],
            bitangent: [0, 1, 0],
        });
        assert.strictEqual(h.uploads.length, 1, 'precondition: the upload actually happened');
        assert.strictEqual(h.renderRequests(), 1);
    });

    it('requests a render after clearing', () => {
        const h = makeHarness();
        h.overlays.clearSection2DOverlay();
        assert.strictEqual(h.clears, 1, 'precondition: the clear actually happened');
        assert.strictEqual(h.renderRequests(), 1, 'a cleared overlay must disappear on the next frame, not eventually');
    });

    it('asks for nothing when the call changed no geometry', () => {
        // The boundary: a call that bailed before touching a buffer has nothing
        // to show, and requesting a frame for it would wake an idle viewer.
        const h = makeHarness(null);
        h.overlays.uploadSection2DOverlay([], [], 'side', 50);
        assert.strictEqual(h.uploads.length, 0, 'precondition: the upload bailed');
        assert.strictEqual(h.renderRequests(), 0);
    });
});
