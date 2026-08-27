/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RendererOverlays, type OverlayHost } from './renderer-overlays.js';
import { LINE_OVERLAY_CHANNELS, type LineOverlayChannel } from './section-2d-overlay.js';

/**
 * What `setLineOverlay` must keep doing per channel (PR #3171 follow-up: the
 * eight `upload*`/`clear*Lines3D` methods collapsed into one channel-keyed
 * entry point).
 *
 * The eight methods were identical on the published `Renderer` but NOT on this
 * facade: annotation and alignment grew the scene AABB and re-fit the camera,
 * grid and DXF deliberately did not. Folding four uploads into one is exactly
 * the shape of change that quietly gives all four the same policy, and the
 * damage is invisible in a unit test that only checks the vertices arrived:
 * grid axes reach far past the model envelope, so a grid upload that expanded
 * bounds would reframe the camera every time someone ticked the toggle, and an
 * annotation-only file that stopped expanding them would have nothing for
 * fit-to-view to aim at and would be clipped by the near/far range.
 *
 * So these assert the host calls, which is the only place that difference is
 * observable from outside.
 */

interface Harness {
    overlays: RendererOverlays;
    /** Vertex buffers handed to `expandModelBoundsWithFlatVertices`. */
    expanded: Float32Array[];
    cameraSyncs(): number;
    renderRequests(): number;
    /** `[channel, vertices]` pairs the fake overlay renderer received. */
    set: Array<[string, Float32Array | null]>;
}

function makeHarness(): Harness {
    const expanded: Float32Array[] = [];
    const set: Array<[string, Float32Array | null]> = [];
    let syncs = 0;
    let renders = 0;

    const host: OverlayHost = {
        getModelBounds: () => null,
        expandModelBoundsWithFlatVertices: (positions) => { expanded.push(positions); },
        syncCameraSceneBounds: () => { syncs++; },
        requestRender: () => { renders++; },
    };

    const overlays = new RendererOverlays(host);

    // `init()` needs a real GPUDevice, so the one collaborator this facade
    // touches is wired by hand — same shape as renderer-overlays-section.test.ts.
    const fakeRenderer = {
        setLineOverlay(channel: string, vertices: Float32Array | null) {
            set.push([channel, vertices]);
        },
        setOverlayLineColor() { /* no-op */ },
    };
    (overlays as unknown as Record<string, unknown>)['section2DOverlayRenderer'] = fakeRenderer;

    return {
        overlays,
        expanded,
        set,
        cameraSyncs: () => syncs,
        renderRequests: () => renders,
    };
}

const SEGMENT = new Float32Array([0, 0, 0, 1, 1, 1]);

/** Channels whose uploads must grow the scene AABB, and those that must not. */
const EXPECTED_EXPANDS: Record<LineOverlayChannel, boolean> = {
    annotation: true,
    alignment: true,
    grid: false,
    dxf: false,
};

describe('setLineOverlay keeps each channel\'s model-bounds policy', () => {
    for (const channel of LINE_OVERLAY_CHANNELS) {
        const expands = EXPECTED_EXPANDS[channel];

        it(`${channel}: an upload ${expands ? 'grows' : 'does NOT grow'} the scene bounds`, () => {
            const h = makeHarness();
            h.overlays.setLineOverlay(channel, SEGMENT);

            assert.deepStrictEqual(
                h.set,
                [[channel, SEGMENT]],
                'precondition: the vertices reached the overlay renderer',
            );
            assert.strictEqual(h.expanded.length, expands ? 1 : 0);
            assert.strictEqual(h.cameraSyncs(), expands ? 1 : 0);
            if (expands) {
                assert.strictEqual(h.expanded[0], SEGMENT, 'the uploaded buffer is what grows bounds');
            }
        });

        it(`${channel}: clearing never touches the scene bounds`, () => {
            const h = makeHarness();
            h.overlays.setLineOverlay(channel, SEGMENT);
            const expandsBefore = h.expanded.length;
            const syncsBefore = h.cameraSyncs();

            h.overlays.setLineOverlay(channel, null);

            assert.deepStrictEqual(h.set[1], [channel, null], 'the clear reached the overlay renderer');
            assert.strictEqual(h.expanded.length, expandsBefore, 'a clear must not grow bounds');
            assert.strictEqual(h.cameraSyncs(), syncsBefore, 'a clear must not re-fit the camera');
        });

        it(`${channel}: both setting and clearing dirty the viewport (#2442)`, () => {
            // Rendering is dirty-flag gated: a channel that changed and did not
            // ask for a frame only appears (or disappears) when something
            // unrelated next dirties the viewport.
            const h = makeHarness();
            assert.strictEqual(h.renderRequests(), 0, 'precondition: nothing asked yet');
            h.overlays.setLineOverlay(channel, SEGMENT);
            assert.strictEqual(h.renderRequests(), 1, 'setting must request a frame');
            h.overlays.setLineOverlay(channel, null);
            assert.strictEqual(h.renderRequests(), 2, 'clearing must request a frame too');
        });
    }

    it('a call before init() changes nothing and asks for nothing', () => {
        // The overlay renderer only exists after `init()`, which needs a real
        // GPUDevice. A pre-init call has nowhere to put the vertices, so it must
        // not request a frame that would render an unchanged scene.
        const h = makeHarness();
        (h.overlays as unknown as Record<string, unknown>)['section2DOverlayRenderer'] = null;

        h.overlays.setLineOverlay('annotation', SEGMENT);
        h.overlays.setLineOverlay('grid', null);

        assert.deepStrictEqual(h.set, []);
        assert.strictEqual(h.expanded.length, 0);
        assert.strictEqual(h.cameraSyncs(), 0);
        assert.strictEqual(h.renderRequests(), 0);
    });

    it('every channel in LINE_OVERLAY_CHANNELS has a stated bounds policy', () => {
        // A fifth channel added to the union without a row in
        // CHANNEL_EXPANDS_MODEL_BOUNDS would not compile, but one added with the
        // wrong row would — and would silently inherit whichever policy its
        // author copied. This makes the table above the thing that has to be
        // updated deliberately.
        assert.deepStrictEqual(
            LINE_OVERLAY_CHANNELS.slice().sort(),
            (Object.keys(EXPECTED_EXPANDS) as LineOverlayChannel[]).sort(),
        );
    });
});
