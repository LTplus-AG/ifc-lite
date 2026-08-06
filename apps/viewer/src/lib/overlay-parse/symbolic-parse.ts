/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Symbolic-annotation (IfcAnnotation / IfcGridAxis) parse, extracted from
 * `hooks/useSymbolicAnnotations.ts` so it can run off the React tree.
 *
 * The walk takes a plain `Uint8Array` source plus the two spatial-hierarchy
 * lookups it needs, deliberately NOT an `IfcDataStore`: a worker module cannot
 * import a React hook file, and the store is not structured-cloneable. The
 * `hasEntityType` pre-filter stays at the call site because it reads
 * `store.entityIndex`, which is not part of this input.
 */

import { GeometryProcessor } from '@ifc-lite/geometry';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import { decodeIfcString } from '@ifc-lite/encoding';

/** Lines belonging to a single storey, ready to feed into the section overlay. */
export interface AnnotationsForStorey {
  storeyId: number;
  /** Authored `IfcBuildingStorey.Elevation`. `null` means the storey carried
   *  no elevation in the parsed metadata — distinguishing that from a real
   *  ground-floor at 0.0 matters because `resolveBucketY` only wants to swap
   *  in the fallback in the missing case, not for legitimate ground floors. */
  storeyElevation: number | null;
  lines: DrawingLine2D[];
  texts: AnnotationText2D[];
  fills: AnnotationFill2D[];
}

/**
 * A single text label in renderer 2D space (XZ on the section plane).
 *
 * `dirX / dirY` encodes the baseline direction (already mirrored to match the
 * Y-negated 2D coord system that lines and circles use). `height` is in world
 * units. `alignment` is the raw IFC `BoxAlignment` string ("bottom-left",
 * "center", …) — the renderer interprets it.
 */
export interface AnnotationText2D {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  height: number;
  content: string;
  alignment: string;
  /** Express ID of the owning IfcAnnotation / IfcGridAxis entity (per-entity hide). */
  ownerId: number;
  /**
   * For multi-line text literals (e.g. CJK descriptions with `\X\0A`
   * newlines), one IfcTextLiteralWithExtent expands into one AnnotationText2D
   * per line. `lineYOffset` is added to the storey-elevation world-Y at 3D
   * conversion so successive lines stack downward (negative Y) below the
   * shared anchor. Optional — single-line literals leave it undefined.
   */
  lineYOffset?: number;
  /**
   * When true, the renderer rebuilds the glyph quad in screen-aligned
   * (cameraRight, cameraUp) basis so the text always faces the camera.
   * Set for every annotation literal (grid bubbles, dimension callouts,
   * leader labels) so they stay legible in any view — flat-in-plane text
   * collapses to a sliver at oblique angles (issue #812). Defaults to false.
   */
  billboard?: boolean;
  /** sRGB straight-alpha tint (0..1). Defaults to renderer near-black. */
  color?: [number, number, number, number];
  /** Per-instance target cap height in screen pixels. 0/undef = renderer default. */
  targetPx?: number;
}

/**
 * A single filled region in renderer 2D space. Outer ring + holes flattened
 * into one `points` array; `holesOffsets` marks where each hole starts (in
 * vertex indices, not floats). Empty `holesOffsets` = simple polygon.
 *
 * `hatching` is present when the IFC style chain resolved to an
 * IfcFillAreaStyleHatching. When absent the fill is solid (color only).
 */
export interface AnnotationFill2D {
  points: Float32Array;
  holesOffsets: Uint32Array;
  color: [number, number, number, number];
  /** Express ID of the owning IfcAnnotation / IfcGridAxis entity (per-entity hide). */
  ownerId: number;
  hatching?: {
    spacing: number;
    angle: number;
    angleSecondary: number | null;
    lineWidth: number;
  };
}

/** Cached parse result keyed by source identity.
 *
 * IfcAnnotation and IfcGridAxis primitives are stored in PARALLEL bucket
 * collections (issue #862). They share the same parse pass and the same
 * storey-resolution logic, but the renderer treats them differently:
 *
 *   - Annotation buckets always lift every storey (memory
 *     `feedback_3d_annotation_overlay_no_section_filter.md`: the user
 *     expects every storey's dimensions to be visible in 3D).
 *   - Grid buckets get optional section-plane filtering and an
 *     independent visibility toggle, so dense-grid models can hide
 *     grids per storey without losing dimensions.
 */
