/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/geo/proj4 — the definition-string layer under `resolveCrs`.
 *
 * These functions hand out and take proj4 definitions directly, which is what
 * a host needs when it calls proj4 itself (the viewer's globe placement does).
 * A definition returned for a WKT is a handle registered with the proj4
 * instance this package imports; it is only valid in that instance. Every
 * function here uses the default engine (`configureCrsLoaders`).
 */

export {
  resolveProjection,
  resolveProjectionId,
  resolveProjectionOperation,
  type CrsDescriptor,
} from './resolve-projection.js';
export {
  coordinatesToLatLon,
  reprojectFromLatLon,
  reprojectPointToLatLon,
  type LatLon,
} from './reproject-point.js';
export { resolveMapUnitToMetreScale } from './map-unit.js';
export { projectedUnitToMetres } from './projected-units.js';
export {
  computeGridConvergence,
  computeGridFrame,
  computeGridPointFactors,
  isGeographicProj4,
  projectedDefinitionInMetres,
  wgs84RadiiOfCurvature,
} from './proj4-utils.js';
export {
  isWithinWktDefinitionExtent,
  isWktDefinition,
  registeredWktDefinition,
  wktDefinitionInMetres,
} from './wkt-projection.js';
export {
  PRECISION_GRIDS,
  hasFailedPrecisionGrid,
  hasLoadedPrecisionGrid,
} from './precision-grids.js';
