/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Georeferencing metadata (`IfcMapConversion` + `IfcProjectedCRS`).
 *
 * Surfaced on every geometry endpoint's `ModelMetadata`, matching the browser
 * parser's `extractGeoreferencing`.
 */
export interface Georeferencing {
  /** Projected CRS name from `IfcProjectedCRS.Name` (e.g. "EPSG:32632"). */
  crs_name?: string;
  /** Geodetic datum (e.g. "WGS84"). */
  geodetic_datum?: string;
  /** Vertical datum (e.g. "NAVD88"). */
  vertical_datum?: string;
  /** Map projection (e.g. "UTM"). */
  map_projection?: string;
  /** False easting — X offset to the map CRS, in the project's length unit. */
  eastings: number;
  /** False northing — Y offset to the map CRS, in the project's length unit. */
  northings: number;
  /** Orthogonal height — Z offset to the map CRS. */
  orthogonal_height: number;
  /** X-axis abscissa: cosine of the rotation to grid north. */
  x_axis_abscissa: number;
  /** X-axis ordinate: sine of the rotation to grid north. */
  x_axis_ordinate: number;
  /** Scale factor applied during the local→map transform (default 1). */
  scale: number;
  /**
   * `IfcMapConversionScaled.FactorX/Y/Z`, multiplied into `scale` per axis
   * before the rotation (default 1). Absent in older server responses; treat
   * a missing factor as 1.
   */
  factor_x?: number;
  factor_y?: number;
  factor_z?: number;
  /** Rotation to grid north in degrees, derived from the X-axis direction. */
  rotation_degrees: number;
  /** Local→map transform as a column-major 4×4 matrix (16 values). */
  transform_matrix: number[];
  /** CRS description from `IfcProjectedCRS.Description`. */
  crs_description?: string;
  /** Map zone (e.g. "32N") from `IfcProjectedCRS.MapZone`. */
  map_zone?: string;
  /** Map unit name from `IfcProjectedCRS.MapUnit` (e.g. "MILLIMETRE"). */
  map_unit?: string;
  /** Scale converting MapConversion values to metres (0.001 for mm). */
  map_unit_scale?: number;
  /** Provenance: "mapConversion" | "ePSetMapConversion" | "siteLocation". */
  source?: string;
}
