/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Authored numeric channels, before coordinate processing or float32 staging. */
export interface IfcxPointSource {
  positions: Float64Array;
  /** Unrounded normalized RGB channels; absent when the source has no colors. */
  colors?: Float64Array;
  pointCount: number;
  /** f32 only when all source coordinates are encoded as float32. */
  sourcePrecision: 'f32' | 'f64';
  sourceEncoding: 'pcd-ascii' | 'pcd-binary' | 'pcd-binary_compressed' | 'points-array' | 'points-base64';
}
