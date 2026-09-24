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
import {
    Section2DOverlayRenderer,
    LINE_OVERLAY_CHANNELS,
    type CutPolygon2D,
    type DrawingLine2D,
    type LineOverlayChannel,
} from './section-2d-overlay.js';
import { SymbolicOverlays } from './renderer-symbolic-overlays.js';
import type { SymbolicFillInput, SymbolicTextInput } from './symbolic-overlay-pipelines.js';
import { ClashSolidPipeline, type ClashSolidInput } from './clash-solid-pipeline.js';
import { anchoredAabbEdgeLineList } from './aabb-edges.js';
import { projectedBoundsRange } from './render-section-plane.js';
import { drawSectionOverlays, type ModelBounds } from './render-section-draw.js';
import type { RelativeToEyeFrame } from './relative-to-eye.js';
import type { RenderOptions } from './types.js';
import type { DeviceRecoveryOmission } from './device-recovery.js';
import { lineVertexFloatCount, type LineVertices } from './section-2d-line-buffer.js';
import type { OverlayTheme } from './overlay-theme.js';
import { OverlayThemeApplier } from './overlay-theme-uniforms.js';

/**
 * The slice of `Renderer` the overlays need. Deliberately narrow:
 * the overlays own their GPU objects outright, and borrow only the model-bounds
 * bookkeeping that the rest of the renderer also owns.
 */
export interface OverlayHost {
    /** The renderer's cached model AABB, or null before any geometry. */
    getModelBounds(): ModelBounds | null;
    /** Grow (or seed) the model AABB from a flat `[x,y,z,...]` buffer. */
    expandModelBoundsWithFlatVertices(positions: Float32Array, stride: number): void;
    /** Fold f32-local overlay vertices through their source f64 anchor. */
    expandModelBoundsWithAnchoredLineVertices(
        positions: Float32Array,
        origin: readonly [number, number, number],
        stride: number,
    ): void;
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
    /** Viewport in CSS px (buffer / `pixelRatio`, see `SectionDrawContext`), as glyph sizes are. */
    canvasWidth: number;
    canvasHeight: number;
    pixelRatio?: number;
    relativeToEyeFrame?: RelativeToEyeFrame;
    rteViewProj?: Float32Array;
    rteCamera?: readonly [number, number, number];
}

/**
 * Whether setting a channel grows the scene AABB.
 *
 * The one behavioural difference between the line-overlay channels, and the reason
 * `setLineOverlay` is a table lookup rather than a plain forward. The
 * per-channel rationale is on `Renderer.setLineOverlay`, which is what
 * consumers read in the emitted `.d.ts`; it is not repeated here.
 *
 * The rule is "does this content DEFINE the model's extent, so that a file
 * containing only it must still be framable". It is NOT "is it behind a
 * visibility toggle" — annotations sit behind `ifcAnnotationsVisible` too and
 * they DO expand. Anyone adding a channel should answer the first
 * question, not the second.
 *
 * IfcGrid and IfcAnnotation content used to share one buffer feeding
 * `setLineOverlay('annotation', ...)`, so an annotations-off / grid-on
 * session could reach `annotation` carrying only grid lines and inflate the
 * bounds that `grid: false` exists to protect (#3359). Fixed:
 * `apps/viewer/src/hooks/symbolic-line-channels.ts` keeps the two channels
 * separate and uploads each to its like-named channel, so this table's
 * per-channel keying now matches the content it is keyed by.
 */
const CHANNEL_EXPANDS_MODEL_BOUNDS: Record<LineOverlayChannel, boolean> = {
    annotation: true,
    alignment: true,
    grid: false,
    dxf: false,
    // A LandXML source may consist entirely of authored terrain lines.
    terrain: true,
};

export class RendererOverlays {
    private sectionPlaneRenderer: SectionPlaneRenderer | null = null;
    private section2DOverlayRenderer: Section2DOverlayRenderer | null = null;
    // The overlay theme (#5484) — see overlay-theme-uniforms.ts.
    private readonly themeApplier = new OverlayThemeApplier();
    private readonly symbolic: SymbolicOverlays;
    private clashSolidPipeline: ClashSolidPipeline | null = null;

    constructor(private readonly host: OverlayHost) {
        this.symbolic = new SymbolicOverlays(host);
    }

    /** Snapshot which transient GPU-only layers will be dropped by recovery. */
    recoveryOmissions(): DeviceRecoveryOmission[] {
        const omissions: DeviceRecoveryOmission[] = [];
        const overlay = this.section2DOverlayRenderer;
        if (overlay?.hasGeometry()) omissions.push('section-2d-overlay');
        if (overlay && (LINE_OVERLAY_CHANNELS.some((channel) => overlay.hasLineOverlay(channel)) || overlay.hasClashBoxLines3D() || (this.clashSolidPipeline?.hasGeometry() ?? false))) {
            omissions.push('line-overlays');
        }
        if (this.symbolic.hasGeometry()) omissions.push('symbolic-overlays');
        return omissions;
    }

