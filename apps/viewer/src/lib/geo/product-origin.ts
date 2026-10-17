/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { firstProjAxis, walkPlacementChain } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getIfcLengthUnitScale } from './effective-georef';

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

/** Resolve an IfcProduct placement origin through every PlacementRelTo hop. */
export function resolveProductOriginMeters(store: IfcDataStore, productId: number): Point3 | null {
  const product = store.getEntity(productId);
  const placementId = entityRef(product?.attributes?.[5]);
  if (placementId === null) return null;

  // The shared walker (#7791): a visited set, no depth cap. A cycle has no
  // origin.
  const walked = walkPlacementChain(placementId, (id) => entityRef(store.getEntity(id)?.attributes?.[0]));
  if (walked.end === 'cycle') return null;
  let point: Point3 = { x: 0, y: 0, z: 0 };
  for (const id of walked.ids) {
    const placement = store.getEntity(id);
    if (!placement || String(placement.type).toUpperCase() !== 'IFCLOCALPLACEMENT') return null;
    const relativePlacementId = entityRef(placement.attributes?.[1]);
    if (relativePlacementId === null) return null;
    const resolved = applyRelativePlacement(store, relativePlacementId, point);
    if (!resolved) return null;
    point = resolved;
  }

  const scale = getIfcLengthUnitScale(store);
  return { x: point.x * scale, y: point.y * scale, z: point.z * scale };
}
