/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare IfcSite RefLatitude/RefLongitude with the position the viewer derives
 * from IfcMapConversion + IfcProjectedCRS (#7658). The two are authored
 * independently; when they disagree by more than a few metres either one of
 * them is wrong or the CRS definition used to reproject is (a missing datum
 * shift lands Bessel-based grids 100-200 m off).
 */

import { EntityExtractor, extractGeoreferencing, type IfcDataStore, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { reprojectPointToLatLon, type LatLon } from './reproject';

/** Below this the two positions agree within authoring and Helmert precision. */
export const SITE_REF_MISMATCH_THRESHOLD_M = 5;

const EARTH_RADIUS_M = 6_371_008.8;

/** First IfcSite carrying both RefLatitude and RefLongitude, in WGS84 degrees. */
export function readSiteRefLocation(store: IfcDataStore | null | undefined): LatLon | null {
  const index = store?.entityIndex;
  if (!store?.source?.length || !index) return null;
  const ids = index.byType.get('IFCSITE') ?? [];
  if (ids.length === 0) return null;
  const extractor = new EntityExtractor(store.source);
  const entities = new Map<number, NonNullable<ReturnType<EntityExtractor['extractEntity']>>>();
  for (const id of ids) {
    const ref = index.byId.get(id);
    const entity = ref ? extractor.extractEntity(ref) : null;
    if (entity) entities.set(id, entity);
  }
  // With only sites in scope the extractor takes its legacy IfcSite path, which
  // owns the compound-angle decoding: eastings = longitude, northings = latitude.
  const site = extractGeoreferencing(entities, new Map([['IfcSite', [...entities.keys()]]]));
  if (site.source !== 'siteLocation' || !site.mapConversion) return null;
  return { lat: site.mapConversion.northings, lon: site.mapConversion.eastings };
}

/** Great-circle distance in metres (spherical; sub-0.5% error is irrelevant at this threshold). */
export function distanceMetres(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance between IfcSite RefLatitude/RefLongitude and the MapConversion
 * origin, or null when either side is missing, unresolvable, or within
 * {@link SITE_REF_MISMATCH_THRESHOLD_M}.
 */
export async function siteRefMismatchMetres(
  site: LatLon | null,
  conversion: MapConversion | undefined,
  crs: ProjectedCRS | undefined,
  lengthUnitScale = 1,
): Promise<number | null> {
  if (!site || !conversion || !crs?.name) return null;
  const derived = await reprojectPointToLatLon(conversion.eastings, conversion.northings, crs, lengthUnitScale);
  if (!derived) return null;
  const metres = distanceMetres(site, derived);
  return metres > SITE_REF_MISMATCH_THRESHOLD_M ? metres : null;
}
