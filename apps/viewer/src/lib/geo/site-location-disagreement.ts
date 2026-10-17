/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore, MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { ifcToViewerAxes } from './coordinate-frame';
import { viewerPointToProjected } from './pick-to-geo';
import { resolveProductOriginMeters } from './product-origin';
import { isGeographicProj4 } from './proj4-utils';
import { reprojectPointToLatLon, resolveProjection, type LatLon } from './reproject';

export interface SiteLocationReference {
  location: LatLon;
  /** Maximum horizontal rounding error from the authored compound angles. */
  precisionMetres: number;
  origin: { x: number; y: number; z: number };
}

/** Read precision as well as value: three components resolve only whole seconds. */
function angle(value: unknown, limit: number): { degrees: number; seconds: number } | null {
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)
    || !value.every((part): part is number => typeof part === 'number' && Number.isFinite(part) && Number.isInteger(part))) return null;
  const [d, m, s, us = 0] = value;
  if (Math.abs(m) >= 60 || Math.abs(s) >= 60 || Math.abs(us) >= 1_000_000) return null;
  const sign = value.some(part => part < 0 || Object.is(part, -0)) ? -1 : 1;
  const degrees = sign * (Math.abs(d) + Math.abs(m) / 60 + (Math.abs(s) + Math.abs(us) / 1_000_000) / 3600);
  if (Math.abs(degrees) > limit) return null;
  return { degrees, seconds: value.length === 4 ? 0.000001 : 1 };
}

/** Only compare a single, unambiguous IfcSite in this model's engineering frame. */
export function readSiteLocationReference(store: IfcDataStore | undefined): SiteLocationReference | undefined {
  // @raw-entity-enumeration-ok source-file diagnostic: read the authored IfcSite angles and placement from the same immutable parsed snapshot
  const ids = store?.entityIndex.byType.get('IFCSITE');
  if (!store || !ids || ids.length !== 1) return undefined;
  const site = store.getEntity(ids[0]);
  const latitude = angle(site?.attributes?.[9], 90);
  const longitude = angle(site?.attributes?.[10], 180);
  if (!latitude || !longitude || (latitude.degrees === 0 && longitude.degrees === 0)) return undefined;
  const origin = resolveProductOriginMeters(store, ids[0]);
  if (!origin) return undefined;
  const radians = Math.PI / 180;
  // Half a quantum on each axis. Latitude bounds the metre length of a second
  // of longitude; the diagonal admits any correctly rounded pair (#7666).
  const metresPerSecond = 6_371_000 * radians / 3600;
  return {
    location: { lat: latitude.degrees, lon: longitude.degrees },
    precisionMetres: metresPerSecond / 2 * Math.hypot(latitude.seconds, longitude.seconds * Math.cos(latitude.degrees * radians)),
    origin,
  };
}

export function distanceMetres(a: LatLon, b: LatLon): number {
  const radians = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * radians / 2) ** 2
    + Math.cos(a.lat * radians) * Math.cos(b.lat * radians)
    * Math.sin((b.lon - a.lon) * radians / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Reuse the hook's origin; only a nonzero site placement needs another projection. */
export async function siteLocationDisagreement(
  reference: SiteLocationReference,
  origin: LatLon,
  conversion: MapConversion,
  crs: ProjectedCRS,
  lengthUnitScale: number,
): Promise<number | null> {
  let placed = origin;
  if (reference.origin.x !== 0 || reference.origin.y !== 0) {
    const definition = await resolveProjection(crs);
    if (!definition || isGeographicProj4(definition)) return null;
    const projected = viewerPointToProjected(ifcToViewerAxes(reference.origin), {
      hasGeoreference: true, mapConversion: conversion, projectedCRS: crs, lengthUnitScale,
    }, { x: 0, y: 0, z: 0 });
    const location = await reprojectPointToLatLon(projected.eastings, projected.northings, crs, lengthUnitScale);
    if (!location) return null;
    placed = location;
  }
  const distance = distanceMetres(reference.location, placed);
  return distance > 5 + reference.precisionMetres ? Math.round(distance) : null;
}
