/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import { createCoordinateInfo } from '../../utils/localParsingUtils.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';

/** Derive a federation frame even when LandXML has no renderable TIN mesh. */
export function sourceCoordinateInfo(parsed: LandXmlTinDocument): GeometryResult['coordinateInfo'] {
  if (parsed.units === null) return createCoordinateInfo({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
  const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  const add = (northing: number, easting: number, elevation: number | undefined): void => {
    if (elevation === undefined) return;
    const point = { x: easting * parsed.units!.linearScaleToMeters, y: elevation * parsed.units!.elevationScaleToMeters, z: -northing * parsed.units!.linearScaleToMeters };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return;
    bounds.min.x = Math.min(bounds.min.x, point.x); bounds.min.y = Math.min(bounds.min.y, point.y); bounds.min.z = Math.min(bounds.min.z, point.z);
    bounds.max.x = Math.max(bounds.max.x, point.x); bounds.max.y = Math.max(bounds.max.y, point.y); bounds.max.z = Math.max(bounds.max.z, point.z);
  };
  for (const surface of parsed.surfaces) for (const point of surface.points) add(point.northing, point.easting, point.elevation);
  for (const point of parsed.plan?.cogoPoints ?? []) if (point.point) add(point.point.northing, point.point.easting, point.point.elevation ?? 0);
  for (const monument of parsed.plan?.resolvedMonuments ?? []) if (monument.point) add(monument.point.northing, monument.point.easting, monument.point.elevation ?? 0);
  for (const geometry of parsed.plan?.resolvedGeometry ?? []) for (const point of [geometry.start, geometry.end, geometry.center, geometry.pi]) if (point) add(point.northing, point.easting, point.elevation ?? 0);
  if (!Number.isFinite(bounds.min.x)) return createCoordinateInfo({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
  const maxAbs = Math.max(...[bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].map(Math.abs));
  const hasLargeCoordinates = maxAbs > 10_000;
  const originShift = hasLargeCoordinates ? { x: bounds.min.x / 2 + bounds.max.x / 2, y: bounds.min.y / 2 + bounds.max.y / 2, z: bounds.min.z / 2 + bounds.max.z / 2 } : { x: 0, y: 0, z: 0 };
  return createCoordinateInfo(bounds, originShift, hasLargeCoordinates);
}
