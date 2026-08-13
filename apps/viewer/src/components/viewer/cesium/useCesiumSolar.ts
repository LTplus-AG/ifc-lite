/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The world view's solar study: sun position and lighting, shadow casting, the
 * 3D sun-path dome, and the atmosphere/sky toggle.
 *
 * Split out of CesiumOverlay.tsx (#2593). It is the most self-contained of that
 * file's responsibilities — it reads the studied instant from the store and
 * writes to the Cesium scene, sharing only the viewer, the bridge and the model
 * primitive whose shadow mode it sets.
 *
 * ORDERING NOTE: call this hook where its effects sat, AFTER the model hook.
 * It reads `modelRef` to apply shadow settings, and keys on `modelEpoch` so a
 * swapped-in primitive (#2583) gets those settings applied to it — the model
 * hook must have run first for both to be current.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { useViewerStore } from '@/store';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { sunPosition, sunTimes } from '@ifc-lite/solar';
import { applySolarScene, SunPathDome } from '@/lib/geo/cesium-sun';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { getCesiumModule } from './cesium-module';

export interface UseCesiumSolarParams {
  status: 'idle' | 'loading' | 'ready' | 'error';
  bridgeVersion: number;
  viewerRef: RefObject<InstanceType<typeof import('cesium').Viewer> | null>;
  bridgeRef: RefObject<CesiumBridge | null>;
  /** The primitive currently on the globe, whose shadow mode this sets. */
  modelRef: RefObject<{ shadows?: unknown } | null>;
  /** Changes when a DIFFERENT primitive reaches the globe, so its shadow
   *  settings are re-applied (#2583 stopped `cesiumGlbLoaded` from moving). */
  modelEpoch: number;
  /** The 3D-context tileset, which casts and receives shadows with the model. */
  tilesetRef: RefObject<{ shadows?: unknown } | null>;
  coordinateInfo?: CoordinateInfo;
}

export interface UseCesiumSolarResult {
  /**
   * Tear down the dome and forget that the scene was touched — for the viewer
   * teardown, which destroys the scene and its entities. Same reason
   * `useCesiumModel` exposes `invalidate`: on unmount React runs cleanups but
   * does not re-run effects.
   */
  invalidate: () => void;
}

export function useCesiumSolar({
  status,
  bridgeVersion,
  viewerRef,
  bridgeRef,
  modelRef: cesiumModelRef,
  modelEpoch: cesiumModelEpoch,
  tilesetRef,
  coordinateInfo,
}: UseCesiumSolarParams): UseCesiumSolarResult {
  const solarEnabled = useViewerStore((s) => s.solarEnabled);
  const solarDateMs = useViewerStore((s) => s.solarDateMs);
  const solarShowSunPath = useViewerStore((s) => s.solarShowSunPath);
  const solarShowShadows = useViewerStore((s) => s.solarShowShadows);
  const setSolarSunInfo = useViewerStore((s) => s.setSolarSunInfo);
  const envSkyEnabled = useViewerStore((s) => s.envSkyEnabled);

  // Active sun-path dome entity collection (null when solar study is off).
  const sunPathDomeRef = useRef<SunPathDome | null>(null);
  // UTC calendar day the dome's static geometry was built for.
  const sunPathDomeDayRef = useRef<string | null>(null);
  // Whether the study has ever touched the scene's lighting.
  const solarTouchedSceneRef = useRef(false);

  // ─── Effect 4: Solar study — sun-path dome + shadows ────────────────────
  // Drives Cesium's sun/lighting/shadow map from the studied instant, builds
  // (and live-updates) the 3D sun-path dome anchored at the model origin, and
  // publishes the resolved sun position/times back to the store for the panel.
  useEffect(() => {
    const viewer = viewerRef.current;
    const bridge = bridgeRef.current;
    const Cesium = getCesiumModule();
    if (status !== 'ready' || !viewer || !bridge || !Cesium) return;

    // Never mutate the default Cesium lighting until the study is first
    // enabled — a plain georeferenced model shouldn't have its context
    // re-lit just because this effect mounts with solar off.
    if (!solarEnabled && !solarTouchedSceneRef.current) return;
    solarTouchedSceneRef.current = true;

    const date = new Date(solarDateMs);
    const { latitude, longitude, height } = bridge.modelOrigin;

    // Cast/receive shadows on the IFC model and the context tileset.
    const shadowMode = solarEnabled && solarShowShadows
      ? Cesium.ShadowMode.ENABLED
      : Cesium.ShadowMode.DISABLED;
    if (cesiumModelRef.current) cesiumModelRef.current.shadows = shadowMode;
    if (tilesetRef.current) tilesetRef.current.shadows = shadowMode;

    applySolarScene(Cesium, viewer, {
      date,
      enabled: solarEnabled,
      shadows: solarShowShadows,
      showSun: envSkyEnabled,
    });

    if (solarEnabled) {
      // Publish the readout for the panel.
      const times = sunTimes(date, latitude, longitude);
      const sp = sunPosition(date, latitude, longitude);
      setSolarSunInfo({
        latitude,
        longitude,
        azimuth: sp.azimuth,
        altitude: sp.altitude,
        sunriseMs: times.sunrise ? times.sunrise.getTime() : null,
        sunsetMs: times.sunset ? times.sunset.getTime() : null,
        solarNoonMs: times.solarNoon.getTime(),
      });

      if (solarShowSunPath) {
        const dayKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
        try {
          if (!sunPathDomeRef.current || sunPathDomeDayRef.current !== dayKey) {
            // New day or site → rebuild static geometry (day arc + analemmas).
            sunPathDomeRef.current?.destroy();
            const bounds = coordinateInfo?.originalBounds;
            // Size the dome to roughly the model footprint, but clamp to an
            // architectural scale: with many federated models the combined
            // bounds can span kilometres, which would push the dome arcs so
            // far out they read as nothing. Half-diagonal ≈ bounding radius.
            const rawRadius = bounds
              ? 0.5 * Math.hypot(
                  bounds.max.x - bounds.min.x,
                  bounds.max.y - bounds.min.y,
                  bounds.max.z - bounds.min.z,
                )
              : 80;
            const radius = Math.min(250, Math.max(40, rawRadius));
            sunPathDomeRef.current = new SunPathDome(Cesium, viewer, {
              origin: { latitude, longitude, height },
              radius,
              date,
              showAnalemmas: true,
            });
            sunPathDomeDayRef.current = dayKey;
          } else {
            // Same day, new time → just move the sun marker + beam.
            sunPathDomeRef.current.update(date);
          }
        } catch (err) {
          console.warn('[CesiumOverlay] sun-path dome build/update failed:', err);
        }
      } else if (sunPathDomeRef.current) {
        sunPathDomeRef.current.destroy();
        sunPathDomeRef.current = null;
        sunPathDomeDayRef.current = null;
      }
    } else if (sunPathDomeRef.current) {
      sunPathDomeRef.current.destroy();
      sunPathDomeRef.current = null;
      sunPathDomeDayRef.current = null;
    }

    viewer.scene.requestRender();
  }, [
    status,
    bridgeVersion,
    cesiumModelEpoch,
    solarEnabled,
    solarDateMs,
    solarShowSunPath,
    solarShowShadows,
    envSkyEnabled,
    coordinateInfo,
    setSolarSunInfo,
  ]);

  // ─── Effect 4b: Sky — atmosphere + sun + fog ────────────────────────────
  // The environment panel's Sky toggle. Init disables all of these for
  // transparent compositing; this effect re-enables them on demand. The
  // area outside the atmosphere stays transparent (skyBox off), so space
  // composites over the app background like the rest of the overlay.
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = getCesiumModule();
    if (status !== 'ready' || !viewer || !Cesium) return;
    const scene = viewer.scene;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = envSkyEnabled;
    scene.fog.enabled = envSkyEnabled;
    // Haze on the satellite base map (no-op while the globe is hidden).
    scene.globe.showGroundAtmosphere = envSkyEnabled && scene.globe.show;
    // Sun billboard only when the solar effect isn't already managing it
    // (applySolarScene runs with showSun and wins on solar state changes).
    if (scene.sun && !solarTouchedSceneRef.current) {
      scene.sun.show = envSkyEnabled;
    }
    scene.requestRender();
  }, [status, envSkyEnabled]);

  const invalidate = () => {
    sunPathDomeRef.current = null;
    sunPathDomeDayRef.current = null;
    solarTouchedSceneRef.current = false;
  };

  return { invalidate };
}
