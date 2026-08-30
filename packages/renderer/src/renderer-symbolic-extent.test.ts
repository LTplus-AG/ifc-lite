/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SymbolicOverlays, type SymbolicOverlayHost } from './renderer-symbolic-overlays.js';
import type { SymbolicFillInput, SymbolicTextInput } from './symbolic-overlay-pipelines.js';

/**
 * Which uploaded symbolic content is allowed to grow the scene AABB (issue 3359).
 *
 * `setLineOverlay` decides this per CHANNEL, and `grid: false` is there because
 * a grid reaches past the model envelope, so framing the camera on it throws
 * the model off screen (#967, and #2043 for the DXF layer). Grid BUBBLES are
 * texts and fills, not lines: they never pass through that table, and they are
 * the outermost grid content there is: the bubble sits BUBBLE_OFFSET_M beyond each axis
 * endpoint. So routing the grid LINES to the `grid` channel, on its own, still
 * left an annotations-off / grid-on session reframing on grid extent.
 *
 * These assert the observable host calls, which is the only place the
 * difference shows from outside: the pipelines draw either way.
 */

interface Harness {
    symbolic: SymbolicOverlays;
    /** Buffers handed to `expandModelBoundsWithFlatVertices`, in order. */
    expanded: Float32Array[];
    cameraSyncs(): number;
    renderRequests(): number;
    /** What the fake pipelines were told to draw. */
    uploadedFills: readonly SymbolicFillInput[][];
    uploadedTexts: readonly SymbolicTextInput[][];
}

function makeHarness(): Harness {
    const expanded: Float32Array[] = [];
    const uploadedFills: SymbolicFillInput[][] = [];
    const uploadedTexts: SymbolicTextInput[][] = [];
    let syncs = 0;
    let renders = 0;

    const host: SymbolicOverlayHost = {
        expandModelBoundsWithFlatVertices: (positions) => { expanded.push(positions); },
        syncCameraSceneBounds: () => { syncs++; },
        requestRender: () => { renders++; },
    };

    const symbolic = new SymbolicOverlays(host);
    // `init()` needs a real GPUDevice, so the two pipelines are wired by hand —
    // the same shape as renderer-overlays-line-channels.test.ts.
    const fields = symbolic as unknown as Record<string, unknown>;
    fields['fillPipeline'] = {
        upload(fills: readonly SymbolicFillInput[]) { uploadedFills.push([...fills]); },
    };
    fields['textPipeline'] = {
        upload(texts: readonly SymbolicTextInput[]) { uploadedTexts.push([...texts]); },
    };

    return {
        symbolic,
        expanded,
        uploadedFills,
        uploadedTexts,
        cameraSyncs: () => syncs,
        renderRequests: () => renders,
    };
}

function text(x: number, definesExtent?: boolean): SymbolicTextInput {
    return {
        worldPos: [x, 0, 0],
        dirX: 1,
        dirZ: 0,
        height: 1,
        content: 'A',
        alignment: 'center',
        ...(definesExtent === undefined ? {} : { definesExtent }),
    };
}

function fill(x: number, definesExtent?: boolean): SymbolicFillInput {
    return {
        points: Float32Array.from([x, 0, x + 1, 0, x + 1, 1]),
        holesOffsets: new Uint32Array(0),
        worldY: 0,
        color: [0, 0, 0, 1],
        ...(definesExtent === undefined ? {} : { definesExtent }),
    };
}

/** Every x coordinate in the buffers that reached the host. */
function expandedXs(h: Harness): number[] {
    const xs: number[] = [];
    for (const buf of h.expanded) for (let i = 0; i < buf.length; i += 3) xs.push(buf[i]);
    return xs;
}

describe('symbolic uploads: definesExtent decides what frames the scene (issue 3359)', () => {
    it('an upload of ONLY non-extent texts grows nothing and re-fits nothing', () => {
        const h = makeHarness();

        h.symbolic.uploadTexts([text(1000, false), text(2000, false)]);

        assert.strictEqual(h.uploadedTexts.length, 1);
        assert.strictEqual(h.uploadedTexts[0].length, 2, 'precondition: both labels still DRAW');
        assert.deepStrictEqual(h.expanded, [], 'nothing may reach the model bounds');
        assert.strictEqual(h.cameraSyncs(), 0, 'the camera must not re-fit');
        assert.strictEqual(h.renderRequests(), 1, 'the frame is still requested (#2442)');
    });

    it('an upload of ONLY non-extent fills grows nothing and re-fits nothing', () => {
        const h = makeHarness();

        h.symbolic.uploadFills([fill(1000, false), fill(2000, false)]);

        assert.strictEqual(h.uploadedFills[0].length, 2, 'precondition: both fills still DRAW');
        assert.deepStrictEqual(h.expanded, []);
        assert.strictEqual(h.cameraSyncs(), 0);
        assert.strictEqual(h.renderRequests(), 1);
    });

    it('a mixed text upload frames on the extent-defining labels ALONE', () => {
        // The real annotations-on / grid-on case: one buffer, both kinds. The
        // flag is per item precisely because `upload` replaces the whole array,
        // so a caller cannot split this into two calls.
        const h = makeHarness();

        h.symbolic.uploadTexts([text(1, true), text(9000, false), text(2)]);

        assert.deepStrictEqual(expandedXs(h), [1, 2], 'the grid label must not be in the AABB');
        assert.strictEqual(h.cameraSyncs(), 1);
    });

    it('a mixed fill upload frames on the extent-defining fills ALONE', () => {
        const h = makeHarness();

        h.symbolic.uploadFills([fill(1, true), fill(9000, false), fill(2)]);

        // Each ring is [x, x+1, x+1] in x, lifted to (x, worldY, z).
        assert.deepStrictEqual(expandedXs(h), [1, 2, 2, 2, 3, 3], 'ring x coords of the two kept fills');
        assert.strictEqual(h.cameraSyncs(), 1);
    });

    it('omitting the flag keeps the old behaviour exactly, for texts and fills', () => {
        // Default true. Every caller written before this field must be
        // byte-identical, which is what makes the renderer change additive.
        const h = makeHarness();

        h.symbolic.uploadTexts([text(5), text(7)]);
        assert.deepStrictEqual(expandedXs(h), [5, 7]);
        assert.strictEqual(h.cameraSyncs(), 1);

        h.symbolic.uploadFills([fill(11)]);
        assert.deepStrictEqual(h.expanded.length, 2, 'the fill expanded too');
        assert.strictEqual(h.cameraSyncs(), 2);
    });

    it('a clear asks for a frame without re-fitting the camera', () => {
        const h = makeHarness();

        h.symbolic.uploadTexts([]);
        h.symbolic.uploadFills([]);

        assert.deepStrictEqual(h.expanded, []);
        assert.strictEqual(h.cameraSyncs(), 0);
        assert.strictEqual(h.renderRequests(), 2);
    });

    it('a call before init() changes nothing and asks for nothing', () => {
        const h = makeHarness();
        const fields = h.symbolic as unknown as Record<string, unknown>;
        fields['fillPipeline'] = null;
        fields['textPipeline'] = null;

        h.symbolic.uploadTexts([text(1)]);
        h.symbolic.uploadFills([fill(1)]);

        assert.deepStrictEqual(h.expanded, []);
        assert.strictEqual(h.cameraSyncs(), 0);
        assert.strictEqual(h.renderRequests(), 0);
    });
});
