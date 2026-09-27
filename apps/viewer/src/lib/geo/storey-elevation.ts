/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getMapUnitScale } from './cesium-placement';
import { ifcToViewerAxes } from './coordinate-frame';
import {
  getEffectiveGeoreference,
  getIfcLengthUnitScale,
  type EffectiveGeoreference,
  type GeorefMutationDataLike,
} from './effective-georef';
import { hasUsableMapGeoref, viewerPointToProjected } from './pick-to-geo';
import { firstProjAxis } from '@ifc-lite/data';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';

interface Point3 {
  x: number;
  y: number;
  z: number;
}

function entityRef(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function triple(value: unknown): Point3 | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = typeof value[0] === 'number' ? value[0] : Number.NaN;
  const y = typeof value[1] === 'number' ? value[1] : Number.NaN;
  const z = value.length > 2
    ? (typeof value[2] === 'number' ? value[2] : Number.NaN)
    : 0;
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function normalize(value: Point3, fallback: Point3): Point3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!(length > 1e-12) || !Number.isFinite(length)) return fallback;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function cross(a: Point3, b: Point3): Point3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function direction(store: IfcDataStore, id: number | null, fallback: Point3): Point3 {
  if (id === null) return fallback;
  const entity = store.getEntity(id);
  return normalize(triple(entity?.attributes?.[0]) ?? fallback, fallback);
}

/** Apply one IfcAxis2Placement to a point in its local coordinate system. */
function applyRelativePlacement(
  store: IfcDataStore,
  axisPlacementId: number,
  point: Point3,
): Point3 | null {
  const axisPlacement = store.getEntity(axisPlacementId);
  if (!axisPlacement) return null;
  const locationId = entityRef(axisPlacement.attributes?.[0]);
  const location = locationId === null ? null : store.getEntity(locationId);
  const origin = triple(location?.attributes?.[0]);
  if (!origin) return null;

  const type = String(axisPlacement.type).toUpperCase();
  if (type !== 'IFCAXIS2PLACEMENT2D' && type !== 'IFCAXIS2PLACEMENT3D') return null;
  const zAxis = type === 'IFCAXIS2PLACEMENT2D'
    ? { x: 0, y: 0, z: 1 }
    : direction(store, entityRef(axisPlacement.attributes?.[1]), { x: 0, y: 0, z: 1 });
  const refDirectionIndex = type === 'IFCAXIS2PLACEMENT2D' ? 1 : 2;
  // A `$` RefDirection takes the renderer's fill, not world X as-is (#5922).
  const [fx, fy, fz] = firstProjAxis([zAxis.x, zAxis.y, zAxis.z]);
  const provisionalX = direction(
    store,
    entityRef(axisPlacement.attributes?.[refDirectionIndex]),
    { x: fx, y: fy, z: fz },
  );
  const yAxis = normalize(cross(zAxis, provisionalX), { x: 0, y: 1, z: 0 });
  const xAxis = normalize(cross(yAxis, zAxis), { x: 1, y: 0, z: 0 });

  return {
    x: origin.x + xAxis.x * point.x + yAxis.x * point.y + zAxis.x * point.z,
    y: origin.y + xAxis.y * point.x + yAxis.y * point.y + zAxis.y * point.z,
    z: origin.z + xAxis.z * point.x + yAxis.z * point.y + zAxis.z * point.z,
  };
}

/** Resolve an IfcBuildingStorey placement origin through every PlacementRelTo hop. */
function resolveStoreyOriginMeters(store: IfcDataStore, storeyId: number): Point3 | null {
  const storey = store.getEntity(storeyId);
  let placementId = entityRef(storey?.attributes?.[5]);
  if (placementId === null) return null;

  const visited = new Set<number>();
  let point: Point3 = { x: 0, y: 0, z: 0 };
  while (placementId !== null) {
    if (visited.has(placementId)) return null;
    visited.add(placementId);
    const placement = store.getEntity(placementId);
    if (!placement || String(placement.type).toUpperCase() !== 'IFCLOCALPLACEMENT') return null;
    const relativePlacementId = entityRef(placement.attributes?.[1]);
    if (relativePlacementId === null) return null;
    const resolved = applyRelativePlacement(store, relativePlacementId, point);
    if (!resolved) return null;
    point = resolved;
    placementId = entityRef(placement.attributes?.[0]);
  }

  const scale = getIfcLengthUnitScale(store);
  return { x: point.x * scale, y: point.y * scale, z: point.z * scale };
}

