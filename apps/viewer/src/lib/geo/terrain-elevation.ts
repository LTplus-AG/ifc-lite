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
 *   4. scene.sampleHeightMostDetailed with a bounded timeout — forces tile
 *      load and returns the height of the actually-rendered surface (what
 *      the user SEES in Google Photorealistic 3D Tiles). Tried before
 *      Open-Meteo because the visible-tile elevation is what models need
 *      to sit on; Open-Meteo's DEM ignores buildings/road surfaces.
 *   5. Open-Meteo elevation API — bare-earth fallback when tiles can't be
 *      sampled (offline, no 3D tileset, timeout, etc.).
 */
const SAMPLE_DETAILED_TIMEOUT_MS = 3500;

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

  // 3. Force-load the 3D-Tile tile at this location and sample the
  //    rendered surface. This is what Google Photorealistic 3D Tiles
  //    show on screen, so the model lands on the SAME surface the user
  //    sees — no "below the visible ground" mismatch with Open-Meteo's
  //    DEM. Bounded by a timeout so a slow tile fetch doesn't keep the
  //    bridge waiting forever; Open-Meteo runs after as a backstop.
  if (viewer.scene.sampleHeightSupported) {
    try {
      const t0 = performance.now();
      const detailed = viewer.scene.sampleHeightMostDetailed([position]);
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SAMPLE_DETAILED_TIMEOUT_MS),
      );
      const winner = await Promise.race([
        detailed.then((results) => results),
        timeout,
      ]);
      const ms = performance.now() - t0;
      if (winner !== null) {
        const r0 = winner[0] as { height?: number } | undefined;
        if (r0?.height !== undefined && isPlausibleElevation(r0.height)) {
          return accept(r0.height, 'scene.sampleHeightMostDetailed', ms);
        }
        if (r0?.height !== undefined) skip(r0.height, 'scene.sampleHeightMostDetailed');
      } else {
        console.debug(`[TerrainElevation] sampleHeightMostDetailed timed out after ${ms.toFixed(0)}ms`);
      }
    } catch (err) {
      console.warn('[TerrainElevation] sampleHeightMostDetailed threw:', err);
    }
  }

  // 4. Open-Meteo bare-earth elevation. Used as a network fallback when
  //    the visible-tile sample didn't resolve in time.
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

  console.warn(`[TerrainElevation] no source returned a plausible value at ${cacheKey}`);
  return null;
}
