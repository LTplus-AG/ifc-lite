/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The capabilities `@ifc-lite/georef-check` takes, built from the other two
 * first-wave packages:
 *
 * - the CRS catalogue is `@ifc-lite/data`'s EPSG catalogue (area of use,
 *   native unit; the checker tests a box across the antimeridian itself), with names resolved by
 *   `@ifc-lite/geo` first (it knows aliases such as `LV95` and `RD New`,
 *   which the catalogue refuses as ambiguous) and by the catalogue second;
 * - the reprojector is synchronous, as the checker calls it, over
 *   `@ifc-lite/geo` transformers resolved beforehand for exactly the CRSs
 *   `crsRequirements(facts)` names. Coordinates go in as metres, easting first.
 *
 * Nothing here touches the network unless `allowNetwork` is set: then the
 * engine may fetch EPSG definitions from epsg.io and datum grids from cdn.proj.org.
 */

import { createEpsgCrsCatalog, loadEpsgExtentsDatasetVersion } from '@ifc-lite/data';
import { createCrsEngine, epsgIoDefinitionLoader, projCdnGridLoader, type CrsEngine, type CrsTransformer } from '@ifc-lite/geo';
import type { CrsCatalog, CrsRequirement, GeorefFacts, Reprojector } from '@ifc-lite/georef-check';
import type { GeorefCrsResolution } from './types.js';

let offlineEngine: CrsEngine | null = null;
let onlineEngine: CrsEngine | null = null;

/**
 * One engine per mode for the process: an engine keeps the definitions and
 * grids it loaded, and its loaders are fixed when it is made, so the offline
 * one can never reach the network.
 */
export function crsEngine(allowNetwork: boolean): CrsEngine {
  if (!allowNetwork) return offlineEngine ??= createCrsEngine();
  return onlineEngine ??= createCrsEngine({ loaders: { epsgDefinition: epsgIoDefinitionLoader(), gridFile: projCdnGridLoader() } });
}

export interface LoadedCatalog {
  catalog: CrsCatalog;
  datasetVersion: string;
}

/** `@ifc-lite/data`'s bundled EPSG catalogue (lazily loaded, no network). */
export async function loadEpsgCatalog(): Promise<LoadedCatalog> {
  const [catalog, datasetVersion] = await Promise.all([createEpsgCrsCatalog(), loadEpsgExtentsDatasetVersion()]);
  return { catalog, datasetVersion };
}

/** Every CRS Name the facts carry. */
export function crsNames(facts: GeorefFacts): string[] {
  const names = [facts.entities?.crs?.name, facts.ePSet?.crs?.name, ...(facts.additionalMapConversions ?? []).map((s) => s.crs?.name)];
  return [...new Set(names.map((n) => n?.trim()).filter((n): n is string => !!n))];
}

/** Name → EPSG code as `@ifc-lite/geo` resolves it, for every name it knows. */
export async function geoNameIndex(engine: CrsEngine, names: readonly string[]): Promise<Map<string, number>> {
  const index = new Map<string, number>();
  for (const name of names) {
    const transformer = await engine.resolveCrs({ name });
    if (transformer?.epsg != null) index.set(name, transformer.epsg);
  }
  return index;
}

/** The catalogue the checker sees: entries from `@ifc-lite/data`; names through `@ifc-lite/geo`, then the catalogue. */
export function composeCatalog(catalog: CrsCatalog | null, geoNames: ReadonlyMap<string, number>): CrsCatalog {
  return {
    lookup: (code) => catalog?.lookup(code),
    resolveName: (name) => geoNames.get(name.trim()) ?? catalog?.resolveName?.(name),
  };
}

export interface ResolvedReprojection {
  reprojector: Reprojector;
  transformers: Map<number, CrsTransformer>;
  resolutions: GeorefCrsResolution[];
}

const DATUM_NOTES: Record<CrsTransformer['datumShift'], string | undefined> = {
  'as-defined': undefined,
  'helmert-approximation': 'datum shift by a 7-parameter Helmert approximation (no datum grid loaded); positions can be off by a few metres',
  'grid-unavailable': 'no datum shift applied (its grid is unavailable); positions can be tens to hundreds of metres off',
};

/** Resolve each required CRS once, then answer the checker synchronously. */
export async function resolveRequirements(engine: CrsEngine, requirements: readonly CrsRequirement[], allowNetwork: boolean): Promise<ResolvedReprojection> {
  const transformers = new Map<number, CrsTransformer>();
  const resolutions: GeorefCrsResolution[] = [];
  for (const requirement of requirements) {
    // A readable WKT defines the CRS (geo's precedence); else the EPSG code.
    const transformer = await engine.resolveCrs({ epsg: requirement.epsg, ...(requirement.wkt ? { wkt: requirement.wkt } : {}) });
    if (!transformer || transformer.kind !== 'projected') {
      resolutions.push({
        epsg: requirement.epsg,
        resolved: false,
        note: allowNetwork
          ? `EPSG:${requirement.epsg} could not be resolved to a projected CRS, even with network access.`
          : `EPSG:${requirement.epsg} is not in the bundled EPSG index; allow network access to fetch its definition from epsg.io.`,
      });
      continue;
    }
    transformers.set(requirement.epsg, transformer);
    const note = DATUM_NOTES[transformer.datumShift];
    resolutions.push({
      epsg: requirement.epsg,
      resolved: true,
      datumShift: transformer.datumShift,
      ...(note ? { note: allowNetwork ? note : `${note}; allow network access to load the grid` } : {}),
    });
  }
  const reprojector: Reprojector = {
    toWgs84(code, [easting, northing]) {
      const out = transformers.get(code)?.toWgs84([easting, northing]);
      return out ? [out[0], out[1]] : undefined;
    },
  };
  return { reprojector, transformers, resolutions };
}
