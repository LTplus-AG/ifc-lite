/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/geo/wkt — read what a CRS WKT states (identifiers, axes, units,
 * extent, its horizontal part) without resolving it. No proj4, no EPSG index:
 * point-cloud readers use it to label their data.
 */

export {
  extractWktBoundingBox,
  extractWktCrsIdentifiers,
  extractWktHorizontalCrs,
  extractWktSpatialMetadata,
  type WktAxisDirection,
  type WktBoundingBox,
  type WktCrsIdentifiers,
  type WktSpatialMetadata,
} from './spatial-wkt.js';
