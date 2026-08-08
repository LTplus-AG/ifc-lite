/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer's overlay layer, lifted verbatim out of `Renderer` (issue
 * #2425): the section-plane gizmo, the 2D section drawing / cut cap, and the
 * standalone 3D line overlays (IfcAnnotation lines, IfcAlignment centrelines,
 * IfcGridAxis, the DXF reference layer, and the focused clash's box / contact
 * lines).
 *
 * These were already one unit in everything but location: created together in
 * `init()`, destroyed together in `destroy()`, drawn one after another at the
 * tail of the render pass, and fed by a facade of upload/clear methods that
 * touches nothing else. Owning them here follows the `PickingManager` /
 * `RaycastEngine` precedent — a cohesive chunk of state plus its behaviour,
 * composed by `Renderer` rather than inlined into it.
 *
 * The boundary is GPU-object ownership, not subject matter. Every 3D line
 * layer above lives on the SAME `Section2DOverlayRenderer` instance as the
 * section cap, so "section rendering" and "standalone line overlays" cannot be
 * separate modules without giving one nullable, init-created / destroy-disposed
 * object two owners in two files. The symbolic fill/text pipelines ARE separate
 * GPU objects, so they live in `renderer-symbolic-overlays.ts` and are composed
 * here — this class keeps only the draw ORDER, which is the one thing the two
 * families share.
 *
 * Behaviour that needs those objects but does not own them can still leave:
 * `render-section-draw.ts` holds the section gizmo + cut-cap draw, receiving
 * both renderers as arguments. Passing a GPU object costs nothing; co-owning
 * one is what the paragraph above rules out.
 *
 * Doc comments for the published methods live on the matching `Renderer`
 * delegates, which are what consumers see in the emitted `.d.ts`; they are not
 * duplicated here.
 *
 * What stayed on `Renderer` is what genuinely couples: model bounds. Several
 * uploads grow the scene AABB so an annotation-only or alignment-only model can
 * still be framed, and those bounds are read by the camera, the section slider
 * and `getDiagnostics()`. Rather than give one AABB two owners, this reaches the
 * renderer's copy through the narrow `OverlayHost` seam below.
 */

import type { Camera } from './camera.js';
import { SectionPlaneRenderer } from './section-plane.js';
import { Section2DOverlayRenderer, type CutPolygon2D, type DrawingLine2D } from './section-2d-overlay.js';
import { SymbolicOverlays } from './renderer-symbolic-overlays.js';
import type { SymbolicFillInput, SymbolicTextInput } from './symbolic-overlay-pipelines.js';
import { aabbEdgeLineList } from './aabb-edges.js';
import { projectedBoundsRange } from './render-section-plane.js';
import { drawSectionOverlays, type ModelBounds } from './render-section-draw.js';
import type { RenderOptions } from './types.js';

/**
 * The slice of `Renderer` the overlays need. Deliberately four methods wide:
 * the overlays own their GPU objects outright, and borrow only the model-bounds
 * bookkeeping that the rest of the renderer also owns.
 */
export interface OverlayHost {
    /** The renderer's cached model AABB, or null before any geometry. */
    getModelBounds(): ModelBounds | null;
    /** Grow (or seed) the model AABB from a flat `[x,y,z,...]` buffer. */
    expandModelBoundsWithFlatVertices(positions: Float32Array, stride: number): void;
    /** Push the current model AABB to the camera's near/far fit. */
    syncCameraSceneBounds(): void;
    /** Mark the viewport dirty for the next animation frame. */
    requestRender(): void;
}

/** Everything the overlay draw pass reads from the frame in flight. */
export interface OverlayDrawContext {
    options: RenderOptions;
    viewProj: Float32Array;
    /** The bounds this frame resolved the section slider against. */
    modelBounds: ModelBounds | null;
    camera: Camera;
    canvasWidth: number;
    canvasHeight: number;
}

export class RendererOverlays {
    private sectionPlaneRenderer: SectionPlaneRenderer | null = null;
    private section2DOverlayRenderer: Section2DOverlayRenderer | null = null;
    // Overlay/section-cut line colour, kept here so it survives a
    // pre-init call and a section2DOverlayRenderer re-creation (re-applied below).
    private overlayLineColor: readonly [number, number, number, number] = [0, 0, 0, 1];
    private readonly symbolic: SymbolicOverlays;

