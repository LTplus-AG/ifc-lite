/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF export coordinate mapping (issue #1861): recovers true IFC world (and,
 * when georeferenced, map/CRS) coordinates from `Drawing2D`'s render-frame
 * drawing space, for a plan ('down') section.
 *
 * `Drawing2D` arrives PRE-MIRRORED on a flipped section: both cutters apply
 * the same U-axis flip before this code ever sees a point — the CPU path via
 * `projectTo2D(point, axis, flipped)` in `math.ts` (`x: flipped ? -u : u`),
 * the GPU path via `gpu-section-cutter.ts`'s `flipU` uniform, which
 * multiplies the projected U coordinate by -1 in the shader before it's
 * written out (`createPlaneData`: `data[6] = config.flipped ? -1.0 : 1.0`).
 * So for a flipped section, `drawing_x = -u` where `u` is the point's true
 * (unflipped) render-frame X; for an unflipped section, `drawing_x = u`.
 *
 * `flipped` exists purely as a *display* convention (which way the plan
 * reads on screen) — it is not a change in where the model actually sits.
 * A georeferenced CAD export must therefore report the SAME world/map
 * coordinate for the same physical point regardless of how the user had the
 * viewer's flip toggle set when they hit "Download DXF". The `(flipped ?
 * -p.x : p.x)` term below is exactly `u = flipped ? -drawing_x :
 * drawing_x)` — it UNDOES the cutter's pre-mirror, not adds a new one. The
 * net effect, by design, is that `buildDxfExportTransform`'s output is
 * flip-invariant: flipped and unflipped exports of the same section produce
 * byte-identical DXF coordinates. (This looks like a bug in isolation — a
 * flip that appears to do nothing — until you know the input was already
 * mirrored; see `dxfExportGeoref.test.ts`'s invariance test.)
 *
 * The render-frame shift (`dxfWorldShift`, shared with the DXF-underlay
 * import path in `dxfUnderlayMath.ts`) is unrelated to the flip and is
 * always undone the same way:
 *
 *   world_x = (flipped ? -drawing_x : drawing_x) + shift.x
 *   world_y = shift.y - drawing_y     // IFC Y (north), metres
 *
 * When the model carries an `IfcMapConversion` (+ `IfcProjectedCRS`), the
 * world point is further projected to map (CRS) coordinates using the same
 * eastings/northings/rotation/scale formula `reproject.ts` uses for the
 * model centre (`computeProjectedCenter`), just evaluated per point instead
 * of once at the bounds centre.
 *
 * Only a plan ('down', non-custom-plane) section has a 2D CAD-meaningful
 * georeference; front/side/custom sections pass through unchanged (per
 * issue #1861: "vertical sections ... export in drawing coordinates").
 */

import type { Point2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { dxfWorldShift } from './dxfUnderlayMath';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from '@/lib/geo/geo-scale';
import {
  selectAnchorGeoref,
  type SelectAnchorGeorefParams,
} from '@/lib/geo/useAnchorGeoreference';

/** The subset of `EffectiveGeoreference` the DXF export transform needs. */
export interface DxfExportGeoreference {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
  /** IFC project length-unit → metres (from `IfcUnitAssignment`). */
  lengthUnitScale: number;
}

/**
 * Resolve the georeference a DXF export should target: the federation
 * *anchor* model's effective georef — the file's IfcMapConversion /
 * IfcProjectedCRS merged with any user placement edits. Placement changes
 * applied in `CesiumPlacementEditor` land in the store's `georefMutations`
 * map (keyed by model id, `'__legacy__'` for the single-model store), NOT
 * in `ifcDataStore`, so reading the data store alone exports the original
 * file coordinates while the viewer displays the edited placement (PR
 * #1871 review, P1). Delegates to {@link selectAnchorGeoref} — the exact
 * pinned-anchor / earliest-loaded / legacy-fallback rule ViewportContainer's
 * Cesium georef memo and the measure readout use — so the exported DXF
 * always agrees with the placement the viewer shows, and a georef the user
 * ADDED entirely via the editor (no file georef) is exported too.
 */
export function resolveDxfExportGeoreference(
  params: SelectAnchorGeorefParams,
): DxfExportGeoreference | null {
  const selection = selectAnchorGeoref(params);
  if (!selection) return null;
  const { mapConversion, projectedCRS, lengthUnitScale } = selection.eff;
  return { mapConversion, projectedCRS, lengthUnitScale };
}

export interface DxfExportTransformParams {
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined;
  sectionAxis: 'down' | 'front' | 'side';
  isCustomPlane: boolean;
  flipped: boolean;
  /** Present only when the model has a standard IfcMapConversion + IfcProjectedCRS. */
  georeference?: DxfExportGeoreference | null;
}

/**
 * Build the drawing-space → export-space point transform for DXF export.
 * Plan sections recover true IFC world coordinates (and, when available,
 * project them to map/CRS coordinates); every other section is the
 * identity function.
 */
export function buildDxfExportTransform(params: DxfExportTransformParams): (p: Point2D) => Point2D {
  const { coordinateInfo, sectionAxis, isCustomPlane, flipped, georeference } = params;
  if (sectionAxis !== 'down' || isCustomPlane) {
    return (p) => p;
  }

  const shift = dxfWorldShift(coordinateInfo);
  const toWorld = (p: Point2D): Point2D => ({
    x: (flipped ? -p.x : p.x) + shift.x,
    y: shift.y - p.y,
  });

  if (!georeference) return toWorld;

  const { mapConversion, projectedCRS, lengthUnitScale } = georeference;
  const mapUnitScale = resolveMapUnitToMetreScale(projectedCRS.mapUnitScale, lengthUnitScale);
  // Guard the pathological IfcMapConversion.Scale = 0 (or negative/NaN):
  // getEffectiveHorizontalScale passes an explicit 0 through, which would
  // collapse every exported point onto the eastings/northings origin.
  // Exporting unscaled (1) keeps the geometry intact, which is strictly
  // less wrong than a single-point file.
  const rawEffectiveScale = getEffectiveHorizontalScale(mapConversion.scale, mapUnitScale, lengthUnitScale);
  const scale = Number.isFinite(rawEffectiveScale) && rawEffectiveScale > 0 ? rawEffectiveScale : 1;
  // IfcMapConversion.XAxisAbscissa/XAxisOrdinate form a direction vector, not
  // necessarily unit length — the IFC spec allows an authoring tool to write
  // any non-zero (cos, sin)-proportional pair. Used raw, a non-unit vector
  // scales the whole exported drawing by its magnitude. Normalize exactly
  // like the Rust source of truth (rust/core/src/georef.rs normalize_axis);
  // a near-zero vector (both components ~0) falls back to the no-rotation
  // default (1, 0), matching that function's guard.
  const rawAbscissa = mapConversion.xAxisAbscissa ?? 1;
  const rawOrdinate = mapConversion.xAxisOrdinate ?? 0;
  const axisLen = Math.hypot(rawAbscissa, rawOrdinate);
  const abscissa = axisLen < 1e-9 ? 1 : rawAbscissa / axisLen;
  const ordinate = axisLen < 1e-9 ? 0 : rawOrdinate / axisLen;

  return (p) => {
    const world = toWorld(p);
    return {
      x: mapConversion.eastings * mapUnitScale + scale * (abscissa * world.x - ordinate * world.y),
      y: mapConversion.northings * mapUnitScale + scale * (ordinate * world.x + abscissa * world.y),
    };
  };
}