    /**
     * Create the overlay GPU objects. Called from `Renderer.init()` once the
     * device and the main pipeline (for its sample count) exist.
     */
    init(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): void {
        this.sectionPlaneRenderer = new SectionPlaneRenderer(device, format, sampleCount);
        this.section2DOverlayRenderer = new Section2DOverlayRenderer(device, format, sampleCount);
        // Re-apply any theme set before this (re)creation so it isn't lost.
        this.themeApplier.reapply(this.sectionPlaneRenderer, this.section2DOverlayRenderer);
        this.symbolic.init(device, format, sampleCount);
        this.clashSolidPipeline = new ClashSolidPipeline(device, format, sampleCount);
    }

    /** Release every overlay GPU resource. Idempotent, like `Renderer.destroy()`. */
    destroy(): void {
        this.sectionPlaneRenderer?.destroy();
        this.sectionPlaneRenderer = null;
        this.section2DOverlayRenderer?.dispose();
        this.section2DOverlayRenderer = null;
        this.symbolic.destroy();
        this.clashSolidPipeline?.destroy();
        this.clashSolidPipeline = null;
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
        this.symbolic.drawFills(pass, viewProj, ctx.rteViewProj, ctx.rteCamera);
        // `LINE_OVERLAY_CHANNELS` is in draw order: annotation, alignment,
        // grid, DXF, LandXML. All share the overlay colour and the line pipeline,
        // so the order only decides who wins a depth tie.
        const overlay = this.section2DOverlayRenderer;
        if (overlay) {
            for (const channel of LINE_OVERLAY_CHANNELS) {
                if (overlay.hasLineOverlay(channel)) {
                    overlay.drawLineOverlay(pass, viewProj, channel, ctx.rteViewProj, ctx.rteCamera);
                }
            }
            if (overlay.hasClashBoxLines3D()) {
                overlay.drawClashBoxLines3D(pass, viewProj, ctx.rteViewProj, ctx.rteCamera);
            }
        }
        // Drawn after the box/contact lines and — crucially — after every
        // ghosted (depth-non-writing) element in the main pass, so the true
        // overlap volume shows opaque through both ghosted parents rather
        // than being buried inside them.
        if (this.clashSolidPipeline?.hasGeometry()) {
            this.clashSolidPipeline.render(pass, viewProj, ctx.rteViewProj, ctx.rteCamera);
        }
        this.symbolic.drawTexts(
            pass,
            viewProj,
            ctx.canvasWidth,
            ctx.canvasHeight,
            camera,
            ctx.rteViewProj,
            ctx.rteCamera,
        );
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
        // correctly ask for nothing — matching `setLineOverlay` before init.
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

    /** See `Renderer.setOverlayTheme` for the published contract. */
    setTheme(theme: OverlayTheme): void {
        this.themeApplier.set(theme, this.sectionPlaneRenderer, this.section2DOverlayRenderer);
        this.host.requestRender();
    }

    /** See `Renderer.setLineOverlay` for the published contract. */
    setLineOverlay(channel: LineOverlayChannel, vertices: LineVertices | null): void {
        if (!this.section2DOverlayRenderer) return;
        this.section2DOverlayRenderer.setLineOverlay(channel, vertices);
        if (CHANNEL_EXPANDS_MODEL_BOUNDS[channel] && vertices) {
            // Mirrors the point-cloud upload path (`addPointClouds`,
            // `setPointClouds`): without `syncCameraSceneBounds` the frustum
            // excludes the cluster and it is clipped away even when the camera
            // points straight at it. See CHANNEL_EXPANDS_MODEL_BOUNDS.
            if (vertices instanceof Float32Array) {
                this.host.expandModelBoundsWithFlatVertices(vertices, 3);
            } else if ('localVertices' in vertices) {
                this.host.expandModelBoundsWithAnchoredLineVertices(vertices.localVertices, vertices.origin, 3);
            } else {
                for (const partition of vertices) {
                    this.host.expandModelBoundsWithAnchoredLineVertices(partition.localVertices, partition.origin, 3);
                }
            }
            this.host.syncCameraSceneBounds();
        }
        // Rendering is dirty-flag gated (#2442): a channel that changed has to
        // ask for a frame or the change waits for something unrelated to
        // dirty the viewport. Clearing counts as a change; a pre-init call
        // returns above without asking, because it changed nothing.
        this.host.requestRender();
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
        this.section2DOverlayRenderer.uploadClashBoxLines3D(anchoredAabbEdgeLineList(box.min, box.max));
        this.host.requestRender();
    }

    /**
     * See `Renderer.setClashContactLines` for the published contract. Shares the
     * clash-box line buffer, so only one of this / setClashOverlapBox shows.
     */
    setClashContactLines(
        lines: { vertices: LineVertices; color: [number, number, number, number] } | null,
    ): void {
        if (!this.section2DOverlayRenderer) return;
        if (!lines || lineVertexFloatCount(lines.vertices) === 0) {
            this.section2DOverlayRenderer.clearClashBoxLines3D();
            this.host.requestRender();
            return;
        }
        this.section2DOverlayRenderer.setClashBoxLineColor(lines.color);
        this.section2DOverlayRenderer.uploadClashBoxLines3D(lines.vertices);
        this.host.requestRender();
    }

    /** See `Renderer.setClashIntersectionSolid` for the published contract. */
    setClashIntersectionSolid(input: ClashSolidInput | null): void {
        if (!this.clashSolidPipeline) return;
        this.clashSolidPipeline.upload(input);
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