    constructor(private readonly host: OverlayHost) {
        this.symbolic = new SymbolicOverlays(host);
    }

    /**
     * Create the overlay GPU objects. Called from `Renderer.init()` once the
     * device and the main pipeline (for its sample count) exist.
     */
    init(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): void {
        this.sectionPlaneRenderer = new SectionPlaneRenderer(device, format, sampleCount);
        this.section2DOverlayRenderer = new Section2DOverlayRenderer(device, format, sampleCount);
        // Re-apply any colour set before this (re)creation so it isn't lost.
        this.section2DOverlayRenderer.setOverlayLineColor(this.overlayLineColor);
        this.symbolic.init(device, format, sampleCount);
    }

    /** Release every overlay GPU resource. Idempotent, like `Renderer.destroy()`. */
    destroy(): void {
        this.sectionPlaneRenderer?.destroy();
        this.sectionPlaneRenderer = null;
        this.section2DOverlayRenderer?.dispose();
        this.section2DOverlayRenderer = null;
        this.symbolic.destroy();
    }

    /**
     * Draw every overlay into the frame's render pass, in the documented order.
     * Called from the encode region right before `pass.end()`.
     */
    draw(pass: GPURenderPassEncoder, ctx: OverlayDrawContext): void {
        const { viewProj, camera } = ctx;

        drawSectionOverlays(pass, this.sectionPlaneRenderer, this.section2DOverlayRenderer, ctx);

        // Standalone IFC annotation overlay (issue #653). The line
        // vertices were pre-lifted to world space at upload time, so
        // this draw happens regardless of whether a section plane is
        // active — annotations are a free-floating "drawing layer"
        // that sits at each annotation's storey elevation.
        //
        // This block was previously nested inside the `if (options.sectionPlane && ...)`
        // guard above, contradicting its own comment. Loading an
        // annotation-only model with no section plane meant the entire
        // overlay was skipped at draw time even though 9000+ vertices
        // had been uploaded successfully. Pulled out to its own block.
        //
        // Order: fills (background) → lines (outlines on top) →
        // texts (labels above everything).
        this.symbolic.drawFills(pass, viewProj);
        if (this.section2DOverlayRenderer?.hasAnnotationLines3D()) {
            this.section2DOverlayRenderer.drawAnnotationLines3D(pass, viewProj);
        }
        if (this.section2DOverlayRenderer?.hasAlignmentLines3D()) {
            this.section2DOverlayRenderer.drawAlignmentLines3D(pass, viewProj);
        }
        if (this.section2DOverlayRenderer?.hasGridLines3D()) {
            this.section2DOverlayRenderer.drawGridLines3D(pass, viewProj);
        }
        if (this.section2DOverlayRenderer?.hasDxfLines3D()) {
            this.section2DOverlayRenderer.drawDxfLines3D(pass, viewProj);
        }
        if (this.section2DOverlayRenderer?.hasClashBoxLines3D()) {
            this.section2DOverlayRenderer.drawClashBoxLines3D(pass, viewProj);
        }
        this.symbolic.drawTexts(pass, viewProj, ctx.canvasWidth, ctx.canvasHeight, camera);
    }

