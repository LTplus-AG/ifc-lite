/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two places the CRS engine can reach the network, as injectable loaders.
 *
 * Nothing here runs unless the host installs it with
 * {@link configureCrsLoaders} or passes it to `createCrsEngine`: with no
 * loaders the engine resolves from the bundled EPSG index, the UTM and name
 * aliases and WKT only, and a CRS that has a precision grid uses its
 * documented `+towgs84` approximation.
 */

import { reportCrsDiagnostic } from './diagnostics.js';
import { replaceDefaultEngineState } from './engine-state.js';

/**
 * Last-resort definition lookup for an EPSG code the bundled index does not
 * carry. Resolves to a proj4 string, or `null` when there is none. A `null`
 * is not cached, so a transient failure can be retried.
 */
export type EpsgDefinitionLoader = (epsgCode: string) => Promise<string | null>;

/**
 * Fetches one datum-shift grid by its PROJ-data filename (for example
 * `ch_swisstopo_CHENyx06_ETRS.tif`) and resolves to the GeoTIFF bytes.
 * `null` means "not available right now": the grid reads as failed
 * (`hasFailedPrecisionGrid`) and the next resolution asks again. A rejection
 * marks the grid failed for the engine's lifetime.
 */
export type GridFileLoader = (filename: string) => Promise<ArrayBuffer | null>;

export interface CrsLoaders {
  /** Absent or `null`: an EPSG code missing from the bundled index does not resolve. */
  epsgDefinition?: EpsgDefinitionLoader | null;
  /** Absent or `null`: no precision grid is loaded; the `+towgs84` approximation is used. */
  gridFile?: GridFileLoader | null;
}

/**
 * Install the loaders the default engine (`resolveCrs`, `@ifc-lite/geo/proj4`)
 * may call, replacing both. Returns the previous ones, so a caller that
 * installs temporarily can put them back.
 *
 * This is one configuration per process. It starts the default engine over:
 * definitions and grids resolved under the previous loaders are dropped, so
 * nothing a previous loader returned is used afterwards (a transformer made
 * earlier keeps working with the definition it holds). A host that needs
 * different loaders side by side, such as a server handling several tenants,
 * makes an engine for each with `createCrsEngine`.
 */
export function configureCrsLoaders(loaders: CrsLoaders): CrsLoaders {
  return replaceDefaultEngineState(loaders);
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** The host's `fetch`, looked up per call so a later replacement is honoured. */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/**
 * {@link EpsgDefinitionLoader} that reads `https://epsg.io/<code>.proj4`.
 * Any failure (offline, HTTP error, a non-proj4 body) reads as `null`.
 */
export function epsgIoDefinitionLoader(fetchImpl: FetchLike = globalFetch): EpsgDefinitionLoader {
  return async (epsgCode) => {
    try {
      const resp = await fetchImpl(`https://epsg.io/${epsgCode}.proj4`);
      if (!resp.ok) return null;
      const text = (await resp.text()).trim();
      if (!text || text.startsWith('<') || text.startsWith('{') || !text.includes('+')) {
        return null;
      }
      return text;
    } catch {
      return null;
    }
  };
}

export interface ProjCdnGridLoaderOptions {
  fetch?: FetchLike;
  /** Where the PROJ-data files are served from. Default `https://cdn.proj.org`. */
  baseUrl?: string;
  /** Abort the request after this long. Default 15 s. */
  timeoutMs?: number;
}

/**
 * {@link GridFileLoader} that downloads PROJ's GeoTIFF grids from
 * cdn.proj.org. A host that ships or caches the files supplies its own loader
 * (read from disk, an internal mirror) instead.
 */
export function projCdnGridLoader(options: ProjCdnGridLoaderOptions = {}): GridFileLoader {
  const { fetch: fetchImpl = globalFetch, baseUrl = 'https://cdn.proj.org', timeoutMs = 15_000 } = options;
  return async (filename) => {
    // cdn.proj.org is usually a few hundred ms, but corporate proxies and the
    // occasional CDN hiccup can hang a fetch indefinitely without a signal.
    // Falling back to +towgs84 after the timeout is far better than a
    // perpetual "loading grid" badge.
    const response = await fetchImpl(`${baseUrl}/${filename}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      reportCrsDiagnostic(`[precision-grid] ${filename}: fetch failed (HTTP ${response.status})`);
      return null;
    }
    return response.arrayBuffer();
  };
}