export interface ParseResult {
  // IfcAnnotation buckets
  byStorey: Map<number, AnnotationsForStorey>;
  loose: DrawingLine2D[];
  looseTexts: AnnotationText2D[];
  looseFills: AnnotationFill2D[];

  // IfcGridAxis buckets (issue #862)
  gridByStorey: Map<number, AnnotationsForStorey>;
  gridLoose: DrawingLine2D[];
  gridLooseTexts: AnnotationText2D[];
  gridLooseFills: AnnotationFill2D[];
}

/** The empty (nothing parsed) result. Also used by callers that short-circuit
 *  before the walk — e.g. the `hasEntityType` pre-filter in the hook. */
export function createEmptyParseResult(): ParseResult {
  return {
    byStorey: new Map(),
    loose: [],
    looseTexts: [],
    looseFills: [],
    gridByStorey: new Map(),
    gridLoose: [],
    gridLooseTexts: [],
    gridLooseFills: [],
  };
}

const CIRCLE_SEGMENTS_FULL = 32;
const CIRCLE_SEGMENTS_ARC = 16;

/**
 * Convert a polyline (Float32Array of [x,y,x,y,…]) into start/end segments.
 * Exported for unit testing.
 */
export function polylineToSegments(
  points: Float32Array,
  pointCount: number,
  isClosed: boolean,
  out: DrawingLine2D[],
  ownerId = 0,
): void {
  for (let j = 0; j < pointCount - 1; j++) {
    out.push({
      line: {
        start: { x: points[j * 2], y: points[j * 2 + 1] },
        end:   { x: points[(j + 1) * 2], y: points[(j + 1) * 2 + 1] },
      },
      category: 'annotation',
      ownerId,
    });
  }
  if (isClosed && pointCount > 2) {
    out.push({
      line: {
        start: { x: points[(pointCount - 1) * 2], y: points[(pointCount - 1) * 2 + 1] },
        end:   { x: points[0], y: points[1] },
      },
      category: 'annotation',
      ownerId,
    });
  }
}

/**
 * Tessellate a circle/arc into chord segments.
 * Exported for unit testing.
 */
export function circleToSegments(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  isFullCircle: boolean,
  out: DrawingLine2D[],
  ownerId = 0,
): void {
  const numSegments = isFullCircle ? CIRCLE_SEGMENTS_FULL : CIRCLE_SEGMENTS_ARC;
  for (let j = 0; j < numSegments; j++) {
    const t1 = j / numSegments;
    const t2 = (j + 1) / numSegments;
    const a1 = startAngle + t1 * (endAngle - startAngle);
    const a2 = startAngle + t2 * (endAngle - startAngle);
    out.push({
      line: {
        start: { x: centerX + radius * Math.cos(a1), y: centerY + radius * Math.sin(a1) },
        end:   { x: centerX + radius * Math.cos(a2), y: centerY + radius * Math.sin(a2) },
      },
      category: 'annotation',
      ownerId,
    });
  }
}

/** Set `localStorage.IFC_ANNOTATIONS_DEBUG = '1'` in the browser to log
 *  per-store parse counts + lift vertex counts to the console. Off by
 *  default; useful when triaging "no annotations visible" reports. */
export const debugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage?.getItem('IFC_ANNOTATIONS_DEBUG') === '1'; }
  catch { return false; }
};

/** Everything the symbolic-annotation walk needs off an `IfcDataStore`. */
export interface SymbolicParseInput {
  source: Uint8Array;
  /** store.spatialHierarchy?.elementToStorey */
  elementToStorey?: ReadonlyMap<number, number>;
  /** store.spatialHierarchy?.storeyElevations */
  storeyElevations?: ReadonlyMap<number, number>;
}

