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
        const camPos = camera.getPosition();
        const camTgt = camera.getTarget();
        const camUpVec = camera.getUp();
        // Forward = normalize(target - position).
        let fx = camTgt.x - camPos.x;
        let fy = camTgt.y - camPos.y;
        let fz = camTgt.z - camPos.z;
        let flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;
        // Right = normalize(cross(forward, world-up)).
        let rx = fy * camUpVec.z - fz * camUpVec.y;
        let ry = fz * camUpVec.x - fx * camUpVec.z;
        let rz = fx * camUpVec.y - fy * camUpVec.x;
        let rlen = Math.hypot(rx, ry, rz) || 1;
        rx /= rlen; ry /= rlen; rz /= rlen;
        // True up = normalize(cross(right, forward)) — guaranteed
        // perpendicular to both, defines screen-space vertical.
        const ux = ry * fz - rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy - ry * fx;
        this.textPipeline.render(
            pass,
            viewProj,
            canvasWidth,
            canvasHeight,
            [rx, ry, rz],
            [ux, uy, uz],
        );
    }

    /** See `Renderer.uploadAnnotationFills3D` for the published contract. */
    uploadFills(fills: readonly SymbolicFillInput[]): void {
        if (!this.fillPipeline) return;
        this.fillPipeline.upload(fills);
        // Contribute fill extents to modelBounds — see uploadAnnotationLines3D.
        for (const fill of fills) {
            const pts = fill.points;
            if (pts.length === 0) continue;
            // points are flat [x,z,x,z,...]; lift to (x, fill.worldY, z) per
            // vertex so we expand bounds in the same world space the renderer draws in.
            const lifted = new Float32Array((pts.length / 2) * 3);
            for (let i = 0, j = 0; i < pts.length; i += 2, j += 3) {
                lifted[j] = pts[i];
                lifted[j + 1] = fill.worldY;
                lifted[j + 2] = pts[i + 1];
            }
            this.host.expandModelBoundsWithFlatVertices(lifted, 3);
        }
        this.host.syncCameraSceneBounds();
        this.host.requestRender();
    }

    /** See `Renderer.uploadAnnotationTexts3D` for the published contract. */
    uploadTexts(texts: readonly SymbolicTextInput[]): void {
        if (!this.textPipeline) return;
        this.textPipeline.upload(texts);
        // Text origins are single points; pack them into a flat buffer and
        // expand bounds. Glyph extents are small enough that origin-only
        // suffices for framing.
        if (texts.length > 0) {
            const buf = new Float32Array(texts.length * 3);
            for (let i = 0; i < texts.length; i++) {
                buf[i * 3 + 0] = texts[i].worldPos[0];
                buf[i * 3 + 1] = texts[i].worldPos[1];
                buf[i * 3 + 2] = texts[i].worldPos[2];
            }
            this.host.expandModelBoundsWithFlatVertices(buf, 3);
            this.host.syncCameraSceneBounds();
        }
        this.host.requestRender();
    }
}
