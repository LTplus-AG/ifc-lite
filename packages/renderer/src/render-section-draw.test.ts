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
import { MathUtils } from './math.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';
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
    /** The planes each primary / extra cap draw was told to clip against (#7545). */
    primaryClippedBy: unknown[];
    /** Every highlight the draw handed the cap (#7950). */
    highlights: unknown[];
    extraDraws: Array<{ params: Record<string, unknown>; caps: Array<{ key: string; clippedBy: unknown[] }> }>;
}

/** `hasGeometry` gates the cap draw, so it is part of the fixture, not a detail. */
function makeStubs(capHasGeometry = true, extraHasGeometry = false): Stubs {
    const gizmoDraws: DrawCall[] = [];
    const capDraws: DrawCall[] = [];
    const primaryClippedBy: unknown[] = [];
    const extraDraws: Stubs['extraDraws'] = [];
    const highlights: unknown[] = [];
    return {
        highlights,
        gizmoDraws,
        capDraws,
        primaryClippedBy,
        extraDraws,
        gizmo: {
            draw(_pass: unknown, params: Record<string, unknown>) { gizmoDraws.push({ params }); },
        } as unknown as SectionPlaneRenderer,
        cap: {
            hasGeometry: () => capHasGeometry,
            hasExtraGeometry: () => extraHasGeometry,
            setCapHighlight(highlight: unknown) { highlights.push(highlight); },
            draw(_pass: unknown, params: Record<string, unknown>, clippedBy: unknown[] = []) {
                capDraws.push({ params });
                primaryClippedBy.push(clippedBy);
            },
            drawExtras(_pass: unknown, params: Record<string, unknown>, caps: Array<{ key: string; clippedBy: unknown[] }>) {
                extraDraws.push({ params, caps });
            },
            // Every 3D line family reports empty, so the facade's draw() reaches
            // nothing but the section block under test.
            hasLineOverlay: () => false,
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

    it('hands the cap the selection / hover highlight, or null when there is none (#7950)', () => {
        const s = makeStubs();
        const highlight = new Map([['*:5', [0.3, 0.6, 1, 1] as const]]);
        const base = ctxFor({ axis: 'side', position: 40, enabled: true });
        drawSectionOverlays(PASS, s.gizmo, s.cap, { ...base, options: { ...base.options, capHighlight: highlight } });
        drawSectionOverlays(PASS, s.gizmo, s.cap, base);
        assert.deepStrictEqual(s.highlights, [highlight, null]);
    });

    it('draws the gizmo as PREVIEW and no cap when the section is off', () => {
        const s = makeStubs();
        drawSectionOverlays(PASS, s.gizmo, s.cap, ctxFor({ axis: 'down', position: 10, enabled: false }));

        assert.strictEqual(s.gizmoDraws[0].params.isPreview, true);
        assert.strictEqual(s.capDraws.length, 0, 'a preview plane has no cut to cap');
    });

    it('routes the camera-owned RTE frame to the preview gizmo (#5049)', () => {
        const s = makeStubs();
        const frame = new RelativeToEyeFrame();
        frame.update({ x: 5_000_000, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity());
        drawSectionOverlays(PASS, s.gizmo, s.cap, {
            ...ctxFor({ axis: 'down', position: 50, enabled: false }),
            relativeToEyeFrame: frame,
        });
        assert.strictEqual(s.gizmoDraws[0].params.relativeToEyeFrame, frame);
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
            expandModelBoundsWithAnchoredLineVertices: () => { /* unused */ },
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

describe('the caps of the cutting planes beyond the first (#7545)', () => {
    const extra = (id: string | undefined, nx: number, distance: number) =>
        ({ normal: [nx, 0, 0] as [number, number, number], distance, flipped: false, ...(id ? { id } : {}) });
    const primary = { normal: [0, 1, 0] as [number, number, number], distance: 5, flipped: false };
    const withExtras = (sectionPlane: RenderOptions['sectionPlane'], extraPlanes: ReturnType<typeof extra>[], primaryPlane = primary) =>
        ({ ...ctxFor(sectionPlane), extraPlanes, primaryPlane });

    it('clips the primary cap by every extra plane and each extra cap by every OTHER plane, the primary included', () => {
        const s = makeStubs(true, true);
        const b = extra('b', 1, 2);
        const c = extra('c', 1, 4);
        drawSectionOverlays(PASS, s.gizmo, s.cap, withExtras({ axis: 'down', position: 50, enabled: true }, [b, c]));
        assert.deepStrictEqual(s.primaryClippedBy[0], [b, c]);
        assert.strictEqual(s.extraDraws.length, 1);
        assert.deepStrictEqual(s.extraDraws[0].caps, [
            { key: 'b', clippedBy: [primary, c] },
            { key: 'c', clippedBy: [primary, b] },
        ]);
    });

    it('a primary plane that is not cutting clips nothing and its extras\' caps are not clipped by it', () => {
        const s = makeStubs(false, true);
        const b = extra('b', 1, 2);
        drawSectionOverlays(PASS, s.gizmo, s.cap, withExtras({ axis: 'down', position: 50, enabled: false }, [b], null as never));
        assert.deepStrictEqual(s.extraDraws[0].caps, [{ key: 'b', clippedBy: [] }]);
    });

    it('draws the extra caps with the primary plane\'s cap style, and with no primary plane at all with the defaults', () => {
        const withStyle = makeStubs(false, true);
        drawSectionOverlays(PASS, withStyle.gizmo, withStyle.cap, withExtras(
            { axis: 'down', position: 50, enabled: true, capStyle: { pattern: 'brick' } }, [extra('b', 1, 2)],
        ));
        assert.strictEqual((withStyle.extraDraws[0].params.capStyle as { patternId: number }).patternId, HATCH_PATTERN_IDS.brick);

        const bare = makeStubs(false, true);
        drawSectionOverlays(PASS, bare.gizmo, bare.cap, withExtras(undefined, [extra('b', 1, 2)], null as never));
        assert.strictEqual(bare.gizmoDraws.length, 0, 'no primary plane, no gizmo');
        assert.strictEqual((bare.extraDraws[0].params.capStyle as { patternId: number }).patternId, HATCH_PATTERN_IDS[DEFAULT_CAP_STYLE.pattern]);
    });

    it('skips a plane without an id (it cannot key a cap) and draws nothing when no extra cap exists', () => {
        const s = makeStubs(true, true);
        drawSectionOverlays(PASS, s.gizmo, s.cap, withExtras({ axis: 'down', position: 50, enabled: true }, [extra(undefined, 1, 2)]));
        assert.deepStrictEqual(s.extraDraws[0].caps, []);
        const none = makeStubs(true, false);
        drawSectionOverlays(PASS, none.gizmo, none.cap, withExtras({ axis: 'down', position: 50, enabled: true }, [extra('b', 1, 2)]));
        assert.strictEqual(none.extraDraws.length, 0);
    });

    it('with no extra planes the primary cap is told it is clipped by nothing', () => {
        const s = makeStubs();
        drawSectionOverlays(PASS, s.gizmo, s.cap, ctxFor({ axis: 'down', position: 50, enabled: true }));
        assert.deepStrictEqual(s.primaryClippedBy, [[]]);
    });
});
