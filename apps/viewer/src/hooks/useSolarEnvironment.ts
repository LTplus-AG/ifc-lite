/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge the solar study to the WebGPU renderer's lighting environment.
 *
 * While the study is enabled and the model is georeferenced, this hook
 * computes the sun's true direction for the studied instant at the site and
 * publishes it (viewer/world space, Y-up) to `solarSunDirection` — Viewport
 * folds it into `RenderOptions.environment`, so the WebGPU sun and sky track
 * the same instant Cesium's clock is pinned to.
 *
 * It also publishes the panel readout (`solarSunInfo`) when the Cesium
 * overlay is OFF — with Cesium on, CesiumOverlay's solar effect owns that
 * write (it uses the terrain-clamped bridge origin).
 */

import { useEffect, useState } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { sunPosition, sunTimes, azimuthAltitudeToEnu } from '@ifc-lite/solar';
import { useViewerStore } from '@/store';
import { computeCesiumModelOrigin } from '@/lib/geo/cesium-bridge';
import { enuToViewerDirection } from '@/lib/geo/solar-direction';

export interface SolarEnvironmentGeoref {
  mapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale?: number;
}

interface SiteOrigin {
  latitude: number;
  longitude: number;
  /** Meridian convergence (radians): needed to place the sun on true north,
   *  not grid north, in the grid-aligned WebGPU scene (#1408). */
  gamma: number;
}

export function useSolarEnvironment(georef: SolarEnvironmentGeoref | null): void {
  const solarEnabled = useViewerStore((s) => s.solarEnabled);
  const solarDateMs = useViewerStore((s) => s.solarDateMs);
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const setSolarSunDirection = useViewerStore((s) => s.setSolarSunDirection);
  const setSolarSunInfo = useViewerStore((s) => s.setSolarSunInfo);

  const [origin, setOrigin] = useState<SiteOrigin | null>(null);

  const mapConversion = georef?.mapConversion;
  const projectedCRS = georef?.projectedCRS;

  // Resolve the site's lat/lon once per georeference (proj4 lookup is async).
  useEffect(() => {
    if (!solarEnabled || !mapConversion || !projectedCRS) {
      setOrigin(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resolved = await computeCesiumModelOrigin(
          mapConversion,
          projectedCRS,
          georef?.coordinateInfo,
          georef?.lengthUnitScale ?? 1,
        );
        if (!cancelled) {
          setOrigin(resolved
            ? { latitude: resolved.latitude, longitude: resolved.longitude, gamma: resolved.gamma }
            : null);
        }
      } catch {
        if (!cancelled) setOrigin(null);
      }
    })();
    return () => { cancelled = true; };
  }, [solarEnabled, mapConversion, projectedCRS, georef?.coordinateInfo, georef?.lengthUnitScale]);

  // Publish the viewer-space sun direction for the studied instant.
  useEffect(() => {
    if (!solarEnabled || !origin) {
      setSolarSunDirection(null);
      return;
    }
    const date = new Date(solarDateMs);
    const sp = sunPosition(date, origin.latitude, origin.longitude);
    const enu = azimuthAltitudeToEnu(sp.azimuth, sp.altitude);
    setSolarSunDirection(enuToViewerDirection(
      enu,
      mapConversion?.xAxisAbscissa ?? 1,
      mapConversion?.xAxisOrdinate ?? 0,
      origin.gamma,
    ));

    // Panel readout — only when CesiumOverlay isn't publishing it.
    if (!cesiumEnabled) {
      const times = sunTimes(date, origin.latitude, origin.longitude);
      setSolarSunInfo({
        latitude: origin.latitude,
        longitude: origin.longitude,
        azimuth: sp.azimuth,
        altitude: sp.altitude,
        sunriseMs: times.sunrise ? times.sunrise.getTime() : null,
        sunsetMs: times.sunset ? times.sunset.getTime() : null,
        solarNoonMs: times.solarNoon.getTime(),
      });
    }
  }, [
    solarEnabled,
    solarDateMs,
    origin,
    cesiumEnabled,
    mapConversion?.xAxisAbscissa,
    mapConversion?.xAxisOrdinate,
    setSolarSunDirection,
    setSolarSunInfo,
  ]);
}
