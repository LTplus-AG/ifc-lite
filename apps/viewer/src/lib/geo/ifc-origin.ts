/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compute the viewer-space position where a model's IFC (0,0,0) point
 * currently sits — the "true" IFC origin, regardless of any federation
 * alignment that re-baked the vertices.
 *
 * Standalone load or this model is the federation anchor:
 *   viewer = -(originShift + wasmRtcOffset_Yup)
 *
 * Non-anchor federated model:
 *   1. IFC (0,0,0)  → model projected coords (E_m, N_m, H_m)  [the pivot,
 *      so MapConversion rotation/scale collapses to the offsets]
 *   2. model projected → anchor projected via proj4 (identity if same CRS)
 *   3. anchor projected → anchor IFC frame via inverse MapConversion
 *   4. anchor IFC (Z-up) → world Y-up via axis swap
 *   5. subtract anchor's shift + rtc to land in anchor viewer-local space
 *
 * This works for both same-CRS arithmetic alignment and cross-CRS proj4
 * alignment without depending on stored alignment transforms or vertex
 * snapshots — it derives everything from the MapConversion + ProjectedCRS
 * the IFC file declares.
 */

import proj4 from 'proj4';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { resolveProjection } from './reproject';
import { getEffectiveHorizontalScale } from './geo-scale';

export interface IfcOriginPlacement {
  /** Viewer-local position (Y-up) where this model's IFC (0,0,0) currently sits. */
  viewer: { x: number; y: number; z: number };
  /**
   * How the position was computed:
   *   - `'self'`      — model is its own frame (standalone or anchor)
   *   - `'anchor'`    — projected from model georef → anchor georef
   *   - `'fallback'`  — anchor has no usable georef; used model's own
   *                     pre-alignment frame as a best-effort guess
   */
  source: 'self' | 'anchor' | 'fallback';
}

export interface ModelGeorefInput {
  coordinateInfo?: CoordinateInfo;
  mapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  lengthUnitScale?: number;
  preAlignmentCoordinateInfo?: CoordinateInfo;
}

function totalYupOffset(info?: CoordinateInfo): { x: number; y: number; z: number } {
  const shift = info?.originShift ?? { x: 0, y: 0, z: 0 };
  const rtc = info?.wasmRtcOffset;
  const rtcYup = rtc ? { x: rtc.x, y: rtc.z, z: -rtc.y } : { x: 0, y: 0, z: 0 };
  return { x: shift.x + rtcYup.x, y: shift.y + rtcYup.y, z: shift.z + rtcYup.z };
}

export async function computeIfcOriginViewerPosition(
  model: ModelGeorefInput,
  anchor?: ModelGeorefInput | null,
): Promise<IfcOriginPlacement | null> {
  // Standalone load, or model has no georef → its own frame.
  if (!anchor || !model.mapConversion || !model.projectedCRS) {
    const off = totalYupOffset(model.coordinateInfo);
    return { viewer: { x: -off.x, y: -off.y, z: -off.z }, source: 'self' };
  }
  if (model === anchor) {
    const off = totalYupOffset(anchor.coordinateInfo);
    return { viewer: { x: -off.x, y: -off.y, z: -off.z }, source: 'self' };
  }
  if (!anchor.mapConversion || !anchor.projectedCRS) {
    // Anchor has no usable georef. The model's geometry was either left in
    // its own frame or aligned via RTC-only — fall back to pre-alignment.
    const off = totalYupOffset(model.preAlignmentCoordinateInfo ?? model.coordinateInfo);
    return { viewer: { x: -off.x, y: -off.y, z: -off.z }, source: 'fallback' };
  }

  // Step 1: model IFC (0,0,0) → model projected. At the pivot, rotation+scale
  // multiply zero — only the eastings/northings/orthogonalHeight remain.
  const modelLengthScale = model.lengthUnitScale ?? 1;
  const modelMapUnitScale = model.projectedCRS.mapUnitScale ?? modelLengthScale;
  const eM = model.mapConversion.eastings * modelMapUnitScale;
  const nM = model.mapConversion.northings * modelMapUnitScale;
  const hM = model.mapConversion.orthogonalHeight * modelMapUnitScale;

  // Step 2: same CRS → identity; different CRS → proj4 hop.
  let eA = eM;
  let nA = nM;
  const sameCrs = (model.projectedCRS.name ?? '').toUpperCase()
    === (anchor.projectedCRS.name ?? '').toUpperCase();
  if (!sameCrs) {
    const srcDef = await resolveProjection(model.projectedCRS);
    const refDef = await resolveProjection(anchor.projectedCRS);
    if (!srcDef || !refDef) return null;
    try {
      const result = proj4(srcDef, refDef, [eM, nM]);
      eA = result[0];
      nA = result[1];
    } catch (error) {
      console.warn(
        `[ifc-origin] proj4 reprojection failed (${model.projectedCRS.name} → ${anchor.projectedCRS.name}) for [${eM}, ${nM}]:`,
        error,
      );
      return null;
    }
  }
  const hA = hM; // No vertical datum transform in browser.

  // Step 3: anchor projected → anchor IFC (invert anchor's MapConversion).
  const anchorLengthScale = anchor.lengthUnitScale ?? 1;
  const anchorMapUnitScale = anchor.projectedCRS.mapUnitScale ?? anchorLengthScale;
  const eAnchor = anchor.mapConversion.eastings * anchorMapUnitScale;
  const nAnchor = anchor.mapConversion.northings * anchorMapUnitScale;
  const hAnchor = anchor.mapConversion.orthogonalHeight * anchorMapUnitScale;
  const anchorAbsc = anchor.mapConversion.xAxisAbscissa ?? 1;
  const anchorOrd = anchor.mapConversion.xAxisOrdinate ?? 0;
  const anchorScale = getEffectiveHorizontalScale(
    anchor.mapConversion.scale,
    anchorMapUnitScale,
    anchorLengthScale,
  );
  const anchorDenom = anchorScale * Math.max(anchorAbsc * anchorAbsc + anchorOrd * anchorOrd, 1e-12);
  if (Math.abs(anchorDenom) < 1e-12) return null;
  const invDenom = 1 / anchorDenom;
  const dE = eA - eAnchor;
  const dN = nA - nAnchor;
  const ifcX = invDenom * (anchorAbsc * dE + anchorOrd * dN);
  const ifcY = invDenom * (-anchorOrd * dE + anchorAbsc * dN);
  const ifcZ = hA - hAnchor;

  // Step 4 + 5: IFC Z-up → world Y-up → anchor viewer-local
  const anchorOff = totalYupOffset(anchor.coordinateInfo);
  return {
    viewer: {
      x: ifcX - anchorOff.x,
      y: ifcZ - anchorOff.y,
      z: -ifcY - anchorOff.z,
    },
    source: 'anchor',
  };
}
