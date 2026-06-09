/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stitch together the auto-space pipeline for a single storey:
 *
 *   walls (existing + overlay)
 *     → 2D axis segments (`extractWallSegmentsForStorey`)
 *     → enclosed regions (`detectEnclosedAreas`)
 *     → IfcSpace per region (`addSpaceToStore` polygon mode)
 *
 * Pure orchestration — the geometry/IFC heavy lifting lives in the
 * dedicated modules. The result lists every IfcSpace expressId emitted
 * plus a richer per-region summary (area, outline) for UI feedback.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import {
  extractWallSegmentsForStorey,
  type OverlayWallReader,
  type WallSkip,
} from './extract-walls.js';
import {
  detectEnclosedAreasWithStats,
  type DetectedSpace,
  type DetectStats,
  type Segment,
  type Vec2,
} from './auto-space-detect.js';
import { addSpaceToStore, type SpaceBuildResult } from './space.js';

/**
 * IfcSpace.ObjectType marker stamped on every derived space, so a re-run can
 * recognise its own output and skip it instead of duplicating (idempotency),
 * and so generated spaces are filterable downstream.
 */
export const GENERATED_SPACE_OBJECTTYPE = 'IfcLite:GeneratedSpace';

export interface GenerateSpacesOptions {
  /** Snap tolerance for wall-end vertex merge in METRES. Default 0.1 m. */
  snapTolerance?: number;
  /** Drop detected regions below this area in m². Default 0.5 m². */
  minArea?: number;
  /** IfcSpace extrusion height (m). Default 3. */
  height?: number;
  /**
   * Naming pattern for emitted spaces. `{n}` is replaced with a 1-based
   * index. Default `'Space {n}'`.
   */
  namePattern?: string;
  /** Optional IfcSpacePredefinedType (defaults to INTERNAL). */
  predefinedType?: string;
  /** Optional override for IfcSpace.LongName (single value, all spaces). */
  longName?: string;
  /** When true, runs detection but doesn't emit any IfcSpace. */
  dryRun?: boolean;
  /**
   * When true, every stage of the pipeline (wall extraction →
   * detection) emits `console.debug` messages so the viewer's
   * Auto Spaces "no regions detected" failure mode can be diagnosed
   * from devtools without touching the algorithm. The result also
   * carries detection stats unconditionally.
   */
  debug?: boolean;
  /**
   * Additional element types to treat as space dividers (passed to
   * the wall extractor verbatim — case-insensitive). The defaults
   * already cover walls, curtain walls, virtual elements, plates,
   * members, and railings.
   */
  extraDividerTypes?: string[];
}

export interface GenerateSpacesResult {
  /** Total walls considered (existing + overlay) on the storey. */
  wallsConsidered: number;
  /** Walls that contributed an axis segment to the planar graph. */
  wallsContributing: number;
  /** Walls dropped by the extractor, with the reason (best-effort). */
  wallsSkipped: WallSkip[];
  /** Enclosed regions detected (after min-area + outer-face filter). */
  detected: DetectedSpace[];
  /** Per-stage planar-graph statistics — surfaced for diagnostics. */
  detectionStats: DetectStats;
  /** Per-region builder result. Empty when `dryRun: true`. */
  emitted: Array<{ region: DetectedSpace; result: SpaceBuildResult; name: string }>;
}

