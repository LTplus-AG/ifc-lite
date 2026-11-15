/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Everything CRS resolution caches, kept per engine so that an engine's
 * loaders decide what it resolves: a definition or grid one engine fetched is
 * never seen by another.
 *
 * The module-level functions (`resolveCrs`, `configureCrsLoaders`, the
 * `@ifc-lite/geo/proj4` entry) use the default engine. `configureCrsLoaders`
 * replaces it with a fresh one, so nothing resolved under the previous
 * loaders survives into the new configuration. `createCrsEngine` makes an
 * engine of its own.
 */

import type { CrsLoaders, EpsgDefinitionLoader, GridFileLoader } from './loaders.js';

/**
 * How the horizontal datum shift to WGS84 is carried out.
 *
 * - `as-defined`: the CRS's own operation is in use: the bundled EPSG
 *   parameters, a loaded precision grid, or what the WKT states.
 * - `helmert-approximation`: the CRS needs a datum-shift grid that was not
 *   available (no grid loader installed, or the load failed), and a published
 *   7-parameter shift stands in. Expect metre-level differences.
 * - `grid-unavailable`: the CRS needs a grid that is not available and there
 *   is no known 7-parameter replacement, so no datum shift is applied.
 *   Positions can be tens to hundreds of metres off.
 */
export type CrsDatumShift = 'as-defined' | 'helmert-approximation' | 'grid-unavailable';

/** A proj4 definition together with how its datum shift was obtained. */
export interface ResolvedDefinition {
  definition: string;
  datumShift: CrsDatumShift;
}

interface GridState {
  loaded: Set<string>;
  failed: Set<string>;
  inflight: Map<string, Promise<boolean>>;
  /** The loader's last answer was "not available right now" (`null`); retried on the next resolution. */
  unavailable: Set<string>;
  /** EPSG codes whose datum does not match their listed grid's source. */
  incompatible: Set<string>;
}

export interface EngineState {
  readonly loaders: { readonly epsgDefinition: EpsgDefinitionLoader | null; readonly gridFile: GridFileLoader | null };
  /** EPSG code to resolved definition; `null` is not stored, so a miss can be retried. */
  readonly definitions: Map<string, ResolvedDefinition>;
  readonly grids: GridState;
  /**
   * The name a grid is registered under in proj4's process-wide grid table:
   * the grid's key with a suffix unique to this engine, so the grid bytes one
   * engine's loader returned never replace another engine's registration, nor
   * the grid a transformer from an earlier default engine still uses.
   */
  gridName(key: string): string;
}

let engines = 0;

export function createEngineState(loaders: CrsLoaders): EngineState {
  const suffix = `~engine${++engines}`;
  return {
    loaders: { epsgDefinition: loaders.epsgDefinition ?? null, gridFile: loaders.gridFile ?? null },
    definitions: new Map(),
    grids: { loaded: new Set(), failed: new Set(), inflight: new Map(), unavailable: new Set(), incompatible: new Set() },
    gridName: (key) => `${key}${suffix}`,
  };
}

let defaultState = createEngineState({});

/** The default engine's state. Read it per call: `configureCrsLoaders` replaces it. */
export function defaultEngineState(): EngineState {
  return defaultState;
}

/** Replace the default engine with a fresh one using `loaders`; returns the previous loaders. */
export function replaceDefaultEngineState(loaders: CrsLoaders): CrsLoaders {
  const previous = { ...defaultState.loaders };
  defaultState = createEngineState(loaders);
  return previous;
}
