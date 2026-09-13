/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Georeferencing metadata from IfcMapConversion and IfcProjectedCRS. */
export interface Georeferencing {
  crs_name?: string;
  geodetic_datum?: string;
  vertical_datum?: string;
  map_projection?: string;
  eastings: number;
  northings: number;
  orthogonal_height: number;
  x_axis_abscissa: number;
  x_axis_ordinate: number;
  scale: number;
  /** Per-axis factors from IfcMapConversionScaled. Absent in older server responses; default to 1. */
  factor_x?: number;
  factor_y?: number;
  factor_z?: number;
  rotation_degrees: number;
  transform_matrix: number[];
  crs_description?: string;
  map_zone?: string;
  map_unit?: string;
  map_unit_scale?: number;
  source?: string;
}
