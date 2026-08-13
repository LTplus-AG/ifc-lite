/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section feature's DRAW half, lifted verbatim out of
 * `RendererOverlays.draw()` (issue #2451 review).
 *
 * `render-section-plane.ts` is the "what does this frame CLIP against, and over
 * what range" half; this is its mirror: "what does this frame DRAW for the
 * section" — the plane gizmo quad, and the 2D drawing that doubles as the 3D
 * cut cap. Both are pure translations of `RenderOptions.sectionPlane` into a
 * draw-parameter object (the preview flag, the cap-style merge, the hatch
 * pattern id lookup), which is a different concern from owning overlay GPU
 * objects and fronting their upload/clear facade.
 *
 * Crucially it does NOT take ownership of anything. The two nullable renderers
 * arrive as arguments and stay owned by `RendererOverlays`, which alone creates
 * them in `init()` and nulls them in `destroy()`. That is what makes this seam
 * available where a class-shaped split is not: the `Section2DOverlayRenderer`
 * instance backs the section cap AND five independent 3D line families, so
 * carving those apart into two owning classes would give one nullable GPU
 * object two owners in two files. Passing it is free; co-owning it is not.
 */

import type { SectionPlaneRenderer } from './section-plane.js';
import type { Section2DOverlayRenderer } from './section-2d-overlay.js';
import { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
import type { RenderOptions } from './types.js';

/** World-space AABB in the renderer's Y-up frame. */
export type ModelBounds = {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
};

/** The slice of the frame in flight that the section draw reads. */
export interface SectionDrawContext {
    options: RenderOptions;
    viewProj: Float32Array;
    /** The bounds this frame resolved the section slider against. */
    modelBounds: ModelBounds | null;
}

/**
 * Draw the section-plane gizmo and, when the section is active, the cut cap.
 *
 * Both renderers are nullable because they only exist between `init()` and
 * `destroy()`; a null one simply draws nothing.
 */
export function drawSectionOverlays(
    pass: GPURenderPassEncoder,
    gizmo: SectionPlaneRenderer | null,
    cap: Section2DOverlayRenderer | null,
    ctx: SectionDrawContext,
): void {
    const { options, viewProj, modelBounds } = ctx;

    // Draw section plane visual BEFORE pass.end() (within same MSAA render pass)
    // Always show plane when sectionPlane options are provided (as preview or active)
    if (options.sectionPlane && gizmo && modelBounds) {
        gizmo.draw(
            pass,
            {
                axis: options.sectionPlane.axis,
                position: options.sectionPlane.position,
                bounds: modelBounds,
                viewProj,
                isPreview: !options.sectionPlane.enabled, // Preview mode when not enabled
                min: options.sectionPlane.min,
                max: options.sectionPlane.max,
                // Custom-plane gizmo override (issue #243). When both
                // are set the gizmo bypasses the cardinal path; see
                // SectionPlaneRenderer.calculatePlaneVerticesFromNormal.
                normal: options.sectionPlane.normal,
                distance: options.sectionPlane.distance,
            }
        );

        // Draw 2D section overlay on the section plane (when section is
        // active, not preview). The overlay is also the 3D SECTION CAP:
        // its polygon fills come from `SectionCutter` (exact triangle-
        // plane intersection), and the new fill shader applies the
        // user's screen-space hatch + colour directly on those
        // polygons. This replaces the old stencil-parity cap, which
        // bled hatch into empty sky on non-manifold IFC geometry —
        // the polygons here are mathematically correct, so the cap
        // silhouette matches the 2D drawing exactly.
        if (options.sectionPlane.enabled && cap?.hasGeometry()) {
            const o = options.sectionPlane;
            const showFills    = o.showCap !== false;
            const showOutlines = o.showOutlines !== false;
            const style = { ...DEFAULT_CAP_STYLE, ...(o.capStyle ?? {}) };
            cap.draw(
                pass,
                {
                    axis: o.axis,
                    position: o.position,
                    bounds: modelBounds,
                    viewProj,
                    min: o.min,
                    max: o.max,
                    showFills,
                    showOutlines,
                    capStyle: showFills ? {
                        fillColor:   style.fillColor,
                        strokeColor: style.strokeColor,
                        patternId:   HATCH_PATTERN_IDS[style.pattern],
                        spacingPx:   style.spacingPx,
                        angleRad:    style.angleRad,
                        widthPx:     style.widthPx,
                        secondaryAngleRad: style.secondaryAngleRad,
                    } : undefined,
                }
            );
        }

    }
}
