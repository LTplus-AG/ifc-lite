/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF export coordinate mapping (issue #1861): the drawing-space →
 * world/map-space inverse of `dxfUnderlayMath.ts`'s `worldToDrawing`.
 *
 * `useDxfUnderlaysForDrawing` maps a DXF underlay's world plan coordinates
 * (metres, IFC XY, +Y = north) INTO drawing space by subtracting the
 * render-frame shift (`dxfWorldShift`) and mirroring X on a flipped
 * section. `Drawing2D` itself (the generated section/plan) is built in
 * that same drawing space (`projectTo2D` for a 'down' section: `x_d =
 * renderX`, `y_d = renderZ = -ifcY_local`), so exporting it as a
 * georeferenced DXF is the exact inverse of that mapping:
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

/** The subset of `EffectiveGeoreference` the DXF export transform needs. */
export interface DxfExportGeoreference {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
  /** IFC project length-unit → metres (from `IfcUnitAssignment`). */
  lengthUnitScale: number;
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
  const scale = getEffectiveHorizontalScale(mapConversion.scale, mapUnitScale, lengthUnitScale);
  const abscissa = mapConversion.xAxisAbscissa ?? 1;
  const ordinate = mapConversion.xAxisOrdinate ?? 0;

  return (p) => {
    const world = toWorld(p);
    return {
      x: mapConversion.eastings * mapUnitScale + scale * (abscissa * world.x - ordinate * world.y),
      y: mapConversion.northings * mapUnitScale + scale * (ordinate * world.x + abscissa * world.y),
    };
  };
}
