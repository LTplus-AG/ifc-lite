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
import { extractWallSegmentsForStorey, type OverlayWallReader } from './extract-walls.js';
import { detectEnclosedAreas, type DetectedSpace } from './auto-space-detect.js';
import { addSpaceToStore, type SpaceBuildResult } from './space.js';

export interface GenerateSpacesOptions {
  /** Snap tolerance for wall-end vertex merge. Default 0.05 m. */
  snapTolerance?: number;
  /** Drop detected regions below this area. Default 0.5 m². */
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
}

export interface GenerateSpacesResult {
  /** Total walls considered (existing + overlay) on the storey. */
  wallsConsidered: number;
  /** Walls that contributed an axis segment to the planar graph. */
  wallsContributing: number;
  /** Enclosed regions detected (before min-area filter, in candidate count). */
  detected: DetectedSpace[];
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

  const extraction = extractWallSegmentsForStorey(store, storeyExpressId, overlay);
  const detected = detectEnclosedAreas(extraction.segments, {
    snapTolerance: options.snapTolerance,
    minArea: options.minArea,
  });

  const emitted: GenerateSpacesResult['emitted'] = [];
  if (options.dryRun || detected.length === 0) {
    return {
      wallsConsidered: extraction.contributingWallIds.length + extraction.skippedWallIds.length,
      wallsContributing: extraction.contributingWallIds.length,
      detected,
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
      LongName: options.longName,
      PredefinedType: options.predefinedType,
    });
    emitted.push({ region, result, name });
  });

  return {
    wallsConsidered: extraction.contributingWallIds.length + extraction.skippedWallIds.length,
    wallsContributing: extraction.contributingWallIds.length,
    detected,
    emitted,
  };
}
