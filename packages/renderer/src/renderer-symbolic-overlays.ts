/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The symbolic annotation overlay: filled IfcAnnotation regions and world-space
 * text labels (issue #653).
 *
 * Split out of `RendererOverlays` because these are a genuinely separate pair of
 * GPU objects — `SymbolicFillPipeline` and `SymbolicTextPipeline` own their own
 * buffers, sampler and glyph-atlas texture, and share no state whatsoever with
 * the `Section2DOverlayRenderer` that backs the section cap and every 3D line
 * layer. `RendererOverlays` composes this and drives the draw order, because the
 * order is the one thing the two families do share: fills paint underneath the
 * line layers, text labels on top of everything.
 */

import type { Camera } from './camera.js';
import { viewBasis } from './math.js';
import {
    SymbolicFillPipeline,
    SymbolicTextPipeline,
    type SymbolicFillInput,
    type SymbolicTextInput,
} from './symbolic-overlay-pipelines.js';

/**
 * The model-bounds bookkeeping the symbolic uploads borrow from `Renderer`.
 * Structurally narrower than `OverlayHost` on purpose: this module never reads
 * the bounds back, it only grows them and asks for a frame.
 */
export interface SymbolicOverlayHost {
    expandModelBoundsWithFlatVertices(positions: Float32Array, stride: number): void;
    syncCameraSceneBounds(): void;
    requestRender(): void;
}

export class SymbolicOverlays {
    private fillPipeline: SymbolicFillPipeline | null = null;
    private textPipeline: SymbolicTextPipeline | null = null;

    constructor(private readonly host: SymbolicOverlayHost) {}

    /**
     * Share the device + presentation format AND the MSAA sample count +
     * objectId attachment shape with the rest of the renderer so these
     * composite into the same RGBA pass without WebGPU pass-compatibility
     * validation errors.
     */
    init(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): void {
        this.fillPipeline = new SymbolicFillPipeline(device, format, sampleCount);
        this.textPipeline = new SymbolicTextPipeline(device, format, sampleCount);
    }

    /**
     * These pipelines own their own GPU buffers, sampler, and atlas texture —
     * recreating the viewer without releasing them leaks resources on every
     * reload.
     */
    destroy(): void {
        this.fillPipeline?.destroy();
        this.fillPipeline = null;
        this.textPipeline?.destroy();
        this.textPipeline = null;
    }

    /** Background layer: painted before the 3D line overlays. */
    drawFills(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
        if (this.fillPipeline?.hasGeometry()) {
            this.fillPipeline.render(pass, viewProj);
        }
    }

    /** Label layer: painted after everything else. */
    drawTexts(
        pass: GPURenderPassEncoder,
        viewProj: Float32Array,
        canvasWidth: number,
        canvasHeight: number,
        camera: Camera,
    ): void {
        if (!this.textPipeline?.hasGeometry()) return;
        // Pass viewport pixel dimensions so the shader can scale glyphs
        // to a constant on-screen size (BIMvision-style annotations)
        // regardless of camera distance or authored text height.
        //
        // Also pass the screen-aligned camera basis (right, up) so
        // billboarded glyphs (grid bubble tags) can face the camera
        // in any orientation — top-down, eye-level, oblique alike.
        //
        // `viewBasis` rather than a local `cross(forward, up)` (#2489): this
        // used to be a third independent derivation of the same basis the
        // view matrix is built from, and like the unprojection ray's copy
        // that #2467 removed it disagreed with `lookAt` about every
        // degenerate pose. It guarded the two divisors with `|| 1` but not
        // the numerators, so an infinite or NaN coordinate anywhere in the
        // pose produced NaN axes; and for the two *finite* degeneracies —
        // `eye === target`, and an `up` parallel to the view direction (a
        // plan pose, or a restored BCF viewpoint) — it produced a zero-length
        // right/up, which collapses every glyph quad to a point. Both are
        // exactly the cases `viewBasis` substitutes a deterministic hint for,
        // and taking that substitute is what makes the labels billboard
        // against the basis the frame was actually drawn with.
        //
        // Only `right`/`up` are read here: a screen-aligned quad needs the
        // screen plane, not the view direction.
        const basis = viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp());
        this.textPipeline.render(
            pass,
            viewProj,
            canvasWidth,
            canvasHeight,
            [basis.right.x, basis.right.y, basis.right.z],
            [basis.up.x, basis.up.y, basis.up.z],
        );
    }

    /**
     * See `Renderer.uploadAnnotationFills3D` for the published contract.
     *
     * `definesExtent: false` draws the fill without letting it grow the scene
     * AABB (#3359). This is the fill half of the policy `setLineOverlay` keys
     * by channel: `grid` lines are excluded from the bounds because a grid is a
     * reference layer that routinely reaches past the model envelope, and
     * framing the camera on it is what #967 removed. Grid BUBBLES are fills and
     * texts, not lines, so they never passed through that table at all — with
     * annotations off and the grid on, a perfect line routing still reframed
     * the camera on the bubbles, which sit a fixed offset beyond each axis
     * endpoint (BUBBLE_OFFSET_M in rust/processing/src/symbolic/grid.rs) and
     * are therefore the outermost grid content there is.
     *
     * Per ITEM rather than per call because `upload` REPLACES the whole array
     * TODAY: these two pipelines each own one buffer, so one annotation call
     * plus one grid call is not something a caller can currently do and the
     * declaration has to travel with the item. That is a property of the
     * present pipeline, not of the problem. The shape that removes this flag
     * is a channel-keyed upload matching `setLineOverlay(channel, ...)`, which
     * would answer from `CHANNEL_EXPANDS_MODEL_BOUNDS` alone; it needs
     * per-channel buffers and a draw per channel, so it is deliberately not
     * this change. Default true, so every caller that says nothing keeps the
     * old behaviour exactly.
     */
    uploadFills(fills: readonly SymbolicFillInput[]): void {
        if (!this.fillPipeline) return;
        this.fillPipeline.upload(fills);
        let expanded = false;
        for (const fill of fills) {
            const pts = fill.points;
            if (pts.length === 0 || fill.definesExtent === false) continue;
            // points are flat [x,z,x,z,...]; lift to (x, fill.worldY, z) per
            // vertex so we expand bounds in the same world space the renderer draws in.
            const lifted = new Float32Array((pts.length / 2) * 3);
            for (let i = 0, j = 0; i < pts.length; i += 2, j += 3) {
                lifted[j] = pts[i];
                lifted[j + 1] = fill.worldY;
                lifted[j + 2] = pts[i + 1];
            }
            this.host.expandModelBoundsWithFlatVertices(lifted, 3);
            expanded = true;
        }
        // Only re-fit the camera when something actually moved the bounds. The
        // old code synced on every call including a clear, which pushed an
        // unchanged AABB back at the camera; `setLineOverlay` has always been
        // conditional this way.
        if (expanded) this.host.syncCameraSceneBounds();
        this.host.requestRender();
    }

    /**
     * See `Renderer.uploadAnnotationTexts3D` for the published contract, and
     * `uploadFills` above for what `definesExtent: false` is for (#3359).
     */
    uploadTexts(texts: readonly SymbolicTextInput[]): void {
        if (!this.textPipeline) return;
        this.textPipeline.upload(texts);
        // A clear allocates nothing. Main guarded this behind `texts.length > 0`
        // and the rewrite lost it, which matters here: "every text waived" is
        // this change's own scenario (annotations off, grid on).
        if (texts.length === 0) { this.host.requestRender(); return; }
        // Text origins are single points. Written straight into a worst-case
        // buffer and passed on as a subarray: filtering first would allocate a
        // second array holding every framing text just to read its length, and
        // annotation-heavy models push thousands.
        const buf = new Float32Array(texts.length * 3);
        let n = 0;
        for (const t of texts) {
            if (t.definesExtent === false) continue;
            buf[n * 3 + 0] = t.worldPos[0];
            buf[n * 3 + 1] = t.worldPos[1];
            buf[n * 3 + 2] = t.worldPos[2];
            n++;
        }
        if (n > 0) {
            this.host.expandModelBoundsWithFlatVertices(buf.subarray(0, n * 3), 3);
            this.host.syncCameraSceneBounds();
        }
        this.host.requestRender();
    }
}
