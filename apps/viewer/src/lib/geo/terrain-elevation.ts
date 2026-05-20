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

export type TerrainElevationSource =
  | 'globe.getHeight'
  | 'scene.sampleHeight'
  | 'scene.sampleHeightMostDetailed'
  | 'open-meteo';

export type TerrainHeightReference = 'ellipsoidal' | 'visual-surface' | 'orthometric';

export interface TerrainElevationSample {
  height: number;
  source: TerrainElevationSource;
  reference: TerrainHeightReference;
  cacheNamespace: string;
  fromCache: boolean;
}

export interface ResolveTerrainElevationOptions {
  cacheNamespace?: string;
  preferOrthometric?: boolean;
}

// Module-level cache so bridge rebuilds (georef edits, clamp toggles)
// re-use values within the session instead of re-hitting the network.
const terrainElevationCache = new Map<string, TerrainElevationSample>();

function terrainCacheKey(lat: number, lon: number, cacheNamespace: string): string {
  // 5 decimal places ≈ 1.1m precision — plenty for site-level elevation.
  return `${cacheNamespace}:${lat.toFixed(5)},${lon.toFixed(5)}`;
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
 *   2. scene.sampleHeight (sync, queries 3D Tiles + terrain — only works
 *      if tiles for the location are already rendered).
 *   3. scene.sampleHeightMostDetailed with a bounded timeout — forces tile
 *      load and returns the height of the actually-rendered surface (what
 *      the user SEES in Google Photorealistic 3D Tiles). Tried before
 *      Open-Meteo because the visible-tile elevation is what models need
 *      to sit on; Open-Meteo's DEM ignores buildings/road surfaces.
 *   4. globe.getHeight (terrain provider fallback — exact-zero treated as
 *      "no data" since the default ellipsoid provider returns 0 for every
 *      lat/lon).
 *   5. Open-Meteo elevation API — bare-earth fallback when tiles can't be
 *      sampled (offline, no 3D tileset, timeout, etc.).
 */
const SAMPLE_DETAILED_TIMEOUT_MS = 3500;

function getTerrainSourceReference(source: TerrainElevationSource): TerrainHeightReference {
  switch (source) {
    case 'globe.getHeight':
      return 'ellipsoidal';
    case 'scene.sampleHeight':
    case 'scene.sampleHeightMostDetailed':
      return 'visual-surface';
    case 'open-meteo':
      return 'orthometric';
  }
}

function acceptTerrainElevation(
  cacheKey: string,
  height: number,
  source: TerrainElevationSource,
  cacheNamespace: string,
  ms?: number,
): TerrainElevationSample {
  const sample: TerrainElevationSample = {
    height,
    source,
    reference: getTerrainSourceReference(source),
    cacheNamespace,
    fromCache: false,
  };
  terrainElevationCache.set(cacheKey, sample);
  const timing = ms !== undefined ? ` (${ms.toFixed(0)}ms)` : '';
  console.debug(
    `[TerrainElevation] via ${source}: ${height.toFixed(2)}m`
    + ` (${sample.reference}) at ${cacheKey}${timing}`,
  );
  return sample;
}

function getTerrainSourceCandidates(
  preferOrthometric: boolean,
): Array<{
  source: TerrainElevationSource;
  resolve: (
    Cesium: typeof import('cesium'),
    viewer: InstanceType<typeof import('cesium').Viewer>,
    position: InstanceType<typeof import('cesium').Cartographic>,
    lat: number,
    lon: number,
  ) => Promise<{ height: number | undefined | null; elapsedMs?: number; skipped?: boolean }>;
}> {
  const candidates = [
    {
      source: 'scene.sampleHeight' as const,
      resolve: async (
        _Cesium: typeof import('cesium'),
        viewer: InstanceType<typeof import('cesium').Viewer>,
        position: InstanceType<typeof import('cesium').Cartographic>,
      ) => {
        if (!viewer.scene.sampleHeightSupported) return { height: null, skipped: true };
        return { height: viewer.scene.sampleHeight(position) };
      },
    },
    {
      source: 'scene.sampleHeightMostDetailed' as const,
      resolve: async (
        _Cesium: typeof import('cesium'),
        viewer: InstanceType<typeof import('cesium').Viewer>,
        position: InstanceType<typeof import('cesium').Cartographic>,
      ) => {
        if (!viewer.scene.sampleHeightSupported) return { height: null, skipped: true };

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const t0 = performance.now();
          const detailed = viewer.scene.sampleHeightMostDetailed([position]);
          const timeout = new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => resolve(null), SAMPLE_DETAILED_TIMEOUT_MS);
          });
          const winner = await Promise.race([detailed, timeout]);
          const elapsedMs = performance.now() - t0;
          if (winner === null) {
            console.debug(
              `[TerrainElevation] sampleHeightMostDetailed timed out after ${elapsedMs.toFixed(0)}ms`,
            );
            return { height: null, elapsedMs, skipped: true };
          }

          const r0 = winner[0] as { height?: number } | undefined;
          return { height: r0?.height, elapsedMs };
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
      },
    },
    {
      source: 'globe.getHeight' as const,
      resolve: async (
        _Cesium: typeof import('cesium'),
        viewer: InstanceType<typeof import('cesium').Viewer>,
        position: InstanceType<typeof import('cesium').Cartographic>,
      ) => {
        const h = viewer.scene.globe.getHeight(position);
        if (h !== undefined && Math.abs(h) <= 1e-3) {
          return { height: null, skipped: true };
        }
        return { height: h };
      },
    },
    {
      source: 'open-meteo' as const,
      resolve: async (
        _Cesium: typeof import('cesium'),
        _viewer: InstanceType<typeof import('cesium').Viewer>,
        _position: InstanceType<typeof import('cesium').Cartographic>,
        lat: number,
        lon: number,
      ) => {
        const t0 = performance.now();
        const elev = await queryTerrainElevation({ lat, lon });
        return { height: elev, elapsedMs: performance.now() - t0 };
      },
    },
  ];

  if (!preferOrthometric) return candidates;
  return [
    candidates[3],
    candidates[2],
    candidates[0],
    candidates[1],
  ];
}

