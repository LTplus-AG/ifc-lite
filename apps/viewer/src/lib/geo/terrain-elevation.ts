/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Terrain elevation lookup pipeline.
 *
 * Multiple sources are tried fast-first with diagnostic logging and a
 * sanity range check, so callers get a usable elevation regardless of
 * whether the user has Cesium-ion terrain, Google Photorealistic 3D
 * Tiles, or no Cesium-side terrain at all (Open-Meteo handles that).
 */

import { queryTerrainElevation } from './reproject';

// Module-level cache so bridge rebuilds (georef edits, clamp toggles)
// re-use values within the session instead of re-hitting the network.
const terrainElevationCache = new Map<string, number>();

function terrainCacheKey(lat: number, lon: number): string {
  // 5 decimal places ≈ 1.1m precision — plenty for site-level elevation.
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

// Earth's plausible terrestrial elevation range. Mariana Trench ≈ −11 km
// (no buildings there) and Everest summit ≈ 8.85 km. Anything outside this
// band is depth-buffer / uninitialised garbage and must be discarded.
const ELEV_MIN = -1000;
const ELEV_MAX = 9000;

function isPlausibleElevation(h: number): boolean {
  return Number.isFinite(h) && h > ELEV_MIN && h < ELEV_MAX;
}

/**
 * Clear the session terrain cache. Call when switching terrain providers,
 * data sources, or whenever a stale cached value would be misleading.
 */
export function clearTerrainElevationCache(): void {
  terrainElevationCache.clear();
}

/**
 * Resolve terrain elevation at a WGS84 lat/lon.
 *
 * Order:
 *   1. Cache (instant — re-bridge after georef edit).
 *   2. globe.getHeight (sync, terrain provider — exact-zero treated as
 *      "no data" since the default ellipsoid provider returns 0 for every
 *      lat/lon).
 *   3. scene.sampleHeight (sync, queries 3D Tiles + terrain — only works
 *      if tiles for the location are already rendered).
 *   4. Open-Meteo elevation API (~200-500 ms, always works online).
 *   5. scene.sampleHeightMostDetailed (async, forces tile load — slow last
 *      resort if Open-Meteo fails).
 */
export async function resolveTerrainElevation(
  Cesium: typeof import('cesium'),
  viewer: InstanceType<typeof import('cesium').Viewer>,
  lat: number,
  lon: number,
): Promise<number | null> {
  const cacheKey = terrainCacheKey(lat, lon);
  const cached = terrainElevationCache.get(cacheKey);
  if (cached !== undefined) {
    console.debug(`[TerrainElevation] cached at ${cacheKey}: ${cached.toFixed(2)}m`);
    return cached;
  }

  const position = Cesium.Cartographic.fromDegrees(lon, lat);
  const accept = (h: number, source: string, ms?: number): number => {
    terrainElevationCache.set(cacheKey, h);
    const t = ms !== undefined ? ` (${ms.toFixed(0)}ms)` : '';
    console.debug(`[TerrainElevation] via ${source}: ${h.toFixed(2)}m at ${cacheKey}${t}`);
    return h;
  };
  const skip = (h: unknown, source: string) => {
    console.debug(`[TerrainElevation] ${source} returned implausible value ${h}; skipping`);
  };

  // 1. Sync globe.getHeight. The default ellipsoid provider returns 0 for
  //    every lat/lon, so when no real terrain provider is wired we'd lock
  //    in 0 and never reach the network fallbacks. Treat exact-zero from
  //    this source specifically as "no data" — Open-Meteo can still return
  //    a true 0 elsewhere in the chain for legitimate sea-level sites.
  try {
    const h = viewer.scene.globe.getHeight(position);
    if (h !== undefined && isPlausibleElevation(h) && Math.abs(h) > 1e-3) {
      return accept(h, 'globe.getHeight');
    }
    if (h !== undefined && !isPlausibleElevation(h)) skip(h, 'globe.getHeight');
  } catch (err) {
    console.warn('[TerrainElevation] globe.getHeight threw:', err);
  }

  // 2. Sync scene.sampleHeight — works with 3D Tiles when tiles for this
  //    location are already rendered.
  if (viewer.scene.sampleHeightSupported) {
    try {
      const h = viewer.scene.sampleHeight(position);
      if (h !== undefined && isPlausibleElevation(h)) {
        return accept(h, 'scene.sampleHeight');
      }
      if (h !== undefined) skip(h, 'scene.sampleHeight');
    } catch (err) {
      console.warn('[TerrainElevation] scene.sampleHeight threw:', err);
    }
  }

  // 3. Open-Meteo elevation API — reliable network fallback. Doesn't need
  //    any tiles loaded; works for Google 3D Tiles environments where
  //    Cesium has no tile depth yet. True sea-level (0) is allowed here.
  try {
    const t0 = performance.now();
    const elev = await queryTerrainElevation({ lat, lon });
    const ms = performance.now() - t0;
    if (elev !== null && isPlausibleElevation(elev)) {
      return accept(elev, 'Open-Meteo', ms);
    }
    if (elev !== null) skip(elev, 'Open-Meteo');
  } catch (err) {
    console.warn('[TerrainElevation] Open-Meteo threw:', err);
  }

  // 4. Last resort: force Cesium to load tiles for this location. Slow
  //    (seconds) but the most accurate when 3D Tiles are the only source.
  if (viewer.scene.sampleHeightSupported) {
    try {
      const t0 = performance.now();
      const results = await viewer.scene.sampleHeightMostDetailed([position]);
      const ms = performance.now() - t0;
      const r0 = results?.[0] as { height?: number } | undefined;
      if (r0?.height !== undefined && isPlausibleElevation(r0.height)) {
        return accept(r0.height, 'scene.sampleHeightMostDetailed', ms);
      }
      if (r0?.height !== undefined) skip(r0.height, 'scene.sampleHeightMostDetailed');
    } catch (err) {
      console.warn('[TerrainElevation] sampleHeightMostDetailed threw:', err);
    }
  }

  console.warn(`[TerrainElevation] no source returned a plausible value at ${cacheKey}`);
  return null;
}
