/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { drawSectionOverlays, type SectionDrawContext } from './render-section-draw.js';
import { RendererOverlays, type OverlayHost, type OverlayDrawContext } from './renderer-overlays.js';
import { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
import type { SectionPlaneRenderer } from './section-plane.js';
import type { Section2DOverlayRenderer } from './section-2d-overlay.js';
import type { Camera } from './camera.js';
import type { RenderOptions } from './types.js';

/**
 * The section DRAW half, extracted from `RendererOverlays.draw()` so the
 * overlay facade stays under the ~400-line house rule (#2451 review).
 *
 * The extraction is verbatim — a normalised diff of the moved block against
 * the new function body compares identical apart from the receiver names — but
 * "verbatim" only covers the block itself. These tests cover the two things a
 * diff cannot: that the parameters the two renderers receive are the ones they
 * received before, and that the facade still ROUTES to the extracted function
 * at all. Without the second, deleting the call site would leave the section
 * gizmo and the cut cap silently undrawn with every other test still green.
 */

const BOUNDS = { min: { x: -20, y: 0, z: -10 }, max: { x: 20, y: 10, z: 10 } };

interface DrawCall { params: Record<string, unknown> }

interface Stubs {
    gizmo: SectionPlaneRenderer;
    cap: Section2DOverlayRenderer;
    gizmoDraws: DrawCall[];
    capDraws: DrawCall[];
}

/** `hasGeometry` gates the cap draw, so it is part of the fixture, not a detail. */
function makeStubs(capHasGeometry = true): Stubs {
    const gizmoDraws: DrawCall[] = [];
    const capDraws: DrawCall[] = [];
    return {
        gizmoDraws,
        capDraws,
        gizmo: {
            draw(_pass: unknown, params: Record<string, unknown>) { gizmoDraws.push({ params }); },
        } as unknown as SectionPlaneRenderer,
        cap: {
            hasGeometry: () => capHasGeometry,
            draw(_pass: unknown, params: Record<string, unknown>) { capDraws.push({ params }); },
            // Every 3D line family reports empty, so the facade's draw() reaches
            // nothing but the section block under test.
            hasAnnotationLines3D: () => false,
            hasAlignmentLines3D: () => false,
            hasGridLines3D: () => false,
            hasDxfLines3D: () => false,
            hasClashBoxLines3D: () => false,
        } as unknown as Section2DOverlayRenderer,
    };
}

function ctxFor(sectionPlane: RenderOptions['sectionPlane'], modelBounds = BOUNDS): SectionDrawContext {
    return { options: { sectionPlane }, viewProj: new Float32Array(16), modelBounds };
}

const PASS = {} as GPURenderPassEncoder;

describe('the extracted section draw keeps its parameters (#2451 review)', () => {
    it('draws the gizmo as ACTIVE and draws the cap when the section is enabled', () => {
        const s = makeStubs();
        drawSectionOverlays(PASS, s.gizmo, s.cap, ctxFor({ axis: 'side', position: 40, enabled: true }));

        assert.strictEqual(s.gizmoDraws.length, 1);
        assert.strictEqual(s.gizmoDraws[0].params.axis, 'side');
        assert.strictEqual(s.gizmoDraws[0].params.position, 40);
        assert.strictEqual(s.gizmoDraws[0].params.isPreview, false);
        assert.strictEqual(s.gizmoDraws[0].params.bounds, BOUNDS);
        assert.strictEqual(s.capDraws.length, 1);
    });

    it('draws the gizmo as PREVIEW and no cap when the section is off', () => {
        const s = makeStubs();
        drawSectionOverlays(PASS, s.gizmo, s.cap, ctxFor({ axis: 'down', position: 10, enabled: false }));

        assert.strictEqual(s.gizmoDraws[0].params.isPreview, true);
        assert.strictEqual(s.capDraws.length, 0, 'a preview plane has no cut to cap');
    });

    it('skips the cap while the overlay has no geometry', () => {
        const s = makeStubs(false);
        drawSectionOverlays(PASS, s.gizmo, s.cap, ctxFor({ axis: 'side', position: 40, enabled: true }));
        assert.strictEqual(s.gizmoDraws.length, 1);
        assert.strictEqual(s.capDraws.length, 0);
    });

    it('draws nothing without model bounds or without a section plane', () => {
        const a = makeStubs();
        drawSectionOverlays(PASS, a.gizmo, a.cap, ctxFor({ axis: 'side', position: 40, enabled: true }, null as never));
        assert.strictEqual(a.gizmoDraws.length, 0, 'the gizmo quad is sized from the bounds');

        const b = makeStubs();
        drawSectionOverlays(PASS, b.gizmo, b.cap, ctxFor(undefined));
        assert.strictEqual(b.gizmoDraws.length, 0);
    });

    it('draws nothing when the renderers are null (before init / after destroy)', () => {
        assert.doesNotThrow(() =>
            drawSectionOverlays(PASS, null, null, ctxFor({ axis: 'side', position: 40, enabled: true })));
    });

    it('merges the caller cap style over the defaults and resolves the hatch id', () => {
        const s = makeStubs();
        drawSectionOverlays(PASS, s.gizmo, s.cap, ctxFor({
            axis: 'side', position: 40, enabled: true,
            capStyle: { pattern: 'crossHatch', spacingPx: 3 },
        }));

        const style = s.capDraws[0].params.capStyle as Record<string, unknown>;
        assert.strictEqual(style.patternId, HATCH_PATTERN_IDS.crossHatch, 'the pattern NAME must be mapped to its shader id');
        assert.strictEqual(style.spacingPx, 3, 'an explicit override wins');
        assert.strictEqual(style.widthPx, DEFAULT_CAP_STYLE.widthPx, 'unset fields fall back to the defaults');
    });

    it('omits the cap style entirely when fills are switched off', () => {
        const s = makeStubs();
        drawSectionOverlays(PASS, s.gizmo, s.cap, ctxFor({
            axis: 'side', position: 40, enabled: true, showCap: false, showOutlines: true,
        }));
        assert.strictEqual(s.capDraws[0].params.showFills, false);
        assert.strictEqual(s.capDraws[0].params.capStyle, undefined);
        assert.strictEqual(s.capDraws[0].params.showOutlines, true, 'outlines are independent of fills');
    });
});

describe('the overlay facade still routes its draw pass to it (#2451 review)', () => {
    it('reaches the section gizmo and cap through RendererOverlays.draw()', () => {
        // The guard on the extraction itself: a dropped call site is invisible
        // to every other test in this package.
        const host: OverlayHost = {
            getModelBounds: () => BOUNDS,
            expandModelBoundsWithFlatVertices: () => { /* unused */ },
            syncCameraSceneBounds: () => { /* unused */ },
            requestRender: () => { /* unused */ },
        };
        const overlays = new RendererOverlays(host);
        const s = makeStubs();
        const fields = overlays as unknown as Record<string, unknown>;
        fields['sectionPlaneRenderer'] = s.gizmo;
        fields['section2DOverlayRenderer'] = s.cap;

        const ctx: OverlayDrawContext = {
            options: { sectionPlane: { axis: 'front', position: 60, enabled: true } },
            viewProj: new Float32Array(16),
            modelBounds: BOUNDS,
            camera: {} as Camera,
            canvasWidth: 800,
            canvasHeight: 600,
        };
        overlays.draw(PASS, ctx);

        assert.strictEqual(s.gizmoDraws.length, 1, 'the section gizmo must still be drawn by the facade');
        assert.strictEqual(s.gizmoDraws[0].params.axis, 'front');
        assert.strictEqual(s.capDraws.length, 1, 'the cut cap must still be drawn by the facade');
    });
});