export async function resolveTerrainElevationDetailed(
  Cesium: typeof import('cesium'),
  viewer: InstanceType<typeof import('cesium').Viewer>,
  lat: number,
  lon: number,
  options: ResolveTerrainElevationOptions = {},
): Promise<TerrainElevationSample | null> {
  const cacheNamespace = options.cacheNamespace ?? 'default';
  const preferOrthometric = options.preferOrthometric ?? false;
  const cacheKey = terrainCacheKey(lat, lon, cacheNamespace);
  const cached = terrainElevationCache.get(cacheKey);
  if (cached !== undefined) {
    console.debug(
      `[TerrainElevation] cached at ${cacheKey}: ${cached.height.toFixed(2)}m`
      + ` via ${cached.source} (${cached.reference})`,
    );
    return { ...cached, fromCache: true };
  }

  const position = Cesium.Cartographic.fromDegrees(lon, lat);
  const skip = (h: unknown, source: string) => {
    console.debug(`[TerrainElevation] ${source} returned implausible value ${h}; skipping`);
  };

  for (const candidate of getTerrainSourceCandidates(preferOrthometric)) {
    try {
      const { height, elapsedMs, skipped } = await candidate.resolve(
        Cesium, viewer, position, lat, lon,
      );
      if (height !== undefined && height !== null && isPlausibleElevation(height)) {
        return acceptTerrainElevation(
          cacheKey,
          height,
          candidate.source,
          cacheNamespace,
          elapsedMs,
        );
      }
      if (height !== undefined && height !== null) {
        skip(height, candidate.source);
      } else if (!skipped) {
        console.debug(`[TerrainElevation] ${candidate.source} returned no value`);
      }
    } catch (err) {
      console.warn(`[TerrainElevation] ${candidate.source} threw:`, err);
    }
  }

  console.warn(`[TerrainElevation] no source returned a plausible value at ${cacheKey}`);
  return null;
}

export async function resolveTerrainElevation(
  Cesium: typeof import('cesium'),
  viewer: InstanceType<typeof import('cesium').Viewer>,
  lat: number,
  lon: number,
  options: ResolveTerrainElevationOptions = {},
): Promise<number | null> {
  const result = await resolveTerrainElevationDetailed(Cesium, viewer, lat, lon, options);
  return result?.height ?? null;
}
