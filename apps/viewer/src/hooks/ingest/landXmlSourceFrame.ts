/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import { createCoordinateInfo } from '../../utils/localParsingUtils.js';
import type { LandXmlPointLocation, LandXmlTinDocument } from './landXmlSemantics.js';

/** Establish a source-coordinate frame even when the document has no mesh. */
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
  for (const surface of parsed.surfaces) {
    for (const point of surface.points) add(point.northing, point.easting, point.elevation);
    for (const line of [...surface.boundaries, ...surface.breaklines, ...surface.contours]) {
      const elevation = line.coordinateDimension === 2 && line.properties.elev !== undefined ? Number(line.properties.elev) : undefined;
      for (const [northing, easting, value] of line.points) add(northing, easting, value ?? elevation);
    }
  }
  const addLocation = (location: LandXmlPointLocation): void => { if (location.kind === 'coordinates') add(location.point.northing, location.point.easting, location.point.elevation ?? 0); };
  for (const alignment of parsed.alignments ?? []) for (const { primitive } of alignment.segments) {
    addLocation(primitive.start); addLocation(primitive.end);
    if (primitive.kind === 'curve') addLocation(primitive.center);
    if (primitive.kind === 'spiral' || primitive.kind === 'unsupported_spiral') addLocation(primitive.pi);
    if (primitive.kind === 'irregular_line') for (const point of primitive.points) add(point.northing, point.easting, point.elevation ?? 0);
  }
  if (!Number.isFinite(bounds.min.x)) return createCoordinateInfo({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
  const maxAbs = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.min.y), Math.abs(bounds.min.z), Math.abs(bounds.max.x), Math.abs(bounds.max.y), Math.abs(bounds.max.z));
  const hasLargeCoordinates = maxAbs > 10_000;
  const originShift = hasLargeCoordinates ? { x: bounds.min.x / 2 + bounds.max.x / 2, y: bounds.min.y / 2 + bounds.max.y / 2, z: bounds.min.z / 2 + bounds.max.z / 2 } : { x: 0, y: 0, z: 0 };
  return createCoordinateInfo(bounds, originShift, hasLargeCoordinates);
}
