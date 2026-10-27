/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Globe placement": Anchor (one point plus its tangent frame), Exact (every
 * vertex through the projection, `geo-warp.ts`), or Auto, which picks Exact
 * when the anchor's estimated error exceeds {@link AUTO_EXACT_THRESHOLD_M}.
 *
 * The estimate adds the terms an anchor cannot represent, at the model's
 * farthest horizontal corner r from the anchor (Earth radius R):
 *   - curvature r²/(2R), vertical (2 cm at 500 m, 2 m at 5 km);
 *   - parallel plumb lines |dH|·r/R, horizontal, for the model's height span dH;
 *   - geoid slope |N(corner) − N(anchor)|, vertical (zero with ellipsoidal heights);
 *   - for grid-coordinate sources only, scale variation |k(corner)/k(anchor) − 1|·r.
 *     True-length geometry is drawn at its true length either way.
 * Convergence variation is left out: it nearly cancels against the tangent
 * plane's own meridian convergence (see the research note in the PR).
 */

import proj4 from 'proj4';
import type { GeoMapping } from './geo-warp';
import type { ViewerBounds } from './geo-lattice';
import { computeGridPointFactors, projectedDefinitionInMetres } from './proj4-utils';

export type GlobePlacementMode = 'auto' | 'anchor' | 'exact';
export type ResolvedGlobePlacement = 'anchor' | 'exact';

/** Above this estimated anchor error, Auto places every vertex. */
const AUTO_EXACT_THRESHOLD_M = 0.01;

const EARTH_RADIUS_M = 6_371_000;

export interface AnchorErrorEstimate {
  /** Sum of the terms, metres. */
  total: number;
  curvature: number;
  plumb: number;
  geoidSlope: number;
  scaleVariation: number;
}

export interface AnchorErrorOptions {
  /** The mapping's proj4 definition (or registered `IFC-WKT:` name). */
  projDef: string;
  /** True for grid-coordinate sources (`origin.gridSource !== null`). */
  gridCoordinates: boolean;
  /** The geoid the mapping applies (`() => 0` when heights are ellipsoidal). */
  geoid: (lat: number, lon: number) => number;
  /** Map coordinates of the anchor (`computeCesiumModelOrigin`), metres. */
  anchorMap: { easting: number; northing: number };
}

/** Point scale k at a map position, or null (logged) when proj4 cannot give it. */
function pointScaleAt(projDef: string, easting: number, northing: number, where: string): number | null {
  try {
    return computeGridPointFactors(projDef, easting, northing)?.pointScale ?? null;
  } catch (error) {
    console.warn(`[globe-placement] point scale unavailable at ${where}`, error);
    return null;
  }
}

export function estimateAnchorError(
  mapping: GeoMapping,
  bounds: ViewerBounds,
  options: AnchorErrorOptions,
): AnchorErrorEstimate {
  const { anchor } = mapping;
  const corners: Array<[number, number]> = [
    [bounds.min.x, bounds.min.z], [bounds.max.x, bounds.min.z],
    [bounds.min.x, bounds.max.z], [bounds.max.x, bounds.max.z],
  ];
  const yMid = (bounds.min.y + bounds.max.y) / 2;
  const xMid = (bounds.min.x + bounds.max.x) / 2;
  const zMid = (bounds.min.z + bounds.max.z) / 2;
  const bottom = mapping.toGeodetic(xMid, bounds.min.y, zMid);
  const top = mapping.toGeodetic(xMid, bounds.max.y, zMid);
  const heightSpan = bottom && top ? Math.abs(top.orthometricHeight - bottom.orthometricHeight) : 0;
  const anchorUndulation = options.geoid(anchor.latitude, anchor.longitude);
  const kAnchor = options.gridCoordinates
    ? pointScaleAt(options.projDef, options.anchorMap.easting, options.anchorMap.northing, 'the anchor')
    : null;
  const toMap = kAnchor !== null ? proj4('WGS84', projectedDefinitionInMetres(options.projDef)) : null;
  let r = 0;
  let geoidSlope = 0;
  let scaleVariation = 0;
  const enu = [0, 0, 0];
  for (const [x, z] of corners) {
    if (!mapping.toEnu(x, yMid, z, enu)) continue;
    const dist = Math.hypot(enu[0], enu[1]);
    r = Math.max(r, dist);
    const g = mapping.toGeodetic(x, yMid, z);
    if (!g) continue;
    geoidSlope = Math.max(geoidSlope, Math.abs(options.geoid(g.latitude, g.longitude) - anchorUndulation));
    if (kAnchor === null || !toMap) continue;
    const [easting, northing] = toMap.forward([g.longitude, g.latitude]);
    const k = pointScaleAt(options.projDef, easting, northing, 'a model corner');
    if (k !== null) scaleVariation = Math.max(scaleVariation, Math.abs(k / kAnchor - 1) * dist);
  }
  const curvature = (r * r) / (2 * EARTH_RADIUS_M);
  const plumb = (heightSpan * r) / EARTH_RADIUS_M;
  return { total: curvature + plumb + geoidSlope + scaleVariation, curvature, plumb, geoidSlope, scaleVariation };
}

/** Auto resolves by the estimate; the explicit modes are taken as asked. */
export function resolveGlobePlacement(mode: GlobePlacementMode, estimateMetres: number | null): ResolvedGlobePlacement {
  if (mode !== 'auto') return mode;
  return estimateMetres !== null && estimateMetres > AUTO_EXACT_THRESHOLD_M ? 'exact' : 'anchor';
}

/** What the bridge decided, for the model loader and the Georeferencing panel. */
export interface GlobePlacementPlan {
  requested: GlobePlacementMode;
  mode: ResolvedGlobePlacement;
  /** Null when the model has no bounds to estimate over. */
  estimate: AnchorErrorEstimate | null;
  /**
   * Identity of everything an Exact GLB is baked from (anchor and mapping
   * inputs). Empty in Anchor mode, whose GLB does not depend on the georeference.
   */
  key: string;
}

export function planGlobePlacement(
  requested: GlobePlacementMode,
  mapping: GeoMapping,
  bounds: ViewerBounds | undefined,
  options: AnchorErrorOptions & { mappingKey: unknown },
): GlobePlacementPlan {
  // Anchor needs no estimate to place; it is still computed so the panel can show it.
  const estimate = bounds ? estimateAnchorError(mapping, bounds, options) : null;
  const mode = resolveGlobePlacement(requested, estimate?.total ?? null);
  return { requested, mode, estimate, key: mode === 'exact' ? JSON.stringify(['exact', options.mappingKey]) : '' };
}
