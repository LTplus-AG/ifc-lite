/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate one zone per building storey, spanning the model's horizontal X-Z
 * footprint bounds — the viewer frame is Y-up — (issue #1810 v1, generation path (b)). Pure — callers gather the storey
 * list + bounds from the loaded model(s) (see the store slice for how that
 * uses `@ifc-lite/data`'s canonical storey-elevation contract, PR #1857) and
 * hand them in here.
 *
 * A storey's zone height is the gap to the next storey up; the topmost
 * storey (no "next" to measure against) falls back to
 * `DEFAULT_STOREY_ZONE_HEIGHT_M` since a raw IFC storey list carries no
 * "roof height" — a known v1 simplification, easy to override afterwards
 * via numeric editing.
 */

import type { Zone } from './types.js';

/** Minimal per-storey input: caller-chosen identity (e.g. a federated global
 *  id, or `${modelId}:${expressId}` for cross-model uniqueness) plus name +
 *  elevation in the viewer's world frame (Y-up), metres. */
export interface StoreyInfo {
  id: string;
  name: string;
  elevation: number;
}

/** World-space XY (X/Z in viewer Y-up terms) footprint to span. */
export interface XYBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const DEFAULT_STOREY_ZONE_HEIGHT_M = 3.5;
/** Floor so a degenerate/duplicate elevation can't produce a zero-thickness
 *  (or inverted) box. */
export const MIN_STOREY_ZONE_HEIGHT_M = 0.1;

/**
 * One axis-aligned (rotationY = 0) zone per storey, sorted by elevation,
 * each spanning `bounds` in X/Z and `[elevation, elevation + height)` in Y.
 * `makeId` is injectable so callers can supply `crypto.randomUUID` in the
 * browser and a deterministic generator in tests.
 */
export function generateStoreyZones(
  storeys: readonly StoreyInfo[],
  bounds: XYBounds,
  makeId: () => string,
): Zone[] {
  const sorted = [...storeys].sort((a, b) => a.elevation - b.elevation);
  const width = Math.max(0, bounds.maxX - bounds.minX);
  const depth = Math.max(0, bounds.maxZ - bounds.minZ);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  return sorted.map((storey, i) => {
    const next = sorted[i + 1];
    const gap = next ? next.elevation - storey.elevation : DEFAULT_STOREY_ZONE_HEIGHT_M;
    const height = Math.max(MIN_STOREY_ZONE_HEIGHT_M, gap);
    const centerY = storey.elevation + height / 2;
    return {
      id: makeId(),
      name: storey.name || `Storey (${storey.elevation.toFixed(2)}m)`,
      center: [centerX, centerY, centerZ],
      size: [width, height, depth],
      rotationY: 0,
    };
  });
}
