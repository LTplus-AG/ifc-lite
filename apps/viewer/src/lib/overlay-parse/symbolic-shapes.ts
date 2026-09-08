/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Result contracts and pure tessellation helpers for the symbolic-annotation
 * parse. Split from `symbolic-parse.ts` to keep both modules under the ~400
 * line house limit; that file owns the WASM walk, this one owns the shapes it
 * produces and the geometry helpers it uses.
 *
 * Nothing here touches WASM or the DOM, so it is safe to import from a worker,
 * the React tree, or a test.
 */

import type { DrawingLine2D } from '@ifc-lite/renderer';
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