export async function parseSymbolicAnnotations(
  input: SymbolicParseInput,
): Promise<ParseResult> {
  const result: ParseResult = createEmptyParseResult();
  const source = input.source;
  if (!source || source.byteLength === 0) {
    if (debugEnabled()) console.log('[annotations] skip: missing/empty source');
    return result;
  }

  const elementToStorey = input.elementToStorey;
  const storeyElevations = input.storeyElevations;

  const processor = new GeometryProcessor();
  try {
    await processor.init();
    // SymbolicRepresentationCollection and each getPolyline/getCircle/getText/
    // getFill item are wasm-bindgen handles owning WASM memory — free them
    // deterministically (AGENTS.md §7). Leaking them to GC lets the
    // FinalizationRegistry free them later against an already-grown/reused
    // shared dlmalloc heap, corrupting the allocator free-list.
    const collection = processor.parseSymbolicRepresentations(source);
    if (debugEnabled()) {
      console.log(
        `[annotations] parsed ${source.byteLength} bytes →`,
        collection
          ? `${collection.polylineCount} polylines, ${collection.circleCount} circles, ${collection.textCount} texts, ${collection.fillCount} fills`
          : 'null',
      );
    }
    if (!collection) return result;
    try {
    if (collection.isEmpty) return result;

    // Resolve a bucket by elevation rather than by storey id.
    //
    // The legacy path used `elementToStorey` exclusively — which breaks for
    // 3DEXPERIENCE / IfcPlusPlus exports whose `IfcRelAggregates` leaves
    // storeys orphaned so `SpatialHierarchyBuilder` reports "No storeys
    // found". Those files still encode the elevation on each item's
    // geometry (the IfcCartesianPoint.Z), which the WASM extractor now
    // surfaces as `primitive.worldY`. Bucketing by Y means every annotation
    // lands at the right floor regardless of whether the spatial hierarchy
    // could be built.
    //
    // Priority: explicit primitive worldY → fall back to storey-table
    // elevation → null (loose bucket, renders at fallbackY).
    //
    // Bucket keys are millimetre-rounded Y so two storeys 1mm apart still
    // collapse to one bucket — that's the precision Revit etc. round to.
    const ensureBucket = (
      expressId: number,
      primitiveWorldY: number,
      ifcType: string,
    ): AnnotationsForStorey | null => {
      let effectiveY: number | null = null;
      if (Number.isFinite(primitiveWorldY) && primitiveWorldY !== 0) {
        effectiveY = primitiveWorldY;
      } else {
        const storeyId = elementToStorey?.get(expressId);
        if (storeyId !== undefined) {
          const elev = storeyElevations?.get(storeyId);
          if (typeof elev === 'number' && Number.isFinite(elev)) effectiveY = elev;
        }
      }
      if (effectiveY === null) return null;
      const key = Math.round(effectiveY * 1000);
      // Issue #862: IfcGridAxis primitives land in a parallel bucket
      // collection so the renderer can section-clip + visibility-toggle
      // them independently of IfcAnnotation (text/dimension symbols).
      const storeyMap = ifcType === 'IfcGridAxis' ? result.gridByStorey : result.byStorey;
      let bucket = storeyMap.get(key);
      if (!bucket) {
        bucket = {
          storeyId: key,
          storeyElevation: effectiveY,
          lines: [],
          texts: [],
          fills: [],
        };
        storeyMap.set(key, bucket);
      }
      return bucket;
    };

    for (let i = 0; i < collection.polylineCount; i++) {
      const poly = collection.getPolyline(i);
      if (!poly) continue;
      try {
        if (poly.ifcType !== 'IfcAnnotation' && poly.ifcType !== 'IfcGridAxis') continue;
        const bucket = ensureBucket(poly.expressId, poly.worldY, poly.ifcType);
        const looseTarget = poly.ifcType === 'IfcGridAxis' ? result.gridLoose : result.loose;
        const out = bucket ? bucket.lines : looseTarget;
        // poly.points is consumed synchronously here (not stored), so no copy needed.
        polylineToSegments(poly.points, poly.pointCount, poly.isClosed, out, poly.expressId);
      } finally {
        poly.free();
      }
    }

    for (let i = 0; i < collection.circleCount; i++) {
      const circle = collection.getCircle(i);
      if (!circle) continue;
      try {
        if (circle.ifcType !== 'IfcAnnotation' && circle.ifcType !== 'IfcGridAxis') continue;
        const bucket = ensureBucket(circle.expressId, circle.worldY, circle.ifcType);
        const looseTarget = circle.ifcType === 'IfcGridAxis' ? result.gridLoose : result.loose;
        const out = bucket ? bucket.lines : looseTarget;
        circleToSegments(
          circle.centerX,
          circle.centerY,
          circle.radius,
          circle.startAngle,
          circle.endAngle,
          circle.isFullCircle,
          out,
          circle.expressId,
        );
      } finally {
        circle.free();
      }
    }

    for (let i = 0; i < collection.textCount; i++) {
      const text = collection.getText(i);
      if (!text) continue;
      try {
      if (text.ifcType !== 'IfcAnnotation' && text.ifcType !== 'IfcGridAxis') continue;
      // Skip empty literals so the renderer doesn't waste an instance slot.
      // Decode STEP escapes — `\X2\NNNN\X0\` (UTF-16 hex code units) and
      // `\X\NN` (Latin-1 hex byte). The Rust parser intentionally passes
      // the literal through verbatim; this is where the JS encoding
      // package gets applied. Without it, non-ASCII annotation labels
      // (e.g. CJK content) render as raw escape sequences in the atlas.
      const decoded = decodeIfcString(text.content);
      if (decoded.length === 0) continue;

      // Multi-line split: IfcTextLiteralWithExtent.SizeInY is the LAYOUT BOX
      // height, not the glyph cap height. The Rust extractor multiplies
      // SizeInY × 0.7 to recover a single-line cap; for multi-line literals
      // we further divide by line count and stack lines downward in world-Y.
      // Source: IFC4 spec — IfcPlanarExtent describes the bounding box of
      // the typeset string; one literal per line is the conventional
      // rendering model (matches BIMvision / Solibri / Revit).
      const lines = decoded.split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length === 0) continue;
      const perLineHeight = lines.length > 1 ? text.height / lines.length : text.height;
      // Industry-standard line-spacing (CSS line-height ≈ 1.2). Picks up
      // a little air between rows so descenders don't kiss the next cap.
      const lineSpacing = perLineHeight * 1.2;
      const bucket = ensureBucket(text.expressId, text.worldY, text.ifcType);
      const looseTextTarget = text.ifcType === 'IfcGridAxis' ? result.gridLooseTexts : result.looseTexts;
      // All annotation text — grid bubbles, dimension callouts, leader labels —
      // billboards to the camera so it stays legible in any view orientation
      // (top-down, eye-level, oblique). The shader rebuilds the quad in the
      // screen-aligned basis at render time. Authored orientation is intentionally
      // dropped: at oblique viewing angles, flat-in-plane text becomes a smeared
      // sliver of pixels (issue #812). Anchor + alignment are preserved, so each
      // label still sits at its authored insertion point.
      // Read per-instance style metadata. WASM emits these for grid
      // bubble parts (● fill / ○ outline / tag) and reserves them for
      // future IfcTextStyle resolution on regular annotation text.
      const colorA = text.colorA;
      const hasColor = colorA > 0;
      const textColor: [number, number, number, number] | undefined = hasColor
        ? [text.colorR, text.colorG, text.colorB, colorA]
        : undefined;
      const targetPx = text.targetPx > 0 ? text.targetPx : undefined;
      for (let li = 0; li < lines.length; li++) {
        const t2d: AnnotationText2D = {
          x: text.x,
          y: text.y,
          dirX: text.dirX,
          dirY: text.dirY,
          height: perLineHeight,
          content: lines[li],
          alignment: text.alignment,
          lineYOffset: -li * lineSpacing,
          billboard: true,
          color: textColor,
          targetPx,
          ownerId: text.expressId,
        };
        (bucket ? bucket.texts : looseTextTarget).push(t2d);
      }
      } finally {
        text.free();
      }
    }

    for (let i = 0; i < collection.fillCount; i++) {
      const fill = collection.getFill(i);
      if (!fill) continue;
      try {
        if (fill.ifcType !== 'IfcAnnotation' && fill.ifcType !== 'IfcGridAxis') continue;
        // fill.points / fill.holesOffsets are getter results that may be views
        // into WASM memory; they're STORED into f2d (outlive this iteration),
        // so copy them before the handle is freed below. Element types match
        // the AnnotationFill2D fields (Float32Array / Uint32Array).
        const points = new Float32Array(fill.points);
        if (points.length < 6) continue; // <3 vertices = no polygon
        const holesOffsets = new Uint32Array(fill.holesOffsets);
        const f2d: AnnotationFill2D = {
          points,
          holesOffsets,
          color: [fill.fillR, fill.fillG, fill.fillB, fill.fillA],
          ownerId: fill.expressId,
          hatching: fill.hasHatching
            ? {
                spacing: fill.hatchSpacing,
                angle: fill.hatchAngle,
                angleSecondary: Number.isNaN(fill.hatchAngleSecondary) ? null : fill.hatchAngleSecondary,
                lineWidth: fill.hatchLineWidth,
              }
            : undefined,
        };
        const bucket = ensureBucket(fill.expressId, fill.worldY, fill.ifcType);
        const looseFillTarget = fill.ifcType === 'IfcGridAxis' ? result.gridLooseFills : result.looseFills;
        (bucket ? bucket.fills : looseFillTarget).push(f2d);
      } finally {
        fill.free();
      }
    }
    } finally {
      collection.free();
    }
  } finally {
    processor.dispose();
  }

  return result;
}
