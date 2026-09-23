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
  /**
   * True only when the JS-side `originShift` fired: the geometry reaching
   * `CoordinateHandler` was still beyond `NORMAL_COORD_THRESHOLD_M`, which in
   * practice means WASM did not re-base it. Stays `false` when WASM applied
   * `wasmRtcOffset` instead, and `wasmRtcOffset` is absent when only
   * `originShift` fired, so neither field alone answers "was this model
   * shifted?". Use `hasLargeCoordinates || wasmRtcOffset !== undefined`.
   */
  hasLargeCoordinates: boolean;
  /**
   * Number of batches (#5210) where the fast bounds path sampled a vertex
   * beyond `MAX_REASONABLE_COORD` and `calculateBounds` fell back to the
   * filtered slow path for that batch. Recovery is silent to the caller —
   * the corrupted vertex is dropped, not reported — so this is the only way
   * to learn that the mesher emitted a qualifying vertex at all. `0` means
   * every batch stayed on the fast path.
   */
  boundsRecoveryFallbackCount?: number;
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
