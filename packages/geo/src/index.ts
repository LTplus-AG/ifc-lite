/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/geo — headless CRS engine.
 *
 * Resolve a CRS, convert points to and from WGS84, read grid convergence and
 * point scale, and look up the EGM96 geoid undulation. Works in Node and the
 * browser, and makes no network request unless the host installs a loader.
 *
 * The definition-string functions the viewer builds on are the separate
 * `@ifc-lite/geo/proj4` entry.
 */

export {
  resolveCrs,
  type Coordinate,
  type CrsDatumShift,
  type CrsInput,
  type CrsTransformer,
} from './transformer.js';
export type { GridPointFactors } from './proj4-utils.js';
export {
  configureCrsLoaders,
  epsgIoDefinitionLoader,
  projCdnGridLoader,
  type CrsLoaders,
  type EpsgDefinitionLoader,
  type GridFileLoader,
  type ProjCdnGridLoaderOptions,
} from './loaders.js';
export { egm96Undulation } from './egm96-undulation.js';
