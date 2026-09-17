/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Render frame <-> IFC world coordinates: the one implementation (#4879).
 *
 * Meshes out of this package are NOT in the file's own coordinates. The wasm
 * mesh pass subtracts an RTC offset (`CoordinateInfo.wasmRtcOffset`, IFC
 * Z-up) and `CoordinateHandler` may subtract a further origin shift
 * (`CoordinateInfo.originShift`, already in the Y-up mesh axes), both to keep
 * f32 precision usable for georeferenced models. Everything read off those
 * meshes (renderer camera, section plane, entity and clash bounds) is in that
 * shifted, Y-up "render frame". Anything written for another tool (BCF
 * viewpoints above all) has to be in IFC world coordinates, Z-up.
 *
 * The viewer, the CLI, the MCP playground and the SDK all need the same
 * answer, so the axis swap and the offset sum live here, next to the
 * `CoordinateInfo` they read, rather than once per consumer.
 * `scripts/check-rtc-frame-copies.mjs` keeps it that way.
 */

import type { CoordinateInfo, Vec3 } from './coordinate-types.js';

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** The two recorded offsets; either may be absent (a model near the origin). */
export type RenderFrameInfo = {
  originShift?: Readonly<Vec3> | null;
  wasmRtcOffset?: Readonly<Vec3> | null;
};

/**
 * Convert an IFC Z-up coordinate to the render frame's Y-up axes. `0 - value`
 * deliberately normalises either sign of zero only on the negated axis.
 */
export function ifcToViewerAxes(point: Readonly<Vec3>): Vec3 {
  return { x: point.x, y: point.z, z: 0 - point.y };
}

/** Convert render-frame Y-up to IFC Z-up with the same negated-axis zero rule. */
export function viewerToIfcAxes(point: Readonly<Vec3>): Vec3 {
  return { x: point.x, y: 0 - point.z, z: point.y };
}

/**
 * Total translation from the render frame to world coordinates, in Y-up
 * axes. `originShift` is already Y-up; `wasmRtcOffset` is IFC Z-up.
 */
export function totalYupOffset(info?: RenderFrameInfo | null): Vec3 {
  const shift = info?.originShift ?? ZERO;
  const rtcYup = ifcToViewerAxes(info?.wasmRtcOffset ?? ZERO);
  return {
    x: shift.x + rtcYup.x,
    y: shift.y + rtcYup.y,
    z: shift.z + rtcYup.z,
  };
}

/**
 * Render frame -> IFC world translation, in IFC Z-up metres: the axes BCF
 * positions (and the IFC file) use. Add it to a render-frame point that has
 * already been converted to Z-up. Exactly zero, with no `-0`, for a model
 * that was not shifted.
 */
export function renderFrameWorldOffset(info?: RenderFrameInfo | null): Vec3 {
  const offset = viewerToIfcAxes(totalYupOffset(info));
  return { x: offset.x + 0, y: offset.y + 0, z: offset.z + 0 };
}

/** A loaded model as far as the federation frame rule is concerned. */
export interface FrameCandidate {
  /** Load order; the earliest-loaded model owns the shared frame. */
  loadedAt: number;
  geometryResult?: { coordinateInfo?: CoordinateInfo | null } | null;
}

/**
 * The `CoordinateInfo` whose frame a set of loaded models is drawn in.
 *
 * A federation is aligned to the earliest-loaded model's RTC frame at load,
 * so that model's offsets ARE the scene's offsets; reading a later model's
 * would describe a frame nothing is drawn in. `fallback` covers a single
 * model loaded without a federation entry. Null when nothing has geometry.
 */
export function federationFrameInfo(
  models: Iterable<FrameCandidate>,
  fallback?: { coordinateInfo?: CoordinateInfo | null } | null,
): CoordinateInfo | null {
  let earliest = Infinity;
  let info: CoordinateInfo | null = null;
  for (const model of models) {
    const candidate = model.geometryResult?.coordinateInfo;
    if (candidate && model.loadedAt < earliest) {
      earliest = model.loadedAt;
      info = candidate;
    }
  }
  return info ?? fallback?.coordinateInfo ?? null;
}
