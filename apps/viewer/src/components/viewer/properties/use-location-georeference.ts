/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { reprojectPointToLatLon, reprojectToLatLon, type LatLon } from '@/lib/geo/reproject';
import type { TranslationKey } from '@/i18n';

/** Prefer the declared CRS origin (#6677); identify a physical geometry location
 * separately when that origin is outside the projection coverage (#6698). */
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
      if (!origin && coordinateInfo) {
        // An unresolved declared origin does not invalidate geometry already
        // placed inside the CRS. This is a display choice, never a placement
        // repair; origin editing still writes the picked projected coordinate.
        const center = await reprojectToLatLon(conversion, crs, coordinateInfo, lengthUnitScale);
        if (cancelled) return;
        setLatLon(center);
        setLocationKind(center ? 'geometry' : null);
        setMapState(center ? 'ready' : 'error');
        setErrorKey(center ? null : 'properties.locationMap.projectionUnresolved');
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