    /** See `Renderer.uploadSection2DOverlay` for the published contract. */
    uploadSection2DOverlay(
        polygons: CutPolygon2D[],
        lines: DrawingLine2D[],
        axis: 'down' | 'front' | 'side',
        position: number,  // 0-100 percentage
        sectionRange?: { min?: number; max?: number },  // Same storey-based range as section plane
        flipped: boolean = false,
        customPlane?: {
            origin:    [number, number, number];
            tangent:   [number, number, number];
            bitangent: [number, number, number];
        },
    ): void {
        // Rendering is dirty-flag gated, so every path that actually CHANGES
        // overlay geometry has to request a frame or the new drawing only
        // appears when something unrelated next dirties the viewport (#2442).
        // The two early returns below leave the geometry untouched, so they
        // correctly ask for nothing — matching `uploadGridLines3D` and friends.
        if (!this.section2DOverlayRenderer) return;

        if (customPlane) {
            // Custom-plane path: planePosition / axis are unused — the
            // basis the cap shader needs travels in `customPlane`. We pass
            // 0 for `planePosition` and the existing `axis` so the cardinal
            // shader code path that callers depend on (e.g. legacy SVG
            // export) keeps working when customPlane is omitted.
            this.section2DOverlayRenderer.uploadDrawing(
                polygons, lines, axis, 0, flipped, customPlane,
            );
            this.host.requestRender();
            return;
        }

        // Same range formula as the clip plane (`resolveSectionPlaneFrame`),
        // shared rather than copied — but deliberately evaluated against the
        // UN-ROTATED axis normal, which is what makes the two agree instead of
        // merely look alike (#2447).
        //
        // `planePosition` is not a plane distance here: `transform2Dto3D` lifts
        // the cardinal drawing onto an AXIS-ALIGNED plane at that world
        // coordinate (`side` -> `[planePosition, y, x]`), and the polygons it
        // lifts were cut on that same axis-aligned plane upstream. Feeding it
        // the rotated plane's distance would move the cap off the geometry it
        // was cut from. A rotated or face-picked plane reaches the cap through
        // `customPlane` above, which carries its own basis.
        const axisNormal: [number, number, number] =
            axis === 'side' ? [1, 0, 0] : axis === 'down' ? [0, 1, 0] : [0, 0, 1];

        const modelBounds = this.host.getModelBounds();

        // Allow upload if either sectionRange has both values, or modelBounds exists as fallback
        const hasFullRange = sectionRange?.min !== undefined && sectionRange?.max !== undefined;
        if (!hasFullRange && !modelBounds) return;

        const axisRange = modelBounds ? projectedBoundsRange(modelBounds.min, modelBounds.max, axisNormal) : null;
        const minVal = sectionRange?.min ?? axisRange!.min;
        const maxVal = sectionRange?.max ?? axisRange!.max;
        const planePosition = minVal + (position / 100) * (maxVal - minVal);

        this.section2DOverlayRenderer.uploadDrawing(polygons, lines, axis, planePosition, flipped);
        this.host.requestRender();
    }

    /** See `Renderer.clearSection2DOverlay` for the published contract. */
    clearSection2DOverlay(): void {
        if (this.section2DOverlayRenderer) {
            this.section2DOverlayRenderer.clearGeometry();
            this.host.requestRender();
        }
    }

    /** See `Renderer.setOverlayLineColor` for the published contract. */
    setOverlayLineColor(color: readonly [number, number, number, number]): void {
        // Persist here so a pre-init call (and any later overlay
        // re-creation) keeps the colour — init() re-applies this.overlayLineColor.
        this.overlayLineColor = color;
        this.section2DOverlayRenderer?.setOverlayLineColor(color);
        this.host.requestRender();
    }

    /** See `Renderer.uploadAnnotationLines3D` for the published contract. */
    uploadAnnotationLines3D(vertices: Float32Array): void {
        if (!this.section2DOverlayRenderer) return;
        this.section2DOverlayRenderer.uploadAnnotationLines3D(vertices);
        // Contribute annotation extents to modelBounds + camera sceneBounds
        // so an annotation-only model (no IfcProduct meshes — common for
        // separate "annotation sheets") gets framed by Home / fit-to-view
        // AND has correct near/far clipping. Without sceneBounds the camera
        // frustum doesn't include the annotation cluster and they're clipped
        // away even when the camera is pointed at them. Mirror the
        // point-cloud upload path (`addPointClouds`, `setPointClouds`) which
        // does the same thing.
        this.host.expandModelBoundsWithFlatVertices(vertices, 3);
        this.host.syncCameraSceneBounds();
        this.host.requestRender();
    }

    /** See `Renderer.clearAnnotationLines3D` for the published contract. */
    clearAnnotationLines3D(): void {
        if (this.section2DOverlayRenderer) {
            this.section2DOverlayRenderer.clearAnnotationLines3D();
            this.host.requestRender();
        }
    }