/**
 * Resolve an IfcBuildingStorey's model-relative elevation to the absolute
 * height a user reads in the Inspector and the hierarchy badges (#4843).
 *
 * - With a usable IfcMapConversion: metres above the projected CRS vertical
 *   datum (the storey's engineering point run through MapConversion).
 * - Without one: the storey's world Z in the file's own coordinates, i.e. the
 *   full IfcLocalPlacement PlacementRelTo chain. Many exporters keep the
 *   real-world offset in the IfcSite/IfcBuilding placements rather than in a
 *   MapConversion; this is the same frame as the measure tool's Model row.
 * - The relative value is returned only when the placement chain cannot be
 *   resolved.
 *
 * `spatialHierarchy.storeyElevations` deliberately stays model-relative: it
 * drives level matching, grouping, sorting, isolation, editing, and
 * render-frame placement. Only display surfaces use this value. RTC/origin
 * shifts are render precision details and must not be added here; the chain
 * is read from the file's placements, before those shifts are applied.
 */
export function displayStoreyElevationMeters(
  relativeElevationMeters: number,
  georef: EffectiveGeoreference | null | undefined,
  store?: IfcDataStore | null,
  storeyId?: number,
): number {
  // The hierarchy value is intentionally relative, and its placement fallback
  // contains only the storey's own Z. For display, resolve the complete
  // PlacementRelTo chain so Site/Building offsets and rotations are included.
  const storeyOrigin = store && storeyId !== undefined && typeof store.getEntity === 'function'
    ? resolveStoreyOriginMeters(store, storeyId)
    : null;

  if (!hasUsableMapGeoref(georef)) {
    return storeyOrigin && Number.isFinite(storeyOrigin.z) ? storeyOrigin.z : relativeElevationMeters;
  }

  const mapUnitScale = getMapUnitScale(georef.projectedCRS, georef.lengthUnitScale);
  // Keeping the engineering point and origin in the same zero-based frame
  // makes RTC/origin shifts cancel while the canonical projection path
  // supplies MapConversion, unit, Scale, and FactorZ handling. The chain Z is
  // the only engineering height fed in, so OrthogonalHeight is added once.
  const viewerPoint = storeyOrigin
    ? ifcToViewerAxes(storeyOrigin)
    : { x: 0, y: relativeElevationMeters, z: 0 };
  const projected = viewerPointToProjected(
    viewerPoint,
    georef,
    { x: 0, y: 0, z: 0 },
  );
  const absoluteElevation = projected.height * mapUnitScale;

  return Number.isFinite(absoluteElevation) ? absoluteElevation : relativeElevationMeters;
}

/**
 * Per-model display-elevation lookup for surfaces that label many storeys at
 * once (the hierarchy tree). The effective georeference is resolved lazily and
 * once per model, so a model with no storeys pays nothing.
 */
export function createStoreyDisplayElevationResolver(
  store: IfcDataStore | null | undefined,
  coordinateInfo: CoordinateInfo | undefined,
  mutations: GeorefMutationDataLike | undefined,
): (storeyId: number, relativeElevationMeters: number) => number {
  let georef: EffectiveGeoreference | null | undefined;
  let georefResolved = false;
  return (storeyId, relativeElevationMeters) => {
    if (!store) return relativeElevationMeters;
    if (!georefResolved) {
      georef = getEffectiveGeoreference(store, coordinateInfo, mutations);
      georefResolved = true;
    }
    return displayStoreyElevationMeters(relativeElevationMeters, georef, store, storeyId);
  };
}
