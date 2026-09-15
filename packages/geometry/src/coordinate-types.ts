/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RtcFrame } from './rtc-frame.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface CoordinateInfo {
  originShift: Vec3;
  originalBounds: AABB;
  shiftedBounds: AABB;
  /** True when large coordinates required an RTC shift, not IFC georeferencing. */
  hasLargeCoordinates: boolean;
  /** RTC offset applied by WASM in IFC coordinates (Z-up). */
  wasmRtcOffset?: Vec3;
  /**
   * Exact RTC frame selected by the WASM mesh producer, in IFC Z-up metres.
   * Absence means the producer did not publish provenance (for example a
   * native path), not that no shift was applied.
   */
  wasmRtcFrame?: RtcFrame;
  /** Building rotation angle in radians, resolved from the IfcSite placement. */
  buildingRotation?: number;
  /**
   * Length-unit scale (file units to metres) from IfcProject's unit assignment,
   * e.g. `0.001` for millimetre files. Lets consumers map externally-resolved
   * geometry into the render frame. See issue #945.
   */
  lengthUnitScale?: number;
}