    /** See `Renderer.uploadAlignmentLines3D` for the published contract. */
    uploadAlignmentLines3D(vertices: Float32Array): void {
        if (!this.section2DOverlayRenderer) return;
        this.section2DOverlayRenderer.uploadAlignmentLines3D(vertices);
        // Frame alignment-only files the same way annotation overlays are
        // framed (see uploadAnnotationLines3D).
        this.host.expandModelBoundsWithFlatVertices(vertices, 3);
        this.host.syncCameraSceneBounds();
        this.host.requestRender();
    }

    /** See `Renderer.clearAlignmentLines3D` for the published contract. */
    clearAlignmentLines3D(): void {
        if (this.section2DOverlayRenderer) {
            this.section2DOverlayRenderer.clearAlignmentLines3D();
            this.host.requestRender();
        }
    }

    /**
     * See `Renderer.uploadGridLines3D` for the published contract. Unlike
     * alignment, grids do NOT expand model bounds: they're behind a visibility
     * toggle, so toggling them on must not reframe the camera.
     */
    uploadGridLines3D(vertices: Float32Array): void {
        if (!this.section2DOverlayRenderer) return;
        this.section2DOverlayRenderer.uploadGridLines3D(vertices);
        this.host.requestRender();
    }

    /** See `Renderer.clearGridLines3D` for the published contract. */
    clearGridLines3D(): void {
        if (this.section2DOverlayRenderer) {
            this.section2DOverlayRenderer.clearGridLines3D();
            this.host.requestRender();
        }
    }

    /** See `Renderer.uploadDxfLines3D` for the published contract. */
    uploadDxfLines3D(vertices: Float32Array): void {
        if (!this.section2DOverlayRenderer) return;
        this.section2DOverlayRenderer.uploadDxfLines3D(vertices);
        this.host.requestRender();
    }

    /** See `Renderer.clearDxfLines3D` for the published contract. */
    clearDxfLines3D(): void {
        if (this.section2DOverlayRenderer) {
            this.section2DOverlayRenderer.clearDxfLines3D();
            this.host.requestRender();
        }
    }

    /** See `Renderer.setClashOverlapBox` for the published contract. */
    setClashOverlapBox(
        box: { min: [number, number, number]; max: [number, number, number]; color: [number, number, number, number] } | null,
    ): void {
        if (!this.section2DOverlayRenderer) return;
        if (!box) {
            this.section2DOverlayRenderer.clearClashBoxLines3D();
            this.host.requestRender();
            return;
        }
        this.section2DOverlayRenderer.setClashBoxLineColor(box.color);
        this.section2DOverlayRenderer.uploadClashBoxLines3D(aabbEdgeLineList(box.min, box.max));
        this.host.requestRender();
    }

    /**
     * See `Renderer.setClashContactLines` for the published contract. Shares the
     * clash-box line buffer, so only one of this / setClashOverlapBox shows.
     */
    setClashContactLines(
        lines: { vertices: Float32Array; color: [number, number, number, number] } | null,
    ): void {
        if (!this.section2DOverlayRenderer) return;
        if (!lines || lines.vertices.length === 0) {
            this.section2DOverlayRenderer.clearClashBoxLines3D();
            this.host.requestRender();
            return;
        }
        this.section2DOverlayRenderer.setClashBoxLineColor(lines.color);
        this.section2DOverlayRenderer.uploadClashBoxLines3D(lines.vertices);
        this.host.requestRender();
    }

    /** See `Renderer.uploadAnnotationFills3D` for the published contract. */
    uploadAnnotationFills3D(fills: readonly SymbolicFillInput[]): void {
        this.symbolic.uploadFills(fills);
    }

    /** See `Renderer.uploadAnnotationTexts3D` for the published contract. */
    uploadAnnotationTexts3D(texts: readonly SymbolicTextInput[]): void {
        this.symbolic.uploadTexts(texts);
    }

    /** See `Renderer.hasSection2DOverlay` for the published contract. */
    hasSection2DOverlay(): boolean {
        return this.section2DOverlayRenderer?.hasGeometry() ?? false;
    }
}
