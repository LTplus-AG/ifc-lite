/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Precision datum-shift grids for CRSs where 7-parameter Helmert
 * (`+towgs84`) gives unacceptable error (≥ ~80 m).
 *
 * Browser proj4js can't read NTv2 `.gsb` files directly, but it CAN consume
 * GeoTIFF datum-shift grids published by PROJ at cdn.proj.org. We fetch the
 * grid on first use of a covered CRS, parse with geotiff.js, register via
 * `proj4.nadgrid(key, adapter)`, then call `proj4.defs(...)` with a string
 * that references `+nadgrids={key}`. proj4js resolves the reference and
 * does the datum-shift via the loaded grid — sub-decimeter accuracy.
 *
 * Without the grid (network blocked, fetch failed, CRS not in our list),
 * proj4js falls back to the `+towgs84` baked into the bundled definition,
 * which is the ~100 m approximation we had before.
 *
 * Coverage today (start small, add more as users hit them):
 *   - EPSG:28992 — Amersfoort / RD New (Netherlands)   → nl_nsgi_rdtrans2018.tif
 *   - EPSG:27700 — OSGB36 / British National Grid      → uk_os_OSTN15_NTv2_OSGBtoETRS.tif
 *   - EPSG:31370 — Belge 1972 / Belgian Lambert 72     → be_ign_bd72lb72_etrs89lb08.tif
 *   - EPSG:7415  — Amersfoort / RD New + NAP height    → same horizontal grid as 28992
 *
 * Switzerland (EPSG:2056 / LV95), French Lambert-93, German ETRS89 UTM,
 * and other ETRS89/GRS80-aligned systems don't need grids — their
 * `+towgs84` already gives sub-metre accuracy.
 *
 * Pattern lifted from bedrock-engineer/ifc-gref under Apache-2.0.
 */

import proj4 from 'proj4';

export interface PrecisionGridSpec {
  /** Key proj4 references via `+nadgrids={key}` */
  key: string;
  /** Filename under cdn.proj.org/ */
  filename: string;
  /** Full proj4 string with `+nadgrids` instead of `+towgs84` */
  proj4: string;
  /** Human-readable name for diagnostics */
  region: string;
}

const RD_PROJ_HEAD =
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 '
  + '+k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel';

const RD_GRID = 'nl_nsgi_rdtrans2018.tif';

/**
 * EPSG code → grid spec. Order is irrelevant; loaded lazily on first use.
 *
 * Curated set covers the European national grids where the bundled +towgs84
 * has ≥ 1 m error. ETRS89/WGS84/NAD83-aligned systems (Swiss LV95, French
 * Lambert-93, German ETRS89 UTM, etc.) already give sub-decimeter accuracy
 * through Helmert and don't need entries here.
 *
 * To add a new region: pick the EPSG code, look up the canonical grid name
 * on cdn.proj.org, and add an entry with the proj4 string using +nadgrids
 * instead of +towgs84.
 */
export const PRECISION_GRIDS: Record<string, PrecisionGridSpec> = {
  // ── Netherlands — RDNAPTRANS™2018 (Kadaster canonical) ──
  // Bundled +towgs84 is off by ~117 m. Grid gives sub-decimeter.
  '28992': {
    key: RD_GRID,
    filename: RD_GRID,
    proj4: `${RD_PROJ_HEAD} +nadgrids=${RD_GRID} +units=m +no_defs +type=crs`,
    region: 'Netherlands (RDNAPTRANS™2018)',
  },
  '7415': {
    key: RD_GRID,
    filename: RD_GRID,
    proj4: `${RD_PROJ_HEAD} +nadgrids=${RD_GRID} +units=m +no_defs +type=crs`,
    region: 'Netherlands (RD + NAP compound)',
  },

  // ── United Kingdom — OSTN15 NTv2 (Ordnance Survey) ──
  // +towgs84 off ~1–5 m, up to 20 m in Scotland.
  '27700': {
    key: 'uk_os_OSTN15_NTv2_OSGBtoETRS.tif',
    filename: 'uk_os_OSTN15_NTv2_OSGBtoETRS.tif',
    proj4: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 '
      + '+ellps=airy +nadgrids=uk_os_OSTN15_NTv2_OSGBtoETRS.tif +units=m +no_defs +type=crs',
    region: 'United Kingdom (OSTN15)',
  },

  // ── Belgium — BD72 → ETRS89 NTv2 (IGN/NGI) ──
  // +towgs84 off ~2–5 m.
  '31370': {
    key: 'be_ign_bd72lb72_etrs89lb08.tif',
    filename: 'be_ign_bd72lb72_etrs89lb08.tif',
    proj4: '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 '
      + '+lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl '
      + '+nadgrids=be_ign_bd72lb72_etrs89lb08.tif +units=m +no_defs +type=crs',
    region: 'Belgium (BD72 → ETRS89)',
  },

  // ── Germany — DHDN Gauss-Krüger via BeTA2007 (AdV) ──
  // +towgs84 off ~1–3 m for old GK zones 2-5. Same grid for all four zones.
  ...Object.fromEntries(
    [
      ['31466', 6, 2500000],
      ['31467', 9, 3500000],
      ['31468', 12, 4500000],
      ['31469', 15, 5500000],
    ].map(([code, lon0, x0]) => [
      code,
      {
        key: 'de_adv_BETA2007.tif',
        filename: 'de_adv_BETA2007.tif',
        proj4: `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 +ellps=bessel `
          + '+nadgrids=de_adv_BETA2007.tif +units=m +no_defs +type=crs',
        region: `Germany (DHDN GK zone ${(Number(x0) - 500000) / 1000000})`,
      } satisfies PrecisionGridSpec,
    ]),
  ),

  // ── Austria — MGI / Austria Lambert via AT_GIS_GRID (BEV) ──
  // +towgs84 off ~1–3 m.
  '31287': {
    key: 'at_bev_AT_GIS_GRID_2021_09_28.tif',
    filename: 'at_bev_AT_GIS_GRID_2021_09_28.tif',
    proj4: '+proj=lcc +lat_0=47.5 +lon_0=13.3333333333333 +lat_1=49 +lat_2=46 '
      + '+x_0=400000 +y_0=400000 +ellps=bessel '
      + '+nadgrids=at_bev_AT_GIS_GRID_2021_09_28.tif +units=m +no_defs +type=crs',
    region: 'Austria (MGI → ETRS89)',
  },

  // ── France — NTF / Lambert zones via NTF→RGF93 NTv2 (IGN) ──
  // +towgs84 off ~1–3 m. The grid covers the legacy Lambert I-IV (incl. carto).
  ...Object.fromEntries(
    [
      ['27572', 2.337229166666667, 600000, 2200000, 0.99987742],
      ['27562', 2.337229166666667, 600000, 1200000, 0.99987742],
      ['27582', 2.337229166666667, 600000, 3200000, 0.99987742],
      ['27592', 2.337229166666667, 600000, 4185861.369, 0.99994471],
    ].map(([code, lon0, x0, y0, k0]) => [
      code,
      {
        key: 'fr_ign_ntf_r93.tif',
        filename: 'fr_ign_ntf_r93.tif',
        proj4: `+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=${lon0} +k_0=${k0} `
          + `+x_0=${x0} +y_0=${y0} +a=6378249.2 +b=6356515 `
          + '+nadgrids=fr_ign_ntf_r93.tif +pm=paris +units=m +no_defs +type=crs',
        region: `France (NTF Lambert ${code})`,
      } satisfies PrecisionGridSpec,
    ]),
  ),
};