export function generateSpacesFromWalls(
  editor: StoreEditor,
  store: IfcDataStore,
  storeyExpressId: number,
  options: GenerateSpacesOptions = {},
  overlay?: OverlayWallReader,
): GenerateSpacesResult {
  const height = options.height ?? 3;
  const namePattern = options.namePattern ?? 'Space {n}';
  if (height <= 0) {
    throw new Error('generateSpacesFromWalls: height must be positive');
  }

  const debug = !!options.debug;
  const log = debug ? (...args: unknown[]) => console.debug('[generate-spaces]', ...args) : () => {};
  log(`storey #${storeyExpressId}: starting auto-space generation`);

  const extraction = extractWallSegmentsForStorey(store, storeyExpressId, overlay, {
    debug,
    extraDividerTypes: options.extraDividerTypes,
  });
  log(`extracted ${extraction.segments.length} segments from ${extraction.considered} walls (${extraction.skipped.length} skipped); unitScale=${extraction.lengthUnitScale}`);

  // Snap tolerance / min area are user-friendly metres. Segments are
  // also already converted to metres by the extractor, so no further
  // unit-scaling is needed here.
  const detection = detectEnclosedAreasWithStats(extraction.segments, {
    snapTolerance: options.snapTolerance ?? 0.1,
    minArea: options.minArea ?? 0.5,
    debug,
  });
  const detected = detection.spaces;

  // Always log a one-liner summary at info level so users see something
  // in devtools without flipping the debug flag — the most common
  // failure ("no regions detected") becomes self-explanatory.
  const unitNote = extraction.lengthUnitScale === 1 ? 'metres'
    : extraction.lengthUnitScale === 0.001 ? 'millimetres'
    : `scale ${extraction.lengthUnitScale}`;
  console.info(
    `[auto-spaces] storey #${storeyExpressId}: ${detected.length} region(s) from ${extraction.contributingWallIds.length}/${extraction.considered} walls — ` +
    `${detection.stats.vertices}v / ${detection.stats.segmentsAfterSplit}e / ${detection.stats.faces}f ` +
    `(dropped ${detection.stats.outerFacesDropped} outer + ${detection.stats.belowMinAreaDropped} small) [${unitNote}].`,
  );

  const emitted: GenerateSpacesResult['emitted'] = [];
  if (options.dryRun || detected.length === 0) {
    return {
      wallsConsidered: extraction.considered,
      wallsContributing: extraction.contributingWallIds.length,
      wallsSkipped: extraction.skipped,
      detected,
      detectionStats: detection.stats,
      emitted,
    };
  }

  const anchor = resolveSpatialAnchor(store, storeyExpressId);
  if (!anchor) {
    throw new Error(`generateSpacesFromWalls: no resolvable spatial anchor for storey #${storeyExpressId}`);
  }

  detected.forEach((region, i) => {
    const name = namePattern.replace('{n}', String(i + 1));
    const result = addSpaceToStore(editor, anchor, {
      Profile: 'polygon',
      OuterCurve: region.outline,
      Height: height,
      Name: name,
      ObjectType: GENERATED_SPACE_OBJECTTYPE,
      LongName: options.longName,
      PredefinedType: options.predefinedType,
      boundaryElementIds: matchBoundaryWalls(
        region.outline,
        extraction.segments,
        extraction.contributingWallIds,
      ),
    });
    emitted.push({ region, result, name });
  });

  return {
    wallsConsidered: extraction.considered,
    wallsContributing: extraction.contributingWallIds.length,
    wallsSkipped: extraction.skipped,
    detected,
    detectionStats: detection.stats,
    emitted,
  };
}

/**
 * Map each edge of a detected room outline back to the wall(s) it runs along,
 * so the bake can emit IfcRelSpaceBoundary linking the space to its real
 * bounding walls. `segments[k]` was extracted from `wallIds[k]` (1:1), and an
 * outline edge lies on a wall's centreline, so we match by: parallel direction,
 * the edge midpoint sitting on the wall's line, and overlapping extent.
 * (Corner-snap only moves endpoints along a wall's line, so the line — hence
 * the match — is unaffected.)
 */
function matchBoundaryWalls(outline: Vec2[], segments: Segment[], wallIds: number[]): number[] {
  const PERP_TOL = 0.2;   // m — edge sits on the wall centreline
  const PARALLEL_TOL = 0.03;
  const OVERLAP_MARGIN = 0.3; // m
  const ids = new Set<number>();
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    let ex = b[0] - a[0];
    let ey = b[1] - a[1];
    const el = Math.hypot(ex, ey);
    if (el < 1e-6) continue;
    ex /= el; ey /= el;
    for (let k = 0; k < segments.length; k++) {
      const sa = segments[k].a;
      const sb = segments[k].b;
      let sx = sb[0] - sa[0];
      let sy = sb[1] - sa[1];
      const sl = Math.hypot(sx, sy);
      if (sl < 1e-6) continue;
      sx /= sl; sy /= sl;
      if (Math.abs(ex * sy - ey * sx) > PARALLEL_TOL) continue; // not parallel
      const t = (mx - sa[0]) * sx + (my - sa[1]) * sy;          // projection onto wall (m)
      const px = sa[0] + sx * t;
      const py = sa[1] + sy * t;
      if (Math.hypot(mx - px, my - py) > PERP_TOL) continue;     // edge off the wall line
      if (t < -OVERLAP_MARGIN || t > sl + OVERLAP_MARGIN) continue; // no extent overlap
      ids.add(wallIds[k]);
    }
  }
  return [...ids];
}
