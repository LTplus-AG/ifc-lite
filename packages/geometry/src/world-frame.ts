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
 *
 * This is only accurate because the federation loader (`useIfcFederation.ts`)
 * keeps every model's `wasmRtcOffset` converging on one value: later models
 * join an established real anchor via `chooseSharedRtcOffset`, and once a
 * model FIRST introduces a real anchor, every already-loaded, still-raw
 * model is re-based onto it (`rtc-rebase.ts`) rather than left behind in the
 * frame it happened to load in. Without that re-basing step, a model with
 * no `wasmRtcOffset` could stay in a raw frame while a later, large-
 * coordinate model picked its own — the earliest-loaded model would then no
 * longer describe the frame every model is actually drawn in (#4897).
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

/**
 * The `sharedRtcOffset` a newly-loading model should be given: the earliest
 * already-loaded model's `wasmRtcOffset`, or `undefined` when no
 * already-loaded model has one yet (including when there is no earlier
 * model at all) — the loading model is then free to detect its own.
 *
 * `undefined` here is NOT "no frame exists" — every earlier model, offset or
 * not, already rendered in SOME frame. It only means no model has picked a
 * real (non-zero-shift) anchor for the federation yet, so the caller must
 * decide what happens when this loading model turns out to need one: see
 * `federationFrameInfo`'s doc and #4897. `useIfcFederation.ts` handles that
 * by re-basing (`rtc-rebase.ts`) every already-loaded, still-raw model onto
 * this one's anchor the moment it is known, rather than pretending "no
 * anchor chosen yet" is a frame these already-raw models were drawn in.
 */
export function chooseSharedRtcOffset(existingModels: Iterable<FrameCandidate>): Vec3 | undefined {
  let earliestOffsetAt = Infinity;
  let earliestOffset: Readonly<Vec3> | null = null;
  for (const model of existingModels) {
    const offset = model.geometryResult?.coordinateInfo?.wasmRtcOffset;
    if (offset != null && model.loadedAt < earliestOffsetAt) {
      earliestOffsetAt = model.loadedAt;
      earliestOffset = offset;
    }
  }
  return earliestOffset ? { ...earliestOffset } : undefined;
}