const CDN_BASE = 'https://cdn.proj.org';

const loadedGrids = new Set<string>();
const inflightGrids = new Map<string, Promise<boolean>>();
const failedGrids = new Set<string>();

/**
 * Load a GeoTIFF datum-shift grid into proj4js. Idempotent: subsequent
 * calls for the same key resolve immediately. Concurrent calls dedup.
 * Returns `true` on success, `false` on any failure (caller decides
 * whether to fall back to a `+towgs84`-based proj4 string).
 */
export async function loadPrecisionGrid(spec: PrecisionGridSpec): Promise<boolean> {
  if (loadedGrids.has(spec.key)) return true;
  if (failedGrids.has(spec.key)) return false;
  const pending = inflightGrids.get(spec.key);
  if (pending) return pending;

  const promise = (async (): Promise<boolean> => {
    try {
      const url = `${CDN_BASE}/${spec.filename}`;
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[precision-grid] ${spec.key}: fetch failed (HTTP ${response.status})`);
        return false;
      }
      const buffer = await response.arrayBuffer();
      const { fromArrayBuffer } = await import('geotiff');
      const tiff = await fromArrayBuffer(buffer);

      // proj4js's GeoTIFF nadgrid path expects an older API shape.
      // Bridge to geotiff.js v3 via a Proxy. Adapter borrowed from
      // bedrock-engineer/ifc-gref under Apache-2.0.
      const adapter = {
        getImageCount: () => tiff.getImageCount(),
        getImage: async (index: number) => {
          const img = await tiff.getImage(index);
          const [scaleX = 0, scaleY = 0] = img.getResolution();
          return new Proxy(img, {
            get(target, property) {
              if (property === 'fileDirectory') {
                return {
                  ModelPixelScale: [Math.abs(scaleX), Math.abs(scaleY), 0],
                };
              }
              const value = (target as unknown as Record<string | symbol, unknown>)[
                property as string
              ];
              return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
            },
          });
        },
      };

      // proj4js types lag the actual adapter shape; cast at the boundary.
      const grid = (proj4 as unknown as {
        nadgrid: (key: string, source: unknown) => { ready?: Promise<unknown> } | undefined;
      }).nadgrid(spec.key, adapter);
      const ready = grid?.ready;
      if (ready && typeof ready.then === 'function') {
        await ready;
      }
      loadedGrids.add(spec.key);
      console.info(`[precision-grid] loaded ${spec.key} (${spec.region})`);
      return true;
    } catch (error) {
      console.warn(`[precision-grid] ${spec.key}: load failed, falling back to +towgs84`, error);
      failedGrids.add(spec.key);
      return false;
    }
  })();

  inflightGrids.set(spec.key, promise);
  promise.finally(() => inflightGrids.delete(spec.key));
  return promise;
}

/**
 * If `epsgCode` has a registered precision grid, load it and return the
 * grid-using proj4 definition. Returns `null` when the code isn't in our
 * curated list — caller should fall back to the bundled `+towgs84` def.
 */
export async function resolvePrecisionDef(epsgCode: string): Promise<string | null> {
  const spec = PRECISION_GRIDS[epsgCode];
  if (!spec) return null;
  const loaded = await loadPrecisionGrid(spec);
  if (!loaded) return null;
  return spec.proj4;
}

/**
 * Diagnostic — has the grid for this code been loaded successfully?
 * Surfaces in the GeoreferencingPanel so users know they're getting
 * the grid-accurate transform vs. the +towgs84 fallback.
 */
export function hasLoadedPrecisionGrid(epsgCode: string): boolean {
  const spec = PRECISION_GRIDS[epsgCode];
  return spec ? loadedGrids.has(spec.key) : false;
}
