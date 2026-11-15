/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Precision datum-shift grids for CRSs where 7-parameter Helmert
 * (`+towgs84`) gives unacceptable error (≥ ~1 m).
 *
 * proj4js can't read NTv2 `.gsb` files directly, but it CAN consume the
 * GeoTIFF datum-shift grids PROJ publishes at cdn.proj.org. The engine's grid
 * loader (`configureCrsLoaders`, `projCdnGridLoader`) fetches the grid on
 * first use of a covered CRS; we parse it with geotiff.js, register via
 * `proj4.nadgrid(key, adapter)`, then call `proj4.defs(...)` with a string
 * that references `+nadgrids={key}`. proj4js resolves the reference and
 * does the datum shift via the loaded grid. Regional frame → WGS84
 * remains an approximation; coordinate epochs are not represented here.
 *
 * Without the grid (no loader installed, fetch failed, CRS not in our list),
 * proj4js falls back to the `+towgs84` baked into the bundled definition,
 * which is the ~1–120 m approximation we had before.
 *
 * Filenames are taken verbatim from the OSGeo/PROJ-data repository (the
 * upstream that publishes to cdn.proj.org). Pattern lifted from
 * bedrock-engineer/ifc-gref under Apache-2.0.
 */

import proj4 from 'proj4';
import { lookupEpsgByCode } from '@ifc-lite/data';
import { DEPRECATED_SOURCE_DATUMS } from './precision-grid-data.js';
import { PRECISION_GRIDS, type PrecisionGridSpec } from './precision-grid-table.js';
import { reportCrsDiagnostic } from './diagnostics.js';
import { defaultEngineState, type EngineState } from './engine-state.js';

export { PRECISION_GRIDS } from './precision-grid-table.js';

// ── Grid loader ────────────────────────────────────────────────────────────

/**
 * proj4's `+nadgrids` reader treats a GeoTIFF as a horizontal-offset grid and
 * reads TWO raster bands (band 0 = latitude offsets, band 1 = longitude
 * offsets). A single-band grid is a vertical / height model (e.g. a
 * quasigeoid) and makes proj4 dereference an undefined second band and throw.
 * Guard against any such mis-registration. (#1357)
 */
export function isHorizontalOffsetGrid(sampleCount: number): boolean {
  return sampleCount >= 2;
}

/**
 * Load a GeoTIFF datum-shift grid into proj4js. Idempotent: subsequent
 * calls for the same key resolve immediately. Concurrent calls dedup.
 * Returns `true` on success, `false` on any failure (caller decides
 * whether to fall back to a `+towgs84`-based proj4 string).
 */
async function loadPrecisionGrid(spec: PrecisionGridSpec, state: EngineState): Promise<boolean> {
  const { loaded: loadedGrids, failed: failedGrids, inflight: inflightGrids } = state.grids;
  if (loadedGrids.has(spec.key)) return true;
  if (failedGrids.has(spec.key)) return false;
  const loadGridFile = state.loaders.gridFile;
  if (!loadGridFile) {
    // No grid loader installed (the default, and what a test run wants):
    // the caller falls back to the bundled +towgs84.
    failedGrids.add(spec.key);
    return false;
  }
  const pending = inflightGrids.get(spec.key);
  if (pending) return pending;

  const promise = (async (): Promise<boolean> => {
    try {
      const buffer = await loadGridFile(spec.filename);
      if (!buffer) {
        // Not available right now: the next resolution asks the loader again,
        // but until then the grid reads as failed rather than still loading.
        state.grids.unavailable.add(spec.key);
        return false;
      }
      const { fromArrayBuffer } = await import('geotiff');
      const tiff = await fromArrayBuffer(buffer);

      // Reject non-horizontal grids before proj4 chokes on the missing second
      // band — turns an opaque proj4 internal TypeError into a clear fallback.
      const probe = await tiff.getImage(0);
      const bands = probe.getSamplesPerPixel();
      if (!isHorizontalOffsetGrid(bands)) {
        reportCrsDiagnostic(
          `[precision-grid] ${spec.key}: ${bands}-band grid is not a horizontal datum shift; using +towgs84 fallback`,
        );
        failedGrids.add(spec.key);
        return false;
      }

      // proj4js's GeoTIFF nadgrid path expects an older API shape.
      // Bridge to geotiff.js v3 via a Proxy. Adapter borrowed from
      // bedrock-engineer/ifc-gref under Apache-2.0.
      const adapter = {
        getImageCount: () => tiff.getImageCount(),
        getImage: async (index: number) => {
          // Reuse the band-guard probe for image 0 instead of re-fetching it.
          const img = index === 0 ? probe : await tiff.getImage(index);
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
      }).nadgrid(state.gridName(spec.key), adapter);
      const ready = grid?.ready;
      if (ready && typeof ready.then === 'function') {
        await ready;
      }
      loadedGrids.add(spec.key);
      state.grids.unavailable.delete(spec.key);
      return true;
    } catch (error) {
      reportCrsDiagnostic(`[precision-grid] ${spec.key}: load failed, falling back to +towgs84`, error);
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
export async function resolvePrecisionDef(
  epsgCode: string,
  state: EngineState = defaultEngineState(),
): Promise<string | null> {
  const spec = PRECISION_GRIDS[epsgCode];
  if (!spec) return null;
  const incompatibleCodes = state.grids.incompatible;
  const entry = await lookupEpsgByCode(epsgCode);
  const sourceDatum = entry?.datum ?? DEPRECATED_SOURCE_DATUMS[epsgCode];
  if (!sourceDatum || !spec.sourceDatums.includes(sourceDatum)) {
    if (!incompatibleCodes.has(epsgCode)) {
      reportCrsDiagnostic(
        `[precision-grid] EPSG:${epsgCode}: source datum ${sourceDatum ?? '(unknown)'} is incompatible with ${spec.filename}; keeping bundled definition`,
      );
    }
    incompatibleCodes.add(epsgCode);
    return null;
  }
  incompatibleCodes.delete(epsgCode);
  const loaded = await loadPrecisionGrid(spec, state);
  if (!loaded) return null;
  return spec.proj4.replace(`+nadgrids=${spec.key}`, `+nadgrids=${state.gridName(spec.key)}`);
}

/**
 * Diagnostic for the default engine — has the grid for this code been loaded successfully?
 * Surfaces in the GeoreferencingPanel so users know they're getting
 * the grid-accurate transform vs. the +towgs84 fallback.
 */
export function hasLoadedPrecisionGrid(epsgCode: string): boolean {
  const spec = PRECISION_GRIDS[epsgCode];
  const { incompatible, loaded } = defaultEngineState().grids;
  return spec ? !incompatible.has(epsgCode) && loaded.has(spec.key) : false;
}

/**
 * Diagnostic for the default engine — did the grid load fail (so the badge can stop spinning
 * and show an error state instead of perpetually "loading")?
 */
export function hasFailedPrecisionGrid(epsgCode: string): boolean {
  const spec = PRECISION_GRIDS[epsgCode];
  const { incompatible, failed, unavailable } = defaultEngineState().grids;
  return spec ? incompatible.has(epsgCode) || failed.has(spec.key) || unavailable.has(spec.key) : false;
}
