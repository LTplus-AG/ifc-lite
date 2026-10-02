/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { reprojectPointToLatLon, reprojectToLatLon, resolveProjection, type LatLon } from '@/lib/geo/reproject';
import { getEffectiveAxisScales, resolveMapUnitToMetreScale } from '@/lib/geo/geo-scale';
import { isGeographicProj4 } from '@/lib/geo/proj4-utils';
import type { TranslationKey } from '@/i18n';

/** An effective identity leaves metre geometry in the map frame. Reuse the
 * same unit/factor policy as reprojection, rather than treating Scale=1 alone
 * as physical identity (#6698). */
function isNeutralMapOperation(conversion: MapConversion, crs: ProjectedCRS, lengthUnitScale: number): boolean {
  const axis = conversion.xAxisAbscissa ?? 1;
  const values = [conversion.scale, conversion.factorX, conversion.factorY, conversion.factorZ, crs.mapUnitScale];
  if (!Number.isFinite(axis) || axis !== 1 || !Number.isFinite(lengthUnitScale) || lengthUnitScale <= 0
    || (crs.mapUnitScale !== undefined && crs.mapUnitScale <= 0)
    || values.some(value => value !== undefined && (!Number.isFinite(value) || value <= 0))) return false;
  const scales = getEffectiveAxisScales(conversion, resolveMapUnitToMetreScale(crs.mapUnitScale, lengthUnitScale), lengthUnitScale);
  return conversion.eastings === 0 && conversion.northings === 0 && conversion.orthogonalHeight === 0
    && (conversion.xAxisOrdinate ?? 0) === 0
    && scales.x === 1 && scales.y === 1 && scales.z === 1;
}

/** Prefer the declared origin (#6677); identify physical geometry separately
 * for an identity map operation or an unprojectable origin (#6698). */
export function useLocationGeoreference(
  conversion: MapConversion | undefined,
  crs: ProjectedCRS | undefined,
  coordinateInfo: CoordinateInfo | undefined,
  lengthUnitScale: number,
) {
  const [latLon, setLatLon] = useState<LatLon | null>(null);
  const [mapState, setMapState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [locationKind, setLocationKind] = useState<'origin' | 'geometry' | null>(null);
  const [geometryDistanceKm, setGeometryDistanceKm] = useState<number | null>(null);

  useEffect(() => {
    setGeometryDistanceKm(null);
    setLocationKind(null);
    if (!conversion || !crs) {
      setLatLon(null);
      setErrorKey(null);
      setMapState('idle');
      return;
    }
    let cancelled = false;
    setMapState('loading');
    setErrorKey(null);
    reprojectPointToLatLon(conversion.eastings, conversion.northings, crs, lengthUnitScale).then(async origin => {
      if (cancelled) return;
      const definition = origin && coordinateInfo && isNeutralMapOperation(conversion, crs, lengthUnitScale)
        ? await resolveProjection(crs) : null;
      if (cancelled) return;
      const neutralProjectedOperation = definition !== null && !isGeographicProj4(definition);
      if ((!origin || neutralProjectedOperation) && coordinateInfo) {
        // An identity operation's abstract zero origin can invert to a point
        // far from the model. Display its physical centre without changing the
        // authored origin, just as for an origin outside projection coverage.
        const center = await reprojectToLatLon(conversion, crs, coordinateInfo, lengthUnitScale);
        if (cancelled) return;
        const location = center ?? origin;
        setLatLon(location);
        setLocationKind(center ? 'geometry' : origin ? 'origin' : null);
        setMapState(location ? 'ready' : 'error');
        setErrorKey(location ? null : 'properties.locationMap.projectionUnresolved');
        return;
      }
      setLatLon(origin);
      setLocationKind(origin ? 'origin' : null);
      setMapState(origin ? 'ready' : 'error');
      setErrorKey(origin ? null : 'properties.locationMap.projectionUnresolved');
      if (!origin || !coordinateInfo) return;
      // Preserve the real geometry transform. A correct origin does not prove
      // that element placements agree with it: #6677 nearly cancels the offset.
      return reprojectToLatLon(conversion, crs, coordinateInfo, lengthUnitScale).then(center => {
        if (cancelled || !center) return;
        const radians = Math.PI / 180;
        const a = Math.sin((center.lat - origin.lat) * radians / 2) ** 2
          + Math.cos(origin.lat * radians) * Math.cos(center.lat * radians)
          * Math.sin((center.lon - origin.lon) * radians / 2) ** 2;
        const km = 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
        // Report large discrepancies as distances, without guessing a repair
        // to file-authored coordinates. Ordinary local model offsets stay quiet.
        setGeometryDistanceKm(km >= 100 ? Math.round(km) : null);
      }).catch(error => {
        // A diagnostic failure must not hide an independently resolved origin.
        if (!cancelled) console.warn('[location-map] geometry centre resolution failed:', error);
      });
    }).catch(error => {
      if (cancelled) return;
      console.warn('[location-map] georeference resolution failed:', error);
      setLatLon(null);
      setLocationKind(null);
      setMapState('error');
      setErrorKey('properties.locationMap.projectionUnresolved');
    });
    return () => { cancelled = true; };
  }, [conversion, crs, coordinateInfo, lengthUnitScale]);

  return { latLon, mapState, errorKey, geometryDistanceKm, locationKind };
}
